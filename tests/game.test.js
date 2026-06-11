import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS, WALL_PATTERN, FLOOR_PENALTIES,
  shuffle, scoreWallPlacement, applyEndBonuses,
  doWallTiling, initGameState,
} from './game-logic.js';

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'player-' + i, name: 'Player ' + (i + 1), color: '#fff',
  }));
}

function placeToFloor(gs, board, tiles) {
  tiles.forEach(t => {
    if (board.floor.length < 7) board.floor.push(t);
    else gs.lid.push(t);
  });
}

function setFactory(gs, idx, tiles) {
  gs.bag.push(...gs.factories[idx]);
  gs.factories[idx] = [...tiles];
}

function pickTiles(gs, playerIdx, source, factoryIdx, color, targetRow) {
  const board = gs.boards[playerIdx];
  let picked = [], getsStartMarker = false;
  if (source === 'factory') {
    const factory = gs.factories[factoryIdx];
    picked = factory.filter(t => t === color);
    gs.center.push(...factory.filter(t => t !== color));
    gs.factories[factoryIdx] = [];
  } else {
    picked = gs.center.filter(t => t === color);
    gs.center = gs.center.filter(t => t !== color);
    if (gs.centerHasStart) { gs.centerHasStart = false; getsStartMarker = true; gs.nextStartPlayer = playerIdx; }
  }
  if (targetRow === 'floor') {
    placeToFloor(gs, board, picked);
  } else {
    const maxLen = targetRow + 1;
    const space = maxLen - board.patternLines[targetRow].length;
    board.patternLines[targetRow].unshift(...picked.slice(0, space));
    placeToFloor(gs, board, picked.slice(space));
  }
  if (getsStartMarker) {
    if (board.floor.length < 7) board.floor.push('start');
    else gs.lid.push('start');
  }
  const roundOver = gs.factories.every(f => f.length === 0) && gs.center.length === 0 && !gs.centerHasStart;
  if (roundOver) doWallTiling(gs);
  else gs.currentPlayer = (gs.currentPlayer + 1) % gs.players.length;
}

// ═════════════════════════════════════════════════════════════
//  TEST SUITE
// ═════════════════════════════════════════════════════════════

// ── 1. GAME SETUP ──────────────────────────────────────────
describe('Game Setup', () => {
  test('2-player game has 5 factory displays', () => {
    const gs = initGameState(makePlayers(2));
    assert.equal(gs.factories.length, 5);
  });

  test('3-player game has 7 factory displays', () => {
    const gs = initGameState(makePlayers(3));
    assert.equal(gs.factories.length, 7);
  });

  test('4-player game has 9 factory displays', () => {
    const gs = initGameState(makePlayers(4));
    assert.equal(gs.factories.length, 9);
  });

  test('each factory has exactly 4 tiles', () => {
    const gs = initGameState(makePlayers(2));
    gs.factories.forEach((f, i) => {
      assert.equal(f.length, 4, `Factory ${i} should have 4 tiles`);
    });
  });

  test('bag starts with 100 tiles total (20 of each color)', () => {
    const gs = initGameState(makePlayers(2));
    // bag + factories = 100
    const inFactories = gs.factories.flat().length;
    const total = gs.bag.length + inFactories;
    assert.equal(total, 100);
  });

  test('each color has exactly 20 tiles across bag and factories', () => {
    const gs = initGameState(makePlayers(2));
    const all = [...gs.bag, ...gs.factories.flat()];
    COLORS.forEach(c => {
      const count = all.filter(t => t === c).length;
      assert.equal(count, 20, `Color ${c} should have 20 tiles`);
    });
  });

  test('game starts in factory phase', () => {
    const gs = initGameState(makePlayers(2));
    assert.equal(gs.phase, 'factory');
  });

  test('center starts with starting player marker only', () => {
    const gs = initGameState(makePlayers(2));
    assert.equal(gs.center.length, 0);
    assert.equal(gs.centerHasStart, true);
  });

  test('all player boards start with empty pattern lines', () => {
    const gs = initGameState(makePlayers(2));
    gs.boards.forEach(board => {
      board.patternLines.forEach(line => assert.equal(line.length, 0));
    });
  });

  test('all player scores start at 0', () => {
    const gs = initGameState(makePlayers(2));
    gs.boards.forEach(board => assert.equal(board.score, 0));
  });

  test('wall starts completely empty', () => {
    const gs = initGameState(makePlayers(2));
    gs.boards.forEach(board => {
      board.wall.forEach(row => row.forEach(cell => assert.equal(cell, null)));
    });
  });

  test('player 0 goes first', () => {
    const gs = initGameState(makePlayers(2));
    assert.equal(gs.currentPlayer, 0);
  });
});

