/**
 * Products and Variants API routes.
 *
 * GET    /products                       — list active products (filterable)
 * GET    /products/:id                   — get product + variants
 * POST   /products                       — create product (admin)
 * PUT    /products/:id                   — update product (admin)
 * DELETE /products/:id                   — soft-delete product (admin)
 * GET    /products/:id/variants          — list variants for product
 * POST   /products/:id/variants          — add variant (admin)
 * PUT    /products/:id/variants/:variantId — update variant (admin)
 */
import { z } from 'zod';
import { and, eq, gt, gte, like, lte, sql } from 'drizzle-orm';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { productVariants, products } from '../db/schema.js';
import { getStripe } from '../lib/stripe.js';
import { validateBearerToken } from '../middleware/auth.js';
import {
  badRequest,
  conflict,
  created,
  noContent,
  notFound,
  ok,
  parsePagination,
  unprocessable,
} from '../types.js';

// ---- Helpers ----------------------------------------------------------------

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function uniqueProductSlug(base: string, db: ReturnType<typeof getDb>, excludeId?: string): Promise<string> {
  let slug = base;
  let counter = 2;
  for (;;) {
    const rows = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
    const conflict = rows.find((r) => r.id !== excludeId);
    if (!conflict) return slug;
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

const CreateProductSchema = z.object({
  name:         z.string().min(1),
  categoryId:   z.string().optional(),
  description:  z.string().optional(),
  price:        z.number().positive(),
  comparePrice: z.number().positive().optional(),
  stock:        z.number().int().min(0).optional(),
  status:       z.enum(['draft', 'active', 'archived']).optional(),
});

const UpdateProductSchema = CreateProductSchema.partial();

const CreateVariantSchema = z.object({
  sku:        z.string().min(1),
  name:       z.string().min(1),
  price:      z.number().positive().optional(),
  stock:      z.number().int().min(0).optional(),
  attributes: z.string().optional(),
});

const UpdateVariantSchema = CreateVariantSchema.partial();

// ---- GET /products ----------------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/products',
  auth: 'none',
  description: 'List products with optional filtering and pagination.',
  queryParams: ['category', 'minPrice', 'maxPrice', 'search', 'inStock', 'status', 'page', 'pageSize'],
  handler: async (request, ctx) => {
    const url = new URL(request.url);
    const { page, pageSize, offset } = parsePagination(url);
    const db = getDb(ctx.env);

    const auth = await validateBearerToken(request, ctx.env);
    const isAdmin = auth?.role === 'admin';
    const categoryFilter = url.searchParams.get('category');
    const minPrice      = url.searchParams.get('minPrice');
    const maxPrice      = url.searchParams.get('maxPrice');
    const search        = url.searchParams.get('search');
    const inStock       = url.searchParams.get('inStock');
    const statusParam   = url.searchParams.get('status');

    // Non-admins always see only active products.
    const effectiveStatus = isAdmin && statusParam ? statusParam : 'active';

    const conditions = [
      eq(products.status, effectiveStatus as 'draft' | 'active' | 'archived'),
    ];

    if (categoryFilter) conditions.push(eq(products.categoryId, categoryFilter));
    if (minPrice)       conditions.push(gte(products.price, Number(minPrice)));
    if (maxPrice)       conditions.push(lte(products.price, Number(maxPrice)));
    if (search)         conditions.push(like(products.name, `%${search}%`));
    if (inStock === 'true') conditions.push(gt(products.stock, 0));

    const where = and(...conditions);

    const [rows, countRows] = await Promise.all([
      db.select().from(products).where(where).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(products).where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return ok(rows, { page, pageSize, total });
  },
});

// ---- GET /products/:id ------------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/products/:id',
  auth: 'none',
  description: 'Get a single product with all its variants.',
  handler: async (request, ctx, params) => {
    const db = getDb(ctx.env);
    const isAdmin = ctx.role === 'admin';
    const rows = await db.select().from(products).where(eq(products.id, params.id));
    const product = rows[0];

    if (!product) return notFound('Product not found');
    if (!isAdmin && product.status === 'archived') return notFound('Product not found');

    const variants = await db.select().from(productVariants).where(eq(productVariants.productId, product.id));
    return ok({ ...product, variants });
  },
});

// ---- POST /products ---------------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/products',
  auth: 'admin',
  description: 'Create a new product.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, CreateProductSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const { name, categoryId, description, price, comparePrice, stock, status } = parsed.data;

    const baseSlug = toSlug(name);
    const slug = await uniqueProductSlug(baseSlug, db);

    try {
      const rows = await db.insert(products).values({
        name,
        slug,
        categoryId:   categoryId   ?? null,
        description:  description  ?? null,
        price,
        comparePrice: comparePrice ?? null,
        stock:        stock        ?? 0,
        status:       status       ?? 'draft',
      }).returning();

      const product = rows[0];

      // Sync to Stripe — wrapped in try/catch so a Stripe outage won't block creation.
      try {
        const stripe = getStripe(ctx.env);
        const stripeProduct = await stripe.products.create({
          name: product.name,
          description: product.description ?? undefined,
          metadata: { productId: product.id },
        });
        const stripePrice = await stripe.prices.create({
          product: stripeProduct.id,
          unit_amount: Math.round(product.price * 100),
          currency: 'usd',
          metadata: { productId: product.id },
        });
        const [synced] = await db.update(products)
          .set({ stripeProductId: stripeProduct.id, stripePriceId: stripePrice.id })
          .where(eq(products.id, product.id))
          .returning();
        return created(synced);
      } catch {
        // Stripe sync failed — return the product without Stripe IDs.
      }

      return created(product);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return conflict('A product with this slug already exists');
      }
      throw err;
    }
  },
});

