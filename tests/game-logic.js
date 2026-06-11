/**
 * Pure game logic — shared between server.js and tests
 */

export const COLORS = ['B', 'C', 'R', 'Y', 'K'];

export const WALL_PATTERN = [
  ['B', 'Y', 'R', 'K', 'C'],
  ['C', 'B', 'Y', 'R', 'K'],
  ['K', 'C', 'B', 'Y', 'R'],
  ['R', 'K', 'C', 'B', 'Y'],
  ['Y', 'R', 'K', 'C', 'B'],
];

export const FLOOR_PENALTIES = [-1, -1, -2, -2, -2, -3, -3];

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function scoreWallPlacement(wall, row, col) {
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

export function applyEndBonuses(gs) {
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

export function prepareNextRound(gs) {
  gs.round++;
  gs.phase = 'factory';
  gs.centerHasStart = true;
  gs.currentPlayer = gs.nextStartPlayer ?? (gs.startPlayer + 1) % gs.players.length;
  gs.startPlayer = gs.currentPlayer;
  gs.nextStartPlayer = null;
  const needed = gs.factories.length * 4;
  if (gs.bag.length < needed) {
    gs.bag.push(...shuffle(gs.lid));
    gs.lid = [];
  }
  gs.factories = gs.factories.map(() => gs.bag.splice(0, 4));
}

export function doWallTiling(gs) {
  let gameEnds = false;
  gs.players.forEach((_, pi) => {
    const board = gs.boards[pi];
    for (let row = 0; row < 5; row++) {
      const line = board.patternLines[row];
      const maxLen = row + 1;
      if (line.length === maxLen) {
        const color = line[0];
        const col = WALL_PATTERN[row].indexOf(color);
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
  if (gameEnds) {
    applyEndBonuses(gs);
    gs.phase = 'end';
  } else {
    prepareNextRound(gs);
  }
}

export function initGameState(players) {
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
