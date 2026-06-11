/**
 * AZUL — Node.js WebSocket Game Server with AI Players
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

const COLORS = ['B', 'C', 'R', 'Y', 'K'];
const COLOR_NAMES = { B: 'Blue', C: 'Cyan', R: 'Red', Y: 'Yellow', K: 'Black' };
const WALL_PATTERN = [
  ['B', 'Y', 'R', 'K', 'C'],
  ['C', 'B', 'Y', 'R', 'K'],
  ['K', 'C', 'B', 'Y', 'R'],
  ['R', 'K', 'C', 'B', 'Y'],
  ['Y', 'R', 'K', 'C', 'B'],
];
const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3];
const PLAYER_COLORS = ['#4eb8c8', '#c94040', '#d4a017', '#9b59b6'];
const AI_DELAY_MS = { rookie: 1800, veteran: 1200, master: 800 };
const AI_NAMES = {
  rookie:  ['Azulito', 'Tilesworth', 'Rookstone'],
  veteran: ['Groutmaster', 'Señor Azul', 'The Grouter'],
  master:  ['Grand Tiler', 'El Maestro', 'The Oracle'],
};

const rooms   = new Map(); // roomCode → RoomState
const clients = new Map(); // ws → { roomCode, playerId }

const app    = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

server.listen(PORT, () => console.log(`🎮 Azul server → http://localhost:${PORT}`));

// ─── Message router ────────────────────────────────────────
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room': return onCreateRoom(ws, msg);
    case 'join_room':   return onJoinRoom(ws, msg);
    case 'start_game':  return onStartGame(ws, msg);
    case 'pick_tiles':  return onPickTiles(ws, msg);
    case 'leave_room':  return handleDisconnect(ws);
    default: send(ws, { type: 'error', message: `Unknown message: ${msg.type}` });
  }
}

// ─── Lobby ─────────────────────────────────────────────────
function onCreateRoom(ws, { playerName, aiPlayers = [] }) {
  if (!playerName?.trim()) return send(ws, { type: 'error', message: 'Name required' });

  const code     = generateCode();
  const playerId = generateId();
  const human    = { id: playerId, name: playerName.trim(), color: PLAYER_COLORS[0], isAI: false };

  // Build AI player objects from requested difficulties
  const allPlayers = [human];
  for (const difficulty of aiPlayers) {
    if (!['rookie','veteran','master'].includes(difficulty)) continue;
    if (allPlayers.length >= 4) break;
    const names = AI_NAMES[difficulty];
    const aiName = names[Math.floor(Math.random() * names.length)];
    allPlayers.push({
      id: `ai-${generateId()}`,
      name: `${aiName} (${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)})`,
      color: PLAYER_COLORS[allPlayers.length],
      isAI: true,
      difficulty,
    });
  }

  rooms.set(code, { code, phase: 'lobby', players: allPlayers, gameState: null });
  clients.set(ws, { roomCode: code, playerId });
  send(ws, { type: 'room_created', roomCode: code, playerId, players: allPlayers });
  console.log(`[${code}] Created by ${human.name} with ${allPlayers.length - 1} AI`);
}

function onJoinRoom(ws, { playerName, roomCode }) {
  if (!playerName?.trim()) return send(ws, { type: 'error', message: 'Name required' });
  const code = roomCode?.toUpperCase();
  const room = rooms.get(code);
  if (!room)                   return send(ws, { type: 'error', message: 'Room not found. Check the code.' });
  if (room.phase !== 'lobby')  return send(ws, { type: 'error', message: 'Game already in progress.' });
  if (room.players.length >= 4) return send(ws, { type: 'error', message: 'Room is full (max 4 players).' });

  const playerId = generateId();
  const player   = { id: playerId, name: playerName.trim(), color: PLAYER_COLORS[room.players.length], isAI: false };
  room.players.push(player);
  clients.set(ws, { roomCode: code, playerId });
  send(ws, { type: 'room_joined', roomCode: code, playerId, players: room.players });
  broadcast(code, { type: 'lobby_update', players: room.players });
  console.log(`[${code}] ${player.name} joined (${room.players.length}/4)`);
}

function onStartGame(ws, _msg) {
  const meta = clients.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room) return;
  if (room.players[0].id !== meta.playerId)
    return send(ws, { type: 'error', message: 'Only the host can start.' });
  if (room.players.length < 2)
    return send(ws, { type: 'error', message: 'Need at least 2 players.' });

  room.phase     = 'game';
  room.gameState = initGameState(room.players);
  broadcast(meta.roomCode, { type: 'game_started', gameState: room.gameState });
  console.log(`[${meta.roomCode}] Game started (${room.players.length} players)`);

  // Kick off AI if it goes first
  maybeScheduleAI(meta.roomCode);
}

// ─── Pick tiles (human) ────────────────────────────────────
function onPickTiles(ws, payload) {
  const meta = clients.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room?.gameState) return;
  const gs = room.gameState;

  if (gs.phase !== 'factory')
    return send(ws, { type: 'error', message: 'Not the factory offer phase.' });
  if (gs.players[gs.currentPlayer].id !== meta.playerId)
    return send(ws, { type: 'error', message: "It's not your turn." });

  const err = applyPickTiles(gs, meta.playerId, payload);
  if (err) return send(ws, { type: 'error', message: err });

  broadcast(meta.roomCode, { type: 'state_update', gameState: gs });
  maybeScheduleAI(meta.roomCode);
}

// ─── Core move application (used by both humans & AI) ──────
function applyPickTiles(gs, playerId, { source, factoryIdx, color, targetRow }) {
  const myIdx = gs.players.findIndex(p => p.id === playerId);
  if (myIdx < 0) return 'Player not found.';
  const board = gs.boards[myIdx];

  let picked = [];
  let getsStart = false;

  if (source === 'factory') {
    const f = gs.factories[factoryIdx];
    if (!f?.length)           return 'Invalid factory.';
    if (!f.includes(color))   return `No ${COLOR_NAMES[color]} tiles there.`;
    picked = f.filter(t => t === color);
    gs.center.push(...f.filter(t => t !== color));
    gs.factories[factoryIdx] = [];
  } else if (source === 'center') {
    if (!gs.center.includes(color)) return `No ${COLOR_NAMES[color]} in center.`;
    picked = gs.center.filter(t => t === color);
    gs.center = gs.center.filter(t => t !== color);
    if (gs.centerHasStart) { gs.centerHasStart = false; getsStart = true; gs.nextStartPlayer = myIdx; }
  } else {
    return 'Invalid source.';
  }

  if (targetRow === 'floor') {
    placeToFloor(gs, board, picked);
  } else {
    const row = parseInt(targetRow);
    if (isNaN(row) || row < 0 || row > 4) return 'Invalid row.';
    const maxLen  = row + 1;
    const line    = board.patternLines[row];
    const existing = line[0];
    if (existing && existing !== color)
      return 'Row already has a different color.';
    if (board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === color))
      return 'That color is already on your wall in that row.';
    if (line.length >= maxLen) return 'That row is full.';
    const space = maxLen - line.length;
    board.patternLines[row].unshift(...picked.slice(0, space));
    placeToFloor(gs, board, picked.slice(space));
  }

  if (getsStart) {
    if (board.floor.length < 7) board.floor.push('start');
    else gs.lid.push('start');
  }

  const roundOver = gs.factories.every(f => f.length === 0)
    && gs.center.length === 0 && !gs.centerHasStart;

  if (roundOver) doWallTiling(gs);
  else gs.currentPlayer = (gs.currentPlayer + 1) % gs.players.length;

  return null; // no error
}

// ─── AI scheduling ─────────────────────────────────────────
function maybeScheduleAI(roomCode) {
  const room = rooms.get(roomCode);
  if (!room?.gameState) return;
  const gs = room.gameState;
  if (gs.phase !== 'factory') return;

  const cp = gs.players[gs.currentPlayer];
  if (!cp?.isAI) return;

  const delay = AI_DELAY_MS[cp.difficulty] ?? 1200;
  setTimeout(() => runAITurn(roomCode), delay);
}

function runAITurn(roomCode) {
  const room = rooms.get(roomCode);
  if (!room?.gameState) return;
  const gs = room.gameState;
  if (gs.phase !== 'factory') return;

  const cp = gs.players[gs.currentPlayer];
  if (!cp?.isAI) return;

  const move = computeAIMove(gs, gs.currentPlayer, cp.difficulty);
  if (!move) return;

  const err = applyPickTiles(gs, cp.id, move);
  if (err) { console.error(`[${roomCode}] AI error: ${err}`); return; }

  console.log(`[${roomCode}] ${cp.name} played ${move.color} → row ${move.targetRow}`);
  broadcast(roomCode, { type: 'state_update', gameState: gs });
  maybeScheduleAI(roomCode);
}

// ─── AI brains ─────────────────────────────────────────────

/**
 * Returns all legal moves for a given board state as
 * [{ source, factoryIdx, color, targetRow, score }]
 */