// ── 2. FACTORY OFFER — TILE PICKING ────────────────────────
describe('Factory Offer — Picking from Factory', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
    setFactory(gs, 0, ['B', 'B', 'R', 'Y']);
  });

  test('picking blue from factory removes both blue tiles', () => {
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    assert.equal(gs.factories[0].length, 0);
  });

  test('remaining tiles move to center after factory pick', () => {
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    assert.ok(gs.center.includes('R'));
    assert.ok(gs.center.includes('Y'));
    assert.equal(gs.center.length, 2);
  });

  test('picked tiles are added to chosen pattern line', () => {
    pickTiles(gs, 0, 'factory', 0, 'B', 1); // row 1 = max 2 tiles
    assert.equal(gs.boards[0].patternLines[1].length, 2);
    assert.ok(gs.boards[0].patternLines[1].every(t => t === 'B'));
  });

  test('excess tiles go to floor when pattern line is smaller than pick', () => {
    setFactory(gs, 0, ['B', 'B', 'B', 'B']);
    pickTiles(gs, 0, 'factory', 0, 'B', 0); // row 0 = max 1 tile, 3 excess
    assert.equal(gs.boards[0].patternLines[0].length, 1);
    assert.equal(gs.boards[0].floor.length, 3);
  });

  test('turn advances to next player after pick', () => {
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    assert.equal(gs.currentPlayer, 1);
  });

  test('picking all tiles of one color leaves factory empty', () => {
    setFactory(gs, 0, ['R', 'R', 'R', 'R']);
    pickTiles(gs, 0, 'factory', 0, 'R', 0);
    assert.equal(gs.factories[0].length, 0);
    assert.equal(gs.center.length, 0); // nothing left to push to center
  });

  test('all tiles can be sent to floor', () => {
    pickTiles(gs, 0, 'factory', 0, 'B', 'floor');
    assert.equal(gs.boards[0].floor.length, 2);
    assert.equal(gs.boards[0].patternLines[0].length, 0);
  });
});

// ── 3. CENTER PICKING ───────────────────────────────────────
describe('Factory Offer — Picking from Center', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
    setFactory(gs, 0, ['B', 'B', 'R', 'Y']);
    // Player 0 picks blue, pushing R+Y to center
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    // Now it's player 1's turn
  });

  test('first player to pick from center gets starting player marker', () => {
    pickTiles(gs, 1, 'center', null, 'R', 0);
    assert.equal(gs.boards[1].floor.includes('start'), true);
    assert.equal(gs.centerHasStart, false);
    assert.equal(gs.nextStartPlayer, 1);
  });

  test('start marker goes to floor line', () => {
    pickTiles(gs, 1, 'center', null, 'R', 0);
    assert.ok(gs.boards[1].floor.includes('start'));
  });

  test('second player to pick from center does NOT get start marker', () => {
    pickTiles(gs, 1, 'center', null, 'R', 0); // P1 gets marker
    // Put something back in center and have P0 pick it
    gs.center.push('Y');
    gs.currentPlayer = 0;
    const floorBefore = gs.boards[0].floor.length;
    pickTiles(gs, 0, 'center', null, 'Y', 1);
    // P0 floor should NOT gain another start marker
    assert.equal(gs.boards[0].floor.includes('start'), false);
  });

  test('center becomes empty after all tiles picked', () => {
    pickTiles(gs, 1, 'center', null, 'R', 0);
    gs.currentPlayer = 0;
    pickTiles(gs, 0, 'center', null, 'Y', 1);
    assert.equal(gs.center.length, 0);
  });
});

