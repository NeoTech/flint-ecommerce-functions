/**
 * Customers API routes.
 *
 * GET    /customers                              — list customers (admin)
 * GET    /customers/:id                          — get customer (self or admin)
 * PUT    /customers/:id                          — update customer (self or admin)
 * DELETE /customers/:id                          — deactivate customer (admin)
 * GET    /customers/:id/orders                   — list orders (self or admin)
 * GET    /customers/:id/addresses                — list addresses (self or admin)
 * POST   /customers/:id/addresses                — add address (self or admin)
 * PUT    /customers/:id/addresses/:addressId     — update address (self or admin)
 * DELETE /customers/:id/addresses/:addressId     — delete address (self or admin)
 */
import { z } from 'zod';
import { and, eq, like, or, sql } from 'drizzle-orm';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { addresses, customers, orderLines, orders, users } from '../db/schema.js';
import {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  ok,
  parsePagination,
  unprocessable,
} from '../types.js';

// ---- Helpers ----------------------------------------------------------------

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: badRequest('Request body must be valid JSON') };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: unprocessable(result.error.issues[0]?.message ?? 'Invalid body') };
  }
  return { ok: true, data: result.data };
}

// Fetch a customer row joined with user, returning null if not found.
async function fetchCustomerWithUser(customerId: string, db: ReturnType<typeof getDb>) {
  const rows = await db
    .select({
      id: customers.id,
      userId: customers.userId,
      email: users.email,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      role: users.role,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(customers.id, customerId));
  return rows[0] ?? null;
}

// ---- Zod schemas ------------------------------------------------------------

const UpdateCustomerSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName:  z.string().min(1).optional(),
  phone:     z.string().optional(),
  role:      z.enum(['customer', 'admin', 'inactive']).optional(),
});

const AddressSchema = z.object({
  type:       z.enum(['shipping', 'billing']).optional(),
  street:     z.string().min(1),
  city:       z.string().min(1),
  state:      z.string().optional(),
  postalCode: z.string().min(1),
  country:    z.string().optional(),
  isDefault:  z.boolean().optional(),
});

const UpdateAddressSchema = AddressSchema.partial();

// ---- GET /customers ---------------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/customers',
  auth: 'admin',
  description: 'List all customers with pagination and optional search. Admin only.',
  queryParams: ['search', 'page', 'pageSize'],
  handler: async (request, ctx) => {
    const url = new URL(request.url);
    const { page, pageSize, offset } = parsePagination(url);
    const search = url.searchParams.get('search');
    const db = getDb(ctx.env);

    const conditions = search
      ? [
          or(
            like(users.email, `%${search}%`),
            like(customers.firstName, `%${search}%`),
            like(customers.lastName, `%${search}%`),
          ),
        ]
      : [];

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      db
        .select({
          id: customers.id,
          userId: customers.userId,
          email: users.email,
          firstName: customers.firstName,
          lastName: customers.lastName,
          phone: customers.phone,
          role: users.role,
          createdAt: customers.createdAt,
        })
        .from(customers)
        .innerJoin(users, eq(customers.userId, users.id))
        .where(where)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(customers)
        .innerJoin(users, eq(customers.userId, users.id))
        .where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return ok(rows, { page, pageSize, total });
  },
});

// ---- GET /customers/:id -----------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/customers/:id',
  auth: 'customer',
  description: 'Get a customer by ID. Self or admin.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    return ok(customer);
  },
});

// ---- PUT /customers/:id -----------------------------------------------------

registerRoute({
  method: 'PUT',
  path: '/customers/:id',
  auth: 'customer',
  description: 'Update a customer. Self can update name/phone; admins can also update role.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, UpdateCustomerSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    const { firstName, lastName, phone, role } = parsed.data;

    // Non-admin attempting to change role
    if (role !== undefined && ctx.role !== 'admin') {
      return forbidden('Cannot change role');
    }

    // Update customers table fields
    if (firstName !== undefined || lastName !== undefined || phone !== undefined) {
      const customerUpdate: Record<string, unknown> = {};
      if (firstName !== undefined) customerUpdate.firstName = firstName;
      if (lastName !== undefined) customerUpdate.lastName = lastName;
      if (phone !== undefined) customerUpdate.phone = phone;

      await db
        .update(customers)
        .set(customerUpdate)
        .where(eq(customers.id, params.id));
    }

    // Update users table fields (role)
    if (role !== undefined) {
      await db
        .update(users)
        .set({ role, updatedAt: new Date().toISOString() })
        .where(eq(users.id, customer.userId));
    }

    const updated = await fetchCustomerWithUser(params.id, db);
    return ok(updated);
  },
});

// ---- DELETE /customers/:id --------------------------------------------------