function getLegalMoves(gs, playerIdx) {
  const board   = gs.boards[playerIdx];
  const moves   = [];
  const sources = [];

  // Factory sources
  gs.factories.forEach((tiles, fi) => {
    if (!tiles.length) return;
    const colors = [...new Set(tiles)];
    colors.forEach(c => sources.push({ source: 'factory', factoryIdx: fi, color: c, count: tiles.filter(t => t === c).length }));
  });

  // Center sources
  const centerColors = [...new Set(gs.center)];
  centerColors.forEach(c => sources.push({ source: 'center', factoryIdx: null, color: c, count: gs.center.filter(t => t === c).length }));

  for (const src of sources) {
    let placed = false;
    for (let row = 0; row < 5; row++) {
      const maxLen   = row + 1;
      const line     = board.patternLines[row];
      const existing = line[0];
      const onWall   = board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === src.color);
      if (onWall)                                    continue;
      if (line.length >= maxLen)                     continue;
      if (existing && existing !== src.color)        continue;
      moves.push({ ...src, targetRow: row });
      placed = true;
    }
    // Always allow floor as fallback
    moves.push({ ...src, targetRow: 'floor' });
  }

  return moves;
}

/**
 * Score a potential move for the AI evaluation function.
 * Higher = better.
 */