// ---- PUT /products/:id ------------------------------------------------------

registerRoute({
  method: 'PUT',
  path: '/products/:id',
  auth: 'admin',
  description: 'Update a product.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, UpdateProductSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const existing = await db.select().from(products).where(eq(products.id, params.id));
    if (!existing[0]) return notFound('Product not found');

    const { name, categoryId, description, price, comparePrice, stock, status } = parsed.data;

    const updates: Record<string, unknown> = {
      updatedAt: sql`(datetime('now'))`,
    };
    if (name !== undefined)         { updates.name = name; updates.slug = await uniqueProductSlug(toSlug(name), db, params.id); }
    if (categoryId !== undefined)   updates.categoryId   = categoryId;
    if (description !== undefined)  updates.description  = description;
    if (price !== undefined)        updates.price        = price;
    if (comparePrice !== undefined) updates.comparePrice = comparePrice;
    if (stock !== undefined)        updates.stock        = stock;
    if (status !== undefined)       updates.status       = status;

    const rows = await db.update(products).set(updates).where(eq(products.id, params.id)).returning();
    const updated = rows[0];

    // Stripe sync — update product name/description; create new price if price changed.
    if (updated.stripeProductId) {
      try {
        const stripe = getStripe(ctx.env);

        // Update Stripe product metadata.
        await stripe.products.update(updated.stripeProductId, {
          ...(name !== undefined       ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        });

        // If price changed, create a new Stripe Price and archive the old one.
        if (price !== undefined && price !== existing[0].price) {
          const newPrice = await stripe.prices.create({
            product: updated.stripeProductId,
            unit_amount: Math.round(price * 100),
            currency: 'usd',
            metadata: { productId: updated.id },
          });

          // Archive old price (best-effort).
          if (existing[0].stripePriceId) {
            await stripe.prices.update(existing[0].stripePriceId, { active: false }).catch(() => {});
          }

          const [synced] = await db.update(products)
            .set({ stripePriceId: newPrice.id })
            .where(eq(products.id, updated.id))
            .returning();
          return ok(synced);
        }
      } catch {
        // Stripe sync failed — return local data as-is.
      }
    }

    return ok(updated);
  },
});

// ---- DELETE /products/:id ---------------------------------------------------

registerRoute({
  method: 'DELETE',
  path: '/products/:id',
  auth: 'admin',
  description: 'Soft-delete a product by setting status to archived.',
  handler: async (request, ctx, params) => {
    const db = getDb(ctx.env);
    const existing = await db.select({ id: products.id }).from(products).where(eq(products.id, params.id));
    if (!existing[0]) return notFound('Product not found');

    await db.update(products)
      .set({ status: 'archived', updatedAt: sql`(datetime('now'))` })
      .where(eq(products.id, params.id));

    return noContent();
  },
});

// ---- GET /products/:id/variants ---------------------------------------------

registerRoute({
  method: 'GET',
  path: '/products/:id/variants',
  auth: 'none',
  description: 'List all variants for a product.',
  handler: async (request, ctx, params) => {
    const db = getDb(ctx.env);
    const productRows = await db.select({ id: products.id }).from(products).where(eq(products.id, params.id));
    if (!productRows[0]) return notFound('Product not found');

    const variants = await db.select().from(productVariants).where(eq(productVariants.productId, params.id));
    return ok(variants);
  },
});

// ---- POST /products/:id/variants --------------------------------------------

registerRoute({
  method: 'POST',
  path: '/products/:id/variants',
  auth: 'admin',
  description: 'Add a variant to a product.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, CreateVariantSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const productRows = await db.select({ id: products.id }).from(products).where(eq(products.id, params.id));
    if (!productRows[0]) return notFound('Product not found');

    const { sku, name, price, stock, attributes } = parsed.data;

    // Check SKU uniqueness.
    const existing = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku));
    if (existing[0]) return conflict('A variant with this SKU already exists');

    try {
      const rows = await db.insert(productVariants).values({
        productId:  params.id,
        sku,
        name,
        price:      price      ?? null,
        stock:      stock      ?? 0,
        attributes: attributes ?? null,
      }).returning();

      return created(rows[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return conflict('A variant with this SKU already exists');
      }
      throw err;
    }
  },
});

// ---- PUT /products/:id/variants/:variantId ----------------------------------

registerRoute({
  method: 'PUT',
  path: '/products/:id/variants/:variantId',
  auth: 'admin',
  description: 'Update a product variant.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, UpdateVariantSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const existing = await db.select().from(productVariants)
      .where(and(eq(productVariants.id, params.variantId), eq(productVariants.productId, params.id)));
    if (!existing[0]) return notFound('Variant not found');

    const { sku, name, price, stock, attributes } = parsed.data;
    const updates: Record<string, unknown> = {};
    if (sku        !== undefined) updates.sku        = sku;
    if (name       !== undefined) updates.name       = name;
    if (price      !== undefined) updates.price      = price;
    if (stock      !== undefined) updates.stock      = stock;
    if (attributes !== undefined) updates.attributes = attributes;

    const rows = await db.update(productVariants).set(updates)
      .where(eq(productVariants.id, params.variantId)).returning();
    return ok(rows[0]);
  },
});
