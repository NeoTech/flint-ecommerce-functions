/**
 * Logistics / Shipments API routes.
 *
 * GET    /logistics/shipments                 — list shipments (admin)
 * GET    /logistics/shipments/:id             — get shipment (owner or admin)
 * POST   /logistics/shipments                 — create shipment (admin)
 * PUT    /logistics/shipments/:id             — update shipment (admin)
 * GET    /logistics/tracking/:trackingNumber  — public tracking lookup (none)
 */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { customers, orders, shipments } from '../db/schema.js';
import {
  badRequest,
  conflict,
  created,
  forbidden,
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

// Statuses that mean an order is already in a terminal or advanced shipping state
const ORDER_ALREADY_SHIPPED_STATUSES = new Set(['shipped', 'delivered', 'cancelled', 'refunded']);

// ---- Zod schemas ------------------------------------------------------------

const CreateShipmentSchema = z.object({
  orderId:        z.string().min(1),
  carrier:        z.string().min(1),
  trackingNumber: z.string().min(1),
  status:         z.enum(['preparing', 'in_transit', 'out_for_delivery', 'delivered', 'failed']).optional(),
});

const UpdateShipmentSchema = z.object({
  status:         z.enum(['preparing', 'in_transit', 'out_for_delivery', 'delivered', 'failed']).optional(),
  trackingNumber: z.string().min(1).optional(),
  deliveredAt:    z.string().optional(),
});

// ---- GET /logistics/shipments -----------------------------------------------

registerRoute({
  method: 'GET',
  path: '/logistics/shipments',
  auth: 'admin',
  description: 'List all shipments with optional filters. Admin only.',
  queryParams: ['orderId', 'status', 'carrier', 'page', 'pageSize'],
  handler: async (request, ctx) => {
    const url = new URL(request.url);
    const { page, pageSize, offset } = parsePagination(url);
    const db = getDb(ctx.env);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [];

    const orderIdFilter = url.searchParams.get('orderId');
    const statusFilter  = url.searchParams.get('status');
    const carrierFilter = url.searchParams.get('carrier');

    if (orderIdFilter) conditions.push(eq(shipments.orderId, orderIdFilter));
    if (statusFilter)  conditions.push(eq(shipments.status, statusFilter as typeof shipments.status._));
    if (carrierFilter) conditions.push(eq(shipments.carrier, carrierFilter));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      db
        .select()
        .from(shipments)
        .where(where)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(shipments)
        .where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return ok(rows, { page, pageSize, total });
  },
});

// ---- GET /logistics/shipments/:id -------------------------------------------

registerRoute({
  method: 'GET',
  path: '/logistics/shipments/:id',
  auth: 'customer',
  description: 'Get a single shipment. Admin always allowed; customer must own the related order.',
  handler: async (_request, ctx, params) => {
    const db = getDb(ctx.env);

    const rows = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, params.id));

    const shipment = rows[0];
    if (!shipment) return notFound('Shipment not found');

    if (ctx.role !== 'admin') {
      // Verify ownership: shipment → order → customer → user
      const orderRows = await db
        .select({ customerId: orders.customerId })
        .from(orders)
        .where(eq(orders.id, shipment.orderId));

      const order = orderRows[0];
      if (!order) return notFound('Shipment not found');

      const customerRows = await db
        .select({ userId: customers.userId })
        .from(customers)
        .where(eq(customers.id, order.customerId));

      const customer = customerRows[0];
      if (!customer || customer.userId !== ctx.userId) {
        return forbidden('Access denied');
      }
    }

    return ok(shipment);
  },
});

// ---- POST /logistics/shipments ----------------------------------------------

