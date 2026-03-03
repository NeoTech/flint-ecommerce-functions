/**
 * GET /admin/dashboard
 * Returns today's summary: ordersToday, revenueToday, newCustomersToday, lowStockProducts.
 */
import { sql, lt } from 'drizzle-orm';
import type { AppEnv } from '../../src/types.js';
import { getDb } from '../../src/db/client.js';
import { products, orders, customers } from '../../src/db/schema.js';
import { ok } from '../../src/types.js';

export async function handleDashboard(request: Request, env: AppEnv): Promise<Response> {
  const db = getDb(env);
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  // Orders today (created_at starts with today's date)
  const ordersRes = await db.select({ count: sql<number>`count(*)` }).from(orders)
    .where(sql`date(created_at) = ${today}`);
  const ordersToday = ordersRes[0]?.count ?? 0;

  // Revenue today (sum of total where status not cancelled/refunded)
  const revenueRes = await db.select({ sum: sql<number>`coalesce(sum(total), 0)` }).from(orders)
    .where(sql`date(created_at) = ${today} and status not in ('cancelled', 'refunded')`);
  const revenueToday = revenueRes[0]?.sum ?? 0;

  // New customers today
  const customersRes = await db.select({ count: sql<number>`count(*)` }).from(customers)
    .where(sql`date(created_at) = ${today}`);
  const newCustomersToday = customersRes[0]?.count ?? 0;

  // Low stock products (stock < 10)
  const lowStockRes = await db.select({ id: products.id, name: products.name, stock: products.stock })
    .from(products)
    .where(lt(products.stock, 10))
    .limit(20);

  return ok({
    ordersToday,
    revenueToday,
    newCustomersToday,
    lowStockProducts: lowStockRes,
  });
}
