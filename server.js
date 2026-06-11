/**
 * AZUL — Node.js WebSocket Game Server
 * 
 * Responsibilities:
 *  - Room creation & joining (4-letter codes)
 *  - Authoritative game state (all moves validated server-side)
 *  - Broadcasting state updates to all players in a room
 *  - Serving the static client from /public
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;

// ── Constants ──────────────────────────────────────────────
const COLORS = ['B', 'C', 'R', 'Y', 'K'];
const COLOR_NAMES = { B: 'Blue', C: 'Cyan', R: 'Red', Y: 'Yellow', K: 'Black' };

// Fixed wall color layout (coloured side)
const WALL_PATTERN = [
  ['B', 'Y', 'R', 'K', 'C'],
  ['C', 'B', 'Y', 'R', 'K'],
  ['K', 'C', 'B', 'Y', 'R'],
  ['R', 'K', 'C', 'B', 'Y'],
  ['Y', 'R', 'K', 'C', 'B'],
];

const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3];
const PLAYER_COLORS = ['#4eb8c8', '#c94040', '#d4a017', '#9b59b6'];

// ── In-memory state ────────────────────────────────────────
// rooms: Map<roomCode, RoomState>
// clients: Map<ws, { roomCode, playerId }>
const rooms = new Map();
const clients = new Map();

// ── HTTP + WS setup ────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Health check (useful for cloud deploys)
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

server.listen(PORT, () => {
  console.log(`🎮 Azul server running → http://localhost:${PORT}`);
});

// ── Message router ──────────────────────────────────────────
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room':  return onCreateRoom(ws, msg);
    case 'join_room':    return onJoinRoom(ws, msg);
    case 'start_game':   return onStartGame(ws, msg);
    case 'pick_tiles':   return onPickTiles(ws, msg);
    case 'place_floor':  return onPlaceFloor(ws, msg);
    case 'leave_room':   return onLeaveRoom(ws, msg);
    default:
      send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

// ── Lobby handlers ──────────────────────────────────────────
function onCreateRoom(ws, { playerName }) {
  if (!playerName?.trim()) return send(ws, { type: 'error', message: 'Name required' });

  const code = generateCode();
  const playerId = generateId();
  const player = { id: playerId, name: playerName.trim(), color: PLAYER_COLORS[0] };

  rooms.set(code, {
    code,
    phase: 'lobby',
    players: [player],
    gameState: null,
  });

  clients.set(ws, { roomCode: code, playerId });
  send(ws, { type: 'room_created', roomCode: code, playerId, players: [player] });
  console.log(`[${code}] Room created by ${player.name}`);
}

function onJoinRoom(ws, { playerName, roomCode }) {
  if (!playerName?.trim()) return send(ws, { type: 'error', message: 'Name required' });
  const code = roomCode?.toUpperCase();
  const room = rooms.get(code);

  if (!room)              return send(ws, { type: 'error', message: 'Room not found. Check the code.' });
  if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'Game already in progress.' });
  if (room.players.length >= 4) return send(ws, { type: 'error', message: 'Room is full (max 4 players).' });

  const playerId = generateId();
  const player = { id: playerId, name: playerName.trim(), color: PLAYER_COLORS[room.players.length] };
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

  // Only host (first player) can start
  if (room.players[0].id !== meta.playerId)
    return send(ws, { type: 'error', message: 'Only the host can start the game.' });

  if (room.players.length < 2)
    return send(ws, { type: 'error', message: 'Need at least 2 players.' });

  room.phase = 'game';
  room.gameState = initGameState(room.players);
  broadcast(meta.roomCode, { type: 'game_started', gameState: room.gameState });
  console.log(`[${meta.roomCode}] Game started with ${room.players.length} players`);
}

// ── Game action handlers ────────────────────────────────────

/**
 * pick_tiles: A player picks tiles from a factory or center.
 * Payload: { source: 'factory'|'center', factoryIdx?: number, color: string, targetRow: number | 'floor' }
 *   targetRow: 0-4 for pattern line rows, 'floor' to discard all to floor
 */