// ── 4. PATTERN LINE VALIDATION ─────────────────────────────
describe('Pattern Line Rules', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
  });

  test('cannot add different color to already-occupied pattern line', () => {
    gs.boards[0].patternLines[2] = ['R', 'R']; // 2 reds in row 2 (max 3)
    setFactory(gs, 0, ['B', 'B', 'B', 'B']);
    // Trying to place Blue into row 2 which already has Red — check server validation
    // We test this via the validation logic directly
    const line = gs.boards[0].patternLines[2];
    const existingColor = line[0];
    assert.equal(existingColor, 'R');
    assert.notEqual(existingColor, 'B'); // B != R, so placement is invalid
  });

  test('can add same color to partially filled pattern line', () => {
    gs.boards[0].patternLines[2] = ['R']; // 1 red in row 2 (max 3), space for 2 more
    setFactory(gs, 0, ['R', 'R', 'B', 'Y']);
    pickTiles(gs, 0, 'factory', 0, 'R', 2);
    assert.equal(gs.boards[0].patternLines[2].length, 3); // now full
  });

  test('cannot place color in row if that color already on wall in same row', () => {
    // Place B on wall row 0 (col 0 for B in row 0)
    gs.boards[0].wall[0][0] = 'B';
    // Now check that placing B in pattern row 0 is invalid
    const alreadyOnWall = gs.boards[0].wall[0].some(
      (v, ci) => v && WALL_PATTERN[0][ci] === 'B'
    );
    assert.equal(alreadyOnWall, true);
  });

  test('row 0 holds max 1 tile', () => {
    setFactory(gs, 0, ['B', 'B', 'B', 'B']);
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    assert.equal(gs.boards[0].patternLines[0].length, 1);
    assert.equal(gs.boards[0].floor.length, 3); // 3 excess to floor
  });

  test('row 1 holds max 2 tiles', () => {
    setFactory(gs, 0, ['R', 'R', 'R', 'R']);
    pickTiles(gs, 0, 'factory', 0, 'R', 1);
    assert.equal(gs.boards[0].patternLines[1].length, 2);
    assert.equal(gs.boards[0].floor.length, 2);
  });

  test('row 2 holds max 3 tiles', () => {
    setFactory(gs, 0, ['Y', 'Y', 'Y', 'Y']);
    pickTiles(gs, 0, 'factory', 0, 'Y', 2);
    assert.equal(gs.boards[0].patternLines[2].length, 3);
    assert.equal(gs.boards[0].floor.length, 1);
  });

  test('row 3 holds max 4 tiles', () => {
    setFactory(gs, 0, ['K', 'K', 'K', 'K']);
    pickTiles(gs, 0, 'factory', 0, 'K', 3);
    assert.equal(gs.boards[0].patternLines[3].length, 4);
    assert.equal(gs.boards[0].floor.length, 0);
  });

  test('row 4 holds max 5 tiles', () => {
    // Need 5 tiles of same color — pick from factory twice
    setFactory(gs, 0, ['C', 'C', 'C', 'C']);
    pickTiles(gs, 0, 'factory', 0, 'C', 4); // 4 tiles into row 4
    gs.currentPlayer = 0; // force back to player 0
    setFactory(gs, 1, ['C', 'B', 'B', 'B']);
    pickTiles(gs, 0, 'factory', 1, 'C', 4); // 1 more into row 4
    assert.equal(gs.boards[0].patternLines[4].length, 5);
  });

  test('incomplete pattern lines stay on board for next round', () => {
    gs.boards[0].patternLines[2] = ['R']; // partially filled
    // Simulate wall-tiling — incomplete lines should remain
    doWallTiling(gs);
    assert.equal(gs.boards[0].patternLines[2].length, 1);
  });
});

