# Agent Lessons

## Do not overcomplicate things

**Lesson (general):** Spent multiple turns fighting stripe mock hoisting, tmp file redirects, and class-based mock gymnastics when the right call was to just run `bun run test` and move on. Over-engineered the verification step.

**Rule:** If a verification step is taking more than one attempt, stop and do the simplest possible thing. A plain `bun run test` in a background terminal is enough. Do not chain, pipe, redirect, or write clever workarounds — just run the command.

## Never touch git — no commits, no staging, no resets

**Lesson:** The agent ran `git add`, `git reset`, and `git diff --cached` without being asked, interfering with the user's own commit workflow.

**Rule:** NEVER run any git command that modifies repository state (`git add`, `git commit`, `git reset`, `git stash`, `git checkout`, `git rm`, etc.) unless the user explicitly asks for it. Read-only git commands (`git log`, `git diff`, `git status`) are acceptable for research. The user owns their git history.

## Subagents must exit the shell after their last command

## Never use `sessions.retrieve + expand` for line items in CF Workers

**Lesson (LOPC-14):** Used `stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'line_items.data.price.product'] })` to get line items for fulfillment. This is a 4-level deep expand (the documented maximum), fans out to fetch every product for every line item, and times out on Cloudflare Workers. The Stripe SDK retries twice then throws `StripeConnectionError: An error occurred with our connection to Stripe. Request was retried 2 times.` — confirmed by stripe/stripe-node#2493 which reproduces with this exact call.

Also a correctness bug: `expand: ['line_items']` on `retrieve` only returns "the first handful" of line items per Stripe docs, silently truncating orders with many items.

**Rule:** When retrieving line items for a completed Checkout Session in CF Workers, always use the dedicated `listLineItems` endpoint:
```typescript
const lineItemsPage = await stripe.checkout.sessions.listLineItems(session.id, {
  limit: 100,
  expand: ['data.price.product'],
});
```
This is 3 levels deep (not 4), paginated, and the Stripe-recommended pattern for post-session fulfillment. The session object passed to the fulfillment function already has all other needed fields — no second `retrieve` is needed.

**Rule:** When batching many Stripe API calls in a CF Workers admin sync loop, make individual session failures resilient (skip + log + count) rather than aborting the whole sync, so a single bad session does not block importing all other historical orders.

**Lesson (LOPC-06 through LOPC-12):** Each subagent left its bash instance open after finishing, resulting in 20+ lingering Git for Windows processes that the user had to manually kill.

**Rule:** The last terminal command a subagent runs must always be `exit`. After the final `bun test` or any cleanup step, call `run_in_terminal` with `command: "exit"` to close the shell. Never leave a subagent's bash instance open.
## SQLite FK chain blocks naive DELETE — always delete in dependency order

**Lesson (LOPC-15):** The LOPC schema has this FK chain:
- `order_lines` → `orders`
- `orders` → `customers` + `addresses` (no ON DELETE CASCADE)
- `addresses` → `customers` (cascade)
- `customers` → `users` (cascade)

Trying to `DELETE FROM users` or `DELETE FROM customers` fails silently or throws because `orders.customerId` has no cascade. SQLite does not support `TRUNCATE`. Disabling FKs with `PRAGMA foreign_keys=OFF` is session-scoped and unreliable in LibSQL/Turso.

**Rule:** Always delete in this order: `processed_webhook_events` → `order_lines` → `orders` → `addresses` → `customers` → `users` (non-admin). Use `scripts/cleanup-db.ts` for manual resets. Never try to delete parents before children.

## Use Stripe charges as the admin sync source of truth for orders

**Lesson (LOPC-15):** Using `checkout.sessions.list` as the historical order source is fragile: sessions can expire, miss customer context, or be incomplete. The Stripe "Transactions" view (charges) is the canonical record of money movement and is simpler to work with.

**Rule:** For admin sync order import, iterate `stripe.charges.list` and key idempotency on `stripePaymentIntentId` in the `orders` table — no `processedWebhookEvents` involvement. This naturally covers both succeeded and refunded transactions. To get line items, call `sessions.list({ payment_intent: piId, limit: 1 })` to find the session, then `listLineItems` as normal. The webhook real-time fulfillment (`stripe-fulfill.ts`) keeps its own session-based idempotency path unchanged.

## Keep fixes surgical to avoid regressions

**Lesson:** Broad refactors across working sync paths caused repeated regressions and made debugging harder.

**Rule:** For recurring production bugs, implement in minimal slices: first add deterministic verification, then apply one narrowly scoped fix at a time with no unrelated behavior changes. Validate after each slice before touching another area.

## Stripe import reset/resync runbook (production)

**Lesson:** A full `finalize` call with larger `batchSize` can intermittently fail with `INTERNAL_ERROR` on production-scale backfills, leaving rows in `processing`/`failed` states even when stage succeeded.

**Rule:** For production resyncs, use a two-step recovery-safe flow:
1. Selectively reset only Stripe-import artifacts (`orders WHERE source='stripe'`, staging rows, `sync_cursors` row, synthetic `processed_webhook_events` entries).
2. Run `phase=stage` once.
3. If `phase=finalize&batchSize=10` fails, immediately fall back to draining with `batchSize=1` in a loop and clear stale claims (`status='processing'` -> releasable) before retrying.
4. Verify completion with `phase=status` (`remainingToFinalize=0`) and query imported order dates to confirm historical timestamps are preserved.