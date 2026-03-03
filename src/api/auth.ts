/**
 * Auth API routes.
 *
 * POST /auth/register        — create account, return token pair
 * POST /auth/login           — verify credentials, return token pair
 * POST /auth/logout          — revoke refresh token
 * POST /auth/refresh         — rotate refresh token, return new token pair
 * POST /auth/forgot-password — issue password reset token (no email enumeration)
 * POST /auth/reset-password  — consume reset token, update password
 *
 * All routes are auth: 'none' — access control is done inside handlers.
 * This module is imported by src/app.ts which triggers route registration.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { customers, users } from '../db/schema.js';
import { getStripe } from '../lib/stripe.js';
import {
  badRequest,
  conflict,
  created,
  forbidden,
  noContent,
  ok,
  unauthorized,
  unprocessable,
} from '../types.js';
import {
  consumeResetToken,
  issueResetToken,
  issueTokenPair,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../lib/tokens.js';

// ---- Zod schemas ------------------------------------------------------------

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

const BootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// ---- Body parser helper -----------------------------------------------------

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequest('Request body must be valid JSON') };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    return { ok: false, response: unprocessable(message, 'VALIDATION_ERROR') };
  }

  return { ok: true, data: result.data };
}

// ---- POST /auth/register ----------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/register',
  auth: 'none',
  description: 'Create a new customer account and return a token pair.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, RegisterSchema);
    if (!parsed.ok) return parsed.response;
    const { email, password, firstName, lastName } = parsed.data;

    const db = getDb(ctx.env);

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) return conflict('An account with this email already exists');

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    const customerId = crypto.randomUUID();

    await db.insert(users).values({ id: userId, email, passwordHash, role: 'customer' });
    await db.insert(customers).values({ id: customerId, userId, firstName, lastName });

    // Create a Stripe Customer so checkout sessions can be pre-filled.
    // Wrapped in try/catch so a Stripe outage does not break registration.
    try {
      const stripe = getStripe(ctx.env);
      const stripeCustomer = await stripe.customers.create({
        email,
        name: `${firstName} ${lastName}`,
        metadata: { userId },
      });
      await db.update(users)
        .set({ stripeCustomerId: stripeCustomer.id })
        .where(eq(users.id, userId));
    } catch {
      // Non-fatal: the customer can be backfilled on next login.
    }

    const tokens = await issueTokenPair(userId, 'customer', ctx.env, db);
    return created({
      user: { id: userId, email, role: 'customer', firstName, lastName },
      ...tokens,
    });
  },
});

// ---- POST /auth/login -------------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/login',
  auth: 'none',
  description: 'Authenticate with email and password and receive a token pair.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, LoginSchema);
    if (!parsed.ok) return parsed.response;
    const { email, password } = parsed.data;

    const db = getDb(ctx.env);
    const rows = await db.select().from(users).where(eq(users.email, email));
    const user = rows[0];

    // Always run password verification to prevent timing-based email enumeration.
    let validPassword = false;
    if (user) {
      validPassword = await bcrypt.compare(password, user.passwordHash);
    } else {
      await bcrypt.hash(password, 12); // burn equivalent time
    }

    if (!user || !validPassword || user.role === 'inactive') {
      return unauthorized('Invalid email or password');
    }

    // Backfill Stripe Customer if the registration Stripe call failed earlier.
    if (!user.stripeCustomerId) {
      try {
        const stripe = getStripe(ctx.env);
        const stripeCustomer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: user.id },
        });
        await db.update(users)
          .set({ stripeCustomerId: stripeCustomer.id })
          .where(eq(users.id, user.id));
      } catch {
        // Non-fatal: checkout will still work via email lookup.
      }
    }

    const tokens = await issueTokenPair(user.id, user.role, ctx.env, db);
    return ok({ user: { id: user.id, email: user.email, role: user.role }, ...tokens });
  },
});

// ---- POST /auth/logout ------------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/logout',
  auth: 'none',
  description: 'Revoke a refresh token.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, LogoutSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    await revokeRefreshToken(parsed.data.refreshToken, db);
    return noContent();
  },
});

// ---- POST /auth/refresh -----------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/refresh',
  auth: 'none',
  description: 'Rotate a refresh token and receive a new access + refresh token pair.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, RefreshSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const tokens = await rotateRefreshToken(parsed.data.refreshToken, db, ctx.env);
    if (!tokens) return unauthorized('Refresh token is invalid or has expired');

    return ok(tokens);
  },
});

// ---- POST /auth/forgot-password ---------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/forgot-password',
  auth: 'none',
  description: 'Request a password reset. Always returns success to prevent email enumeration.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, ForgotPasswordSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.data.email));

    if (rows.length > 0) {
      await issueResetToken(rows[0].id, db);
      // TODO LOPC-11: deliver raw token via email (reset link)
    }

    return ok({ message: 'If the email exists, a reset link has been sent' });
  },
});

// ---- POST /auth/reset-password ----------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/reset-password',
  auth: 'none',
  description: 'Consume a password reset token and update the account password.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, ResetPasswordSchema);
    if (!parsed.ok) return parsed.response;
    const { token, newPassword } = parsed.data;

    const db = getDb(ctx.env);
    const userId = await consumeResetToken(token, db);
    if (!userId) return unauthorized('Reset token is invalid or has expired');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId));

    return ok({ message: 'Password updated successfully' });
  },
});

// ---- POST /auth/bootstrap ---------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/auth/bootstrap',
  auth: 'none',
  description: 'One-time admin account creation. Disabled once any admin exists.',
  handler: async (request, ctx) => {
    const secret = request.headers.get('x-bootstrap-secret');
    if (!ctx.env.BOOTSTRAP_SECRET || secret !== ctx.env.BOOTSTRAP_SECRET) {
      return forbidden('Invalid or missing bootstrap secret');
    }

    const db = getDb(ctx.env);
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'admin'))
      .limit(1);
    if (existing.length > 0) return forbidden('Bootstrap already completed — an admin already exists');

    const parsed = await parseBody(request, BootstrapSchema);
    if (!parsed.ok) return parsed.response;
    const { email, password } = parsed.data;

    const emailExists = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (emailExists.length > 0) return conflict('An account with this email already exists');

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email, passwordHash, role: 'admin' });

    return created({ message: 'Admin account created', userId, email });
  },
});
