/**
 * db.js — Persistent storage using sql.js (pure JS SQLite)
 * Saves to disk as azul.db in the project root
 */

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = process.env.DB_PATH ?? path.join(__dirname, 'azul.db');

let db = null;

// ── Init ──────────────────────────────────────────────────
export async function initDB() {
  const SQL = await initSqlJs();

  // Load existing DB from disk, or create fresh
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id        TEXT PRIMARY KEY,
      email     TEXT UNIQUE NOT NULL,
      name      TEXT NOT NULL,
      password  TEXT NOT NULL,
      created   INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id          TEXT PRIMARY KEY,
      room_code   TEXT UNIQUE NOT NULL,
      state       TEXT NOT NULL,
      players     TEXT NOT NULL,
      phase       TEXT NOT NULL DEFAULT 'lobby',
      created     INTEGER DEFAULT (strftime('%s','now')),
      updated     INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS game_players (
      game_id   TEXT NOT NULL,
      user_id   TEXT,
      player_id TEXT NOT NULL,
      seat      INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS otp_requests (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      code       TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created    INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  save();
  console.log('📦 Database ready');
}

// ── Persist to disk ───────────────────────────────────────
export function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Users ─────────────────────────────────────────────────
export function createUser({ id, email, name, password }) {
  db.run(
    'INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)',
    [id, email.toLowerCase().trim(), name.trim(), password]
  );
  save();
}

export function getUserByEmail(email) {
  const res = db.exec(
    'SELECT * FROM users WHERE email = ?',
    [email.toLowerCase().trim()]
  );
  if (!res.length || !res[0].values.length) return null;
  return rowToObj(res[0]);
}

export function getUserById(id) {
  const res = db.exec('SELECT * FROM users WHERE id = ?', [id]);
  if (!res.length || !res[0].values.length) return null;
  return rowToObj(res[0]);
}

// ── Games ─────────────────────────────────────────────────
export function saveGame(roomCode, gameState, players, phase) {
  const id  = roomCode;
  const now = Math.floor(Date.now() / 1000);
  const existing = getGameByCode(roomCode);

  if (existing) {
    db.run(
      'UPDATE games SET state=?, players=?, phase=?, updated=? WHERE room_code=?',
      [JSON.stringify(gameState), JSON.stringify(players), phase, now, roomCode]
    );
  } else {
    db.run(
      'INSERT INTO games (id, room_code, state, players, phase, created, updated) VALUES (?,?,?,?,?,?,?)',
      [id, roomCode, JSON.stringify(gameState), JSON.stringify(players), phase, now, now]
    );
  }
  save();
}

export function getGameByCode(roomCode) {
  const res = db.exec('SELECT * FROM games WHERE room_code = ?', [roomCode]);
  if (!res.length || !res[0].values.length) return null;
  const row = rowToObj(res[0]);
  return {
    ...row,
    state:   row.state   ? JSON.parse(row.state)   : null,
    players: row.players ? JSON.parse(row.players) : [],
  };
}

export function getGamesForUser(userId) {
  // Find all games where this user has a seat
  const res = db.exec(`
    SELECT g.* FROM games g
    INNER JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.user_id = ? AND g.phase != 'ended'
    ORDER BY g.updated DESC
  `, [userId]);
  if (!res.length) return [];
  return res[0].values.map(row => {
    const obj = zipRow(res[0].columns, row);
    return {
      ...obj,
      state:   obj.state   ? JSON.parse(obj.state)   : null,
      players: obj.players ? JSON.parse(obj.players) : [],
    };
  });
}

export function linkPlayerToGame(gameId, userId, playerId, seat) {
  // Upsert: update user_id if seat already exists for this player
  db.run(`
    INSERT INTO game_players (game_id, user_id, player_id, seat)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(game_id, player_id) DO UPDATE SET user_id=excluded.user_id
  `, [gameId, userId, playerId, seat]);
  save();
}

export function markGameEnded(roomCode) {
  db.run("UPDATE games SET phase='ended', updated=? WHERE room_code=?",
    [Math.floor(Date.now()/1000), roomCode]);
  save();
}

// ── OTP / Password reset ─────────────────────────────────
export function createOTP({ id, email, code, expiresAt }) {
  // Invalidate any existing unused OTPs for this email
  db.run("UPDATE otp_requests SET used=1 WHERE email=? AND used=0", [email.toLowerCase().trim()]);
  db.run(
    'INSERT INTO otp_requests (id, email, code, expires_at) VALUES (?,?,?,?)',
    [id, email.toLowerCase().trim(), code, expiresAt]
  );
  save();
}

export function getValidOTP(email, code) {
  const now = Math.floor(Date.now() / 1000);
  const res = db.exec(
    'SELECT * FROM otp_requests WHERE email=? AND code=? AND used=0 AND expires_at > ? ORDER BY created DESC LIMIT 1',
    [email.toLowerCase().trim(), code, now]
  );
  if (!res.length || !res[0].values.length) return null;
  return rowToObj(res[0]);
}

export function consumeOTP(id) {
  db.run("UPDATE otp_requests SET used=1 WHERE id=?", [id]);
  save();
}

export function updateUserPassword(email, hashedPassword) {
  db.run("UPDATE users SET password=? WHERE email=?", [hashedPassword, email.toLowerCase().trim()]);
  save();
}

// ── Helpers ───────────────────────────────────────────────
function rowToObj(result) {
  if (!result.values.length) return null;
  return zipRow(result.columns, result.values[0]);
}

function zipRow(columns, values) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[i]; });
  return obj;
}
