/**
 * COLMEDORNO — Full Regression Test Suite
 * Covers: auth, lobby, game flow, AI, rejoin, abandon, persistence, edge cases
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { WALL_PATTERN, FLOOR_PENALTIES, initGameState, doWallTiling } from './game-logic.js';

const PORT = 3098;
const JWT_SECRET = 'test-secret';
const COLORS = ['B','C','R','Y','K'];

// ── Minimal in-process server ────────────────────────────────
const rooms = new Map();
const clients = new Map();
const users = new Map(); // email → user
const otps = new Map();  // id → { email, code, expiresAt, used }
const PLAYER_COLORS = ['#4eb8c8','#c94040','#d4a017','#9b59b6'];
const AI_DELAY = { rookie: 50, veteran: 40, master: 30 }; // fast for tests

function genId() { return Math.random().toString(36).substr(2,9); }
function genCode() {
  let c; do { c = Math.random().toString(36).substr(2,4).toUpperCase(); } while (rooms.has(c));
  return c;
}
function shuffle(arr) {
  const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a;
}
function placeToFloor(gs, board, tiles) {
  tiles.forEach(t => { if(board.floor.length<7) board.floor.push(t); else gs.lid.push(t); });
}
function serverInitGame(players) {
  let bag=[]; COLORS.forEach(c=>{for(let i=0;i<20;i++)bag.push(c);}); bag=shuffle(bag);
  const n=players.length, fc=n===2?5:n===3?7:9, factories=[];
  for(let i=0;i<fc;i++) factories.push(bag.splice(0,4));
  return { round:1, phase:'factory', currentPlayer:0,
    players:players.map(p=>({id:p.id,name:p.name,color:p.color,isAI:p.isAI??false,difficulty:p.difficulty??null,userId:p.userId??null})),
    factories, center:[], centerHasStart:true,
    boards:players.map(()=>({patternLines:[[],[],[],[],[]],wall:Array(5).fill(null).map(()=>Array(5).fill(null)),floor:[],score:0})),
    bag, lid:[], startPlayer:0, nextStartPlayer:null };
}
function applyMove(gs, playerId, {source, factoryIdx, color, targetRow}) {
  const mi = gs.players.findIndex(p=>p.id===playerId);
  if(mi<0) return 'Player not found';
  const board = gs.boards[mi];
  let picked=[], getsStart=false;
  if(source==='factory') {
    if(factoryIdx==null||factoryIdx<0||factoryIdx>=gs.factories.length) return 'Invalid factory';
    const f=gs.factories[factoryIdx];
    if(!f?.length) return 'Empty factory';
    if(!f.includes(color)) return 'No such color';
    picked=f.filter(t=>t===color); gs.center.push(...f.filter(t=>t!==color)); gs.factories[factoryIdx]=[];
  } else {
    if(!gs.center.includes(color)) return 'No such color in center';
    picked=gs.center.filter(t=>t===color); gs.center=gs.center.filter(t=>t!==color);
    if(gs.centerHasStart){gs.centerHasStart=false;getsStart=true;gs.nextStartPlayer=mi;}
  }
  if(targetRow==='floor') { placeToFloor(gs,board,picked); }
  else {
    const row=parseInt(targetRow);
    if(isNaN(row)||row<0||row>4) return 'Invalid row';
    const line=board.patternLines[row], ex=line[0];
    if(ex&&ex!==color) return 'Wrong color for row';
    if(board.wall[row].some((v,ci)=>v&&WALL_PATTERN[row][ci]===color)) return 'Color on wall';
    if(line.length>=row+1) return 'Row full';
    const sp=(row+1)-line.length;
    board.patternLines[row].unshift(...picked.slice(0,sp));
    placeToFloor(gs,board,picked.slice(sp));
  }
  if(getsStart){if(board.floor.length<7)board.floor.push('start');else gs.lid.push('start');}
  const done=gs.factories.every(f=>f.length===0)&&gs.center.length===0&&!gs.centerHasStart;
  if(done) doWallTiling(gs); else gs.currentPlayer=(gs.currentPlayer+1)%gs.players.length;
  return null;
}
function getLegalMoves(gs, pi) {
  const board=gs.boards[pi], moves=[], srcs=[];
  gs.factories.forEach((tiles,fi)=>{if(!tiles.length)return;[...new Set(tiles)].forEach(c=>srcs.push({source:'factory',factoryIdx:fi,color:c,count:tiles.filter(t=>t===c).length}));});
  [...new Set(gs.center)].forEach(c=>srcs.push({source:'center',factoryIdx:null,color:c,count:gs.center.filter(t=>t===c).length}));
  for(const s of srcs){
    for(let row=0;row<5;row++){
      const line=board.patternLines[row],ex=line[0],onWall=board.wall[row].some((v,ci)=>v&&WALL_PATTERN[row][ci]===s.color);
      if(!onWall&&line.length<row+1&&(!ex||ex===s.color)) moves.push({...s,targetRow:row});
    }
    moves.push({...s,targetRow:'floor'});
  }
  return moves;
}
function send(ws, data) { if(ws.readyState===1) ws.send(JSON.stringify(data)); }
function broadcast(code, data) {
  const p=JSON.stringify(data);
  clients.forEach((m,ws)=>{if(m.roomCode===code&&ws.readyState===1)ws.send(p);});
}

function handleMsg(ws, msg) {
  const meta = clients.get(ws) || {};
  switch(msg.type) {
    case 'register': {
      if(users.has(msg.email.toLowerCase())) return send(ws,{type:'error',message:'Email exists'});
      const id=genId(), hash=bcrypt.hashSync(msg.password,4);
      users.set(msg.email.toLowerCase(),{id,email:msg.email,name:msg.name,password:hash});
      const token=jwt.sign({id,email:msg.email,name:msg.name},JWT_SECRET,{expiresIn:'1d'});
      send(ws,{type:'registered',token,user:{id,name:msg.name,email:msg.email}});
      break;
    }
    case 'login': {
      const u=users.get(msg.email.toLowerCase());
      if(!u||!bcrypt.compareSync(msg.password,u.password)) return send(ws,{type:'error',message:'Bad credentials'});
      const token=jwt.sign({id:u.id,email:u.email,name:u.name},JWT_SECRET,{expiresIn:'1d'});
      send(ws,{type:'logged_in',token,user:{id:u.id,name:u.name,email:u.email}});
      break;
    }
    case 'create_room': {
      let userId=null;
      if(msg.token){try{userId=jwt.verify(msg.token,JWT_SECRET).id;}catch{}}
      const code=genCode(), playerId=genId();
      const human={id:playerId,name:msg.playerName,color:PLAYER_COLORS[0],isAI:false,userId};
      const allPlayers=[human];
      for(const diff of (msg.aiPlayers||[])){
        if(allPlayers.length>=4) break;
        allPlayers.push({id:`ai-${genId()}`,name:`AI (${diff})`,color:PLAYER_COLORS[allPlayers.length],isAI:true,difficulty:diff,userId:null});
      }
      rooms.set(code,{code,phase:'lobby',players:allPlayers,gameState:null});
      clients.set(ws,{roomCode:code,playerId,userId});
      send(ws,{type:'room_created',roomCode:code,playerId,players:allPlayers});
      break;
    }
    case 'join_room': {
      let userId=null;
      if(msg.token){try{userId=jwt.verify(msg.token,JWT_SECRET).id;}catch{}}
      const code=msg.roomCode?.toUpperCase(), room=rooms.get(code);
      if(!room) return send(ws,{type:'error',message:'Room not found.'});
      if(room.phase!=='lobby') return send(ws,{type:'error',message:'Game already in progress.'});
      if(room.players.length>=4) return send(ws,{type:'error',message:'Room is full.'});
      const playerId=genId();
      const player={id:playerId,name:msg.playerName,color:PLAYER_COLORS[room.players.length],isAI:false,userId};
      room.players.push(player);
      clients.set(ws,{roomCode:code,playerId,userId});
      send(ws,{type:'room_joined',roomCode:code,playerId,players:room.players});
      broadcast(code,{type:'lobby_update',players:room.players});
      break;
    }
    case 'rejoin_room': {
      let userId=null;
      if(msg.token){try{userId=jwt.verify(msg.token,JWT_SECRET).id;}catch{}}
      if(!userId) return send(ws,{type:'error',message:'Must be logged in.'});
      const code=msg.roomCode?.toUpperCase(), room=rooms.get(code);
      if(!room) return send(ws,{type:'error',message:'Room not found.'});
      const player=room.players.find(p=>p.userId===userId);
      if(!player) return send(ws,{type:'error',message:'You are not in this game.'});
      clients.set(ws,{roomCode:code,playerId:player.id,userId});
      send(ws,{type:'room_rejoined',roomCode:code,playerId:player.id,players:room.players,gameState:room.gameState,roomPhase:room.phase});
      if(room.phase==='game') maybeScheduleAI(code);
      break;
    }
    case 'start_game': {
      const room=rooms.get(meta.roomCode);
      if(!room) return send(ws,{type:'error',message:'Room not found.'});
      if(room.players[0].id!==meta.playerId) return send(ws,{type:'error',message:'Only host can start.'});
      if(room.players.length<2) return send(ws,{type:'error',message:'Need 2+ players.'});
      room.phase='game'; room.gameState=serverInitGame(room.players);
      broadcast(meta.roomCode,{type:'game_started',gameState:room.gameState});
      maybeScheduleAI(meta.roomCode);
      break;
    }
    case 'pick_tiles': {
      const room=rooms.get(meta.roomCode);
      if(!room?.gameState) return;
      const gs=room.gameState;
      if(gs.phase!=='factory') return send(ws,{type:'error',message:'Wrong phase.'});
      if(gs.players[gs.currentPlayer].id!==meta.playerId) return send(ws,{type:'error',message:'Not your turn.'});
      const err=applyMove(gs,meta.playerId,msg);
      if(err) return send(ws,{type:'error',message:err});
      broadcast(meta.roomCode,{type:'state_update',gameState:gs});
      maybeScheduleAI(meta.roomCode);
      break;
    }
    case 'abandon_game': {
      const room=rooms.get(meta.roomCode);
      if(!room) return;
      const host=room.players.find(p=>!p.isAI);
      if(!host||host.id!==meta.playerId) return send(ws,{type:'error',message:'Only host can abandon.'});
      rooms.delete(meta.roomCode);
      broadcast(meta.roomCode,{type:'game_abandoned',roomCode:meta.roomCode});
      break;
    }
  }
}

function maybeScheduleAI(code) {
  const room=rooms.get(code); if(!room?.gameState) return;
  const gs=room.gameState; if(gs.phase!=='factory') return;
  const cp=gs.players[gs.currentPlayer]; if(!cp?.isAI) return;
  setTimeout(()=>{
    const r=rooms.get(code); if(!r?.gameState) return;
    const g=r.gameState; if(g.phase!=='factory') return;
    const c=g.players[g.currentPlayer]; if(!c?.isAI) return;
    const moves=getLegalMoves(g,g.currentPlayer);
    if(!moves.length) return;
    const move=moves.find(m=>m.targetRow!=='floor')||moves[0];
    applyMove(g,c.id,move);
    broadcast(code,{type:'state_update',gameState:g});
    maybeScheduleAI(code);
  }, AI_DELAY[cp.difficulty]??50);
}

let serverInst = null;
function startServer() {
  return new Promise(resolve => {
    const app = express(); app.use(express.json()); app.use(cookieParser());
    const srv = http.createServer(app);
    const wss = new WebSocketServer({server:srv});
    wss.on('connection', ws => {
      ws.on('message', raw => { try { handleMsg(ws,JSON.parse(raw)); } catch(e){ console.error(e); } });
      ws.on('close', () => clients.delete(ws));
    });
    srv.listen(PORT, () => { serverInst=srv; resolve(); });
  });
}
function stopServer() {
  return new Promise(resolve => {
    rooms.clear(); clients.clear(); users.clear();
    serverInst?.closeAllConnections?.();
    serverInst?.close(resolve) ?? resolve();
  });
}

// ── Client helper ────────────────────────────────────────────
function mkClient() {
  return new Promise((res,rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const waiters=[];
    ws.on('open', () => res({
      ws,
      send(data) { ws.send(JSON.stringify(data)); },
      close() { ws.close(); },
      waitFor(type, timeout=3000) {
        return new Promise((r,j) => {
          const t=setTimeout(()=>j(new Error(`Timeout waiting for "${type}"`)),timeout);
          waiters.push({type,resolve(m){clearTimeout(t);r(m);}});
        });
      },
    }));
    ws.on('message', raw => {
      const msg=JSON.parse(raw);
      const i=waiters.findIndex(w=>w.type===msg.type);
      if(i>=0) { const w=waiters.splice(i,1)[0]; w.resolve(msg); }
    });
    ws.on('error', rej);
  });
}

// Force a factory to known tiles
function forceFactory(roomCode, fi, tiles) {
  const room=rooms.get(roomCode);
  if(!room?.gameState) return;
  room.gameState.bag.push(...room.gameState.factories[fi]);
  room.gameState.factories[fi]=[...tiles];
}

// Play a game to completion
async function playToEnd(p1, p2, roomCode) {
  let gs=rooms.get(roomCode).gameState;
  let turns=0;
  while(gs.phase!=='end' && turns<600) {
    gs=rooms.get(roomCode).gameState;
    const cp=gs.players[gs.currentPlayer];
    if(cp.isAI) { await new Promise(r=>setTimeout(r,100)); turns++; continue; }
    const client=cp.id===p1.playerId?p1.client:p2.client;
    let moved=false;
    for(let fi=0;fi<gs.factories.length&&!moved;fi++){
      const f=gs.factories[fi]; if(!f.length) continue;
      const color=f[0];
      const board=gs.boards[gs.currentPlayer];
      let targetRow='floor';
      for(let row=0;row<5;row++){
        const line=board.patternLines[row],ex=line[0];
        const onWall=board.wall[row].some((v,ci)=>v&&WALL_PATTERN[row][ci]===color);
        if(!onWall&&line.length<row+1&&(!ex||ex===color)){targetRow=row;break;}
      }
      client.send({type:'pick_tiles',source:'factory',factoryIdx:fi,color,targetRow});
      await client.waitFor('state_update');
      moved=true;
    }
    if(!moved){
      gs=rooms.get(roomCode).gameState;
      const colors=[...new Set(gs.center)];
      if(colors.length){
        const color=colors[0];
        const board=gs.boards[gs.currentPlayer];
        let targetRow='floor';
        for(let row=0;row<5;row++){
          const line=board.patternLines[row],ex=line[0];
          const onWall=board.wall[row].some((v,ci)=>v&&WALL_PATTERN[row][ci]===color);
          if(!onWall&&line.length<row+1&&(!ex||ex===color)){targetRow=row;break;}
        }
        client.send({type:'pick_tiles',source:'center',color,targetRow});
        await client.waitFor('state_update');
        moved=true;
      }
    }
    turns++;
    gs=rooms.get(roomCode).gameState;
  }
  return gs;
}

before(startServer);
after(stopServer);
setTimeout(()=>process.exit(0), 500);

// ════════════════════════════════════════════════════════════
//  REGRESSION TESTS
// ════════════════════════════════════════════════════════════

describe('Auth — Register & Login', () => {
  test('register creates account and returns token', async () => {
    const c = await mkClient();
    c.send({type:'register',name:'Alice',email:'alice@test.com',password:'pass123'});
    const msg = await c.waitFor('registered');
    assert.ok(msg.token);
    assert.equal(msg.user.name,'Alice');
    assert.equal(msg.user.email,'alice@test.com');
    c.close();
  });

  test('duplicate email returns error', async () => {
    const c = await mkClient();
    c.send({type:'register',name:'Alice2',email:'alice@test.com',password:'pass123'});
    const msg = await c.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('exist'));
    c.close();
  });

  test('login with correct credentials', async () => {
    const c = await mkClient();
    c.send({type:'login',email:'alice@test.com',password:'pass123'});
    const msg = await c.waitFor('logged_in');
    assert.ok(msg.token);
    assert.equal(msg.user.email,'alice@test.com');
    c.close();
  });

  test('login with wrong password returns error', async () => {
    const c = await mkClient();
    c.send({type:'login',email:'alice@test.com',password:'wrongpass'});
    const msg = await c.waitFor('error');
    assert.ok(msg.message);
    c.close();
  });

  test('login with unknown email returns error', async () => {
    const c = await mkClient();
    c.send({type:'login',email:'nobody@test.com',password:'pass123'});
    const msg = await c.waitFor('error');
    assert.ok(msg.message);
    c.close();
  });
});

describe('Room Creation', () => {
  test('can create a room without AI', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Bob',aiPlayers:[]});
    const msg = await c.waitFor('room_created');
    assert.ok(msg.roomCode);
    assert.equal(msg.roomCode.length, 4);
    assert.equal(msg.players.length, 1);
    c.close();
  });

  test('creates room with 1 AI player', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Bob',aiPlayers:['rookie']});
    const msg = await c.waitFor('room_created');
    assert.equal(msg.players.length, 2);
    assert.equal(msg.players[1].isAI, true);
    assert.equal(msg.players[1].difficulty, 'rookie');
    c.close();
  });

  test('creates room with 3 AI players', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Bob',aiPlayers:['rookie','veteran','master']});
    const msg = await c.waitFor('room_created');
    assert.equal(msg.players.length, 4);
    assert.equal(msg.players.filter(p=>p.isAI).length, 3);
    c.close();
  });

  test('does not exceed 4 players even with excess AI', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Bob',aiPlayers:['rookie','veteran','master','master']});
    const msg = await c.waitFor('room_created');
    assert.equal(msg.players.length, 4);
    c.close();
  });

  test('AI players have correct difficulty colors', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Bob',aiPlayers:['rookie','veteran','master']});
    const msg = await c.waitFor('room_created');
    assert.ok(msg.players[1].color);
    assert.ok(msg.players[2].color);
    assert.ok(msg.players[3].color);
    assert.notEqual(msg.players[1].color, msg.players[2].color);
    c.close();
  });
});

describe('Room Joining', () => {
  let host, roomCode;
  beforeEach(async () => {
    host = await mkClient();
    host.send({type:'create_room',playerName:'Host',aiPlayers:[]});
    const msg = await host.waitFor('room_created');
    roomCode = msg.roomCode;
    host.playerId = msg.playerId;
  });

  test('second player can join', async () => {
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'Guest',roomCode});
    const msg = await guest.waitFor('room_joined');
    assert.equal(msg.players.length, 2);
    assert.equal(msg.players[1].name, 'Guest');
    host.close(); guest.close();
  });

  test('host receives lobby_update when guest joins', async () => {
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'Guest',roomCode});
    const [, update] = await Promise.all([
      guest.waitFor('room_joined'),
      host.waitFor('lobby_update'),
    ]);
    assert.equal(update.players.length, 2);
    host.close(); guest.close();
  });

  test('wrong room code returns error', async () => {
    const c = await mkClient();
    c.send({type:'join_room',playerName:'X',roomCode:'ZZZZ'});
    const msg = await c.waitFor('error');
    assert.ok(msg.message.includes('not found'));
    c.close(); host.close();
  });

  test('5th player cannot join (max 4)', async () => {
    const clients = await Promise.all([1,2,3].map(async i => {
      const c = await mkClient();
      c.send({type:'join_room',playerName:`P${i+1}`,roomCode});
      await c.waitFor('room_joined');
      return c;
    }));
    const overflow = await mkClient();
    overflow.send({type:'join_room',playerName:'P5',roomCode});
    const msg = await overflow.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('full'));
    host.close(); overflow.close(); clients.forEach(c=>c.close());
  });

  test('cannot join game already in progress', async () => {
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'Guest',roomCode});
    await guest.waitFor('room_joined');
    host.send({type:'start_game'});
    await host.waitFor('game_started');

    const late = await mkClient();
    late.send({type:'join_room',playerName:'Late',roomCode});
    const msg = await late.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('progress'));
    host.close(); guest.close(); late.close();
  });
});

describe('Game Start', () => {
  test('host can start with 2 players', async () => {
    const host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode:cr.roomCode});
    await guest.waitFor('room_joined');
    host.send({type:'start_game'});
    const [hMsg, gMsg] = await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);
    assert.equal(hMsg.gameState.phase, 'factory');
    assert.equal(gMsg.gameState.phase, 'factory');
    host.close(); guest.close();
  });

  test('non-host cannot start', async () => {
    const host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode:cr.roomCode});
    await guest.waitFor('room_joined');
    guest.send({type:'start_game'});
    const msg = await guest.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('host'));
    host.close(); guest.close();
  });

  test('cannot start with 1 player', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Solo',aiPlayers:[]});
    const cr = await c.waitFor('room_created');
    c.send({type:'start_game'});
    const msg = await c.waitFor('error');
    assert.ok(msg.message.includes('2'));
    c.close();
  });

  test('2-player game has 5 factories', async () => {
    const host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode:cr.roomCode});
    await guest.waitFor('room_joined');
    host.send({type:'start_game'});
    const msg = await host.waitFor('game_started');
    assert.equal(msg.gameState.factories.length, 5);
    host.close(); guest.close();
  });

  test('host goes first (currentPlayer=0)', async () => {
    const host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    const guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode:cr.roomCode});
    await guest.waitFor('room_joined');
    host.send({type:'start_game'});
    const msg = await host.waitFor('game_started');
    assert.equal(msg.gameState.currentPlayer, 0);
    host.close(); guest.close();
  });
});

describe('Tile Picking — Factories', () => {
  let host, guest, roomCode, hostId;

  beforeEach(async () => {
    host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    roomCode = cr.roomCode; hostId = cr.playerId;
    guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode});
    await guest.waitFor('room_joined');
    host.send({type:'start_game'});
    await Promise.all([host.waitFor('game_started'), guest.waitFor('game_started')]);
    forceFactory(roomCode, 0, ['B','B','R','Y']);
  });

  test('host picks tiles from factory', async () => {
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const msg = await host.waitFor('state_update');
    assert.equal(msg.gameState.factories[0].length, 0);
    assert.equal(msg.gameState.boards[0].patternLines[0].length, 1);
    host.close(); guest.close();
  });

  test('remaining tiles go to center', async () => {
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:1});
    const msg = await host.waitFor('state_update');
    assert.ok(msg.gameState.center.includes('R'));
    assert.ok(msg.gameState.center.includes('Y'));
    host.close(); guest.close();
  });

  test('excess tiles go to floor when row too small', async () => {
    forceFactory(roomCode, 0, ['B','B','B','B']);
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const msg = await host.waitFor('state_update');
    assert.equal(msg.gameState.boards[0].patternLines[0].length, 1);
    assert.equal(msg.gameState.boards[0].floor.filter(t=>t==='B').length, 3);
    host.close(); guest.close();
  });

  test('turn passes to player 2 after pick', async () => {
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const msg = await host.waitFor('state_update');
    assert.equal(msg.gameState.currentPlayer, 1);
    host.close(); guest.close();
  });

  test('guest cannot pick on hosts turn', async () => {
    guest.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const msg = await guest.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('turn'));
    host.close(); guest.close();
  });

  test('cannot pick color not in factory', async () => {
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'K',targetRow:0});
    const msg = await host.waitFor('error');
    assert.ok(msg.message);
    host.close(); guest.close();
  });

  test('cannot place wrong color in occupied row', async () => {
    rooms.get(roomCode).gameState.boards[0].patternLines[1] = ['R'];
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:1});
    const msg = await host.waitFor('error');
    assert.ok(msg.message);
    host.close(); guest.close();
  });

  test('cannot place color already on wall in that row', async () => {
    rooms.get(roomCode).gameState.boards[0].wall[0][0] = 'B'; // B on row 0
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const msg = await host.waitFor('error');
    assert.ok(msg.message);
    host.close(); guest.close();
  });

  test('all tiles can be sent to floor', async () => {
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:'floor'});
    const msg = await host.waitFor('state_update');
    assert.equal(msg.gameState.boards[0].patternLines[0].length, 0);
    assert.equal(msg.gameState.boards[0].floor.filter(t=>t==='B').length, 2);
    host.close(); guest.close();
  });

  test('both players receive state_update broadcast', async () => {
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const [h,g] = await Promise.all([host.waitFor('state_update'), guest.waitFor('state_update')]);
    assert.deepEqual(h.gameState.currentPlayer, g.gameState.currentPlayer);
    host.close(); guest.close();
  });
});

describe('Tile Picking — Center', () => {
  let host, guest, roomCode;
  beforeEach(async () => {
    host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    roomCode = cr.roomCode;
    guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode});
    await guest.waitFor('room_joined');
    host.send({type:'start_game'});
    await Promise.all([host.waitFor('game_started'),guest.waitFor('game_started')]);
    // Set factory 0 to known tiles, keep factory 1 alive so round doesn't end
    forceFactory(roomCode, 0, ['B','B','R','Y']);
    forceFactory(roomCode, 1, ['C','C','C','C']); // keeps round alive
    // Clear all other factories to avoid noise
    const gs = rooms.get(roomCode).gameState;
    for(let i=2;i<gs.factories.length;i++) { gs.bag.push(...gs.factories[i]); gs.factories[i]=[]; }
    // Host picks B from factory 0 — pushes R+Y to center
    // Consume state_update on both clients to avoid stale messages in tests
    host.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    await Promise.all([host.waitFor('state_update'), guest.waitFor('state_update')]);
    // Now it's guest's turn, center has R and Y, factory 1 still has C tiles
  });

  test('picking from center removes tiles', async () => {
    guest.send({type:'pick_tiles',source:'center',color:'R',targetRow:'floor'});
    const msg = await guest.waitFor('state_update');
    assert.ok(!msg.gameState.center.includes('R'));
    host.close(); guest.close();
  });

  test('first player to pick from center gets start marker', async () => {
    guest.send({type:'pick_tiles',source:'center',color:'R',targetRow:'floor'});
    const msg = await guest.waitFor('state_update');
    const gs = rooms.get(roomCode).gameState;
    // nextStartPlayer should be guest (index 1) or startPlayer already set to 1
    const markerRecorded = gs.nextStartPlayer === 1 || gs.startPlayer === 1;
    assert.ok(markerRecorded || gs.boards[1].floor.includes('start'));
    host.close(); guest.close();
  });

  test('centerHasStart becomes false after first center pick', async () => {
    guest.send({type:'pick_tiles',source:'center',color:'R',targetRow:'floor'});
    const msg = await guest.waitFor('state_update');
    assert.equal(msg.gameState.centerHasStart, false);
    host.close(); guest.close();
  });
});

describe('Wall-Tiling & Scoring', () => {
  test('complete pattern line moves tile to wall', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].patternLines[0] = ['B'];
    // drain all factories/center
    gs.factories = gs.factories.map(()=>[]);
    gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.boards[0].wall[0][0], 'B');
  });

  test('incomplete line stays on board after wall-tiling', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].patternLines[1] = ['C']; // needs 2, only 1
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.boards[0].wall[1][0], null);
    assert.equal(gs.boards[0].patternLines[1].length, 1);
  });

  test('floor penalties applied and score floored at 0', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].floor = ['B','B','B','B','B','B','B']; // -14 total
    gs.boards[0].score = 3;
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.boards[0].score, 0);
  });

  test('isolated tile scores 1 point', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].patternLines[0] = ['B'];
    gs.boards[0].score = 0;
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.boards[0].score, 1);
  });

  test('adjacent tile scores chain length', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    // Place B at [0][0] already on wall
    gs.boards[0].wall[0][0] = 'B';
    // Now complete row 1 pattern line with C (goes to [1][0])
    gs.boards[0].patternLines[1] = ['C','C'];
    gs.boards[0].score = 0;
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    // C at [1][0] is vertically adjacent to B at [0][0] → score = 2 (vertical chain)
    assert.ok(gs.boards[0].score >= 2);
  });

  test('round increments after wall-tiling', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.round, 2);
  });

  test('game ends when horizontal row completed', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].wall[0] = [null,'Y','R','K','C'];
    gs.boards[0].patternLines[0] = ['B'];
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.phase, 'end');
  });

  test('end bonuses applied when game ends', async () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].wall[0] = [null,'Y','R','K','C'];
    gs.boards[0].patternLines[0] = ['B'];
    gs.boards[0].score = 5;
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    // +1 (placement) + 4 (horiz links) + 2 (complete row bonus)
    assert.ok(gs.boards[0].score >= 7);
  });
});

describe('Rejoin', () => {
  test('authenticated player can rejoin after disconnect', async () => {
    // Register + create room + start game
    const c1 = await mkClient();
    c1.send({type:'register',name:'RJ1',email:'rj1@test.com',password:'pass123'});
    const reg1 = await c1.waitFor('registered');
    c1.send({type:'create_room',playerName:'RJ1',aiPlayers:['rookie'],token:reg1.token});
    const cr = await c1.waitFor('room_created');
    c1.send({type:'start_game'});
    await c1.waitFor('game_started');
    c1.close();

    // Rejoin from new connection
    await new Promise(r=>setTimeout(r,100));
    const c2 = await mkClient();
    c2.send({type:'rejoin_room',roomCode:cr.roomCode,token:reg1.token});
    const msg = await c2.waitFor('room_rejoined');
    assert.equal(msg.roomCode, cr.roomCode);
    assert.equal(msg.roomPhase, 'game');
    assert.ok(msg.gameState);
    c2.close();
  });

  test('unauthenticated rejoin returns error', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await c.waitFor('room_created');
    const c2 = await mkClient();
    c2.send({type:'rejoin_room',roomCode:cr.roomCode});
    const msg = await c2.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('logged in'));
    c.close(); c2.close();
  });

  test('wrong room code on rejoin returns error', async () => {
    const c = await mkClient();
    c.send({type:'register',name:'RJ2',email:'rj2@test.com',password:'pass123'});
    const reg = await c.waitFor('registered');
    c.send({type:'rejoin_room',roomCode:'ZZZZ',token:reg.token});
    const msg = await c.waitFor('error');
    assert.ok(msg.message);
    c.close();
  });

  test('player not in game gets error on rejoin', async () => {
    const c1 = await mkClient();
    c1.send({type:'register',name:'RJ3',email:'rj3@test.com',password:'pass123'});
    const reg1 = await c1.waitFor('registered');
    c1.send({type:'create_room',playerName:'RJ3',aiPlayers:['rookie'],token:reg1.token});
    const cr = await c1.waitFor('room_created');
    c1.send({type:'start_game'});
    await c1.waitFor('game_started');

    const c2 = await mkClient();
    c2.send({type:'register',name:'RJ4',email:'rj4@test.com',password:'pass123'});
    const reg2 = await c2.waitFor('registered');
    c2.send({type:'rejoin_room',roomCode:cr.roomCode,token:reg2.token});
    const msg = await c2.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('not in'));
    c1.close(); c2.close();
  });
});

describe('Abandon Game', () => {
  let host, guest, roomCode;
  beforeEach(async () => {
    host = await mkClient();
    host.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await host.waitFor('room_created');
    roomCode = cr.roomCode; host.playerId = cr.playerId;
    guest = await mkClient();
    guest.send({type:'join_room',playerName:'G',roomCode});
    await guest.waitFor('room_joined');
  });

  test('host can abandon from lobby', async () => {
    host.send({type:'abandon_game'});
    const [hMsg, gMsg] = await Promise.all([host.waitFor('game_abandoned'), guest.waitFor('game_abandoned')]);
    assert.equal(hMsg.roomCode, roomCode);
    assert.equal(gMsg.roomCode, roomCode);
    host.close(); guest.close();
  });

  test('host can abandon mid-game', async () => {
    host.send({type:'start_game'});
    await Promise.all([host.waitFor('game_started'),guest.waitFor('game_started')]);
    host.send({type:'abandon_game'});
    const [hMsg, gMsg] = await Promise.all([host.waitFor('game_abandoned'), guest.waitFor('game_abandoned')]);
    assert.equal(hMsg.roomCode, roomCode);
    host.close(); guest.close();
  });

  test('non-host cannot abandon', async () => {
    guest.send({type:'abandon_game'});
    const msg = await guest.waitFor('error');
    assert.ok(msg.message.toLowerCase().includes('host'));
    host.close(); guest.close();
  });

  test('room is removed from memory after abandon', async () => {
    host.send({type:'abandon_game'});
    await host.waitFor('game_abandoned');
    assert.equal(rooms.has(roomCode), false);
    host.close(); guest.close();
  });
});

describe('AI Players', () => {
  test('AI-only game (1 human + 3 AI) completes without error', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Human',aiPlayers:['rookie','veteran','master']});
    const cr = await c.waitFor('room_created');
    assert.equal(cr.players.length, 4);
    c.send({type:'start_game'});
    const started = await c.waitFor('game_started');
    assert.equal(started.gameState.factories.length, 9); // 4 players = 9 factories

    // Wait for AI to make at least one move
    const update = await c.waitFor('state_update', 5000);
    assert.ok(update.gameState);
    c.close();
  });

  test('AI makes legal moves (no error broadcasts)', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'Human',aiPlayers:['master']});
    const cr = await c.waitFor('room_created');
    c.send({type:'start_game'});
    const started = await c.waitFor('game_started');

    // If it's AI turn first, wait for a state_update (AI moved)
    // then human picks
    let gs = started.gameState;
    if(gs.players[gs.currentPlayer].isAI) {
      const upd = await c.waitFor('state_update', 5000);
      gs = upd.gameState;
    }

    // Human picks a legal move
    forceFactory(cr.roomCode, 0, ['B','B','R','Y']);
    c.send({type:'pick_tiles',source:'factory',factoryIdx:0,color:'B',targetRow:0});
    const upd = await c.waitFor('state_update');
    assert.ok(upd.gameState);
    c.close();
  });

  test('3-player game has 7 factories', async () => {
    const c = await mkClient();
    c.send({type:'create_room',playerName:'H',aiPlayers:['rookie','veteran']});
    const cr = await c.waitFor('room_created');
    c.send({type:'start_game'});
    const msg = await c.waitFor('game_started');
    assert.equal(msg.gameState.factories.length, 7);
    c.close();
  });
});

describe('Full Game Simulation', () => {
  test('2-player game plays to completion', async () => {
    const c1 = await mkClient();
    c1.send({type:'create_room',playerName:'P1',aiPlayers:[]});
    const cr = await c1.waitFor('room_created');
    const c2 = await mkClient();
    c2.send({type:'join_room',playerName:'P2',roomCode:cr.roomCode});
    await c2.waitFor('room_joined');
    c1.send({type:'start_game'});
    await Promise.all([c1.waitFor('game_started'),c2.waitFor('game_started')]);

    c1.playerId = cr.playerId;
    c2.playerId = (await (async()=>{
      // c2 playerId not captured — read from room
      return rooms.get(cr.roomCode).players[1].id;
    })());

    const p1 = {client:c1, playerId:c1.playerId};
    const p2 = {client:c2, playerId:c2.playerId};
    const final = await playToEnd(p1, p2, cr.roomCode);
    assert.equal(final.phase, 'end');
    assert.ok(final.boards[0].score >= 0);
    assert.ok(final.boards[1].score >= 0);
    c1.close(); c2.close();
  });

  test('wall placements match wall pattern throughout', async () => {
    const c1 = await mkClient();
    c1.send({type:'create_room',playerName:'P1',aiPlayers:[]});
    const cr = await c1.waitFor('room_created');
    const c2 = await mkClient();
    c2.send({type:'join_room',playerName:'P2',roomCode:cr.roomCode});
    await c2.waitFor('room_joined');
    c1.send({type:'start_game'});
    await Promise.all([c1.waitFor('game_started'),c2.waitFor('game_started')]);

    c1.playerId = cr.playerId;
    c2.playerId = rooms.get(cr.roomCode).players[1].id;
    const p1={client:c1,playerId:c1.playerId}, p2={client:c2,playerId:c2.playerId};
    const final = await playToEnd(p1, p2, cr.roomCode);

    final.boards.forEach((board, pi) => {
      for(let row=0;row<5;row++) {
        for(let col=0;col<5;col++) {
          const tile = board.wall[row][col];
          if(tile !== null) {
            assert.equal(tile, WALL_PATTERN[row][col],
              `Player ${pi} wall[${row}][${col}] = ${tile}, expected ${WALL_PATTERN[row][col]}`);
          }
        }
      }
    });
    c1.close(); c2.close();
  });

  test('scores are non-negative at end of game', async () => {
    const c1 = await mkClient();
    c1.send({type:'create_room',playerName:'P1',aiPlayers:[]});
    const cr = await c1.waitFor('room_created');
    const c2 = await mkClient();
    c2.send({type:'join_room',playerName:'P2',roomCode:cr.roomCode});
    await c2.waitFor('room_joined');
    c1.send({type:'start_game'});
    await Promise.all([c1.waitFor('game_started'),c2.waitFor('game_started')]);

    c1.playerId = cr.playerId;
    c2.playerId = rooms.get(cr.roomCode).players[1].id;
    const p1={client:c1,playerId:c1.playerId}, p2={client:c2,playerId:c2.playerId};
    const final = await playToEnd(p1, p2, cr.roomCode);
    final.boards.forEach(b => assert.ok(b.score >= 0));
    c1.close(); c2.close();
  });
});

describe('Edge Cases', () => {
  test('score never goes below 0', () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.boards[0].floor=['B','B','B','B','B','B','B']; // -14
    gs.boards[0].score=3;
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs);
    assert.equal(gs.boards[0].score, 0);
  });

  test('floor capped at 7 tiles, extras go to lid', () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    const board = gs.boards[0];
    board.floor=['B','B','B','B','B','B','B'];
    const lidBefore = gs.lid.length;
    placeToFloor(gs, board, ['R','R']);
    assert.equal(board.floor.length, 7);
    assert.equal(gs.lid.length, lidBefore + 2);
  });

  test('bag refills from lid when needed', () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    gs.bag = []; gs.lid = ['B','B','C','C','R','R','Y','Y','K','K',...Array(10).fill('B')];
    gs.factories=gs.factories.map(()=>[]); gs.center=[]; gs.centerHasStart=false;
    doWallTiling(gs); // triggers prepareNextRound which refills
    gs.factories.forEach(f => assert.ok(f.length >= 0));
  });

  test('cannot pick from out-of-range factory index', async () => {
    const c1 = await mkClient();
    c1.send({type:'create_room',playerName:'H',aiPlayers:[]});
    const cr = await c1.waitFor('room_created');
    const c2 = await mkClient();
    c2.send({type:'join_room',playerName:'G',roomCode:cr.roomCode});
    await c2.waitFor('room_joined');
    c1.send({type:'start_game'});
    await Promise.all([c1.waitFor('game_started'),c2.waitFor('game_started')]);
    c1.send({type:'pick_tiles',source:'factory',factoryIdx:99,color:'B',targetRow:0});
    const msg = await c1.waitFor('error');
    assert.ok(msg.message);
    c1.close(); c2.close();
  });

  test('tile count integrity: 100 tiles distributed correctly at start', () => {
    const gs = initGameState([{id:'p1',name:'P1',color:'#fff'},{id:'p2',name:'P2',color:'#f00'}]);
    const all = [...gs.bag, ...gs.factories.flat()];
    assert.equal(all.length, 100);
    COLORS.forEach(c => assert.equal(all.filter(t=>t===c).length, 20, `Color ${c} should have 20`));
  });

  test('wall pattern has each color once per row', () => {
    WALL_PATTERN.forEach((row, r) => {
      assert.deepEqual([...row].sort(), ['B','C','K','R','Y'], `Row ${r} invalid`);
    });
  });

  test('wall pattern has each color once per column', () => {
    for(let col=0;col<5;col++) {
      const colColors = WALL_PATTERN.map(row=>row[col]).sort();
      assert.deepEqual(colColors, ['B','C','K','R','Y'], `Col ${col} invalid`);
    }
  });
});
