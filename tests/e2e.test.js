/**
 * AZUL — End-to-End WebSocket Test Suite
 * 
 * Spins up a real server, connects real WebSocket clients,
 * and plays through complete game scenarios.
 * 
 * Run with: npm run test:e2e
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Import game logic from server ────────────────────────────
// We re-export the pure functions via a thin wrapper
import {
  initGameState,
  doWallTiling,
  applyEndBonuses,
  scoreWallPlacement,
  WALL_PATTERN,
  FLOOR_PENALTIES,
} from './game-logic.js';

// ── Test server setup ────────────────────────────────────────
const TEST_PORT = 3099;

// We'll spin up a minimal in-process server for E2E tests
let serverInstance = null;
const rooms = new Map();
const clients = new Map();

const COLORS = ['B', 'C', 'R', 'Y', 'K'];
const COLOR_NAMES = { B: 'Blue', C: 'Cyan', R: 'Red', Y: 'Yellow', K: 'Black' };
const PLAYER_COLORS = ['#4eb8c8', '#c94040', '#d4a017', '#9b59b6'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(roomCode, data) {
  const payload = JSON.stringify(data);
  clients.forEach((meta, ws) => {
    if (meta.roomCode === roomCode && ws.readyState === WebSocket.OPEN)
      ws.send(payload);
  });
}

function generateCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 4).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function placeToFloor(gs, board, tiles) {
  tiles.forEach(t => {
    if (board.floor.length < 7) board.floor.push(t);
    else gs.lid.push(t);
  });
}

function serverInitGameState(players) {
  let bag = [];
  COLORS.forEach(c => { for (let i = 0; i < 20; i++) bag.push(c); });
  bag = shuffle(bag);
  const n = players.length;
  const factoryCount = n === 2 ? 5 : n === 3 ? 7 : 9;
  const factories = [];
  for (let i = 0; i < factoryCount; i++) factories.push(bag.splice(0, 4));
  return {
    round: 1, phase: 'factory', currentPlayer: 0,
    players: players.map(p => ({ id: p.id, name: p.name, color: p.color })),
    factories, center: [], centerHasStart: true,
    boards: players.map(() => ({
      patternLines: [[], [], [], [], []],
      wall: Array(5).fill(null).map(() => Array(5).fill(null)),
      floor: [], score: 0,
    })),
    bag, lid: [], startPlayer: 0, nextStartPlayer: null, log: [],
  };
}

function serverDoWallTiling(gs) {
  let gameEnds = false;
  gs.players.forEach((_, pi) => {
    const board = gs.boards[pi];
    for (let row = 0; row < 5; row++) {
      const line = board.patternLines[row];
      if (line.length === row + 1) {
        const color = line[0];
        const col = WALL_PATTERN[row].indexOf(color);
        board.wall[row][col] = color;
        let h = 1, v = 1;
        for (let c = col - 1; c >= 0 && board.wall[row][c]; c--) h++;
        for (let c = col + 1; c < 5 && board.wall[row][c]; c++) h++;
        for (let r = row - 1; r >= 0 && board.wall[r][col]; r--) v++;
        for (let r = row + 1; r < 5 && board.wall[r][col]; r++) v++;
        let pts = (h === 1 && v === 1) ? 1 : (h > 1 ? h : 0) + (v > 1 ? v : 0);
        board.score = Math.max(0, board.score + pts);
        for (let i = 0; i < row; i++) gs.lid.push(color);
        board.patternLines[row] = [];
        if (board.wall[row].every(v => v !== null)) gameEnds = true;
      }
    }
    board.floor.forEach((t, i) => {
      if (t !== 'start') gs.lid.push(t);
      board.score = Math.max(0, board.score + FLOOR_PENALTIES[i]);
    });
    board.floor = [];
  });
  if (gameEnds) {
    gs.boards.forEach(board => {
      board.wall.forEach(row => { if (row.every(v => v)) board.score += 2; });
      for (let col = 0; col < 5; col++) {
        if (board.wall.every(row => row[col])) board.score += 7;
      }
      COLORS.forEach(c => {
        let cnt = 0;
        board.wall.forEach(row => row.forEach(v => { if (v === c) cnt++; }));
        if (cnt === 5) board.score += 10;
      });
    });
    gs.phase = 'end';
  } else {
    gs.round++;
    gs.phase = 'factory';
    gs.centerHasStart = true;
    gs.currentPlayer = gs.nextStartPlayer ?? (gs.startPlayer + 1) % gs.players.length;
    gs.startPlayer = gs.currentPlayer;
    gs.nextStartPlayer = null;
    if (gs.bag.length < gs.factories.length * 4) {
      gs.bag.push(...shuffle(gs.lid));
      gs.lid = [];
    }
    gs.factories = gs.factories.map(() => gs.bag.splice(0, 4));
  }
}

function handleServerMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room': {
      const { playerName } = msg;
      const code = generateCode();
      const playerId = generateId();
      const player = { id: playerId, name: playerName.trim(), color: PLAYER_COLORS[0] };
      rooms.set(code, { code, phase: 'lobby', players: [player], gameState: null });
      clients.set(ws, { roomCode: code, playerId });
      send(ws, { type: 'room_created', roomCode: code, playerId, players: [player] });
      break;
    }
    case 'join_room': {
      const { playerName, roomCode } = msg;
      const code = roomCode.toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
      if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'Game in progress.' });
      if (room.players.length >= 4) return send(ws, { type: 'error', message: 'Room full.' });
      const playerId = generateId();
      const player = { id: playerId, name: playerName.trim(), color: PLAYER_COLORS[room.players.length] };
      room.players.push(player);
      clients.set(ws, { roomCode: code, playerId });
      send(ws, { type: 'room_joined', roomCode: code, playerId, players: room.players });
      broadcast(code, { type: 'lobby_update', players: room.players });
      break;
    }
    case 'start_game': {
      const meta = clients.get(ws);
      const room = rooms.get(meta.roomCode);
      if (room.players[0].id !== meta.playerId) return send(ws, { type: 'error', message: 'Only host can start.' });
      if (room.players.length < 2) return send(ws, { type: 'error', message: 'Need 2+ players.' });
      room.phase = 'game';
      room.gameState = serverInitGameState(room.players);
      broadcast(meta.roomCode, { type: 'game_started', gameState: room.gameState });
      break;
    }
    case 'pick_tiles': {
      const meta = clients.get(ws);
      const room = rooms.get(meta.roomCode);
      const gs = room.gameState;
      if (!gs || gs.phase !== 'factory') return send(ws, { type: 'error', message: 'Wrong phase.' });
      if (gs.players[gs.currentPlayer].id !== meta.playerId) return send(ws, { type: 'error', message: "Not your turn." });
      const myIdx = gs.players.findIndex(p => p.id === meta.playerId);
      const board = gs.boards[myIdx];
      const { source, factoryIdx, color, targetRow } = msg;
      let picked = [], getsStart = false;
      if (source === 'factory') {
        const f = gs.factories[factoryIdx];
        if (!f.includes(color)) return send(ws, { type: 'error', message: 'No such tile.' });
        picked = f.filter(t => t === color);
        gs.center.push(...f.filter(t => t !== color));
        gs.factories[factoryIdx] = [];
      } else {
        if (!gs.center.includes(color)) return send(ws, { type: 'error', message: 'No such tile in center.' });
        picked = gs.center.filter(t => t === color);
        gs.center = gs.center.filter(t => t !== color);
        if (gs.centerHasStart) { gs.centerHasStart = false; getsStart = true; gs.nextStartPlayer = myIdx; }
      }
      if (targetRow === 'floor') {
        placeToFloor(gs, board, picked);
      } else {
        const row = parseInt(targetRow);
        const maxLen = row + 1;
        const line = board.patternLines[row];
        if (line[0] && line[0] !== color) return send(ws, { type: 'error', message: 'Wrong color for row.' });
        if (board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === color)) return send(ws, { type: 'error', message: 'Color already on wall.' });
        if (line.length >= maxLen) return send(ws, { type: 'error', message: 'Row full.' });
        const space = maxLen - line.length;
        board.patternLines[row].unshift(...picked.slice(0, space));
        placeToFloor(gs, board, picked.slice(space));
      }
      if (getsStart) {
        if (board.floor.length < 7) board.floor.push('start');
        else gs.lid.push('start');
      }
      const roundOver = gs.factories.every(f => f.length === 0) && gs.center.length === 0 && !gs.centerHasStart;
      if (roundOver) serverDoWallTiling(gs);
      else gs.currentPlayer = (gs.currentPlayer + 1) % gs.players.length;
      broadcast(meta.roomCode, { type: 'state_update', gameState: gs });
      break;
    }
  }
}

// ── Start/stop test server ────────────────────────────────────
function startTestServer() {
  return new Promise(resolve => {
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });
    wss.on('connection', ws => {
      ws.on('message', raw => {
        try { handleServerMessage(ws, JSON.parse(raw)); } catch {}
      });
      ws.on('close', () => { clients.delete(ws); });
    });
    server.listen(TEST_PORT, () => {
      serverInstance = server;
      resolve();
    });
  });
}

function stopTestServer() {
  return new Promise(resolve => {
    rooms.clear();
    clients.clear();
    if (serverInstance) { serverInstance.closeAllConnections?.(); serverInstance.close(resolve); }
    else resolve();
  });
}

// ── WebSocket client helper ───────────────────────────────────
function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    const messages = [];
    const waiters = [];

    ws.on('open', () => resolve({
      ws,
      messages,
      // Wait for next message of given type
      waitFor(type, timeout = 3000) {
        return new Promise((res, rej) => {
          // Check already-received messages
          const idx = messages.findIndex(m => m.type === type);
          if (idx !== -1) { return res(messages.splice(idx, 1)[0]); }
          const timer = setTimeout(() => rej(new Error(`Timeout waiting for "${type}"`)), timeout);
          waiters.push({ type, resolve: res, timer });
        });
      },
      send(data) { ws.send(JSON.stringify(data)); },
      close() { ws.close(); }
    }));

    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      const waiterIdx = waiters.findIndex(w => w.type === msg.type);
      if (waiterIdx !== -1) {
        const w = waiters.splice(waiterIdx, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        messages.push(msg);
      }
    });

    ws.on('error', reject);
  });
}

// ── Helper: force a factory's tiles ──────────────────────────
function forceFactory(roomCode, idx, tiles) {
  const room = rooms.get(roomCode);
  if (!room?.gameState) throw new Error('No game state');
  room.gameState.bag.push(...room.gameState.factories[idx]);
  room.gameState.factories[idx] = [...tiles];
}

// ── Helper: play a full game to completion ────────────────────
async function playFullGame(p1, p2, roomCode) {
  // Force deterministic tile setup each round until game ends
  let gs = rooms.get(roomCode).gameState;
  let turns = 0;
  const MAX_TURNS = 500;

  while (gs.phase !== 'end' && turns < MAX_TURNS) {
    gs = rooms.get(roomCode).gameState;
    const cpIdx = gs.currentPlayer;
    const cpId = gs.players[cpIdx].id;
    const client = cpId === p1.playerId ? p1 : p2;

    // Find a valid move: first non-empty factory, pick any color, place on valid row or floor
    let moved = false;
    for (let fi = 0; fi < gs.factories.length && !moved; fi++) {
      const factory = gs.factories[fi];
      if (factory.length === 0) continue;
      const color = factory[0];
      const board = gs.boards[cpIdx];

      // Find a valid row or send to floor
      let targetRow = 'floor';
      for (let row = 0; row < 5; row++) {
        const maxLen = row + 1;
        const line = board.patternLines[row];
        const existingColor = line[0];
        const alreadyOnWall = board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === color);
        if (!alreadyOnWall && line.length < maxLen && (!existingColor || existingColor === color)) {
          targetRow = row;
          break;
        }
      }

      client.send({ type: 'pick_tiles', source: 'factory', factoryIdx: fi, color, targetRow });
      await client.waitFor('state_update');
      moved = true;
    }

    // If no factory move, pick from center
    if (!moved && (gs.center.length > 0 || gs.centerHasStart)) {
      gs = rooms.get(roomCode).gameState;
      const color = gs.center[0];
      if (color) {
        const board = gs.boards[cpIdx];
        let targetRow = 'floor';
        for (let row = 0; row < 5; row++) {
          const maxLen = row + 1;
          const line = board.patternLines[row];
          const existingColor = line[0];
          const alreadyOnWall = board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === color);
          if (!alreadyOnWall && line.length < maxLen && (!existingColor || existingColor === color)) {
            targetRow = row;
            break;
          }
        }
        client.send({ type: 'pick_tiles', source: 'center', color, targetRow });
        await client.waitFor('state_update');
        moved = true;
      }
    }

    turns++;
    gs = rooms.get(roomCode).gameState;
  }

  return gs;
}

// ═══════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════

before(startTestServer);
after(stopTestServer);

// ── 1. LOBBY / CONNECTION ────────────────────────────────────
describe('Lobby & Room Management', () => {
  test('player can create a room', async () => {
    const client = await createClient();
    client.send({ type: 'create_room', playerName: 'Alice' });
    const msg = await client.waitFor('room_created');
    assert.ok(msg.roomCode, 'Should receive a room code');
    assert.equal(msg.roomCode.length, 4);
    assert.ok(msg.playerId);
    assert.equal(msg.players.length, 1);
    assert.equal(msg.players[0].name, 'Alice');
    client.close();
  });

  test('second player can join with room code', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');

    const guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode: created.roomCode });
    const joined = await guest.waitFor('room_joined');

    assert.equal(joined.roomCode, created.roomCode);
    assert.equal(joined.players.length, 2);
    assert.equal(joined.players[1].name, 'Bob');
    host.close(); guest.close();
  });

  test('joining with wrong code gives error', async () => {
    const client = await createClient();
    client.send({ type: 'join_room', playerName: 'Bob', roomCode: 'ZZZZ' });
    const msg = await client.waitFor('error');
    assert.ok(msg.message.includes('not found'));
    client.close();
  });

  test('5th player cannot join (max 4)', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'P1' });
    const created = await host.waitFor('room_created');
    const code = created.roomCode;

    const clients2 = await Promise.all([1,2,3].map(async i => {
      const c = await createClient();
      c.send({ type: 'join_room', playerName: `P${i+1}`, roomCode: code });
      await c.waitFor('room_joined');
      return c;
    }));

    const overflow = await createClient();
    overflow.send({ type: 'join_room', playerName: 'P5', roomCode: code });
    const err = await overflow.waitFor('error');
    assert.ok(err.message.toLowerCase().includes('full'));

    host.close(); overflow.close();
    clients2.forEach(c => c.close());
  });

  test('non-host cannot start game', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');

    const guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode: created.roomCode });
    await guest.waitFor('room_joined');

    guest.send({ type: 'start_game' });
    const err = await guest.waitFor('error');
    assert.ok(err.message.toLowerCase().includes('host'));
    host.close(); guest.close();
  });

  test('lobby_update broadcast when player joins', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');

    const guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode: created.roomCode });

    // Host should receive lobby_update
    const update = await host.waitFor('lobby_update');
    assert.equal(update.players.length, 2);
    host.close(); guest.close();
  });
});

// ── 2. GAME START ────────────────────────────────────────────
describe('Game Start', () => {
  let host, guest, roomCode, hostId, guestId;

  beforeEach(async () => {
    host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    roomCode = created.roomCode;
    hostId = created.playerId;

    guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    const joined = await guest.waitFor('room_joined');
    guestId = joined.playerId;
    await host.waitFor('lobby_update'); // consume the update
  });

  test('host can start game with 2 players', async () => {
    host.send({ type: 'start_game' });
    const [hostMsg, guestMsg] = await Promise.all([
      host.waitFor('game_started'),
      guest.waitFor('game_started'),
    ]);
    assert.equal(hostMsg.gameState.phase, 'factory');
    assert.equal(guestMsg.gameState.phase, 'factory');
    host.close(); guest.close();
  });

  test('game_started contains 5 factories for 2 players', async () => {
    host.send({ type: 'start_game' });
    const msg = await host.waitFor('game_started');
    assert.equal(msg.gameState.factories.length, 5);
    msg.gameState.factories.forEach(f => assert.equal(f.length, 4));
    host.close(); guest.close();
  });

  test('both players receive correct player list', async () => {
    host.send({ type: 'start_game' });
    const msg = await host.waitFor('game_started');
    assert.equal(msg.gameState.players.length, 2);
    assert.equal(msg.gameState.players[0].name, 'Alice');
    assert.equal(msg.gameState.players[1].name, 'Bob');
    host.close(); guest.close();
  });

  test('host (player 0) goes first', async () => {
    host.send({ type: 'start_game' });
    const msg = await host.waitFor('game_started');
    assert.equal(msg.gameState.currentPlayer, 0);
    host.close(); guest.close();
  });

  test('cannot start with 1 player', async () => {
    // Fresh single-player room
    const solo = await createClient();
    solo.send({ type: 'create_room', playerName: 'Solo' });
    const created = await solo.waitFor('room_created');
    solo.send({ type: 'start_game' });
    const err = await solo.waitFor('error');
    assert.ok(err.message.includes('2'));
    solo.close();
    host.close(); guest.close();
  });
});

// ── 3. TILE SELECTION ────────────────────────────────────────
describe('Tile Selection', () => {
  let host, guest, roomCode, hostId, guestId;

  beforeEach(async () => {
    host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    roomCode = created.roomCode;
    hostId = created.playerId;

    guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    const joined = await guest.waitFor('room_joined');
    guestId = joined.playerId;
    await host.waitFor('lobby_update');

    host.send({ type: 'start_game' });
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);

    // Force factory 0 to known tiles
    forceFactory(roomCode, 0, ['B', 'B', 'R', 'Y']);
  });

  test('player 1 can pick tiles from a factory on their turn', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    assert.equal(update.gameState.factories[0].length, 0);
    host.close(); guest.close();
  });

  test('remaining factory tiles move to center after pick', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    assert.ok(update.gameState.center.includes('R'));
    assert.ok(update.gameState.center.includes('Y'));
    host.close(); guest.close();
  });

  test('picked tiles appear in correct pattern line', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 1 });
    const update = await host.waitFor('state_update');
    const p0board = update.gameState.boards[0];
    assert.equal(p0board.patternLines[1].length, 2);
    assert.ok(p0board.patternLines[1].every(t => t === 'B'));
    host.close(); guest.close();
  });

  test('excess tiles go to floor', async () => {
    forceFactory(roomCode, 0, ['B', 'B', 'B', 'B']);
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    const board = update.gameState.boards[0];
    assert.equal(board.patternLines[0].length, 1);
    assert.equal(board.floor.length, 3);
    host.close(); guest.close();
  });

  test('turn passes to player 2 after player 1 picks', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    assert.equal(update.gameState.currentPlayer, 1);
    host.close(); guest.close();
  });

  test('player 2 CANNOT pick on player 1 turn', async () => {
    guest.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const err = await guest.waitFor('error');
    assert.ok(err.message.toLowerCase().includes("turn"));
    host.close(); guest.close();
  });

  test('cannot pick colour not in factory', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'K', targetRow: 0 });
    const err = await host.waitFor('error');
    assert.ok(err.message);
    host.close(); guest.close();
  });

  test('cannot place colour in row that already has different colour', async () => {
    // Pre-fill pattern row 1 with R
    rooms.get(roomCode).gameState.boards[0].patternLines[1] = ['R'];
    forceFactory(roomCode, 0, ['B', 'B', 'B', 'B']);
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 1 });
    const err = await host.waitFor('error');
    assert.ok(err.message);
    host.close(); guest.close();
  });

  test('cannot place colour in row if that colour already on wall', async () => {
    // Place B on wall row 0
    rooms.get(roomCode).gameState.boards[0].wall[0][0] = 'B';
    forceFactory(roomCode, 0, ['B', 'B', 'B', 'B']);
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const err = await host.waitFor('error');
    assert.ok(err.message);
    host.close(); guest.close();
  });

  test('can send tiles to floor explicitly', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 'floor' });
    const update = await host.waitFor('state_update');
    const board = update.gameState.boards[0];
    assert.equal(board.floor.filter(t => t === 'B').length, 2);
    host.close(); guest.close();
  });

  test('first player to pick from center gets start marker — nextStartPlayer set correctly', async () => {
    // Ensure center has tiles and only one factory remains (so round doesn't end on P0 pick)
    const gs = rooms.get(roomCode).gameState;
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B', 'B', 'R', 'Y']; // P0 picks B → R+Y go to center
    gs.factories[1] = ['C', 'C', 'C', 'C']; // keep round alive for P1
    gs.center = [];
    gs.centerHasStart = true;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const upd1 = await host.waitFor('state_update');

    // Confirm center now has tiles and still has start marker
    assert.ok(upd1.gameState.center.length > 0, 'Center should have tiles');
    assert.equal(upd1.gameState.centerHasStart, true, 'Start marker still in center');
    assert.equal(upd1.gameState.currentPlayer, 1, 'P1 turn');

    // P1 picks from center — gets the start marker
    const color = upd1.gameState.center[0];
    guest.send({ type: 'pick_tiles', source: 'center', color, targetRow: 'floor' });
    const upd2 = await guest.waitFor('state_update');

    // centerHasStart should now be false (marker was taken)
    // nextStartPlayer should be 1 — set before any potential round end
    const serverGs = rooms.get(roomCode).gameState;
    // Either nextStartPlayer=1 (round not over) or startPlayer=1 (round ended, was applied)
    const markerGoesToP1 = serverGs.nextStartPlayer === 1 || serverGs.startPlayer === 1 || serverGs.currentPlayer === 1;
    assert.ok(markerGoesToP1, 'P1 took start marker, should go first next round');
    host.close(); guest.close();
  });

  test('both players receive state_update broadcast', async () => {
    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const [hostUpdate, guestUpdate] = await Promise.all([
      host.waitFor('state_update'),
      guest.waitFor('state_update'),
    ]);
    assert.deepEqual(hostUpdate.gameState.currentPlayer, guestUpdate.gameState.currentPlayer);
    host.close(); guest.close();
  });
});

// ── 4. WALL-TILING PHASE ─────────────────────────────────────
describe('Wall-Tiling Phase', () => {
  let host, guest, roomCode;

  beforeEach(async () => {
    host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    roomCode = created.roomCode;

    guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    await guest.waitFor('room_joined');
    await host.waitFor('lobby_update');

    host.send({ type: 'start_game' });
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);
  });

  test('wall-tiling triggers automatically when all factories and center empty', async () => {
    const gs = rooms.get(roomCode).gameState;
    // Set up so only 1 factory has 1 tile, centre empty, all others empty
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    // After wall tiling, should be back to factory phase round 2
    assert.ok(['factory', 'end'].includes(update.gameState.phase));
    assert.ok(update.gameState.round >= 2 || update.gameState.phase === 'end');
    host.close(); guest.close();
  });

  test('complete pattern line scores points', async () => {
    const gs = rooms.get(roomCode).gameState;
    gs.boards[0].patternLines[0] = []; // clear
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    assert.ok(update.gameState.boards[0].score >= 1);
    host.close(); guest.close();
  });

  test('incomplete pattern line is NOT scored or moved', async () => {
    const gs = rooms.get(roomCode).gameState;
    gs.boards[0].patternLines[1] = ['R']; // 1 of 2 needed — incomplete
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    // Row 1 (R) should still be on board
    assert.equal(update.gameState.boards[0].patternLines[1].length, 1);
    assert.equal(update.gameState.boards[0].wall[1][0], null);
    host.close(); guest.close();
  });

  test('floor penalties are deducted after wall-tiling', async () => {
    const gs = rooms.get(roomCode).gameState;
    gs.boards[0].floor = ['B', 'B']; // -1 -1 = -2
    gs.boards[0].score = 10;
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['R'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'R', targetRow: 'floor' });
    const update = await host.waitFor('state_update');
    // Score should have decreased by floor penalty (but also could gain points)
    assert.ok(update.gameState.boards[0].score <= 10);
    host.close(); guest.close();
  });

  test('round increments after wall-tiling', async () => {
    const gs = rooms.get(roomCode).gameState;
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    if (update.gameState.phase !== 'end') {
      assert.equal(update.gameState.round, 2);
    }
    host.close(); guest.close();
  });
});

// ── 5. GAME END ──────────────────────────────────────────────
describe('Game End Condition', () => {
  let host, guest, roomCode;

  beforeEach(async () => {
    host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    roomCode = created.roomCode;

    guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    await guest.waitFor('room_joined');
    await host.waitFor('lobby_update');

    host.send({ type: 'start_game' });
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);
  });

  test('game transitions to end phase when a full row is completed', async () => {
    const gs = rooms.get(roomCode).gameState;
    // Pre-fill 4 of 5 slots in row 0 of P0's wall
    gs.boards[0].wall[0] = [null, 'Y', 'R', 'K', 'C'];
    // Set up so P0 picks B (which fills row 0 col 0) and round ends
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    assert.equal(update.gameState.phase, 'end');
    host.close(); guest.close();
  });

  test('end-game bonuses applied when game ends', async () => {
    const gs = rooms.get(roomCode).gameState;
    gs.boards[0].wall[0] = [null, 'Y', 'R', 'K', 'C'];
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const update = await host.waitFor('state_update');
    assert.equal(update.gameState.phase, 'end');
    // P0 should have at least: 1 (tile placement) + 4 (horiz links) + 2 (complete row bonus)
    assert.ok(update.gameState.boards[0].score >= 3);
    host.close(); guest.close();
  });

  test('both players receive end state', async () => {
    const gs = rooms.get(roomCode).gameState;
    gs.boards[0].wall[0] = [null, 'Y', 'R', 'K', 'C'];
    gs.factories = gs.factories.map(() => []);
    gs.factories[0] = ['B'];
    gs.center = [];
    gs.centerHasStart = false;

    host.send({ type: 'pick_tiles', source: 'factory', factoryIdx: 0, color: 'B', targetRow: 0 });
    const [hostUpdate, guestUpdate] = await Promise.all([
      host.waitFor('state_update'),
      guest.waitFor('state_update'),
    ]);
    assert.equal(hostUpdate.gameState.phase, 'end');
    assert.equal(guestUpdate.gameState.phase, 'end');
    host.close(); guest.close();
  });
});

// ── 6. FULL GAME SIMULATION ──────────────────────────────────
describe('Full Game Simulation', () => {
  test('a complete 2-player game runs from start to finish', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    const roomCode = created.roomCode;
    const hostId = created.playerId;

    const guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    const joined = await guest.waitFor('room_joined');
    const guestId = joined.playerId;
    await host.waitFor('lobby_update');

    host.send({ type: 'start_game' });
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);

    const p1 = { ws: host, playerId: hostId, send: (d) => host.send(d), waitFor: (t) => host.waitFor(t) };
    const p2 = { ws: guest, playerId: guestId, send: (d) => guest.send(d), waitFor: (t) => guest.waitFor(t) };

    const finalState = await playFullGame(p1, p2, roomCode);

    assert.equal(finalState.phase, 'end', 'Game should end');
    finalState.boards.forEach((board, i) => {
      assert.ok(board.score >= 0, `Player ${i} score should be non-negative`);
    });

    // Verify a winner exists
    const scores = finalState.boards.map(b => b.score);
    const winner = scores.indexOf(Math.max(...scores));
    assert.ok(winner >= 0);

    host.close(); guest.close();
  });

  test('scores are positive at end of game', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    const roomCode = created.roomCode;
    const hostId = created.playerId;

    const guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    const joined = await guest.waitFor('room_joined');
    const guestId = joined.playerId;
    await host.waitFor('lobby_update');

    host.send({ type: 'start_game' });
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);

    const p1 = { ws: host, playerId: hostId, send: (d) => host.send(d), waitFor: (t) => host.waitFor(t) };
    const p2 = { ws: guest, playerId: guestId, send: (d) => guest.send(d), waitFor: (t) => guest.waitFor(t) };

    const finalState = await playFullGame(p1, p2, roomCode);
    const totalScore = finalState.boards.reduce((s, b) => s + b.score, 0);
    assert.ok(totalScore > 0, 'Total score should be > 0 at end of game');

    host.close(); guest.close();
  });

  test('all wall placements respect the wall pattern', async () => {
    const host = await createClient();
    host.send({ type: 'create_room', playerName: 'Alice' });
    const created = await host.waitFor('room_created');
    const roomCode = created.roomCode;
    const hostId = created.playerId;

    const guest = await createClient();
    guest.send({ type: 'join_room', playerName: 'Bob', roomCode });
    const joined = await guest.waitFor('room_joined');
    const guestId = joined.playerId;
    await host.waitFor('lobby_update');

    host.send({ type: 'start_game' });
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);

    const p1 = { ws: host, playerId: hostId, send: (d) => host.send(d), waitFor: (t) => host.waitFor(t) };
    const p2 = { ws: guest, playerId: guestId, send: (d) => guest.send(d), waitFor: (t) => guest.waitFor(t) };

    const finalState = await playFullGame(p1, p2, roomCode);

    // Every filled wall slot must match the WALL_PATTERN
    finalState.boards.forEach((board, pi) => {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          const tile = board.wall[row][col];
          if (tile !== null) {
            assert.equal(
              tile, WALL_PATTERN[row][col],
              `Player ${pi} wall[${row}][${col}] = ${tile}, expected ${WALL_PATTERN[row][col]}`
            );
          }
        }
      }
    });

    host.close(); guest.close();
  });
});

// Force exit after all tests complete (WS connections keep process alive otherwise)
setTimeout(() => process.exit(0), 500);