function scoreMoveForAI(gs, playerIdx, move, difficulty) {
  const board   = gs.boards[playerIdx];
  const { color, targetRow, count, source } = move;

  // Floor moves are penalised (but sometimes unavoidable)
  if (targetRow === 'floor') return -10 - count * 3;

  const row    = parseInt(targetRow);
  const maxLen = row + 1;
  const line   = board.patternLines[row];
  const space  = maxLen - line.length;
  const placed = Math.min(count, space);
  const wasted = count - placed; // tiles that go to floor

  let score = 0;

  // ── Rookie: just prefer rows where tiles fit ──────────────
  score += placed;
  score -= wasted * 2;

  if (difficulty === 'rookie') return score + Math.random() * 3;

  // ── Veteran: prefer rows close to completion ──────────────
  const afterFill  = line.length + placed;
  const completion = afterFill / maxLen; // 0–1
  score += completion * 5;

  // Prefer picking tiles we already have in this row
  if (line.length > 0 && line[0] === color) score += 3;

  // Simulate the wall placement score we'd get when complete
  if (afterFill === maxLen) {
    const col         = WALL_PATTERN[row].indexOf(color);
    const simWall     = gs.boards[playerIdx].wall.map(r => [...r]);
    simWall[row][col] = color;
    const wallPts     = scoreWallPlacement(simWall, row, col);
    score += wallPts * 2;
  }

  // Avoid getting the start marker from center (floor penalty)
  if (source === 'center' && gs.centerHasStart) score -= 3;

  if (difficulty === 'veteran') return score + Math.random() * 1.5;

  // ── Master: additionally hunts bonuses & plans ahead ─────
  const col = WALL_PATTERN[row].indexOf(color);

  // How many of this color already on wall? (working towards +10 bonus)
  let colorCount = 0;
  gs.boards[playerIdx].wall.forEach(r => r.forEach(v => { if (v === color) colorCount++; }));
  score += colorCount * 1.5; // closer to completing 5 of same color

  // How many tiles in this column? (working towards +7 column bonus)
  let colCount = 0;
  gs.boards[playerIdx].wall.forEach(r => { if (r[col]) colCount++; });
  score += colCount * 1.2;

  // How many tiles in this row on the wall? (working towards +2 row bonus)
  const wallRowFilled = gs.boards[playerIdx].wall[row].filter(v => v).length;
  score += wallRowFilled * 1.0;

  // Strongly prefer not wasting tiles
  score -= wasted * 4;

  // Slightly avoid center if start marker is there and floor is already busy
  if (source === 'center' && gs.centerHasStart && board.floor.length >= 3) score -= 6;

  return score + Math.random() * 0.5; // tiny noise to avoid predictability
}