registerRoute({
  method: 'DELETE',
  path: '/customers/:id',
  auth: 'admin',
  description: 'Deactivate a customer by setting their user role to inactive. Admin only.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    await db
      .update(users)
      .set({ role: 'inactive', updatedAt: new Date().toISOString() })
      .where(eq(users.id, customer.userId));

    return noContent();
  },
});

// ---- GET /customers/:id/orders ----------------------------------------------

registerRoute({
  method: 'GET',
  path: '/customers/:id/orders',
  auth: 'customer',
  description: 'List orders for a customer, with line count. Self or admin.',
  queryParams: ['page', 'pageSize'],
  handler: async (request, ctx, params) => {
    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    const url = new URL(request.url);
    const { page, pageSize, offset } = parsePagination(url);

    const [rows, countRows] = await Promise.all([
      db
        .select({
          id: orders.id,
          customerId: orders.customerId,
          status: orders.status,
          subtotal: orders.subtotal,
          tax: orders.tax,
          shippingCost: orders.shippingCost,
          total: orders.total,
          refundedAmount: orders.refundedAmount,
          notes: orders.notes,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
          lineCount: sql<number>`(select count(*) from order_lines where order_lines.order_id = ${orders.id})`,
        })
        .from(orders)
        .where(eq(orders.customerId, params.id))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(eq(orders.customerId, params.id)),
    ]);

    const total = countRows[0]?.count ?? 0;
    return ok(rows, { page, pageSize, total });
  },
});

// ---- GET /customers/:id/addresses -------------------------------------------

registerRoute({
  method: 'GET',
  path: '/customers/:id/addresses',
  auth: 'customer',
  description: 'List addresses for a customer. Self or admin.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    const rows = await db
      .select()
      .from(addresses)
      .where(eq(addresses.customerId, params.id));

    return ok(rows);
  },
});

// ---- POST /customers/:id/addresses ------------------------------------------

registerRoute({
  method: 'POST',
  path: '/customers/:id/addresses',
  auth: 'customer',
  description: 'Add an address for a customer. Self or admin.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, AddressSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    const { type = 'shipping', street, city, state, postalCode, country = 'US', isDefault = false } = parsed.data;

    // If setting as default, unset existing defaults of the same type
    if (isDefault) {
      await db
        .update(addresses)
        .set({ isDefault: false })
        .where(
          and(
            eq(addresses.customerId, params.id),
            eq(addresses.type, type),
            eq(addresses.isDefault, true),
          ),
        );
    }

    const [address] = await db
      .insert(addresses)
      .values({ customerId: params.id, type, street, city, state, postalCode, country, isDefault })
      .returning();

    return created(address);
  },
});

// ---- PUT /customers/:id/addresses/:addressId --------------------------------

registerRoute({
  method: 'PUT',
  path: '/customers/:id/addresses/:addressId',
  auth: 'customer',
  description: 'Update an address for a customer. Self or admin.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, UpdateAddressSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    // Verify the address exists and belongs to this customer
    const existingRows = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, params.addressId), eq(addresses.customerId, params.id)));
    const existing = existingRows[0];
    if (!existing) return notFound('Address not found');

    const { isDefault, type, ...rest } = parsed.data;
    const effectiveType = type ?? existing.type;

    // If setting as default, unset existing defaults of the same type
    if (isDefault) {
      await db
        .update(addresses)
        .set({ isDefault: false })
        .where(
          and(
            eq(addresses.customerId, params.id),
            eq(addresses.type, effectiveType),
            eq(addresses.isDefault, true),
          ),
        );
    }

    const updateData: Record<string, unknown> = { ...rest };
    if (type !== undefined) updateData.type = type;
    if (isDefault !== undefined) updateData.isDefault = isDefault;

    const [updated] = await db
      .update(addresses)
      .set(updateData)
      .where(eq(addresses.id, params.addressId))
      .returning();

    return ok(updated);
  },
});

// ---- DELETE /customers/:id/addresses/:addressId -----------------------------

registerRoute({
  method: 'DELETE',
  path: '/customers/:id/addresses/:addressId',
  auth: 'customer',
  description: 'Delete an address for a customer. Self or admin.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);
    const customer = await fetchCustomerWithUser(params.id, db);

    if (!customer) return notFound('Customer not found');

    if (ctx.role !== 'admin' && ctx.userId !== customer.userId) {
      return forbidden('Access denied');
    }

    // Verify the address exists and belongs to this customer
    const existingRows = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, params.addressId), eq(addresses.customerId, params.id)));
    if (!existingRows[0]) return notFound('Address not found');

    await db.delete(addresses).where(eq(addresses.id, params.addressId));

    return noContent();
  },
});
