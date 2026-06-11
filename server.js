/**
 * COLMEDORNO — Server with Auth, Persistence, and AI Players
 */

import express        from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http           from 'http';
import path           from 'path';
import cookieParser   from 'cookie-parser';
import bcrypt         from 'bcryptjs';
import jwt            from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { initDB, save as saveDB, createUser, getUserByEmail, getUserById,
         saveGame, getGameByCode, getGamesForUser, linkPlayerToGame, markGameEnded,
         createOTP, getValidOTP, consumeOTP, updateUserPassword } from './db.js';
import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colmedorno-secret-change-in-production';

// ── Game constants ─────────────────────────────────────────
const COLORS       = ['B','C','R','Y','K'];
const COLOR_NAMES  = { B:'Blue', C:'Cyan', R:'Red', Y:'Yellow', K:'Black' };
const WALL_PATTERN = [
  ['B','Y','R','K','C'], ['C','B','Y','R','K'], ['K','C','B','Y','R'],
  ['R','K','C','B','Y'], ['Y','R','K','C','B'],
];
const FLOOR_PENALTIES = [-1,-1,-2,-2,-2,-3,-3];
const PLAYER_COLORS   = ['#4eb8c8','#c94040','#d4a017','#9b59b6'];
const AI_DELAY_MS     = { rookie:1800, veteran:1200, master:800 };
const AI_NAMES = {
  rookie:  ['Pebbles','Tilesworth','Rookstone'],
  veteran: ['Groutmaster','The Grouter','Von Grout'],
  master:  ['Grand Tiler','El Maestro','The Oracle'],
};

// ── In-memory rooms (backed by DB) ─────────────────────────
// rooms: Map<roomCode, RoomState>
// clients: Map<ws, { roomCode, playerId, userId }>
const rooms   = new Map();
const clients = new Map();

// ── Express + WS setup ────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok:true, rooms:rooms.size }));

// ── Auth middleware ────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.colmedorno_token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function generateId() { return Math.random().toString(36).substr(2,9); }

