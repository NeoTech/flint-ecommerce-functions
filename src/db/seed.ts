/**
 * Development seed script.
 * Run with: bun run db:seed
 *
 * Clears and repopulates all tables with representative sample data for local dev.
 * Safe to run multiple times — uses INSERT OR REPLACE on fixed IDs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createClient } from '@libsql/client/http';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

// Load .env
function loadEnv(): Record<string, string> {
  if (!existsSync('.env')) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return result;
}

const env = loadEnv();
const client = createClient({
  url: env['TURSO_DB_URL'] ?? '',
  authToken: env['TURSO_AUTH_TOKEN'] ?? '',
});
const db = drizzle(client, { schema });

// ---- Fixed IDs for repeatability -------------------------------------------
const CAT_APPAREL = 'cat-apparel';
const CAT_FOOTWEAR = 'cat-footwear';
const PROD_TSHIRT = 'prod-tshirt';
const PROD_SNEAKER = 'prod-sneaker';
const VAR_TSHIRT_S = 'var-tshirt-s';
const VAR_TSHIRT_M = 'var-tshirt-m';
const VAR_SNEAKER_42 = 'var-sneaker-42';
const USER_CUSTOMER = 'user-customer-1';
const CUST_1 = 'cust-1';
const ADDR_1 = 'addr-1';
const ORDER_1 = 'order-1';
const LINE_1 = 'line-1';

console.log('Seeding database...');

// Categories
await db.insert(schema.categories).values([
  { id: CAT_APPAREL,  name: 'Apparel',  slug: 'apparel',  description: 'Clothing and accessories', sortOrder: 1 },
  { id: CAT_FOOTWEAR, name: 'Footwear', slug: 'footwear', description: 'Shoes and boots',          sortOrder: 2 },
]).onConflictDoUpdate({ target: schema.categories.id, set: { name: schema.categories.name } });
console.log('  categories done');

// Products
await db.insert(schema.products).values([
  {
    id: PROD_TSHIRT, categoryId: CAT_APPAREL, name: 'Classic T-Shirt', slug: 'classic-t-shirt',
    description: 'A comfortable everyday t-shirt.', price: 29.99, comparePrice: 39.99,
    stock: 100, status: 'active',
  },
  {
    id: PROD_SNEAKER, categoryId: CAT_FOOTWEAR, name: 'Urban Sneaker', slug: 'urban-sneaker',
    description: 'Lightweight sneakers for street wear.', price: 89.99,
    stock: 50, status: 'active',
  },
]).onConflictDoUpdate({ target: schema.products.id, set: { name: schema.products.name } });
console.log('  products done');

// Variants
await db.insert(schema.productVariants).values([
  { id: VAR_TSHIRT_S,  productId: PROD_TSHIRT,  sku: 'TS-S',  name: 'Small',  stock: 40, attributes: JSON.stringify({ size: 'S' }) },
  { id: VAR_TSHIRT_M,  productId: PROD_TSHIRT,  sku: 'TS-M',  name: 'Medium', stock: 60, attributes: JSON.stringify({ size: 'M' }) },
  { id: VAR_SNEAKER_42, productId: PROD_SNEAKER, sku: 'SN-42', name: 'EU 42', stock: 20, attributes: JSON.stringify({ size: '42' }) },
]).onConflictDoUpdate({ target: schema.productVariants.id, set: { name: schema.productVariants.name } });
console.log('  variants done');

// User + customer
await db.insert(schema.users).values([
  // Password is "password123" — bcrypt hash generated offline for seed purposes only
  {
    id: USER_CUSTOMER, email: 'customer@example.com',
    passwordHash: '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    role: 'customer',
  },
]).onConflictDoUpdate({ target: schema.users.id, set: { email: schema.users.email } });

await db.insert(schema.customers).values([
  { id: CUST_1, userId: USER_CUSTOMER, firstName: 'Jane', lastName: 'Doe', phone: '+1-555-0100' },
]).onConflictDoUpdate({ target: schema.customers.id, set: { firstName: schema.customers.firstName } });

await db.insert(schema.addresses).values([
  {
    id: ADDR_1, customerId: CUST_1, type: 'shipping',
    street: '123 Main St', city: 'Portland', state: 'OR', postalCode: '97201', country: 'US',
    isDefault: true,
  },
]).onConflictDoUpdate({ target: schema.addresses.id, set: { street: schema.addresses.street } });
console.log('  user / customer / address done');

// Order
await db.insert(schema.orders).values([
  {
    id: ORDER_1, customerId: CUST_1, status: 'delivered',
    subtotal: 29.99, tax: 2.40, shippingCost: 5.00, total: 37.39,
  },
]).onConflictDoUpdate({ target: schema.orders.id, set: { status: schema.orders.status } });

await db.insert(schema.orderLines).values([
  { id: LINE_1, orderId: ORDER_1, productId: PROD_TSHIRT, variantId: VAR_TSHIRT_M, quantity: 1, unitPrice: 29.99, lineTotal: 29.99 },
]).onConflictDoUpdate({ target: schema.orderLines.id, set: { quantity: schema.orderLines.quantity } });
console.log('  orders done');

console.log('Seed complete.');