registerRoute({
  method: 'POST',
  path: '/logistics/shipments',
  auth: 'admin',
  description: 'Create a new shipment for an order. Admin only.',
  handler: async (request, ctx) => {
    const parsed = await parseBody(request, CreateShipmentSchema);
    if (!parsed.ok) return parsed.response;

    const { orderId, carrier, trackingNumber, status = 'preparing' } = parsed.data;
    const db = getDb(ctx.env);

    // Verify order exists
    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));

    if (!orderRows[0]) return notFound('Order not found');

    // Check for duplicate tracking number
    const existingTrackingRows = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.trackingNumber, trackingNumber));

    if (existingTrackingRows[0]) return conflict('Tracking number already exists');

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Insert shipment
    const shipmentId = crypto.randomUUID();
    await db.insert(shipments).values({
      id: shipmentId,
      orderId,
      carrier,
      trackingNumber,
      status,
      shippedAt: status !== 'preparing' ? now : null,
    });

    // Auto-advance order to 'shipped' if not already in a late/terminal state
    const order = orderRows[0];
    if (!ORDER_ALREADY_SHIPPED_STATUSES.has(order.status)) {
      await db
        .update(orders)
        .set({ status: 'shipped', updatedAt: now })
        .where(eq(orders.id, orderId));
    }

    const newRows = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId));

    return created(newRows[0]);
  },
});

// ---- PUT /logistics/shipments/:id -------------------------------------------

registerRoute({
  method: 'PUT',
  path: '/logistics/shipments/:id',
  auth: 'admin',
  description: 'Update a shipment status or tracking info. Admin only.',
  handler: async (request, ctx, params) => {
    const parsed = await parseBody(request, UpdateShipmentSchema);
    if (!parsed.ok) return parsed.response;

    const db = getDb(ctx.env);

    const rows = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, params.id));

    const shipment = rows[0];
    if (!shipment) return notFound('Shipment not found');

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const updates: Partial<typeof shipments.$inferInsert> = {};

    if (parsed.data.trackingNumber !== undefined) {
      updates.trackingNumber = parsed.data.trackingNumber;
    }

    if (parsed.data.status !== undefined) {
      updates.status = parsed.data.status;

      if (parsed.data.status === 'delivered') {
        updates.deliveredAt = parsed.data.deliveredAt ?? now;

        // Auto-advance order to 'delivered'
        await db
          .update(orders)
          .set({ status: 'delivered', updatedAt: now })
          .where(eq(orders.id, shipment.orderId));
      } else if (parsed.data.status === 'in_transit' || parsed.data.status === 'out_for_delivery') {
        // Auto-advance order to 'shipped' if not already in a late/terminal state
        const orderRows = await db
          .select({ status: orders.status })
          .from(orders)
          .where(eq(orders.id, shipment.orderId));

        const order = orderRows[0];
        if (order && !ORDER_ALREADY_SHIPPED_STATUSES.has(order.status)) {
          await db
            .update(orders)
            .set({ status: 'shipped', updatedAt: now })
            .where(eq(orders.id, shipment.orderId));
        }
      }
    }

    if (parsed.data.deliveredAt !== undefined && parsed.data.status !== 'delivered') {
      updates.deliveredAt = parsed.data.deliveredAt;
    }

    await db
      .update(shipments)
      .set(updates)
      .where(eq(shipments.id, params.id));

    const updatedRows = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, params.id));

    return ok(updatedRows[0]);
  },
});

// ---- GET /logistics/tracking/:trackingNumber --------------------------------

registerRoute({
  method: 'GET',
  path: '/logistics/tracking/:trackingNumber',
  auth: 'none',
  description: 'Public tracking lookup. Returns only carrier, status, shippedAt, deliveredAt.',
  handler: async (_request, _ctx, params) => {
    const db = getDb(_ctx.env);

    const rows = await db
      .select({
        carrier:        shipments.carrier,
        status:         shipments.status,
        shippedAt:      shipments.shippedAt,
        deliveredAt:    shipments.deliveredAt,
      })
      .from(shipments)
      .where(eq(shipments.trackingNumber, params.trackingNumber));

    if (!rows[0]) return notFound('Tracking number not found');

    return ok(rows[0]);
  },
});
