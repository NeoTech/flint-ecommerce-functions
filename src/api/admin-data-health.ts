/**
 * Admin data-health routes.
 *
 * GET  /admin/data-health            — diagnostic snapshot (read-only)
 * POST /admin/data-health?action=... — mutation actions
 *
 * Actions:
 *   purge-orphans          — delete orphan order_lines, shipments, unreferenced addresses, empty customers
 *   dedupe-addresses       — remove exact-duplicate address rows, keep order-referenced row
 *   mark-webhook-processed — insert eventId into processed_webhook_events to stop Stripe retry 500s
 *   rollback-order         — delete order + lines + processed_webhook_events row by paymentIntentId
 *
 * All routes require admin auth. Designed to be consumed by an admin UI.
 */
import { registerRoute } from '../router.js';
import { getDb } from '../db/client.js';
import { badRequest, ok } from '../types.js';

// ---- shared raw-client type (mirrors usage in admin-sync.ts) ----------------

type Row = Record<string, unknown>;
type RawResult = { rows: unknown[][] | Row[] };
type RawClient = {
  execute: (input: { sql: string; args?: unknown[] } | string) => Promise<RawResult>;
};

function raw(env: Parameters<typeof getDb>[0]): RawClient {
  const db = getDb(env);
  return (db as unknown as { $client: RawClient }).$client;
}

// ---- helpers ----------------------------------------------------------------

function scalarNum(result: RawResult): number {
  const row = result.rows[0];
  if (!row) return 0;
  if (Array.isArray(row)) return Number(row[0] ?? 0);
  const vals = Object.values(row as Row);
  return Number(vals[0] ?? 0);
}

function rowIds(result: RawResult): string[] {
  return result.rows.map((r) => {
    if (Array.isArray(r)) return String(r[0] ?? '');
    return String((r as Row).id ?? Object.values(r as Row)[0] ?? '');
  }).filter(Boolean);
}

// ---- GET /admin/data-health -------------------------------------------------

registerRoute({
  method: 'GET',
  path: '/admin/data-health',
  auth: 'admin',
  description: 'Read-only diagnostic snapshot: orphan counts, duplicate addresses, stuck webhook orders.',
  handler: async (_request, ctx) => {
    const client = raw(ctx.env);

    const [
      orphanOrderLines,
      orphanShipments,
      ordersWithMissingAddress,
      orphanAddresses,
      dupAddressGroups,
      stuckWebhookOrders,
      tableCounts,
    ] = await Promise.all([
      // order_lines whose order no longer exists
      client.execute("SELECT COUNT(*) AS c FROM order_lines l WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = l.order_id)"),
      // shipments whose order no longer exists
      client.execute("SELECT COUNT(*) AS c FROM shipments s WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = s.order_id)"),
      // orders referencing a missing address
      client.execute("SELECT COUNT(*) AS c FROM orders o WHERE (o.shipping_address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.id = o.shipping_address_id)) OR (o.billing_address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM addresses a2 WHERE a2.id = o.billing_address_id))"),
      // addresses not referenced by any order
      client.execute("SELECT id FROM addresses a WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.shipping_address_id = a.id OR o.billing_address_id = a.id)"),
      // duplicate address groups (same customer + type + street + city + state + postal + country)
      client.execute("SELECT customer_id, type, street, city, state, postal_code, country, COUNT(*) AS c FROM addresses GROUP BY customer_id, type, street, city, state, postal_code, country HAVING COUNT(*) > 1 ORDER BY c DESC"),
      // stripe orders whose payment intent has no processed_webhook_events row
      client.execute("SELECT id, stripe_payment_intent_id, stripe_session_id, total FROM orders WHERE source = 'stripe' AND stripe_payment_intent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM processed_webhook_events e WHERE e.stripe_event_id LIKE '%' || stripe_payment_intent_id || '%') ORDER BY created_at DESC LIMIT 50"),
      // table row counts
      Promise.all([
        client.execute("SELECT COUNT(*) AS c FROM users"),
        client.execute("SELECT COUNT(*) AS c FROM customers"),
        client.execute("SELECT COUNT(*) AS c FROM addresses"),
        client.execute("SELECT COUNT(*) AS c FROM orders"),
        client.execute("SELECT COUNT(*) AS c FROM order_lines"),
        client.execute("SELECT COUNT(*) AS c FROM processed_webhook_events"),
        client.execute("SELECT COUNT(*) AS c FROM stripe_order_import_staging"),
      ]),
    ]);

    const dupGroups = dupAddressGroups.rows.map((r) => {
      if (Array.isArray(r)) return { customerId: r[0], type: r[1], street: r[2], city: r[3], state: r[4], postalCode: r[5], country: r[6], count: Number(r[7]) };
      const row = r as Row;
      return { customerId: row.customer_id, type: row.type, street: row.street, city: row.city, state: row.state, postalCode: row.postal_code, country: row.country, count: Number(row.c) };
    });

    const stuckOrders = stuckWebhookOrders.rows.map((r) => {
      if (Array.isArray(r)) return { orderId: r[0], paymentIntentId: r[1], sessionId: r[2], total: r[3] };
      const row = r as Row;
      return { orderId: row.id, paymentIntentId: row.stripe_payment_intent_id, sessionId: row.stripe_session_id, total: row.total };
    });

    const [users, customers, addresses, orders, orderLines, processedWhEvents, staging] = tableCounts as RawResult[];

    return ok({
      tableCounts: {
        users: scalarNum(users),
        customers: scalarNum(customers),
        addresses: scalarNum(addresses),
        orders: scalarNum(orders),
        orderLines: scalarNum(orderLines),
        processedWebhookEvents: scalarNum(processedWhEvents),
        stripeOrderImportStaging: scalarNum(staging),
      },
      orphans: {
        orderLinesNoOrder: scalarNum(orphanOrderLines),
        shipmentsNoOrder: scalarNum(orphanShipments),
        ordersWithMissingAddress: scalarNum(ordersWithMissingAddress),
        addressesUnreferencedByOrders: {
          count: orphanAddresses.rows.length,
          ids: rowIds(orphanAddresses),
        },
      },
      duplicates: {
        addressGroups: {
          count: dupGroups.length,
          groups: dupGroups,
        },
      },
      webhooks: {
        stuckOrders: {
          count: stuckOrders.length,
          note: 'Orders imported via admin sync that have no processed_webhook_events row. Stripe retries will 500 until marked processed or order is rolled back.',
          items: stuckOrders,
        },
      },
    });
  },
});

