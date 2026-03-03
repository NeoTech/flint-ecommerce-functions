/**
 * Orders API routes.
 *
 * GET    /orders                   — list orders (customer: own only, admin: all)
 * GET    /orders/:id               — get order with lines + shipments (owner or admin)
 * POST   /orders                   — create order (customer)
 * PUT    /orders/:id/status        — update order status (admin)
 * DELETE /orders/:id               — cancel order (customer/admin)
 * POST   /orders/:id/refund        — apply refund (admin)
 */
import { z } from 'zod';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { addresses, customers, orderLines, orders, products, productVariants, shipments } from '../db/schema.js';
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
import { reserveStock, releaseStock } from '../lib/inventory.js';

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

// ---- Zod schemas ------------------------------------------------------------

const OrderLineInputSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().optional(),
  quantity:  z.number().int().positive(),
});

const CreateOrderSchema = z.object({
  lines:             z.array(OrderLineInputSchema).min(1),
  shippingAddressId: z.string().min(1),
  notes:             z.string().optional(),
});

const UpdateStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']),
});

const RefundSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1),
});

// ---- Valid status transitions ------------------------------------------------

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:    ['confirmed', 'cancelled'],
  confirmed:  ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped:    ['delivered'],
  delivered:  ['refunded'],
  cancelled:  [],
  refunded:   [],
};