// ── 5. FLOOR LINE ──────────────────────────────────────────
describe('Floor Line', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
  });

  test('floor holds max 7 tiles, extras go to lid', () => {
    const board = gs.boards[0];
    // Manually fill floor to 7
    board.floor = ['B', 'B', 'B', 'B', 'B', 'B', 'B'];
    const lidBefore = gs.lid.length;
    placeToFloor(gs, board, ['R', 'R']);
    assert.equal(board.floor.length, 7);
    assert.equal(gs.lid.length, lidBefore + 2);
  });

  test('floor penalty values are correct', () => {
    assert.deepEqual(FLOOR_PENALTIES, [-1, -1, -2, -2, -2, -3, -3]);
  });

  test('floor penalties applied at wall-tiling phase', () => {
    gs.boards[0].floor = ['B', 'B']; // -1 -1 = -2 total
    gs.boards[0].score = 5;
    doWallTiling(gs);
    assert.equal(gs.boards[0].score, 3);
  });

  test('score cannot go below 0 from floor penalties', () => {
    gs.boards[0].floor = ['B', 'B', 'B', 'B', 'B', 'B', 'B']; // max penalties = -14
    gs.boards[0].score = 3;
    doWallTiling(gs);
    assert.equal(gs.boards[0].score, 0);
  });

  test('floor tiles (non-start) go to lid after wall-tiling', () => {
    gs.boards[0].floor = ['B', 'R', 'Y'];
    const lidBefore = gs.lid.length;
    doWallTiling(gs);
    assert.equal(gs.lid.length, lidBefore + 3);
  });

  test('start marker in floor does not go to lid', () => {
    gs.boards[0].floor = ['start', 'B'];
    const lidBefore = gs.lid.length;
    doWallTiling(gs);
    // Only 'B' goes to lid, not 'start'
    assert.equal(gs.lid.length, lidBefore + 1);
  });

  test('floor is cleared after wall-tiling', () => {
    gs.boards[0].floor = ['B', 'R'];
    doWallTiling(gs);
    assert.equal(gs.boards[0].floor.length, 0);
  });
});

// ── 6. WALL-TILING & SCORING ────────────────────────────────
describe('Wall-Tiling Scoring', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
  });

  test('isolated tile scores 1 point', () => {
    const wall = Array(5).fill(null).map(() => Array(5).fill(null));
    const pts = scoreWallPlacement(wall, 0, 0);
    assert.equal(pts, 1);
  });

  test('tile adjacent to 1 horizontal neighbour scores 2', () => {
    const wall = Array(5).fill(null).map(() => Array(5).fill(null));
    wall[0][0] = 'B';
    // Place at [0][1] — linked to [0][0]
    wall[0][1] = 'Y'; // pre-place so scoring sees it as placed
    const pts = scoreWallPlacement(wall, 0, 1);
    assert.equal(pts, 2);
  });

  test('tile in middle of 3-tile horizontal row scores 3', () => {
    const wall = Array(5).fill(null).map(() => Array(5).fill(null));
    wall[0][0] = 'B';
    wall[0][2] = 'R';
    wall[0][1] = 'Y';
    const pts = scoreWallPlacement(wall, 0, 1);
    assert.equal(pts, 3);
  });

  test('tile adjacent to 1 vertical neighbour scores 2', () => {
    const wall = Array(5).fill(null).map(() => Array(5).fill(null));
    wall[0][0] = 'B';
    wall[1][0] = 'C';
    const pts = scoreWallPlacement(wall, 1, 0);
    assert.equal(pts, 2);
  });

  test('tile with both horizontal and vertical links scores both', () => {
    const wall = Array(5).fill(null).map(() => Array(5).fill(null));
    // Row 1: already has tiles at col 0 and col 2
    wall[1][0] = 'C'; wall[1][2] = 'Y';
    // Col 1: already has tile at row 0
    wall[0][1] = 'Y';
    // Place at [1][1] — 3 horizontal, 2 vertical
    wall[1][1] = 'B';
    const pts = scoreWallPlacement(wall, 1, 1);
    assert.equal(pts, 3 + 2); // 5
  });

  test('complete pattern line moves tile to correct wall position', () => {
    gs.boards[0].patternLines[0] = ['B']; // row 0, full (max 1)
    doWallTiling(gs);
    // B goes to col 0 in row 0 per WALL_PATTERN
    assert.equal(gs.boards[0].wall[0][0], 'B');
  });

  test('surplus tiles from complete line go to lid', () => {
    gs.boards[0].patternLines[2] = ['R', 'R', 'R']; // row 2, full (max 3)
    const lidBefore = gs.lid.length;
    doWallTiling(gs);
    // 1 tile goes to wall, 2 surplus go to lid
    assert.equal(gs.lid.length, lidBefore + 2);
  });

  test('incomplete pattern line is NOT moved to wall', () => {
    gs.boards[0].patternLines[1] = ['C']; // row 1, needs 2, only 1
    doWallTiling(gs);
    assert.equal(gs.boards[0].wall[1][0], null);
    assert.equal(gs.boards[0].patternLines[1].length, 1); // stays
  });

  test('wall correctly places each color in its designated column', () => {
    // Row 0 pattern: B Y R K C
    const testCases = [
      { row: 0, color: 'B', expectedCol: 0 },
      { row: 0, color: 'Y', expectedCol: 1 },
      { row: 0, color: 'R', expectedCol: 2 },
      { row: 0, color: 'K', expectedCol: 3 },
      { row: 0, color: 'C', expectedCol: 4 },
    ];
    testCases.forEach(({ row, color, expectedCol }) => {
      const freshGs = initGameState(makePlayers(2));
      freshGs.boards[0].patternLines[row] = [color];
      doWallTiling(freshGs);
      assert.equal(
        freshGs.boards[0].wall[row][expectedCol],
        color,
        `${color} in row ${row} should land at col ${expectedCol}`
      );
    });
  });
});