// ---- POST /admin/data-health ------------------------------------------------

registerRoute({
  method: 'POST',
  path: '/admin/data-health',
  auth: 'admin',
  description: 'Mutate data-health issues. Use ?action= to specify the operation.',
  queryParams: ['action', 'eventId', 'paymentIntentId'],
  handler: async (request, ctx) => {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (!action) {
      return badRequest('Missing required query param: action. Valid values: purge-orphans, dedupe-addresses, mark-webhook-processed, rollback-order');
    }

    const client = raw(ctx.env);

    // ------------------------------------------------------------------ purge-orphans
    if (action === 'purge-orphans') {
      // Collect IDs before deletion so we can report counts accurately.
      const [orphanLines, orphanShips, ordsMissAddr, orphanAddrs, emptyCusts] = await Promise.all([
        client.execute("SELECT id FROM order_lines l WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = l.order_id)"),
        client.execute("SELECT id FROM shipments s WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = s.order_id)"),
        client.execute("SELECT id FROM orders o WHERE (o.shipping_address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.id = o.shipping_address_id)) OR (o.billing_address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM addresses a2 WHERE a2.id = o.billing_address_id))"),
        client.execute("SELECT id FROM addresses a WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.shipping_address_id = a.id OR o.billing_address_id = a.id)"),
        client.execute("SELECT id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.customer_id = c.id) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.role = 'admin')"),
      ]);

      const deleted = { orderLines: 0, shipments: 0, orders: 0, addresses: 0, customers: 0 };

      // FK-safe deletion order: lines first, then orders, then addresses, then customers
      for (const id of rowIds(orphanLines)) {
        await client.execute({ sql: 'DELETE FROM order_lines WHERE id = ?', args: [id] });
        deleted.orderLines++;
      }
      for (const id of rowIds(orphanShips)) {
        await client.execute({ sql: 'DELETE FROM shipments WHERE id = ?', args: [id] });
        deleted.shipments++;
      }
      for (const id of rowIds(ordsMissAddr)) {
        // Must delete order_lines for these orders first
        await client.execute({ sql: 'DELETE FROM order_lines WHERE order_id = ?', args: [id] });
        await client.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
        deleted.orders++;
      }
      for (const id of rowIds(orphanAddrs)) {
        await client.execute({ sql: 'DELETE FROM addresses WHERE id = ?', args: [id] });
        deleted.addresses++;
      }
      for (const id of rowIds(emptyCusts)) {
        await client.execute({ sql: 'DELETE FROM customers WHERE id = ?', args: [id] });
        deleted.customers++;
      }

      return ok({ action, deleted });
    }

    // ------------------------------------------------------------------ dedupe-addresses
    if (action === 'dedupe-addresses') {
      const allAddresses = await client.execute('SELECT id, customer_id, type, street, city, state, postal_code, country FROM addresses');
      const referenced = await client.execute('SELECT DISTINCT shipping_address_id AS id FROM orders WHERE shipping_address_id IS NOT NULL UNION SELECT DISTINCT billing_address_id AS id FROM orders WHERE billing_address_id IS NOT NULL');

      const referencedSet = new Set(rowIds(referenced));
      const groups = new Map<string, string[]>();

      for (const r of allAddresses.rows) {
        let id: string, customerId: unknown, type: unknown, street: unknown, city: unknown, state: unknown, postalCode: unknown, country: unknown;
        if (Array.isArray(r)) {
          [id, customerId, type, street, city, state, postalCode, country] = r.map(String);
        } else {
          const row = r as Row;
          id = String(row.id ?? '');
          customerId = row.customer_id; type = row.type; street = row.street; city = row.city;
          state = row.state; postalCode = row.postal_code; country = row.country;
        }
        const key = [customerId, type, street, city, state ?? '', postalCode, country].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(id);
      }

      const toDelete: string[] = [];
      for (const ids of groups.values()) {
        if (ids.length <= 1) continue;
        const referencedInGroup = ids.filter(id => referencedSet.has(id));
        const keepId = referencedInGroup.length > 0
          ? referencedInGroup[0]
          : ids.slice().sort()[0];
        for (const id of ids) {
          if (id !== keepId && !referencedSet.has(id)) toDelete.push(id);
        }
      }

      for (const id of toDelete) {
        await client.execute({ sql: 'DELETE FROM addresses WHERE id = ?', args: [id] });
      }

      return ok({ action, deleted: { addresses: toDelete.length }, deletedIds: toDelete });
    }

    // ------------------------------------------------------------------ mark-webhook-processed
    if (action === 'mark-webhook-processed') {
      const eventId = url.searchParams.get('eventId');
      if (!eventId) return badRequest('Missing required query param: eventId');

      const existing = await client.execute({ sql: 'SELECT stripe_event_id FROM processed_webhook_events WHERE stripe_event_id = ?', args: [eventId] });

      if (existing.rows.length > 0) {
        return ok({ action, eventId, alreadyPresent: true, inserted: false });
      }

      await client.execute({ sql: 'INSERT INTO processed_webhook_events (stripe_event_id) VALUES (?)', args: [eventId] });
      return ok({ action, eventId, alreadyPresent: false, inserted: true });
    }

    // ------------------------------------------------------------------ rollback-order
    if (action === 'rollback-order') {
      const paymentIntentId = url.searchParams.get('paymentIntentId');
      if (!paymentIntentId) return badRequest('Missing required query param: paymentIntentId');

      const orderRow = await client.execute({ sql: 'SELECT id, stripe_session_id FROM orders WHERE stripe_payment_intent_id = ?', args: [paymentIntentId] });

      if (orderRow.rows.length === 0) {
        return badRequest(`No order found for paymentIntentId: ${paymentIntentId}`);
      }

      const orderId = Array.isArray(orderRow.rows[0])
        ? String(orderRow.rows[0][0])
        : String((orderRow.rows[0] as Row).id);

      // Delete in FK-safe order: lines → order → processed event
      await client.execute({ sql: 'DELETE FROM order_lines WHERE order_id = ?', args: [orderId] });
      await client.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [orderId] });

      // Also remove from staging so it can be re-staged
      await client.execute({ sql: "DELETE FROM stripe_order_import_staging WHERE stripe_payment_intent_id = ?", args: [paymentIntentId] });

      // Remove processed webhook event if present (allows Stripe to resend successfully)
      const evtDelete = await client.execute({ sql: 'DELETE FROM processed_webhook_events WHERE stripe_event_id IN (SELECT stripe_event_id FROM processed_webhook_events WHERE stripe_event_id LIKE ?)', args: [`%${paymentIntentId}%`] });
      const evtRows = (evtDelete as unknown as { rowsAffected?: number }).rowsAffected ?? 0;

      return ok({
        action,
        paymentIntentId,
        orderId,
        deleted: {
          order: true,
          orderLines: true,
          stagingRow: true,
          processedWebhookEvent: evtRows > 0,
        },
        note: 'Order and lines removed. You may now resend the Stripe webhook event to recreate this order.',
      });
    }

    return badRequest(`Unknown action: "${action}". Valid values: purge-orphans, dedupe-addresses, mark-webhook-processed, rollback-order`);
  },
});