function computeAIMove(gs, playerIdx, difficulty) {
  const moves = getLegalMoves(gs, playerIdx);
  if (!moves.length) return null;

  const scored = moves.map(m => ({ move: m, score: scoreMoveForAI(gs, playerIdx, m, difficulty) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].move;
}

// ─── Disconnect ────────────────────────────────────────────
function handleDisconnect(ws) {
  const meta = clients.get(ws);
  if (!meta) return;
  clients.delete(ws);
  const room = rooms.get(meta.roomCode);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== meta.playerId);
  if (room.players.filter(p => !p.isAI).length === 0) {
    rooms.delete(meta.roomCode);
    console.log(`[${meta.roomCode}] Room closed`);
  } else {
    broadcast(meta.roomCode, { type: 'player_left', players: room.players, gameState: room.gameState });
  }
}

// ─── Game logic ────────────────────────────────────────────
function initGameState(players) {
  let bag = [];
  COLORS.forEach(c => { for (let i = 0; i < 20; i++) bag.push(c); });
  bag = shuffle(bag);
  const n            = players.length;
  const factoryCount = n === 2 ? 5 : n === 3 ? 7 : 9;
  const factories    = [];
  for (let i = 0; i < factoryCount; i++) factories.push(bag.splice(0, 4));
  return {
    round: 1, phase: 'factory', currentPlayer: 0,
    players: players.map(p => ({ id: p.id, name: p.name, color: p.color, isAI: p.isAI, difficulty: p.difficulty ?? null })),
    factories, center: [], centerHasStart: true,
    boards: players.map(() => ({
      patternLines: [[], [], [], [], []],
      wall: Array(5).fill(null).map(() => Array(5).fill(null)),
      floor: [], score: 0,
    })),
    bag, lid: [], startPlayer: 0, nextStartPlayer: null, log: [],
  };
}

function placeToFloor(gs, board, tiles) {
  tiles.forEach(t => {
    if (board.floor.length < 7) board.floor.push(t);
    else gs.lid.push(t);
  });
}

function doWallTiling(gs) {
  let gameEnds = false;
  gs.players.forEach((_, pi) => {
    const board = gs.boards[pi];
    for (let row = 0; row < 5; row++) {
      const line   = board.patternLines[row];
      const maxLen = row + 1;
      if (line.length === maxLen) {
        const color = line[0];
        const col   = WALL_PATTERN[row].indexOf(color);
        board.wall[row][col] = color;
        const pts = scoreWallPlacement(board.wall, row, col);
        board.score = Math.max(0, board.score + pts);
        for (let i = 0; i < maxLen - 1; i++) gs.lid.push(color);
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
  if (gameEnds) { applyEndBonuses(gs); gs.phase = 'end'; }
  else prepareNextRound(gs);
}

function applyEndBonuses(gs) {
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
}

function prepareNextRound(gs) {
  gs.round++;
  gs.phase          = 'factory';
  gs.centerHasStart = true;
  gs.currentPlayer  = gs.nextStartPlayer ?? (gs.startPlayer + 1) % gs.players.length;
  gs.startPlayer    = gs.currentPlayer;
  gs.nextStartPlayer = null;
  const needed = gs.factories.length * 4;
  if (gs.bag.length < needed) { gs.bag.push(...shuffle(gs.lid)); gs.lid = []; }
  gs.factories = gs.factories.map(() => gs.bag.splice(0, 4));
}

function scoreWallPlacement(wall, row, col) {
  let h = 1, v = 1;
  for (let c = col - 1; c >= 0 && wall[row][c]; c--) h++;
  for (let c = col + 1; c < 5 && wall[row][c]; c++) h++;
  for (let r = row - 1; r >= 0 && wall[r][col]; r--) v++;
  for (let r = row + 1; r < 5 && wall[r][col]; r++) v++;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(roomCode, data) {
  const payload = JSON.stringify(data);
  clients.forEach((meta, ws) => {
    if (meta.roomCode === roomCode && ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

function generateCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 4).toUpperCase(); } while (rooms.has(code));
  return code;
}

function generateId() { return Math.random().toString(36).substr(2, 9); }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