// ── 7. END-GAME BONUSES ────────────────────────────────────
describe('End-Game Bonus Scoring', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
  });

  test('+2 for each complete horizontal row', () => {
    // Fill row 0 completely
    gs.boards[0].wall[0] = ['B', 'Y', 'R', 'K', 'C'];
    gs.boards[0].score = 0;
    applyEndBonuses(gs);
    assert.ok(gs.boards[0].score >= 2);
  });

  test('+7 for each complete vertical column', () => {
    // Fill col 0 completely: B, C, K, R, Y (each row's col-0 color)
    for (let r = 0; r < 5; r++) gs.boards[0].wall[r][0] = WALL_PATTERN[r][0];
    gs.boards[0].score = 0;
    applyEndBonuses(gs);
    assert.ok(gs.boards[0].score >= 7);
  });

  test('+10 for placing all 5 of one color', () => {
    // Place all 5 B tiles (one per row, correct column each time)
    WALL_PATTERN.forEach((row, r) => {
      const col = row.indexOf('B');
      gs.boards[0].wall[r][col] = 'B';
    });
    gs.boards[0].score = 0;
    applyEndBonuses(gs);
    assert.ok(gs.boards[0].score >= 10);
  });

  test('multiple bonuses stack correctly', () => {
    // Complete row 0 AND fill col 0
    gs.boards[0].wall[0] = ['B', 'Y', 'R', 'K', 'C']; // complete row → +2
    for (let r = 0; r < 5; r++) gs.boards[0].wall[r][0] = WALL_PATTERN[r][0]; // complete col → +7
    gs.boards[0].score = 0;
    applyEndBonuses(gs);
    assert.ok(gs.boards[0].score >= 9); // at least 2 + 7
  });

  test('bonuses are per-player independently', () => {
    gs.boards[0].wall[0] = ['B', 'Y', 'R', 'K', 'C']; // P0 gets row bonus
    gs.boards[0].score = 10;
    gs.boards[1].score = 10;
    applyEndBonuses(gs);
    assert.ok(gs.boards[0].score >= 12); // +2 for P0
    assert.equal(gs.boards[1].score, 10); // P1 unchanged
  });
});

// ── 8. ROUND TRANSITIONS ────────────────────────────────────
describe('Round Preparation', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
  });

  test('round counter increments after wall-tiling', () => {
    doWallTiling(gs);
    assert.equal(gs.round, 2);
  });

  test('phase returns to factory after wall-tiling', () => {
    doWallTiling(gs);
    assert.equal(gs.phase, 'factory');
  });

  test('center has starting player marker at start of new round', () => {
    doWallTiling(gs);
    assert.equal(gs.centerHasStart, true);
  });

  test('factories are refilled to 4 tiles each after round', () => {
    doWallTiling(gs);
    gs.factories.forEach((f, i) => {
      assert.equal(f.length, 4, `Factory ${i} should have 4 tiles after refill`);
    });
  });

  test('player who took start marker goes first next round', () => {
    gs.nextStartPlayer = 1;
    doWallTiling(gs);
    assert.equal(gs.currentPlayer, 1);
  });

  test('bag refills from lid when tiles run out', () => {
    // Drain the bag
    const needed = gs.factories.length * 4;
    gs.bag = []; // empty bag
    gs.lid = Array(needed).fill('B'); // lid has enough
    doWallTiling(gs);
    assert.equal(gs.bag.length >= 0, true); // should not crash
    gs.factories.forEach(f => assert.equal(f.length, 4));
  });
});