function onPickTiles(ws, { source, factoryIdx, color, targetRow }) {
  const meta = clients.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room?.gameState) return;
  const gs = room.gameState;

  // Turn validation
  if (gs.phase !== 'factory')
    return send(ws, { type: 'error', message: 'Not the factory offer phase.' });
  if (gs.players[gs.currentPlayer].id !== meta.playerId)
    return send(ws, { type: 'error', message: "It's not your turn." });

  const myIdx = gs.players.findIndex(p => p.id === meta.playerId);
  const board = gs.boards[myIdx];

  // Gather picked tiles
  let picked = [];
  let getsStartMarker = false;

  if (source === 'factory') {
    if (factoryIdx == null || !gs.factories[factoryIdx])
      return send(ws, { type: 'error', message: 'Invalid factory.' });
    const factory = gs.factories[factoryIdx];
    if (!factory.includes(color))
      return send(ws, { type: 'error', message: `No ${COLOR_NAMES[color]} tiles in that factory.` });

    picked = factory.filter(t => t === color);
    const remaining = factory.filter(t => t !== color);
    gs.factories[factoryIdx] = [];
    gs.center.push(...remaining);

  } else if (source === 'center') {
    if (!gs.center.includes(color))
      return send(ws, { type: 'error', message: `No ${COLOR_NAMES[color]} tiles in the center.` });

    picked = gs.center.filter(t => t === color);
    gs.center = gs.center.filter(t => t !== color);

    if (gs.centerHasStart) {
      gs.centerHasStart = false;
      getsStartMarker = true;
      gs.nextStartPlayer = myIdx;
    }
  } else {
    return send(ws, { type: 'error', message: 'Invalid source.' });
  }

  // Place into pattern line or floor
  if (targetRow === 'floor') {
    placeToFloor(gs, board, picked);
  } else {
    const row = parseInt(targetRow);
    if (isNaN(row) || row < 0 || row > 4)
      return send(ws, { type: 'error', message: 'Invalid row.' });

    const maxLen = row + 1;
    const line = board.patternLines[row];
    const existingColor = line[0];

    // Validate pattern line placement
    if (existingColor && existingColor !== color)
      return send(ws, { type: 'error', message: 'Row already contains a different color.' });
    if (board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === color))
      return send(ws, { type: 'error', message: 'That color is already on your wall in that row.' });
    if (line.length >= maxLen)
      return send(ws, { type: 'error', message: 'That row is full.' });

    const space = maxLen - line.length;
    const toPlace = picked.slice(0, space);
    const excess = picked.slice(space);
    board.patternLines[row].unshift(...toPlace);
    placeToFloor(gs, board, excess);
  }

  // If player got start marker, add to floor too
  if (getsStartMarker) {
    if (board.floor.length < 7) board.floor.push('start');
    else gs.lid.push('start');
  }

  // Check if round is over
  const roundOver = gs.factories.every(f => f.length === 0)
    && gs.center.length === 0
    && !gs.centerHasStart;

  if (roundOver) {
    doWallTiling(gs);
  } else {
    gs.currentPlayer = (gs.currentPlayer + 1) % gs.players.length;
  }

  broadcast(meta.roomCode, { type: 'state_update', gameState: gs });
  console.log(`[${meta.roomCode}] ${gs.players[myIdx].name} picked ${picked.length}× ${COLOR_NAMES[color]}`);
}

/**
 * place_floor: A player explicitly dumps their picked tiles to floor.
 * This is a subset of pick_tiles with targetRow='floor' but kept as a 
 * separate safety valve.
 */
function onPlaceFloor(ws, msg) {
  onPickTiles(ws, { ...msg, targetRow: 'floor' });
}

function onLeaveRoom(ws, _msg) {
  handleDisconnect(ws);
}

// ── Disconnect ──────────────────────────────────────────────
function handleDisconnect(ws) {
  const meta = clients.get(ws);
  if (!meta) return;
  clients.delete(ws);

  const room = rooms.get(meta.roomCode);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== meta.playerId);

  if (room.players.length === 0) {
    rooms.delete(meta.roomCode);
    console.log(`[${meta.roomCode}] Room closed (empty)`);
  } else {
    broadcast(meta.roomCode, {
      type: 'player_left',
      players: room.players,
      gameState: room.gameState,
    });
    console.log(`[${meta.roomCode}] A player disconnected (${room.players.length} remain)`);
  }
}