// ---- GET /orders ------------------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/orders',
  auth: 'customer',
  description: 'List orders. Customers see only their own; admins see all with optional filters.',
  queryParams: ['status', 'customerId', 'from', 'to', 'page', 'pageSize'],
  handler: async (request, ctx) => {
    const url = new URL(request.url);
    const { page, pageSize, offset } = parsePagination(url);
    const db = getDb(ctx.env);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [];

    if (ctx.role === 'admin') {
      const statusFilter     = url.searchParams.get('status');
      const customerIdFilter = url.searchParams.get('customerId');
      const from             = url.searchParams.get('from');
      const to               = url.searchParams.get('to');

      if (statusFilter)     conditions.push(eq(orders.status, statusFilter as typeof orders.status._));
      if (customerIdFilter) conditions.push(eq(orders.customerId, customerIdFilter));
      if (from)             conditions.push(gte(orders.createdAt, from));
      if (to)               conditions.push(lte(orders.createdAt, to));
    } else {
      // Find customer record for this user
      const customerRows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.userId, ctx.userId!));

      if (!customerRows[0]) {
        return ok([], { page, pageSize, total: 0 });
      }

      conditions.push(eq(orders.customerId, customerRows[0].id));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      db
        .select({
          id:             orders.id,
          customerId:     orders.customerId,
          status:         orders.status,
          subtotal:       orders.subtotal,
          tax:            orders.tax,
          shippingCost:   orders.shippingCost,
          total:          orders.total,
          refundedAmount: orders.refundedAmount,
          notes:          orders.notes,
          createdAt:      orders.createdAt,
          updatedAt:      orders.updatedAt,
          lineCount:      sql<number>`count(${orderLines.id})`,
        })
        .from(orders)
        .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
        .where(where)
        .groupBy(orders.id)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(distinct ${orders.id})` })
        .from(orders)
        .where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return ok(rows, { page, pageSize, total });
  },
});

// ---- GET /orders/:id --------------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/orders/:id',
  auth: 'customer',
  description: 'Get a single order with lines and shipments. Owner or admin.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);

    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, params.id));

    const order = orderRows[0];
    if (!order) return notFound('Order not found');

    // Ownership check for non-admins
    if (ctx.role !== 'admin') {
      const customerRows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.userId, ctx.userId!));

      if (!customerRows[0] || order.customerId !== customerRows[0].id) {
        return forbidden('Access denied');
      }
    }

    const [lines, shipmentRows] = await Promise.all([
      db.select().from(orderLines).where(eq(orderLines.orderId, order.id)),
      db.select().from(shipments).where(eq(shipments.orderId, order.id)),
    ]);

    return ok({ ...order, lines, shipments: shipmentRows });
  },
});

// ---- POST /orders -----------------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/orders',
  auth: 'customer',
  description: 'Create a new order.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, CreateOrderSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);
    const { lines: lineInputs, shippingAddressId, notes } = parsed.data;

    // Look up customer by userId
    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.userId, ctx.userId!));

    if (!customerRows[0]) return notFound('Customer profile not found');
    const customer = customerRows[0];

    // Validate shipping address belongs to this customer
    const addrRows = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, shippingAddressId), eq(addresses.customerId, customer.id)));

    if (!addrRows[0]) {
      return unprocessable('Shipping address not found or does not belong to this customer');
    }

    // Validate each line: product exists, active, sufficient stock
    type ResolvedLine = {
      productId: string;
      variantId: string | null;
      quantity: number;
      unitPrice: number;
    };

    const resolvedLines: ResolvedLine[] = [];

    for (const lineInput of lineInputs) {
      const productRows = await db
        .select()
        .from(products)
        .where(eq(products.id, lineInput.productId));

      const product = productRows[0];
      if (!product) return unprocessable(`Product not found: ${lineInput.productId}`);
      if (product.status !== 'active') return unprocessable(`Product is not available: ${product.name}`);

      let unitPrice = product.price;

      if (lineInput.variantId) {
        const variantRows = await db
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.id, lineInput.variantId),
              eq(productVariants.productId, lineInput.productId),
            ),
          );

        const variant = variantRows[0];
        if (!variant) return unprocessable(`Variant not found: ${lineInput.variantId}`);
        if (variant.stock < lineInput.quantity) {
          return unprocessable(`Insufficient stock for product: ${product.name}`);
        }
        if (variant.price !== null && variant.price !== undefined) {
          unitPrice = variant.price;
        }

        resolvedLines.push({
          productId: lineInput.productId,
          variantId: lineInput.variantId,
          quantity:  lineInput.quantity,
          unitPrice,
        });
      } else {
        if (product.stock < lineInput.quantity) {
          return unprocessable(`Insufficient stock for product: ${product.name}`);
        }

        resolvedLines.push({
          productId: lineInput.productId,
          variantId: null,
          quantity:  lineInput.quantity,
          unitPrice,
        });
      }
    }

    // Calculate order totals (tax and shippingCost default to 0)
    const subtotal = resolvedLines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
    const total = subtotal;

    // Run atomic transaction: insert order + lines + decrement stock
    const result = await db.transaction(async (tx: ReturnType<typeof getDb>) => {
      const orderInserted = await tx
        .insert(orders)
        .values({
          customerId: customer.id,
          subtotal,
          total,
          notes: notes ?? null,
        })
        .returning();

      const order = orderInserted[0];

      const insertedLines = await tx
        .insert(orderLines)
        .values(
          resolvedLines.map((line) => ({
            orderId:   order.id,
            productId: line.productId,
            variantId: line.variantId,
            quantity:  line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.unitPrice * line.quantity,
          })),
        )
        .returning();

      await reserveStock(tx, resolvedLines);

      return { ...order, lines: insertedLines };
    });

    return created(result);
  },
});

// ---- PUT /orders/:id/status -------------------------------------------------

registerRoute({
  method: 'PUT',
  path: '/orders/:id/status',
  auth: 'admin',
  description: 'Update order status. Admin only. Only valid transitions allowed.',
  handler: async (request, _ctx, params) => {
    const parsed = await parseBody(request, UpdateStatusSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(_ctx.env);

    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, params.id));

    const order = orderRows[0];
    if (!order) return notFound('Order not found');

    const { status: newStatus } = parsed.data;
    const allowed = VALID_TRANSITIONS[order.status] ?? [];

    if (!allowed.includes(newStatus)) {
      return unprocessable(`Invalid status transition from ${order.status} to ${newStatus}`);
    }

    const updated = await db
      .update(orders)
      .set({ status: newStatus, updatedAt: new Date().toISOString() })
      .where(eq(orders.id, order.id))
      .returning();

    return ok(updated[0]);
  },
});

// ---- DELETE /orders/:id -----------------------------------------------------

registerRoute({
  method: 'DELETE',
  path: '/orders/:id',
  auth: 'customer',
  description: 'Cancel an order. Admin: any pending/confirmed/processing. Owner: only pending within 30 minutes.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);

    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, params.id));

    const order = orderRows[0];
    if (!order) return notFound('Order not found');

    const cancellableByAdmin = ['pending', 'confirmed', 'processing'];

    if (ctx.role === 'admin') {
      if (!cancellableByAdmin.includes(order.status)) {
        return forbidden('Order cannot be cancelled');
      }
    } else {
      // Verify ownership
      const customerRows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.userId, ctx.userId!));

      if (!customerRows[0] || order.customerId !== customerRows[0].id) {
        return notFound('Order not found');
      }

      // Owners can only cancel pending orders within 30 minutes
      if (order.status !== 'pending') {
        return forbidden('Order cannot be cancelled');
      }

      const elapsed = Date.now() - new Date(order.createdAt).getTime();
      if (elapsed > 30 * 60 * 1000) {
        return forbidden('Order cannot be cancelled');
      }
    }

    // Fetch lines to restore stock, then cancel atomically
    const lines = await db
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id));

    await db.transaction(async (tx: ReturnType<typeof getDb>) => {
      await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
        .where(eq(orders.id, order.id));

      await releaseStock(
        tx,
        lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })),
      );
    });

    return noContent();
  },
});

// ---- POST /orders/:id/refund ------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/orders/:id/refund',
  auth: 'admin',
  description: 'Apply a refund to a delivered or refunded order. Admin only.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, RefundSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);

    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, params.id));

    const order = orderRows[0];
    if (!order) return notFound('Order not found');

    if (order.status !== 'delivered' && order.status !== 'refunded') {
      return unprocessable('Order must be in delivered or refunded status to process a refund');
    }

    const { amount } = parsed.data;
    const newRefundedAmount = order.refundedAmount + amount;
    const newStatus = newRefundedAmount >= order.subtotal ? 'refunded' : order.status;

    const updated = await db
      .update(orders)
      .set({
        refundedAmount: newRefundedAmount,
        status:         newStatus,
        updatedAt:      new Date().toISOString(),
      })
      .where(eq(orders.id, order.id))
      .returning();

    return ok(updated[0]);
  },
});
