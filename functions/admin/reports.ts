/**
 * Admin report handlers.
 *
 * GET /admin/reports/sales     — daily revenue for a date range
 * GET /admin/reports/inventory — all products with stock + variants
 * GET /admin/reports/customers — customer acquisition and activity summary
 */
import { sql, desc } from 'drizzle-orm';
import type { AppEnv } from '../../src/types.js';
import { getDb } from '../../src/db/client.js';
import { orders, products, productVariants, customers, users } from '../../src/db/schema.js';
import { ok, badRequest } from '../../src/types.js';

export async function handleSalesReport(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');

  if (!from || !to) return badRequest('from and to query params are required (YYYY-MM-DD)');

  const db = getDb(env);

  // Daily revenue totals
  const daily = await db.select({
    date:        sql<string>`date(created_at)`,
    totalOrders: sql<number>`count(*)`,
    revenue:     sql<number>`coalesce(sum(total), 0)`,
  })
    .from(orders)
    .where(sql`date(created_at) between ${from} and ${to} and status not in ('cancelled', 'refunded')`)
    .groupBy(sql`date(created_at)`)
    .orderBy(sql`date(created_at)`);

  const totalOrders = daily.reduce((s, r) => s + r.totalOrders, 0);
  const totalRevenue = daily.reduce((s, r) => s + r.revenue, 0);
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  return ok({ from, to, totalOrders, totalRevenue, avgOrderValue, daily });
}

export async function handleInventoryReport(request: Request, env: AppEnv): Promise<Response> {
  const db = getDb(env);

  const productRows = await db.select().from(products).orderBy(products.name);
  const variantRows = await db.select().from(productVariants);

  const result = productRows.map(p => ({
    ...p,
    variants: variantRows.filter(v => v.productId === p.id),
  }));

  return ok(result);
}

export async function handleCustomersReport(request: Request, env: AppEnv): Promise<Response> {
  const db = getDb(env);

  // New customers per day (last 30 days)
  const newPerDay = await db.select({
    date:  sql<string>`date(created_at)`,
    count: sql<number>`count(*)`,
  })
    .from(customers)
    .where(sql`date(created_at) >= date('now', '-30 days')`)
    .groupBy(sql`date(created_at)`)
    .orderBy(sql`date(created_at)`);

  // Total active
  const activeRes = await db.select({ count: sql<number>`count(*)` }).from(users)
    .where(sql`role = 'customer'`);
  const totalActive = activeRes[0]?.count ?? 0;

  // Total inactive
  const inactiveRes = await db.select({ count: sql<number>`count(*)` }).from(users)
    .where(sql`role = 'inactive'`);
  const totalInactive = inactiveRes[0]?.count ?? 0;

  return ok({ totalActive, totalInactive, newPerDay });
}