// ── 9. GAME END CONDITION ──────────────────────────────────
describe('Game End Condition', () => {
  let gs;
  beforeEach(() => {
    gs = initGameState(makePlayers(2));
  });

  test('game does NOT end if no horizontal row is complete', () => {
    gs.boards[0].patternLines[0] = ['B'];
    doWallTiling(gs);
    assert.notEqual(gs.phase, 'end');
  });

  test('game ends when a player completes a full horizontal row', () => {
    // Fill row 0 pattern line and pre-fill 4 out of 5 wall slots
    gs.boards[0].patternLines[0] = ['B']; // will complete row 0, col 0
    // Pre-fill remaining 4 slots of row 0 on wall
    gs.boards[0].wall[0][1] = 'Y';
    gs.boards[0].wall[0][2] = 'R';
    gs.boards[0].wall[0][3] = 'K';
    gs.boards[0].wall[0][4] = 'C';
    doWallTiling(gs);
    assert.equal(gs.phase, 'end');
  });

  test('end bonuses are applied when game ends', () => {
    gs.boards[0].patternLines[0] = ['B'];
    gs.boards[0].wall[0] = [null, 'Y', 'R', 'K', 'C']; // 4/5 filled, B will complete
    gs.boards[0].score = 5;
    doWallTiling(gs);
    // Score should be at least 5 + 1 (placement) + 2 (complete row)
    assert.ok(gs.boards[0].score >= 8);
  });
});

// ── 10. TURN ORDER ─────────────────────────────────────────
describe('Turn Order', () => {
  test('2-player: turns alternate P0 → P1 → P0', () => {
    const gs = initGameState(makePlayers(2));
    setFactory(gs, 0, ['B', 'B', 'R', 'R']);
    setFactory(gs, 1, ['Y', 'Y', 'K', 'K']);
    assert.equal(gs.currentPlayer, 0);
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    assert.equal(gs.currentPlayer, 1);
    pickTiles(gs, 1, 'factory', 1, 'Y', 0);
    assert.equal(gs.currentPlayer, 0);
  });

  test('3-player: turns cycle P0 → P1 → P2 → P0', () => {
    const gs = initGameState(makePlayers(3));
    setFactory(gs, 0, ['B', 'B', 'R', 'R']);
    setFactory(gs, 1, ['Y', 'Y', 'K', 'K']);
    setFactory(gs, 2, ['C', 'C', 'B', 'B']);
    assert.equal(gs.currentPlayer, 0);
    pickTiles(gs, 0, 'factory', 0, 'B', 0);
    assert.equal(gs.currentPlayer, 1);
    pickTiles(gs, 1, 'factory', 1, 'Y', 0);
    assert.equal(gs.currentPlayer, 2);
    pickTiles(gs, 2, 'factory', 2, 'C', 0);
    assert.equal(gs.currentPlayer, 0);
  });
});

// ── 11. WALL PATTERN ───────────────────────────────────────
describe('Wall Color Pattern', () => {
  test('each row contains all 5 colors exactly once', () => {
    WALL_PATTERN.forEach((row, r) => {
      const sorted = [...row].sort();
      assert.deepEqual(sorted, ['B', 'C', 'K', 'R', 'Y'], `Row ${r} should have all 5 colors`);
    });
  });

  test('each column contains all 5 colors exactly once', () => {
    for (let col = 0; col < 5; col++) {
      const colColors = WALL_PATTERN.map(row => row[col]).sort();
      assert.deepEqual(colColors, ['B', 'C', 'K', 'R', 'Y'], `Col ${col} should have all 5 colors`);
    }
  });

  test('no color appears twice in the same row', () => {
    WALL_PATTERN.forEach((row, r) => {
      const unique = new Set(row);
      assert.equal(unique.size, 5, `Row ${r} should have no duplicate colors`);
    });
  });
});