// ── Auth routes ────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password)
    return res.status(400).json({ error: 'Email, name and password required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (getUserByEmail(email))
    return res.status(409).json({ error: 'An account with that email already exists' });

  const id   = generateId();
  const hash = await bcrypt.hash(password, 10);
  createUser({ id, email, name, password: hash });

  const token = jwt.sign({ id, email, name }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('colmedorno_token', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*60*60*1000 });
  res.json({ ok:true, user:{ id, email, name } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'No account found with that email' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  const token = jwt.sign({ id:user.id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
  res.cookie('colmedorno_token', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*60*60*1000 });
  res.json({ ok:true, user:{ id:user.id, email:user.email, name:user.name } });
});

app.post('/api/logout', (_, res) => {
  res.clearCookie('colmedorno_token');
  res.json({ ok:true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user:{ id:user.id, email:user.email, name:user.name } });
});

app.get('/api/my-games', requireAuth, (req, res) => {
  const games = getGamesForUser(req.user.id);
  res.json({ games: games.map(g => ({
    roomCode:   g.room_code,
    phase:      g.phase,
    round:      g.state?.round ?? 1,
    players:    g.players,
    updatedAt:  g.updated,
  }))});
});
// ── Password reset routes ──────────────────────────────────

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email?.trim()) return res.status(400).json({ error: 'Email required' });

  const user = getUserByEmail(email);
  // Always return success to avoid user enumeration
  if (!user) return res.json({ ok: true });

  const code      = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit OTP
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60; // 15 minutes
  const id        = generateId();
  createOTP({ id, email: email.trim(), code, expiresAt });

  if (resend) {
    try {
      await resend.emails.send({
        from:    'Colmedorno <noreply@' + (process.env.EMAIL_DOMAIN || 'azul.game') + '>',
        to:      user.email,
        subject: 'Your Colmedorno password reset code',
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px;background:#1a1f3a;color:#f5ecd7;border-radius:12px">
            <h1 style="font-family:serif;color:#c9a227;letter-spacing:4px;margin:0 0 8px">COLMEDORNO</h1>
            <p style="color:rgba(245,236,215,0.6);font-size:13px;margin:0 0 32px">DIGITAL EDITION</p>
            <p style="margin:0 0 16px">Your password reset code is:</p>
            <div style="background:#252c50;border:2px dashed #c9a227;border-radius:8px;padding:20px;text-align:center;margin:0 0 24px">
              <span style="font-family:monospace;font-size:36px;font-weight:700;letter-spacing:12px;color:#c9a227">${code}</span>
            </div>
            <p style="color:rgba(245,236,215,0.5);font-size:12px;margin:0">This code expires in 15 minutes. If you didn't request this, you can safely ignore it.</p>
          </div>
        `,
      });
    } catch (err) {
      console.error('Email send failed:', err.message);
      // Don't expose error to client
    }
  } else {
    // Dev fallback — log to console
    console.log(`[DEV] OTP for ${email}: ${code}`);
  }

  res.json({ ok: true });
});

app.post('/api/verify-otp', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const otp = getValidOTP(email, code.trim());
  if (!otp) return res.status(400).json({ error: 'Invalid or expired code. Please try again.' });

  // Return a short-lived reset token (JWT, 10 min)
  const resetToken = jwt.sign(
    { email: email.toLowerCase().trim(), otpId: otp.id, purpose: 'password-reset' },
    JWT_SECRET,
    { expiresIn: '10m' }
  );

  res.json({ ok: true, resetToken });
});

app.post('/api/reset-password', async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  let payload;
  try {
    payload = jwt.verify(resetToken, JWT_SECRET);
  } catch {
    return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
  }

  if (payload.purpose !== 'password-reset')
    return res.status(400).json({ error: 'Invalid token' });

  // Consume the OTP so it can't be reused
  consumeOTP(payload.otpId);

  const hash = await bcrypt.hash(newPassword, 10);
  updateUserPassword(payload.email, hash);

  // Auto-sign them in
  const user  = getUserByEmail(payload.email);
  const token = jwt.sign({ id:user.id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
  res.cookie('colmedorno_token', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*60*60*1000 });
  res.json({ ok:true, user:{ id:user.id, email:user.email, name:user.name } });
});


// ── HTTP/WS server ─────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Try to identify user from cookie on initial connection
  let userId = null;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/colmedorno_token=([^;]+)/);
  if (match) {
    try { userId = jwt.verify(match[1], JWT_SECRET).id; } catch {}
  }
  if (userId) clients.set(ws, { roomCode:null, playerId:null, userId });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg, userId);
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

// Boot DB then start server
initDB().then(() => {
  server.listen(PORT, () => console.log(`🎮 Colmedorno server → http://localhost:${PORT}`));
});

// ── WS message router ──────────────────────────────────────
function handleMessage(ws, msg, userId) {
  switch (msg.type) {
    case 'auth':         return onAuth(ws, msg);
    case 'create_room':  return onCreateRoom(ws, msg, userId);
    case 'join_room':    return onJoinRoom(ws, msg, userId);
    case 'rejoin_room':  return onRejoinRoom(ws, msg, userId);
    case 'start_game':   return onStartGame(ws, userId);
    case 'pick_tiles':   return onPickTiles(ws, msg);
    case 'leave_room':   return handleDisconnect(ws);
    default: send(ws, { type:'error', message:`Unknown: ${msg.type}` });
  }
}

// ── Auth over WS (optional — client can also use /api/me) ──
function onAuth(ws, { token }) {
  try {
    const user = jwt.verify(token, JWT_SECRET);
    const meta = clients.get(ws) || {};
    clients.set(ws, { ...meta, userId: user.id });
    send(ws, { type:'auth_ok', user:{ id:user.id, name:user.name, email:user.email } });
  } catch {
    send(ws, { type:'error', message:'Invalid session' });
  }
}

// ── Lobby ──────────────────────────────────────────────────
function onCreateRoom(ws, { playerName, aiPlayers = [] }, userId) {
  const name = (playerName || '').trim();
  if (!name) return send(ws, { type:'error', message:'Name required' });

  const code     = generateCode();
  const playerId = generateId();
  const human    = { id:playerId, name, color:PLAYER_COLORS[0], isAI:false, userId: userId||null };

  const allPlayers = [human];
  for (const difficulty of aiPlayers) {
    if (!['rookie','veteran','master'].includes(difficulty)) continue;
    if (allPlayers.length >= 4) break;
    const aiNames = AI_NAMES[difficulty];
    const aiName  = aiNames[Math.floor(Math.random()*aiNames.length)];
    allPlayers.push({
      id:`ai-${generateId()}`, name:`${aiName} (${difficulty.charAt(0).toUpperCase()+difficulty.slice(1)})`,
      color:PLAYER_COLORS[allPlayers.length], isAI:true, difficulty,
    });
  }

  const room = { code, phase:'lobby', players:allPlayers, gameState:null };
  rooms.set(code, room);
  clients.set(ws, { roomCode:code, playerId, userId: userId||null });

  // Persist skeleton so it shows in game list immediately
  saveGame(code, null, allPlayers, 'lobby');
  if (userId) linkPlayerToGame(code, userId, playerId, 0);

  send(ws, { type:'room_created', roomCode:code, playerId, players:allPlayers });
  console.log(`[${code}] Created by ${name}`);
}

function onJoinRoom(ws, { playerName, roomCode }, userId) {
  const name = (playerName || '').trim();
  if (!name) return send(ws, { type:'error', message:'Name required' });
  const code = roomCode?.toUpperCase();

  // Try memory first, then DB
  let room = rooms.get(code);
  if (!room) {
    const dbGame = getGameByCode(code);
    if (dbGame && dbGame.phase !== 'ended') {
      // Restore room from DB into memory
      room = { code, phase:dbGame.phase, players:dbGame.players, gameState:dbGame.state };
      rooms.set(code, room);
    }
  }

  if (!room)                    return send(ws, { type:'error', message:'Room not found. Check the code.' });
  if (room.phase !== 'lobby')   return send(ws, { type:'error', message:'Game already in progress. Use Rejoin instead.' });
  if (room.players.length >= 4) return send(ws, { type:'error', message:'Room is full (max 4 players).' });

  const playerId = generateId();
  const player   = { id:playerId, name, color:PLAYER_COLORS[room.players.length], isAI:false, userId:userId||null };
  room.players.push(player);
  clients.set(ws, { roomCode:code, playerId, userId:userId||null });

  saveGame(code, null, room.players, 'lobby');
  if (userId) linkPlayerToGame(code, userId, playerId, room.players.length-1);

  send(ws, { type:'room_joined', roomCode:code, playerId, players:room.players });
  broadcast(code, { type:'lobby_update', players:room.players });
  console.log(`[${code}] ${name} joined`);
}

function onRejoinRoom(ws, { roomCode }, userId) {
  if (!userId) return send(ws, { type:'error', message:'Must be logged in to rejoin.' });
  const code = roomCode?.toUpperCase();

  // Load from memory or DB
  let room = rooms.get(code);
  if (!room) {
    const dbGame = getGameByCode(code);
    if (!dbGame || dbGame.phase === 'ended')
      return send(ws, { type:'error', message:'Game not found or already ended.' });
    room = { code, phase:dbGame.phase, players:dbGame.players, gameState:dbGame.state };
    rooms.set(code, room);
  }

  // Find player seat belonging to this user
  const player = room.players.find(p => p.userId === userId);
  if (!player) return send(ws, { type:'error', message:'You are not in this game.' });

  clients.set(ws, { roomCode:code, playerId:player.id, userId });
  send(ws, { type:'room_rejoined', roomCode:code, playerId:player.id, players:room.players, gameState:room.gameState });
  console.log(`[${code}] ${player.name} rejoined`);

  // Kick AI if it's waiting
  if (room.phase === 'game') maybeScheduleAI(code);
}

function onStartGame(ws, userId) {
  const meta = clients.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room) return;
  if (room.players[0].id !== meta.playerId)
    return send(ws, { type:'error', message:'Only the host can start.' });
  if (room.players.length < 2)
    return send(ws, { type:'error', message:'Need at least 2 players.' });

  room.phase     = 'game';
  room.gameState = initGameState(room.players);
  persistRoom(meta.roomCode);
  broadcast(meta.roomCode, { type:'game_started', gameState:room.gameState });
  console.log(`[${meta.roomCode}] Game started`);
  maybeScheduleAI(meta.roomCode);
}

// ── Pick tiles ─────────────────────────────────────────────
function onPickTiles(ws, payload) {
  const meta = clients.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.roomCode);
  if (!room?.gameState) return;
  const gs = room.gameState;

  if (gs.phase !== 'factory')
    return send(ws, { type:'error', message:'Not the factory offer phase.' });
  if (gs.players[gs.currentPlayer].id !== meta.playerId)
    return send(ws, { type:'error', message:"It's not your turn." });

  const err = applyPickTiles(gs, meta.playerId, payload);
  if (err) return send(ws, { type:'error', message:err });

  if (gs.phase === 'end') markGameEnded(meta.roomCode);
  else persistRoom(meta.roomCode);

  broadcast(meta.roomCode, { type:'state_update', gameState:gs });
  maybeScheduleAI(meta.roomCode);
}

// ── Core move logic ────────────────────────────────────────
function applyPickTiles(gs, playerId, { source, factoryIdx, color, targetRow }) {
  const myIdx = gs.players.findIndex(p => p.id === playerId);
  if (myIdx < 0) return 'Player not found.';
  const board = gs.boards[myIdx];
  let picked = [], getsStart = false;

  if (source === 'factory') {
    const f = gs.factories[factoryIdx];
    if (!f?.length)         return 'Invalid factory.';
    if (!f.includes(color)) return `No ${COLOR_NAMES[color]} tiles there.`;
    picked = f.filter(t => t === color);
    gs.center.push(...f.filter(t => t !== color));
    gs.factories[factoryIdx] = [];
  } else if (source === 'center') {
    if (!gs.center.includes(color)) return `No ${COLOR_NAMES[color]} in center.`;
    picked = gs.center.filter(t => t === color);
    gs.center = gs.center.filter(t => t !== color);
    if (gs.centerHasStart) { gs.centerHasStart=false; getsStart=true; gs.nextStartPlayer=myIdx; }
  } else return 'Invalid source.';

  if (targetRow === 'floor') {
    placeToFloor(gs, board, picked);
  } else {
    const row = parseInt(targetRow);
    if (isNaN(row)||row<0||row>4) return 'Invalid row.';
    const line = board.patternLines[row];
    const existing = line[0];
    if (existing && existing !== color) return 'Row already has a different color.';
    if (board.wall[row].some((v,ci) => v && WALL_PATTERN[row][ci]===color)) return 'Color already on wall in that row.';
    if (line.length >= row+1) return 'That row is full.';
    const space = (row+1) - line.length;
    board.patternLines[row].unshift(...picked.slice(0, space));
    placeToFloor(gs, board, picked.slice(space));
  }

  if (getsStart) {
    if (board.floor.length < 7) board.floor.push('start');
    else gs.lid.push('start');
  }

  const roundOver = gs.factories.every(f => f.length===0) && gs.center.length===0 && !gs.centerHasStart;
  if (roundOver) doWallTiling(gs);
  else gs.currentPlayer = (gs.currentPlayer+1) % gs.players.length;

  return null;
}

// ── AI ─────────────────────────────────────────────────────
function maybeScheduleAI(roomCode) {
  const room = rooms.get(roomCode);
  if (!room?.gameState) return;
  const gs = room.gameState;
  if (gs.phase !== 'factory') return;
  const cp = gs.players[gs.currentPlayer];
  if (!cp?.isAI) return;
  setTimeout(() => runAITurn(roomCode), AI_DELAY_MS[cp.difficulty] ?? 1200);
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
  if (gs.phase === 'end') markGameEnded(roomCode);
  else persistRoom(roomCode);
  broadcast(roomCode, { type:'state_update', gameState:gs });
  maybeScheduleAI(roomCode);
}

function getLegalMoves(gs, playerIdx) {
  const board = gs.boards[playerIdx];
  const moves = [];
  const sources = [];
  gs.factories.forEach((tiles,fi) => {
    if (!tiles.length) return;
    [...new Set(tiles)].forEach(c => sources.push({ source:'factory', factoryIdx:fi, color:c, count:tiles.filter(t=>t===c).length }));
  });
  [...new Set(gs.center)].forEach(c => sources.push({ source:'center', factoryIdx:null, color:c, count:gs.center.filter(t=>t===c).length }));
  for (const src of sources) {
    for (let row=0; row<5; row++) {
      const line=board.patternLines[row], existing=line[0];
      const onWall=board.wall[row].some((v,ci)=>v&&WALL_PATTERN[row][ci]===src.color);
      if (onWall||line.length>=row+1||(existing&&existing!==src.color)) continue;
      moves.push({ ...src, targetRow:row });
    }
    moves.push({ ...src, targetRow:'floor' });
  }
  return moves;
}

function scoreMoveForAI(gs, playerIdx, move, difficulty) {
  const board = gs.boards[playerIdx];
  const { color, targetRow, count, source } = move;
  if (targetRow==='floor') return -10 - count*3;
  const row=parseInt(targetRow), maxLen=row+1, line=board.patternLines[row];
  const placed=Math.min(count, maxLen-line.length), wasted=count-placed;
  let score = placed - wasted*2;
  if (difficulty==='rookie') return score + Math.random()*3;
  score += ((line.length+placed)/maxLen)*5;
  if (line.length>0&&line[0]===color) score+=3;
  if (line.length+placed===maxLen) {
    const col=WALL_PATTERN[row].indexOf(color);
    const sim=gs.boards[playerIdx].wall.map(r=>[...r]); sim[row][col]=color;
    score += scoreWallPlacement(sim,row,col)*2;
  }
  if (source==='center'&&gs.centerHasStart) score-=3;
  if (difficulty==='veteran') return score + Math.random()*1.5;
  const col=WALL_PATTERN[row].indexOf(color);
  let colorCnt=0; gs.boards[playerIdx].wall.forEach(r=>r.forEach(v=>{if(v===color)colorCnt++;}));
  score += colorCnt*1.5;
  let colCnt=0; gs.boards[playerIdx].wall.forEach(r=>{if(r[col])colCnt++;});
  score += colCnt*1.2;
  score += gs.boards[playerIdx].wall[row].filter(v=>v).length;
  score -= wasted*4;
  if (source==='center'&&gs.centerHasStart&&board.floor.length>=3) score-=6;
  return score + Math.random()*0.5;
}

function computeAIMove(gs, playerIdx, difficulty) {
  const moves = getLegalMoves(gs, playerIdx);
  if (!moves.length) return null;
  return moves.map(m=>({move:m, score:scoreMoveForAI(gs,playerIdx,m,difficulty)}))
    .sort((a,b)=>b.score-a.score)[0].move;
}

// ── Disconnect ─────────────────────────────────────────────
function handleDisconnect(ws) {
  const meta = clients.get(ws);
  if (!meta) return;
  clients.delete(ws);
  const room = rooms.get(meta?.roomCode);
  if (!room) return;
  // Remove only non-authenticated players (anonymous players leave for good)
  if (!meta.userId) {
    room.players = room.players.filter(p => p.id !== meta.playerId);
    if (room.players.filter(p=>!p.isAI).length === 0) {
      rooms.delete(meta.roomCode);
    } else {
      broadcast(meta.roomCode, { type:'player_left', players:room.players, gameState:room.gameState });
    }
  }
  // Authenticated players stay in the room — they can rejoin
}

// ── Game logic ─────────────────────────────────────────────
function initGameState(players) {
  let bag=[]; COLORS.forEach(c=>{for(let i=0;i<20;i++)bag.push(c);}); bag=shuffle(bag);
  const n=players.length, factoryCount=n===2?5:n===3?7:9, factories=[];
  for(let i=0;i<factoryCount;i++) factories.push(bag.splice(0,4));
  return {
    round:1, phase:'factory', currentPlayer:0,
    players:players.map(p=>({id:p.id,name:p.name,color:p.color,isAI:p.isAI??false,difficulty:p.difficulty??null,userId:p.userId??null})),
    factories, center:[], centerHasStart:true,
    boards:players.map(()=>({ patternLines:[[],[],[],[],[]], wall:Array(5).fill(null).map(()=>Array(5).fill(null)), floor:[], score:0 })),
    bag, lid:[], startPlayer:0, nextStartPlayer:null, log:[],
  };
}

function placeToFloor(gs, board, tiles) {
  tiles.forEach(t=>{if(board.floor.length<7)board.floor.push(t);else gs.lid.push(t);});
}

function doWallTiling(gs) {
  let gameEnds=false;
  gs.players.forEach((_,pi)=>{
    const board=gs.boards[pi];
    for(let row=0;row<5;row++){
      const line=board.patternLines[row], maxLen=row+1;
      if(line.length===maxLen){
        const color=line[0], col=WALL_PATTERN[row].indexOf(color);
        board.wall[row][col]=color;
        board.score=Math.max(0,board.score+scoreWallPlacement(board.wall,row,col));
        for(let i=0;i<maxLen-1;i++)gs.lid.push(color);
        board.patternLines[row]=[];
        if(board.wall[row].every(v=>v!==null))gameEnds=true;
      }
    }
    board.floor.forEach((t,i)=>{if(t!=='start')gs.lid.push(t);board.score=Math.max(0,board.score+FLOOR_PENALTIES[i]);});
    board.floor=[];
  });
  if(gameEnds){applyEndBonuses(gs);gs.phase='end';}
  else prepareNextRound(gs);
}

function applyEndBonuses(gs) {
  gs.boards.forEach(board=>{
    board.wall.forEach(row=>{if(row.every(v=>v))board.score+=2;});
    for(let col=0;col<5;col++){if(board.wall.every(row=>row[col]))board.score+=7;}
    COLORS.forEach(c=>{let cnt=0;board.wall.forEach(row=>row.forEach(v=>{if(v===c)cnt++;}));if(cnt===5)board.score+=10;});
  });
}

function prepareNextRound(gs) {
  gs.round++; gs.phase='factory'; gs.centerHasStart=true;
  gs.currentPlayer=gs.nextStartPlayer??(gs.startPlayer+1)%gs.players.length;
  gs.startPlayer=gs.currentPlayer; gs.nextStartPlayer=null;
  const needed=gs.factories.length*4;
  if(gs.bag.length<needed){gs.bag.push(...shuffle(gs.lid));gs.lid=[];}
  gs.factories=gs.factories.map(()=>gs.bag.splice(0,4));
}

function scoreWallPlacement(wall,row,col){
  let h=1,v=1;
  for(let c=col-1;c>=0&&wall[row][c];c--)h++;
  for(let c=col+1;c<5&&wall[row][c];c++)h++;
  for(let r=row-1;r>=0&&wall[r][col];r--)v++;
  for(let r=row+1;r<5&&wall[r][col];r++)v++;
  if(h===1&&v===1)return 1;
  return(h>1?h:0)+(v>1?v:0);
}

// ── Persist room state ──────────────────────────────────────
function persistRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  saveGame(code, room.gameState, room.players, room.phase);
}

// ── Utilities ──────────────────────────────────────────────
function send(ws, data) { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(roomCode, data) {
  const payload=JSON.stringify(data);
  clients.forEach((meta,ws)=>{if(meta.roomCode===roomCode&&ws.readyState===WebSocket.OPEN)ws.send(payload);});
}
function generateCode() {
  let code;
  do{code=Math.random().toString(36).substr(2,4).toUpperCase();}while(rooms.has(code));
  return code;
}
function shuffle(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
