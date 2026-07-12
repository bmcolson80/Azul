/**
 * AZUL — Account sync regression tests
 *
 * Proves register/login never depend on the hub being reachable (the exact
 * failure mode that caused the prior production incident), and that the
 * internal sync-account endpoint correctly replicates/rejects.
 *
 * Run with: npm run test:account-sync
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

process.env.NODE_ENV           = 'test';
process.env.DB_PATH            = './tests/account-sync-test.db';
process.env.JWT_SECRET         = 'test-secret';
process.env.INTERNAL_SYNC_SECRET = 'test-internal-secret';
process.env.HUB_URL            = 'http://127.0.0.1:1'; // unreachable on purpose

const TEST_PORT = 3097;
const BASE_URL  = `http://localhost:${TEST_PORT}`;

const { app, server } = await import('../server.js');
const { initDB } = await import('../db.js');

before(async () => {
  if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
  await initDB();
  await new Promise(resolve => server.listen(TEST_PORT, resolve));
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* ignore */ }
});

describe('Register/login survive an unreachable hub', () => {
  test('register succeeds even though HUB_URL is unreachable', async () => {
    const email = `sync-${Date.now()}@example.com`;
    const res = await fetch(`${BASE_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Sync Test', password: 'password123' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user.email, email);
  });

  test('login succeeds locally, independent of the hub', async () => {
    const email = `sync-login-${Date.now()}@example.com`;
    await fetch(`${BASE_URL}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Login Test', password: 'password123' }),
    });
    const res = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    assert.equal(res.status, 200);
  });
});

describe('Internal sync-account endpoint', () => {
  test('rejects requests without the correct internal secret', async () => {
    const res = await fetch(`${BASE_URL}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', name: 'X', passwordHash: 'hash' }),
    });
    assert.equal(res.status, 403);
  });

  test('creates a new local account when none exists for that email', async () => {
    const email = `synced-${Date.now()}@example.com`;
    const res = await fetch(`${BASE_URL}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-internal-secret' },
      body: JSON.stringify({ email, name: 'Synced User', passwordHash: '$2a$10$fakehashfakehashfakehashfa', sourceGameId: 'mahjong' }),
    });
    assert.equal(res.status, 200);
  });

  test('updates the password hash for an account that already exists', async () => {
    const email = `existing-${Date.now()}@example.com`;
    await fetch(`${BASE_URL}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Existing', password: 'originalpass' }),
    });
    const syncRes = await fetch(`${BASE_URL}/api/internal/sync-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': 'test-internal-secret' },
      body: JSON.stringify({ email, name: 'Existing', passwordHash: '$2a$10$fakehashfakehashfakehashfa', sourceGameId: 'mahjong' }),
    });
    assert.equal(syncRes.status, 200);

    // Original password should no longer work — it was overwritten by the sync.
    const loginRes = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'originalpass' }),
    });
    assert.equal(loginRes.status, 401);
  });
});
