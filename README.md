# 🎮 Azul

A real-time multiplayer tile game built with Node.js + WebSockets.

---

## Quick Start (Local / Same WiFi)

### 1. Install dependencies

```bash
cd azul
npm install
```

### 2. Start the server

```bash
npm start
```

You'll see:
```
🎮 Azul server running → http://localhost:3000
```

### 3. Play on your local network

Find your computer's local IP address:
- **Mac/Linux:** `ipconfig getifaddr en0` (or `hostname -I`)
- **Windows:** `ipconfig` → look for IPv4 Address

Then share this URL with players on the same WiFi:
```
http://192.168.x.x:3000
```

Each player opens it on their phone browser. One person creates a room, shares the 4-letter code, others join.

---

## Deploy to the Internet (Play Anywhere)

Pick one of these free options:

---

### Option A — Railway (Recommended, easiest)

1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **"New Project" → "Deploy from GitHub repo"**
3. Push your code to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "Azul"
   gh repo create azul --public --push
   ```
4. In Railway, select your repo
5. Railway auto-detects Node.js and runs `npm start`
6. Click **"Generate Domain"** to get a public URL like `azul.railway.app`
7. Share that URL — anyone worldwide can join!

> Railway gives you 500 free hours/month, more than enough for game nights.

---

### Option B — Render

1. Go to [render.com](https://render.com) and sign up
2. Click **"New" → "Web Service"**
3. Connect your GitHub repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **"Create Web Service"**
6. You'll get a URL like `azul.onrender.com`

> ⚠️ Render's free tier "sleeps" after 15 mins of inactivity. The first player to connect may wait ~30s for it to wake up.

---

### Option C — Fly.io

```bash
npm install -g flyctl
flyctl auth login
flyctl launch   # follow prompts, say yes to Dockerfile generation
flyctl deploy
```

---

## How It Works

```
Players' Phones
      │  WebSocket (ws://)
      ▼
┌─────────────────┐
│  server.js       │  ← Authoritative game state
│  (Node.js + ws)  │  ← All moves validated here
│                  │  ← Broadcasts updates to all players
│  /public/        │  ← Serves index.html (the game UI)
│  index.html      │
└─────────────────┘
```

- **No database needed** — game state lives in memory while the server runs
- **Real-time** — every move is instantly pushed to all players via WebSocket
- **Server-side validation** — the server enforces all game rules, so no cheating

---

## Game Rules Implemented

- ✅ 2–4 players (5/7/9 factory displays)
- ✅ Factory offer phase with tile picking
- ✅ Starting player marker
- ✅ Pattern line placement with full validation
- ✅ Wall-tiling with adjacency scoring
- ✅ Floor line penalties
- ✅ End-of-round preparation & bag refill
- ✅ End-game bonus scoring (rows, columns, full colors)
- ✅ Tiebreaker (complete horizontal lines)

---

## Project Structure

```
azul/
├── server.js          ← WebSocket + HTTP server (all game logic)
├── package.json
├── README.md
└── public/
    └── index.html     ← Game UI (served to players' browsers)
```

---

## Troubleshooting

**"Room not found"** — The server may have restarted (in-memory state is lost). Create a new room.

**Players can't connect** — Make sure your firewall allows port 3000, or use a cloud deploy.

**Render is slow to start** — First request wakes the dyno; wait 20–30 seconds.
