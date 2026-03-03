/**
 * Stock reservation helpers used in order creation and cancellation.
 */
import { eq, sql } from 'drizzle-orm';
import { products, productVariants } from '../db/schema.js';

export interface StockLine {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

/**
 * Decrement stock for each line. No validation — caller must validate first.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reserveStock(db: any, lines: StockLine[]): Promise<void> {
  for (const line of lines) {
    if (line.variantId) {
      await db
        .update(productVariants)
        .set({ stock: sql`stock - ${line.quantity}` })
        .where(eq(productVariants.id, line.variantId));
    } else {
      await db
        .update(products)
        .set({ stock: sql`stock - ${line.quantity}`, updatedAt: new Date().toISOString() })
        .where(eq(products.id, line.productId));
    }
  }
}

/**
 * Restore stock on cancellation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function releaseStock(db: any, lines: StockLine[]): Promise<void> {
  for (const line of lines) {
    if (line.variantId) {
      await db
        .update(productVariants)
        .set({ stock: sql`stock + ${line.quantity}` })
        .where(eq(productVariants.id, line.variantId));
    } else {
      await db
        .update(products)
        .set({ stock: sql`stock + ${line.quantity}`, updatedAt: new Date().toISOString() })
        .where(eq(products.id, line.productId));
    }
  }
}