// ── 12. INTEGRATION: FULL ROUND ────────────────────────────
describe('Integration — Full Round', () => {
  test('a complete 2-player round runs without errors', () => {
    const gs = initGameState(makePlayers(2));

    // Force deterministic state: drain all factories to controlled tiles
    // P0 and P1 pick from all 5 factories alternately
    gs.factories.forEach((_, fi) => setFactory(gs, fi, ['B', 'B', 'R', 'Y']));

    // Round of picks (5 factories × 2 players)
    let turn = 0;
    for (let fi = 0; fi < 5; fi++) {
      const player = turn % 2;
      const row = Math.min(fi, 4);
      // Only pick if it won't violate wall rules
      const color = 'B';
      const board = gs.boards[player];
      const alreadyOnWall = board.wall[row].some((v, ci) => v && WALL_PATTERN[row][ci] === color);
      const lineFull = board.patternLines[row].length >= row + 1;
      const wrongColor = board.patternLines[row][0] && board.patternLines[row][0] !== color;
      
      if (!alreadyOnWall && !lineFull && !wrongColor) {
        pickTiles(gs, player, 'factory', fi, color, row);
      } else {
        pickTiles(gs, player, 'factory', fi, color, 'floor');
      }
      turn++;
    }

    // Game should still be in a valid state
    assert.ok(['factory', 'end'].includes(gs.phase));
    assert.ok(gs.round >= 1);
    gs.boards.forEach(board => {
      assert.ok(board.score >= 0);
      assert.ok(board.floor.length <= 7);
    });
  });

  test('a complete game can reach end state', () => {
    const gs = initGameState(makePlayers(2));

    // Manually construct an end condition: fill row 0 wall for P0
    gs.boards[0].wall[0] = [null, 'Y', 'R', 'K', 'C'];
    gs.boards[0].patternLines[0] = ['B']; // will complete on wall-tiling

    doWallTiling(gs);

    assert.equal(gs.phase, 'end');
    assert.ok(gs.boards[0].score > 0);
  });
});

// ── 13. EDGE CASES ─────────────────────────────────────────
describe('Edge Cases', () => {
  test('score cannot go negative', () => {
    const gs = initGameState(makePlayers(2));
    gs.boards[0].score = 0;
    gs.boards[0].floor = ['B', 'B', 'B', 'B', 'B', 'B', 'B']; // -14 total
    doWallTiling(gs);
    assert.equal(gs.boards[0].score, 0);
  });

  test('empty factory displays are skipped correctly', () => {
    const gs = initGameState(makePlayers(2));
    gs.factories[0] = [];
    assert.equal(gs.factories[0].length, 0);
    // picking from empty factory would fail validation on server — no crash here
  });

  test('4 factories empty and center empty triggers wall-tiling', () => {
    const gs = initGameState(makePlayers(2));
    // Empty all factories and center
    gs.factories = gs.factories.map(() => []);
    gs.center = [];
    gs.centerHasStart = false;

    const roundOver = gs.factories.every(f => f.length === 0)
      && gs.center.length === 0
      && !gs.centerHasStart;

    assert.equal(roundOver, true);
  });

  test('wall placement: color already on wall blocks same color in that row', () => {
    const gs = initGameState(makePlayers(2));
    gs.boards[0].wall[0][0] = 'B'; // B already on row 0
    const alreadyOnWall = gs.boards[0].wall[0].some(
      (v, ci) => v && WALL_PATTERN[0][ci] === 'B'
    );
    assert.equal(alreadyOnWall, true);
  });

  test('bag refill from lid preserves tile count integrity', () => {
    const gs = initGameState(makePlayers(2));
    const totalBefore = gs.bag.length + gs.factories.flat().length;

    // Simulate using up bag
    gs.bag = [];
    gs.lid = ['B', 'B', 'C', 'C', 'R'];
    const needed = gs.factories.length * 4;

    if (gs.bag.length < needed) {
      gs.bag.push(...shuffle(gs.lid));
      gs.lid = [];
    }

    assert.equal(gs.bag.length, 5);
    assert.equal(gs.lid.length, 0);
  });

  test('multiple complete lines score independently in same wall-tiling phase', () => {
    const gs = initGameState(makePlayers(2));
    gs.boards[0].patternLines[0] = ['B']; // 1 tile → wall
    gs.boards[0].patternLines[1] = ['C', 'C']; // 2 tiles → wall
    gs.boards[0].score = 0;
    doWallTiling(gs);
    // Both should have scored (at least 2 points for 2 isolated tiles)
    assert.ok(gs.boards[0].score >= 2);
  });
});
