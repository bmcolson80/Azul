/**
 * AZUL — Notification gating regression tests
 *
 * Covers three easy-to-get-backwards pieces of logic added for the
 * email-fallback / active-session-suppression feature:
 *  1. isActivelyViewing() — must suppress only when a matching userId+roomCode
 *     connection is visible, not merely connected.
 *  2. shouldSendTurnEmail() debounce — must block a second immediate send for
 *     the same (userId, roomCode) but not affect other rooms.
 *  3. notifyPlayer()'s active-viewing gate wired ahead of the push/email
 *     decision — a viewing user must get no email-debounce side effect at all.
 *
 * Run with: node --test tests/notifications.test.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

process.env.NODE_ENV             = 'test';
process.env.DB_PATH              = './tests/notifications-test.db';
process.env.JWT_SECRET           = 'test-secret';
process.env.INTERNAL_SYNC_SECRET = 'test-internal-secret';
process.env.HUB_URL              = 'http://127.0.0.1:1'; // unreachable on purpose

const TEST_PORT = 3096;

const { server, clients, isActivelyViewing, notifyPlayer, shouldSendTurnEmail, turnEmailLastSent } = await import('../server.js');
const { initDB, createUser, savePushSubscription } = await import('../db.js');

before(async () => {
  if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
  await initDB();
  await new Promise(resolve => server.listen(TEST_PORT, resolve));
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_PATH); } catch { /* ignore */ }
});

describe('isActivelyViewing', () => {
  test('true when a client for that userId+roomCode is visible', () => {
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'ROOMA', playerId: 'p1', userId: 'user-1', visible: true });
    assert.equal(isActivelyViewing('user-1', 'ROOMA'), true);
    clients.delete(fakeWs);
  });

  test('false when the matching client is connected but backgrounded', () => {
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'ROOMB', playerId: 'p1', userId: 'user-2', visible: false });
    assert.equal(isActivelyViewing('user-2', 'ROOMB'), false);
    clients.delete(fakeWs);
  });

  test('false when the visible client is scoped to a different room', () => {
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'ROOMC', playerId: 'p1', userId: 'user-3', visible: true });
    assert.equal(isActivelyViewing('user-3', 'ROOMD'), false);
    clients.delete(fakeWs);
  });

  test('false when there is no connection at all for that user', () => {
    assert.equal(isActivelyViewing('nobody-connected', 'ROOME'), false);
  });
});

describe('shouldSendTurnEmail debounce', () => {
  test('allows the first send, blocks an immediate repeat for the same room', () => {
    const userId = 'debounce-user';
    const roomCode = 'DBROOM';
    assert.equal(shouldSendTurnEmail(userId, roomCode), true);
    assert.equal(shouldSendTurnEmail(userId, roomCode), false);
  });

  test('does not block a different room for the same user', () => {
    const userId = 'debounce-user-2';
    assert.equal(shouldSendTurnEmail(userId, 'ROOM-X'), true);
    assert.equal(shouldSendTurnEmail(userId, 'ROOM-Y'), true);
  });
});

describe('notifyPlayer active-viewing gate', () => {
  test('a viewing user gets no email-debounce side effect (fully suppressed)', async () => {
    const userId = 'viewing-user';
    createUser({ id: userId, email: 'viewing@example.com', name: 'Viewer', password: 'x' });
    const fakeWs = {};
    clients.set(fakeWs, { roomCode: 'VIEWROOM', playerId: 'p1', userId, visible: true });

    await notifyPlayer(userId, null, { title: 'Your turn!', body: 'Go', roomCode: 'VIEWROOM', kind: 'turn' });

    assert.equal(turnEmailLastSent.has(`${userId}:VIEWROOM`), false);
    clients.delete(fakeWs);
  });

  test('a non-viewing user with no active push gets an email-debounce marker set', async () => {
    const userId = 'away-user';
    createUser({ id: userId, email: 'away@example.com', name: 'Away', password: 'x' });
    // No clients entry at all for this user — not connected, so not viewing.

    await notifyPlayer(userId, null, { title: 'Your turn!', body: 'Go', roomCode: 'AWAYROOM', kind: 'turn' });

    assert.equal(turnEmailLastSent.has(`${userId}:AWAYROOM`), true);
  });

  test('a non-viewing user WITH an active push subscription gets no email-debounce marker (push, not email)', async () => {
    const userId = 'pushed-user';
    createUser({ id: userId, email: 'pushed@example.com', name: 'Pushed', password: 'x' });
    savePushSubscription({
      id: 'sub-1', userId,
      endpoint: 'https://example.com/push/1',
      keys: { p256dh: 'fake', auth: 'fake' },
    });

    await notifyPlayer(userId, null, { title: 'Your turn!', body: 'Go', roomCode: 'PUSHROOM', kind: 'turn' });

    assert.equal(turnEmailLastSent.has(`${userId}:PUSHROOM`), false);
  });
});
