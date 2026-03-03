/**
 * Categories API routes.
 *
 * GET    /categories      — list all categories sorted by sortOrder, name
 * GET    /categories/:id  — get category + direct children
 * POST   /categories      — create category (admin)
 * PUT    /categories/:id  — update category (admin)
 * DELETE /categories/:id  — hard-delete category if no active products reference it (admin)
 */
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { categories, products } from '../db/schema.js';
import {
  badRequest,
  conflict,
  created,
  noContent,
  notFound,
  ok,
  unprocessable,
} from '../types.js';

// ---- Helpers ----------------------------------------------------------------

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function uniqueCategorySlug(base: string, db: ReturnType<typeof getDb>, excludeId?: string): Promise<string> {
  let slug = base;
  let counter = 2;
  for (;;) {
    const rows = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug));
    const conflicting = rows.find((r) => r.id !== excludeId);
    if (!conflicting) return slug;
    slug = `${base}-${counter}`;
    counter++;
  }
}

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

// ---- Zod schemas ------------------------------------------------------------

const CreateCategorySchema = z.object({
  name:        z.string().min(1),
  parentId:    z.string().optional(),
  description: z.string().optional(),
  sortOrder:   z.number().int().min(0).optional(),
});

const UpdateCategorySchema = CreateCategorySchema.partial();

// ---- GET /categories --------------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/categories',
  auth: 'none',
  description: 'List all categories sorted by sortOrder and name.',
  handler: async (_request, ctx) => {
    const db = getDb(ctx.env);
    const rows = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.name));
    return ok(rows);
  },
});

// ---- GET /categories/:id ----------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/categories/:id',
  auth: 'none',
  description: 'Get a category with its direct children.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);
    const rows = await db.select().from(categories).where(eq(categories.id, params.id));
    const category = rows[0];
    if (!category) return notFound('Category not found');

    const children = await db.select().from(categories).where(eq(categories.parentId, params.id))
      .orderBy(asc(categories.sortOrder), asc(categories.name));

    return ok({ ...category, children });
  },
});

// ---- POST /categories -------------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/categories',
  auth: 'admin',
  description: 'Create a new category.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, CreateCategorySchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const { name, parentId, description, sortOrder } = parsed.data;

    const baseSlug = toSlug(name);
    const slug = await uniqueCategorySlug(baseSlug, db);

    try {
      const rows = await db.insert(categories).values({
        name,
        slug,
        parentId:    parentId    ?? null,
        description: description ?? null,
        sortOrder:   sortOrder   ?? 0,
      }).returning();

      return created(rows[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return conflict('A category with this slug already exists');
      }
      throw err;
    }
  },
});

// ---- PUT /categories/:id ----------------------------------------------------

registerRoute({
  method: 'PUT',
  path: '/categories/:id',
  auth: 'admin',
  description: 'Update a category.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, UpdateCategorySchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const existing = await db.select().from(categories).where(eq(categories.id, params.id));
    if (!existing[0]) return notFound('Category not found');

    const { name, parentId, description, sortOrder } = parsed.data;
    const updates: Record<string, unknown> = {};
    if (name        !== undefined) { updates.name = name; updates.slug = await uniqueCategorySlug(toSlug(name), db, params.id); }
    if (parentId    !== undefined) updates.parentId    = parentId;
    if (description !== undefined) updates.description = description;
    if (sortOrder   !== undefined) updates.sortOrder   = sortOrder;

    const rows = await db.update(categories).set(updates).where(eq(categories.id, params.id)).returning();
    return ok(rows[0]);
  },
});

// ---- DELETE /categories/:id -------------------------------------------------

registerRoute({
  method: 'DELETE',
  path: '/categories/:id',
  auth: 'admin',
  description: 'Delete a category. Returns 409 if active products reference it.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);
    const existing = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, params.id));
    if (!existing[0]) return notFound('Category not found');

    const activeProducts = await db.select({ id: products.id }).from(products)
      .where(and(eq(products.categoryId, params.id), eq(products.status, 'active')));

    if (activeProducts.length > 0) {
      return conflict('Cannot delete category with active products');
    }

    await db.delete(categories).where(eq(categories.id, params.id));
    return noContent();
  },
});