// ── Game logic ──────────────────────────────────────────────
function initGameState(players) {
  let bag = [];
  COLORS.forEach(c => { for (let i = 0; i < 20; i++) bag.push(c); });
  bag = shuffle(bag);

  const n = players.length;
  const factoryCount = n === 2 ? 5 : n === 3 ? 7 : 9;
  const factories = [];
  for (let i = 0; i < factoryCount; i++) factories.push(bag.splice(0, 4));

  return {
    round: 1,
    phase: 'factory',
    currentPlayer: 0,
    players: players.map(p => ({ id: p.id, name: p.name, color: p.color })),
    factories,
    center: [],
    centerHasStart: true,
    boards: players.map(() => ({
      patternLines: [[], [], [], [], []],
      wall: Array(5).fill(null).map(() => Array(5).fill(null)),
      floor: [],
      score: 0,
    })),
    bag,
    lid: [],
    startPlayer: 0,
    nextStartPlayer: null,
    log: [],
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

    // Move complete pattern lines to wall
    for (let row = 0; row < 5; row++) {
      const line = board.patternLines[row];
      const maxLen = row + 1;
      if (line.length === maxLen) {
        const color = line[0];
        const col = WALL_PATTERN[row].indexOf(color);
        board.wall[row][col] = color;

        const pts = scoreWallPlacement(board.wall, row, col);
        board.score = Math.max(0, board.score + pts);

        // Put surplus back in lid
        for (let i = 0; i < maxLen - 1; i++) gs.lid.push(color);
        board.patternLines[row] = [];

        if (board.wall[row].every(v => v !== null)) gameEnds = true;
      }
    }

    // Floor penalties
    board.floor.forEach((t, i) => {
      if (t !== 'start') gs.lid.push(t);
      board.score = Math.max(0, board.score + FLOOR_PENALTIES[i]);
    });
    board.floor = [];
  });

  if (gameEnds) {
    applyEndBonuses(gs);
    gs.phase = 'end';
  } else {
    prepareNextRound(gs);
  }
}

function applyEndBonuses(gs) {
  gs.boards.forEach(board => {
    // +2 per complete horizontal row
    board.wall.forEach(row => {
      if (row.every(v => v)) board.score += 2;
    });
    // +7 per complete vertical column
    for (let col = 0; col < 5; col++) {
      if (board.wall.every(row => row[col])) board.score += 7;
    }
    // +10 per color with all 5 placed
    COLORS.forEach(c => {
      let cnt = 0;
      board.wall.forEach(row => row.forEach(v => { if (v === c) cnt++; }));
      if (cnt === 5) board.score += 10;
    });
  });
}

function prepareNextRound(gs) {
  gs.round++;
  gs.phase = 'factory';
  gs.centerHasStart = true;
  gs.currentPlayer = gs.nextStartPlayer ?? (gs.startPlayer + 1) % gs.players.length;
  gs.startPlayer = gs.currentPlayer;
  gs.nextStartPlayer = null;

  // Refill bag from lid if needed
  const needed = gs.factories.length * 4;
  if (gs.bag.length < needed) {
    gs.bag.push(...shuffle(gs.lid));
    gs.lid = [];
  }
  gs.factories = gs.factories.map(() => gs.bag.splice(0, 4));
}

function scoreWallPlacement(wall, row, col) {
  let h = 1, v = 1;
  for (let c = col - 1; c >= 0 && wall[row][c]; c--) h++;
  for (let c = col + 1; c < 5 && wall[row][c]; c++) h++;
  for (let r = row - 1; r >= 0 && wall[r][col]; r--) v++;
  for (let r = row + 1; r < 5 && wall[r][col]; r++) v++;

  if (h === 1 && v === 1) return 1;
  let pts = 0;
  if (h > 1) pts += h;
  if (v > 1) pts += v;
  return pts;
}

// ── Utilities ──────────────────────────────────────────────
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(data));
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
