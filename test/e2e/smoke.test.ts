/**
 * E2E smoke tests — require wrangler dev to be running.
 *
 * Run with: bun run e2e
 * (NOT included in plain `bun test` — guarded by E2E=1 env var)
 *
 * Prerequisite: wrangler is configured and .env is present.
 * The test starts wrangler dev as a subprocess and polls until ready.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'bun';
import type { Subprocess } from 'bun';

// Guard: skip entirely when not running in e2e mode.
// `bun run e2e` sets E2E=1; plain `bun test` does not.
const RUN_E2E = process.env.E2E === '1';

const PORT = 8788;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

let wranglerProcess: Subprocess | null = null;

async function waitForWrangler(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`wrangler dev did not start within ${STARTUP_TIMEOUT_MS}ms`);
}

if (RUN_E2E) {
  beforeAll(async () => {
    wranglerProcess = spawn({
      cmd: ['bunx', 'wrangler', 'dev', '--port', String(PORT), '--local'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForWrangler();
  });

  afterAll(() => {
    wranglerProcess?.kill();
  });
}

describe.if(RUN_E2E)('E2E smoke tests', () => {
  it('GET / returns 200 with route manifest', async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe('LOPC API');
    expect(body.data.routes).toBeArray();
    expect(body.data.routes.length).toBeGreaterThan(0);
  });

  it('POST /auth/register creates an account', async () => {
    const unique = `smoke-${Date.now()}@test.com`;
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: unique,
        password: 'smoketest123',
        firstName: 'Smoke',
        lastName: 'Test',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.accessToken).toBeString();
    expect(body.data.refreshToken).toBeString();
  });

  it('GET /products returns 200', async () => {
    const res = await fetch(`${BASE_URL}/products`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toBeArray();
  });
});
