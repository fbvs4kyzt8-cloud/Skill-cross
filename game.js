'use strict';

/* ============================================================
   SKILL CROSS — Game Logic
   State-driven, skill-extensible, AI-ready architecture
   ============================================================ */

// ===== SKILL DEFINITIONS =====
const SKILL_DEFS = {
  double: {
    id: 'double', icon: '⚡', name: 'ダブル',
    desc: '1ターンに2回駒を置く。ただし同じ列（縦・横・斜め）には置けない',
  },
  delete: {
    id: 'delete', icon: '🗑', name: 'デリート',
    desc: '相手の駒を1つ削除した後、続けて自分の駒を1つ置ける追加効果スキル',
  },
  switch: {
    id: 'switch', icon: '🔄', name: 'スイッチ',
    desc: '自分の駒1つと相手の駒1つを選んで位置を入れ替え',
  },
  move: {
    id: 'move', icon: '🚀', name: 'ムーブ',
    desc: '自分の駒→好きな空きマスへ移動。相手の駒→そのまま消滅させる',
  },
  lock: {
    id: 'lock', icon: '🔒', name: 'ロック',
    desc: '追加効果として発動。相手の次のターン中スキルを封じ、その後通常通り駒を1つ置ける',
  },
};
const SKILL_ORDER = ['double', 'delete', 'switch', 'move', 'lock'];
const DEFAULT_SELECTED = ['double', 'delete', 'switch'];

// ===== AI DIFFICULTY CONFIG =====
// delay: ms before AI acts; thinkDelay: extra ms for "hard" lookahead display
const AI_CONFIG = {
  easy:   { delay: 700,  label: 'かんたん', cls: 'easy' },
  normal: { delay: 750,  label: 'ふつう',   cls: 'normal' },
  hard:   { delay: 900,  label: 'つよい',   cls: 'hard' },
};

// ===== STORAGE =====
function loadDefaultSkills() {
  try {
    const s = localStorage.getItem('skillcross_defaults');
    if (s) return JSON.parse(s);
  } catch(e) {}
  return [...DEFAULT_SELECTED];
}
function saveDefaultSkills(arr) {
  try { localStorage.setItem('skillcross_defaults', JSON.stringify(arr)); } catch(e) {}
}

// ===== GAME STATE =====
const EMPTY = 0, P1 = 1, P2 = 2;
const BOARD_SIZE = 5;
const WIN_LENGTH = 4;

let state = {};
let aiDifficulty = 'normal'; // 'easy' | 'normal' | 'hard'

function createInitialState(mode, p1Skills, p2Skills) {
  return {
    mode,
    aiDifficulty,
    board: Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY),
    pieceAge: Array(BOARD_SIZE * BOARD_SIZE).fill(null),
    turn: 0,
    currentPlayer: Math.random() < 0.5 ? P1 : P2,
    phase: 'normal',
    activeSkill: null,
    skillState: {},
    skills: {
      [P1]: { available: [...p1Skills], used: [] },
      [P2]: { available: [...p2Skills], used: [] },
    },
    locked: { [P1]: false, [P2]: false },
    pendingLockFor: null,
    gameOver: false,
    winner: null,
    winCells: [],
    score: { [P1]: 0, [P2]: 0 },
  };
}

// ===== BOARD UTILS =====
function idx(r, c) { return r * BOARD_SIZE + c; }
function pos(i) { return { r: Math.floor(i / BOARD_SIZE), c: i % BOARD_SIZE }; }

function getLines() {
  const lines = [];
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c <= BOARD_SIZE - WIN_LENGTH; c++)
      lines.push(Array.from({length: WIN_LENGTH}, (_, k) => idx(r, c + k)));
  for (let c = 0; c < BOARD_SIZE; c++)
    for (let r = 0; r <= BOARD_SIZE - WIN_LENGTH; r++)
      lines.push(Array.from({length: WIN_LENGTH}, (_, k) => idx(r + k, c)));
  for (let r = 0; r <= BOARD_SIZE - WIN_LENGTH; r++)
    for (let c = 0; c <= BOARD_SIZE - WIN_LENGTH; c++)
      lines.push(Array.from({length: WIN_LENGTH}, (_, k) => idx(r + k, c + k)));
  for (let r = 0; r <= BOARD_SIZE - WIN_LENGTH; r++)
    for (let c = WIN_LENGTH - 1; c < BOARD_SIZE; c++)
      lines.push(Array.from({length: WIN_LENGTH}, (_, k) => idx(r + k, c - k)));
  return lines;
}
const ALL_LINES = getLines();

function checkWin(board) {
  for (const line of ALL_LINES) {
    const first = board[line[0]];
    if (first !== EMPTY && line.every(i => board[i] === first))
      return { winner: first, cells: line };
  }
  return null;
}
function isBoardFull(board) { return board.every(v => v !== EMPTY); }

function shareColumnRowDiag(i1, i2) {
  const {r: r1, c: c1} = pos(i1);
  const {r: r2, c: c2} = pos(i2);
  return r1 === r2 || c1 === c2 || Math.abs(r1 - r2) === Math.abs(c1 - c2);
}

// ===== SKILL LOGIC =====
function canUseSkill(player) { return !state.locked[player]; }
function hasSkill(player, skillId) {
  return state.skills[player].available.includes(skillId) &&
         !state.skills[player].used.includes(skillId);
}
function markSkillUsed(player, skillId) { state.skills[player].used.push(skillId); }

// Returns boolean array: true for any opponent piece (no age restriction)
function getDeletableCells(attackerPlayer) {
  const opponent = attackerPlayer === P1 ? P2 : P1;
  return state.board.map(v => v === opponent);
}
function canDoublePlace(i1, i2, board) {
  return board[i2] === EMPTY && !shareColumnRowDiag(i1, i2);
}
function wouldWin(board, player, index) {
  const b = [...board]; b[index] = player;
  return checkWin(b) !== null;
}

// ===== BOARD EVALUATION =====
function evalBoard(board, player) {
  const opp = player === P1 ? P2 : P1;
  let score = 0;
  for (const line of ALL_LINES) {
    const vals = line.map(i => board[i]);
    const mine = vals.filter(v => v === player).length;
    const oppn = vals.filter(v => v === opp).length;
    if (mine > 0 && oppn === 0) score += mine * mine;
    if (oppn > 0 && mine === 0) score -= oppn * oppn * 1.2;
  }
  return score;
}

// Count max consecutive pieces in any line
function maxThreat(board, player) {
  let max = 0;
  for (const line of ALL_LINES) {
    const count = line.filter(i => board[i] === player).length;
    if (line.every(i => board[i] !== (player === P1 ? P2 : P1)) && count > max) max = count;
  }
  return max;
}

// Simple 2-ply lookahead for HARD mode
function minimax(board, player, depth) {
  const win = checkWin(board);
  if (win) return win.winner === P2 ? 100 + depth : -(100 + depth);
  if (depth === 0 || isBoardFull(board)) return evalBoard(board, P2);
  const opp = player === P1 ? P2 : P1;
  const empties = board.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);
  if (player === P2) {
    let best = -Infinity;
    for (const i of empties) {
      const b = [...board]; b[i] = P2;
      best = Math.max(best, minimax(b, P1, depth - 1));
    }
    return best;
  } else {
    let best = Infinity;
    for (const i of empties) {
      const b = [...board]; b[i] = P1;
      best = Math.min(best, minimax(b, P2, depth - 1));
    }
    return best;
  }
}

// ===== AI MOVE SELECTION BY DIFFICULTY =====
function aiBestMoveEasy(board) {
  // ~40% random, rest: only block if 3-in-a-row threat
  if (Math.random() < 0.4) {
    const empties = board.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);
    return empties.length ? empties[Math.floor(Math.random() * empties.length)] : -1;
  }
  // Win if possible
  for (let i = 0; i < board.length; i++)
    if (board[i] === EMPTY && wouldWin(board, P2, i)) return i;
  // Block only obvious 3-in-a-row
  for (const line of ALL_LINES) {
    const vals = line.map(i => board[i]);
    if (vals.filter(v => v === P1).length === 3 && vals.includes(EMPTY)) {
      const empty = line.find(i => board[i] === EMPTY);
      if (empty !== undefined) return empty;
    }
  }
  // Random fallback
  const empties = board.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);
  return empties.length ? empties[Math.floor(Math.random() * empties.length)] : -1;
}

function aiBestMoveNormal(board) {
  // 1. Win
  for (let i = 0; i < board.length; i++)
    if (board[i] === EMPTY && wouldWin(board, P2, i)) return i;
  // 2. Block
  for (let i = 0; i < board.length; i++)
    if (board[i] === EMPTY && wouldWin(board, P1, i)) return i;
  // 3. Heuristic best
  const empties = board.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);
  if (!empties.length) return -1;
  let best = empties[0], bestScore = -Infinity;
  for (const i of empties) {
    const b = [...board]; b[i] = P2;
    const s = evalBoard(b, P2);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

function aiBestMoveHard(board) {
  // 1. Win
  for (let i = 0; i < board.length; i++)
    if (board[i] === EMPTY && wouldWin(board, P2, i)) return i;
  // 2. Block
  for (let i = 0; i < board.length; i++)
    if (board[i] === EMPTY && wouldWin(board, P1, i)) return i;
  // 3. Block 3-in-a-row threats
  for (const line of ALL_LINES) {
    const vals = line.map(i => board[i]);
    if (vals.filter(v => v === P1).length === 3 && vals.includes(EMPTY)) {
      const empty = line.find(i => board[i] === EMPTY);
      if (empty !== undefined) return empty;
    }
  }
  // 4. 2-ply minimax on top candidates
  const empties = board.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);
  if (!empties.length) return -1;
  // Pre-rank by heuristic to limit minimax candidates
  const ranked = empties.map(i => {
    const b = [...board]; b[i] = P2;
    return { i, score: evalBoard(b, P2) };
  }).sort((a, b) => b.score - a.score).slice(0, 10);
  let best = ranked[0].i, bestScore = -Infinity;
  for (const { i } of ranked) {
    const b = [...board]; b[i] = P2;
    const s = minimax(b, P1, 2);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

function aiBestMove(board, _player) {
  // _player kept for compatibility; AI is always P2 here
  switch (state.aiDifficulty) {
    case 'easy':   return aiBestMoveEasy(board);
    case 'hard':   return aiBestMoveHard(board);
    default:       return aiBestMoveNormal(board);
  }
}

// ===== AI SKILL DECISION =====
function aiDecideSkillEasy() {
  // Use skills rarely (~20% chance if available)
  if (Math.random() > 0.2) return null;
  const available = state.skills[P2].available.filter(s => !state.skills[P2].used.includes(s));
  return available.length ? available[Math.floor(Math.random() * available.length)] : null;
}

function aiDecideSkillNormal() {
  const ai = P2, opp = P1;
  if (!canUseSkill(ai)) return null;
  const available = state.skills[ai].available.filter(s => !state.skills[ai].used.includes(s));
  if (!available.length) return null;

  if (available.includes('lock')) {
    const oppAvail = state.skills[opp].available.filter(s => !state.skills[opp].used.includes(s));
    if (oppAvail.length >= 2) return 'lock';
  }
  if (available.includes('delete')) {
    // Delete any opponent piece that's part of a 3-in-a-line threat
    for (const line of ALL_LINES) {
      const vals = line.map(i => state.board[i]);
      if (vals.filter(v => v === opp).length >= 3) {
        const target = line.find(i => state.board[i] === opp);
        if (target !== undefined) return 'delete';
      }
    }
  }
  if (available.includes('double')) {
    const b1 = aiBestMoveNormal(state.board);
    if (b1 >= 0) {
      const bTemp = [...state.board]; bTemp[b1] = ai;
      const b2 = aiBestMoveNormal(bTemp);
      if (b2 >= 0 && !shareColumnRowDiag(b1, b2)) return 'double';
    }
  }
  return null;
}

function aiDecideSkillHard() {
  const ai = P2, opp = P1;
  if (!canUseSkill(ai)) return null;
  const available = state.skills[ai].available.filter(s => !state.skills[ai].used.includes(s));
  if (!available.length) return null;

  const oppAvail = state.skills[opp].available.filter(s => !state.skills[opp].used.includes(s));
  const myThreat = maxThreat(state.board, ai);
  const oppThreat = maxThreat(state.board, opp);

  // Lock opponent if they have dangerous skills and we're not yet in winning position
  if (available.includes('lock') && oppAvail.length >= 1 && myThreat < 3) return 'lock';

  // Delete: opponent is threatening 3-in-a-row (no age restriction)
  if (available.includes('delete') && oppThreat >= 3) {
    for (const line of ALL_LINES) {
      const vals = line.map(i => state.board[i]);
      if (vals.filter(v => v === opp).length >= 3) {
        const target = line.find(i => state.board[i] === opp);
        if (target !== undefined) return 'delete';
      }
    }
  }

  // Double: use to approach win
  if (available.includes('double') && myThreat >= 2) {
    const b1 = aiBestMoveHard(state.board);
    if (b1 >= 0) {
      const bTemp = [...state.board]; bTemp[b1] = ai;
      const b2 = aiBestMoveHard(bTemp);
      if (b2 >= 0 && !shareColumnRowDiag(b1, b2)) return 'double';
    }
  }

  // Move: disrupt opponent if they're at 3-in-a-row
  if (available.includes('move') && oppThreat >= 3) return 'move';

  // Switch: if we can improve position significantly
  if (available.includes('switch') && myThreat >= 2) {
    const myPieces  = state.board.map((v, i) => v === ai  ? i : -1).filter(i => i >= 0);
    const oppPieces = state.board.map((v, i) => v === opp ? i : -1).filter(i => i >= 0);
    for (const mi of myPieces) {
      for (const oi of oppPieces) {
        const b = [...state.board]; b[mi] = opp; b[oi] = ai;
        if (evalBoard(b, ai) > evalBoard(state.board, ai) + 4) return 'switch';
      }
    }
  }

  return null;
}

function aiDecideSkill() {
  switch (state.aiDifficulty) {
    case 'easy':  return aiDecideSkillEasy();
    case 'hard':  return aiDecideSkillHard();
    default:      return aiDecideSkillNormal();
  }
}

// ===== PLACE PIECE =====
function placePiece(index) {
  state.board[index] = state.currentPlayer;
  state.pieceAge[index] = state.turn;
}

// ===== NEXT TURN =====
function nextTurn() {
  state.turn++;
  const prev = state.currentPlayer;
  state.currentPlayer = prev === P1 ? P2 : P1;

  if (state.pendingLockFor === state.currentPlayer) {
    state.locked[state.currentPlayer] = true;
    state.pendingLockFor = null;
  } else {
    state.locked[state.currentPlayer] = false;
  }

  state.phase = 'normal';
  state.activeSkill = null;
  state.skillState = {};

  renderAll();

  if (!state.gameOver) {
    showTurnAnnounce(state.currentPlayer, () => {
      if (state.mode === 'ai' && state.currentPlayer === P2 && !state.gameOver) {
        scheduleAI();
      }
    });
  }
}

function checkGameEnd() {
  const result = checkWin(state.board);
  if (result) {
    state.gameOver = true;
    state.winner = result.winner;
    state.winCells = result.cells;
    state.score[result.winner]++;
    renderAll();
    setTimeout(showResult, 450);
    return true;
  }
  if (isBoardFull(state.board)) {
    state.gameOver = true;
    state.winner = null;
    renderAll();
    setTimeout(showResult, 450);
    return true;
  }
  return false;
}

// ===== AI TURN =====
function scheduleAI() {
  const delay = AI_CONFIG[state.aiDifficulty].delay;
  showAIThinking(true);
  setTimeout(aiTurn, delay);
}

function aiTurn() {
  showAIThinking(false);
  if (state.gameOver) return;

  const skillToUse = aiDecideSkill();
  if (skillToUse) {
    aiExecuteSkill(skillToUse);
    return;
  }

  const move = aiBestMove(state.board, P2);
  if (move >= 0) {
    placePiece(move);
    renderAll();
    if (!checkGameEnd()) nextTurn();
  } else {
    nextTurn();
  }
}

function aiExecuteSkill(skillId) {
  markSkillUsed(P2, skillId);
  const diff = state.aiDifficulty;

  switch (skillId) {
    case 'double': {
      const b1 = diff === 'easy' ? aiBestMoveEasy(state.board) : diff === 'hard' ? aiBestMoveHard(state.board) : aiBestMoveNormal(state.board);
      if (b1 < 0) { nextTurn(); return; }
      placePiece(b1); renderAll();
      const bTemp = [...state.board];
      const empties = bTemp.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);
      const candidates = empties.filter(i => !shareColumnRowDiag(b1, i));
      if (candidates.length) {
        let best = candidates[Math.floor(Math.random() * candidates.length)], bs = -Infinity;
        if (diff !== 'easy') {
          for (const i of candidates) {
            const b = [...bTemp]; b[i] = P2;
            const s = evalBoard(b, P2);
            if (s > bs) { bs = s; best = i; }
          }
        }
        setTimeout(() => { placePiece(best); renderAll(); if (!checkGameEnd()) nextTurn(); }, 280);
      } else {
        if (!checkGameEnd()) nextTurn();
      }
      break;
    }
    case 'delete': {
      // Step 1: remove best opponent piece
      const deletable = getDeletableCells(P2);
      if (diff === 'easy') {
        const targets = deletable.map((v, i) => v ? i : -1).filter(i => i >= 0);
        if (targets.length) {
          const t = targets[Math.floor(Math.random() * targets.length)];
          state.board[t] = EMPTY; state.pieceAge[t] = null;
        }
      } else {
        let bestTarget = -1, bestScore = -Infinity;
        for (let i = 0; i < state.board.length; i++) {
          if (!deletable[i]) continue;
          const b = [...state.board]; b[i] = EMPTY;
          const s = -evalBoard(b, P1);
          if (s > bestScore) { bestScore = s; bestTarget = i; }
        }
        if (bestTarget >= 0) { state.board[bestTarget] = EMPTY; state.pieceAge[bestTarget] = null; }
      }
      renderAll();
      // Step 2: place own piece after short delay (mirrors player UX)
      setTimeout(() => {
        const move = aiBestMove(state.board, P2);
        if (move >= 0) {
          placePiece(move);
          renderAll();
          if (!checkGameEnd()) nextTurn();
        } else {
          nextTurn();
        }
      }, 320);
      break;
    }
    case 'lock': {
      // Lock is a bonus: apply it, then place a piece normally
      state.pendingLockFor = P1;
      showToast('🔒 AIがロックを使用！あなたの次のターン、スキルは使えない');
      renderAll();
      // Place best piece after lock
      setTimeout(() => {
        const move = aiBestMove(state.board, P2);
        if (move >= 0) {
          placePiece(move);
          renderAll();
          if (!checkGameEnd()) nextTurn();
        } else {
          nextTurn();
        }
      }, 350);
      break;
    }
    case 'switch': {
      const myPieces  = state.board.map((v, i) => v === P2 ? i : -1).filter(i => i >= 0);
      const oppPieces = state.board.map((v, i) => v === P1 ? i : -1).filter(i => i >= 0);
      let bestMyI = -1, bestOppI = -1, bestScore = -Infinity;
      for (const mi of myPieces) {
        for (const oi of oppPieces) {
          const b = [...state.board]; b[mi] = P1; b[oi] = P2;
          const s = evalBoard(b, P2);
          if (s > bestScore) { bestScore = s; bestMyI = mi; bestOppI = oi; }
        }
      }
      if (bestMyI >= 0 && bestOppI >= 0) {
        state.board[bestMyI] = P1; state.board[bestOppI] = P2;
        const tmpAge = state.pieceAge[bestMyI];
        state.pieceAge[bestMyI] = state.pieceAge[bestOppI];
        state.pieceAge[bestOppI] = tmpAge;
      }
      renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }
    case 'move': {
      const myPieces  = state.board.map((v, i) => v === P2 ? i : -1).filter(i => i >= 0);
      const oppPieces = state.board.map((v, i) => v === P1 ? i : -1).filter(i => i >= 0);
      const empties   = state.board.map((v, i) => v === EMPTY ? i : -1).filter(i => i >= 0);

      // Option A: vanish the most dangerous opponent piece
      let vanishTarget = -1, vanishScore = -Infinity;
      for (const pi of oppPieces) {
        const b = [...state.board]; b[pi] = EMPTY;
        const s = -evalBoard(b, P1);
        if (s > vanishScore) { vanishScore = s; vanishTarget = pi; }
      }

      // Option B: move own piece to best empty cell
      let movePiece = -1, moveDest = -1, moveScore = -Infinity;
      for (const pi of myPieces) {
        for (const ei of empties) {
          const b = [...state.board]; b[pi] = EMPTY; b[ei] = P2;
          const s = evalBoard(b, P2);
          if (s > moveScore) { moveScore = s; movePiece = pi; moveDest = ei; }
        }
      }

      // Hard/normal: pick whichever option scores better for AI
      // Easy: prefer vanish randomly
      let useVanish = false;
      if (diff === 'easy') {
        useVanish = vanishTarget >= 0 && Math.random() < 0.5;
      } else {
        // Compare: vanish removes threat vs move improves position
        useVanish = vanishTarget >= 0 && (movePiece < 0 || vanishScore >= moveScore);
      }

      if (useVanish && vanishTarget >= 0) {
        state.board[vanishTarget] = EMPTY; state.pieceAge[vanishTarget] = null;
      } else if (movePiece >= 0 && moveDest >= 0) {
        state.board[moveDest] = P2; state.pieceAge[moveDest] = state.pieceAge[movePiece];
        state.board[movePiece] = EMPTY; state.pieceAge[movePiece] = null;
      }
      renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }
    default: nextTurn();
  }
}

// ===== PLAYER SKILL ACTIVATION =====
function activateSkill(player, skillId) {
  if (state.gameOver) return;
  if (state.currentPlayer !== player) { showToast('自分のターンではありません'); return; }
  if (state.phase === 'lock-place') { showToast('🔒 ロック発動中です。駒を置いてください'); return; }
  if (state.phase === 'delete-place') { showToast('🗑 デリート発動中です。駒を置いてください'); return; }
  if (!canUseSkill(player)) { showToast('🔒 ロック中はスキルを使えない！'); return; }
  if (!hasSkill(player, skillId)) { showToast('このスキルは使用済みです'); return; }

  if (state.activeSkill === skillId) { cancelSkill(); return; }

  state.activeSkill = skillId;
  state.skillState = {};

  switch (skillId) {
    case 'double':
      state.phase = 'double-1';
      showSkillStatus('⚡ ダブル: 1つ目の駒を置く場所を選んでください（この駒で即勝利不可）');
      break;
    case 'delete':
      state.phase = 'delete';
      showSkillStatus('🗑 デリート ①: 削除する相手の駒を選んでください');
      break;
    case 'switch':
      state.phase = 'switch-1';
      showSkillStatus('🔄 スイッチ: 入れ替える自分の駒を選んでください');
      break;
    case 'move':
      state.phase = 'move-1';
      showSkillStatus('🚀 ムーブ: 移動させる駒を選んでください（自分または相手）');
      break;
    case 'lock':
      markSkillUsed(player, skillId);
      state.pendingLockFor = player === P1 ? P2 : P1;
      state.activeSkill = null;
      state.phase = 'lock-place'; // special phase: lock applied, now place a piece
      showSkillStatus('🔒 ロック発動！続けて駒を1つ置いてください');
      renderAll();
      return;
    default:
      state.phase = 'normal';
  }
  renderAll();
}

function cancelSkill() {
  // lock-place / delete-place: bonus already applied, can't cancel — remind player
  if (state.phase === 'lock-place') {
    showToast('🔒 ロックは発動済み。駒を置いてターンを終了してください');
    return;
  }
  if (state.phase === 'delete-place') {
    showToast('🗑 デリートは発動済み。駒を置いてターンを終了してください');
    return;
  }
  // If double-1 was already placed, undo it
  if (state.phase === 'double-2' && state.skillState.firstIndex !== undefined) {
    state.board[state.skillState.firstIndex] = EMPTY;
    state.pieceAge[state.skillState.firstIndex] = null;
  }
  state.phase = 'normal';
  state.activeSkill = null;
  state.skillState = {};
  hideSkillStatus();
  renderAll();
}

// ===== CELL CLICK =====
function onCellClick(index) {
  if (state.gameOver) return;
  if (state.mode === 'ai' && state.currentPlayer === P2) return;

  const player = state.currentPlayer;

  switch (state.phase) {
    case 'normal':
      if (state.board[index] !== EMPTY) return;
      placePiece(index); renderAll();
      if (!checkGameEnd()) nextTurn();
      break;

    // LOCK: bonus effect applied, now place one piece normally
    case 'lock-place': {
      if (state.board[index] !== EMPTY) { showToast('空きマスを選んでください'); return; }
      placePiece(index);
      state.phase = 'normal'; state.skillState = {};
      hideSkillStatus(); renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }

    case 'double-1': {
      if (state.board[index] !== EMPTY) { showToast('空きマスを選んでください'); return; }
      if (wouldWin(state.board, player, index)) { showToast('このスキルだけで即勝利はできません'); return; }
      placePiece(index);
      state.skillState.firstIndex = index;
      state.phase = 'double-2';
      showSkillStatus('⚡ ダブル: 2つ目の駒を置く場所を選んでください（同じ列は不可）');
      renderAll();
      break;
    }
    case 'double-2': {
      if (state.board[index] !== EMPTY) { showToast('空きマスを選んでください'); return; }
      if (!canDoublePlace(state.skillState.firstIndex, index, state.board)) {
        showToast('同じ列・行・斜めには置けません'); return;
      }
      markSkillUsed(player, 'double');
      placePiece(index);
      state.phase = 'normal'; state.activeSkill = null;
      hideSkillStatus(); renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }
    case 'delete': {
      // Step 1: select opponent piece to remove
      const deletable = getDeletableCells(player);
      if (!deletable[index]) { showToast('相手の駒を選んでください'); return; }
      markSkillUsed(player, 'delete');
      state.board[index] = EMPTY; state.pieceAge[index] = null;
      // Transition to step 2: place own piece
      state.phase = 'delete-place';
      state.activeSkill = null;
      showSkillStatus('🗑 デリート ②: 続けて自分の駒を置いてください');
      renderAll();
      break;
    }
    // DELETE step 2: place own piece (bonus effect applied, now commit)
    case 'delete-place': {
      if (state.board[index] !== EMPTY) { showToast('空きマスを選んでください'); return; }
      placePiece(index);
      state.phase = 'normal'; state.skillState = {};
      hideSkillStatus(); renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }
    case 'switch-1': {
      if (state.board[index] !== player) { showToast('自分の駒を選んでください'); return; }
      state.skillState.myPiece = index;
      state.phase = 'switch-2';
      showSkillStatus('🔄 スイッチ: 入れ替える相手の駒を選んでください');
      renderAll();
      break;
    }
    case 'switch-2': {
      const opp = player === P1 ? P2 : P1;
      if (state.board[index] !== opp) { showToast('相手の駒を選んでください'); return; }
      markSkillUsed(player, 'switch');
      const myIdx = state.skillState.myPiece;
      state.board[myIdx] = opp; state.board[index] = player;
      const tmpAge = state.pieceAge[myIdx];
      state.pieceAge[myIdx] = state.pieceAge[index];
      state.pieceAge[index] = tmpAge;
      state.phase = 'normal'; state.activeSkill = null; state.skillState = {};
      hideSkillStatus(); renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }
    case 'move-1': {
      // Select own piece (→ move) or opponent piece (→ vanish)
      if (state.board[index] === EMPTY) { showToast('駒を選んでください'); return; }
      const owner = state.board[index];
      if (owner === player) {
        // Own piece: proceed to pick destination
        state.skillState.pieceIndex = index;
        state.skillState.pieceOwner = owner;
        state.phase = 'move-2';
        showSkillStatus('🚀 ムーブ: 移動先の空きマスを選んでください');
        renderAll();
      } else {
        // Opponent piece: vanish immediately, skill done
        markSkillUsed(player, 'move');
        state.board[index] = EMPTY; state.pieceAge[index] = null;
        state.phase = 'normal'; state.activeSkill = null; state.skillState = {};
        hideSkillStatus(); renderAll();
        if (!checkGameEnd()) nextTurn();
      }
      break;
    }
    case 'move-2': {
      // Place own piece at chosen empty cell
      if (state.board[index] !== EMPTY) { showToast('空きマスを選んでください'); return; }
      markSkillUsed(player, 'move');
      const fromIdx = state.skillState.pieceIndex;
      state.board[index] = player; state.pieceAge[index] = state.pieceAge[fromIdx];
      state.board[fromIdx] = EMPTY; state.pieceAge[fromIdx] = null;
      state.phase = 'normal'; state.activeSkill = null; state.skillState = {};
      hideSkillStatus(); renderAll();
      if (!checkGameEnd()) nextTurn();
      break;
    }
  }
}

// ===== UI HELPERS =====
function showSkillStatus(text) {
  document.getElementById('skill-status-text').textContent = text;
  document.getElementById('skill-status-bar').classList.remove('hidden');
}
function hideSkillStatus() {
  document.getElementById('skill-status-bar').classList.add('hidden');
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
}

function showAIThinking(visible) {
  const el = document.getElementById('overlay-ai-thinking');
  if (el) el.classList.toggle('hidden', !visible);
}

// ===== TURN ANNOUNCE =====
let turnAnnounceTimer = null;
function showTurnAnnounce(player, callback) {
  const overlay = document.getElementById('overlay-turn');
  const textEl  = document.getElementById('turn-announce-text');
  if (!overlay || !textEl) { if (callback) callback(); return; }

  if (turnAnnounceTimer) { clearTimeout(turnAnnounceTimer); }

  // Clear any in-progress animation classes
  overlay.classList.remove('show', 'hide', 'hidden');

  const isLocked = !!state.locked[player];
  let txt, color;
  if (state.mode === 'ai') {
    txt   = player === P1 ? 'あなたのターン' : '相手のターン';
    color = player === P1 ? 'var(--p1)' : 'var(--p2)';
  } else {
    txt   = player === P1 ? 'P1 のターン' : 'P2 のターン';
    color = player === P1 ? 'var(--p1)' : 'var(--p2)';
  }
  if (isLocked) txt += '  🔒';

  textEl.textContent = txt;
  textEl.style.color = color;
  textEl.style.borderColor = color;

  // Force reflow then animate in
  overlay.offsetHeight; // eslint-disable-line
  overlay.classList.add('show');

  // Hold then fade out
  turnAnnounceTimer = setTimeout(() => {
    overlay.classList.remove('show');
    overlay.classList.add('hide');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('hide');
      if (callback) callback();
    }, 200);
  }, 750);
}

// ===== RENDER =====
function renderAll() {
  renderBoard();
  renderPanels();
  renderTurnIndicator();
}

function renderBoard() {
  const boardEl   = document.getElementById('board');
  const player    = state.currentPlayer;
  const opp       = player === P1 ? P2 : P1;
  const deletable = state.phase === 'delete' ? getDeletableCells(player) : null;
  const cells     = boardEl.querySelectorAll('.cell');

  cells.forEach((cell, i) => {
    cell.className = 'cell';
    cell.innerHTML = '';

    const val = state.board[i];
    if (val !== EMPTY) {
      cell.classList.add(val === P1 ? 'piece-p1' : 'piece-p2');
      const piece = document.createElement('div');
      piece.className = 'cell-piece';
      cell.appendChild(piece);
    }

    if (state.winCells.includes(i)) cell.classList.add('winning-cell');

    switch (state.phase) {
      case 'delete':
        if (deletable && deletable[i]) cell.classList.add('deletable');
        break;
      case 'delete-place':
        // After deletion: highlight empty cells for placement
        if (val === EMPTY) cell.classList.add('hint-cell');
        break;
      case 'lock-place':
        if (val === EMPTY) cell.classList.add('hint-cell');
        break;
      case 'switch-1':
        if (val === player) cell.classList.add('selectable-for-skill');
        break;
      case 'switch-2':
        if (i === state.skillState.myPiece) cell.classList.add('active-skill');
        if (val === opp) cell.classList.add('selectable-for-skill');
        break;
      case 'move-1':
        // Own piece: green selectable. Opponent piece: red deletable (will vanish)
        if (val === player) cell.classList.add('selectable-for-skill');
        if (val === opp)    cell.classList.add('deletable');
        break;
      case 'move-2':
        if (i === state.skillState.pieceIndex) cell.classList.add('active-skill');
        if (val === EMPTY) cell.classList.add('hint-cell');
        break;
      case 'double-2':
        if (i === state.skillState.firstIndex) cell.classList.add('active-skill');
        if (val === EMPTY && !shareColumnRowDiag(state.skillState.firstIndex, i))
          cell.classList.add('hint-cell');
        break;
    }
  });
}

function buildBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.index = i;
    cell.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(cell);
  }
}

function renderPanels() {
  renderPlayerPanel(P1);
  renderPlayerPanel(P2);
  document.getElementById('panel-p1').classList.toggle('active-player', state.currentPlayer === P1);
  document.getElementById('panel-p2').classList.toggle('active-player', state.currentPlayer === P2);
  document.getElementById('lock-p1').classList.toggle('visible', !!state.locked[P1]);
  document.getElementById('lock-p2').classList.toggle('visible', !!state.locked[P2]);
  document.getElementById('game-score').textContent = `${state.score[P1]} — ${state.score[P2]}`;
}

function renderPlayerPanel(player) {
  const panelId    = player === P1 ? 'p1-skills' : 'p2-skills';
  const el         = document.getElementById(panelId);
  el.innerHTML     = '';
  const playerSkills   = state.skills[player];
  const isCurrentPlayer = state.currentPlayer === player;
  const isAIPlayer      = state.mode === 'ai' && player === P2;

  playerSkills.available.forEach(skillId => {
    const def    = SKILL_DEFS[skillId];
    const used   = playerSkills.used.includes(skillId);
    const isActive = state.activeSkill === skillId && isCurrentPlayer;

    if (isAIPlayer) {
      const div = document.createElement('div');
      div.className = 'enemy-skill-display' + (used ? ' used' : '');
      div.title = def.name;
      div.innerHTML = `<span>${def.icon}</span><span class="skill-label">${def.name}</span>`;
      el.appendChild(div);
    } else {
      const btn = document.createElement('button');
      btn.className = 'panel-skill-btn' + (used ? ' used' : '') + (isActive ? ' active-skill' : '');
      btn.title = `${def.name}: ${def.desc}`;
      btn.innerHTML = `<span>${def.icon}</span><span class="skill-label">${def.name}</span>`;
      if (!used && isCurrentPlayer) {
        btn.addEventListener('click', () => activateSkill(player, skillId));
      } else {
        btn.disabled = used || !isCurrentPlayer;
      }
      el.appendChild(btn);
    }
  });
}

function renderTurnIndicator() {
  const el    = document.getElementById('turn-indicator');
  const label = document.getElementById('turn-label');
  if (state.gameOver) {
    label.textContent = state.winner ? `${playerName(state.winner)} の勝利！` : '引き分け';
    el.className = 'turn-indicator';
    return;
  }
  const name   = playerName(state.currentPlayer);
  const locked = state.locked[state.currentPlayer] ? ' 🔒' : '';
  label.textContent = `${name} のターン${locked}`;
  el.className = `turn-indicator turn-p${state.currentPlayer}`;
}

function playerName(p) {
  if (state.mode === 'ai') return p === P1 ? 'あなた' : 'AI';
  return p === P1 ? 'P1' : 'P2';
}

function showResult() {
  const overlay = document.getElementById('overlay-result');
  const icon    = document.getElementById('result-icon');
  const title   = document.getElementById('result-title');
  const sub     = document.getElementById('result-sub');
  if (state.winner) {
    icon.textContent = '🏆';
    title.textContent = `${playerName(state.winner)} の勝利！`;
    title.style.color = state.winner === P1 ? 'var(--p1)' : 'var(--p2)';
  } else {
    icon.textContent = '🤝';
    title.textContent = '引き分け';
    title.style.color = 'var(--text)';
  }
  sub.textContent = `${state.score[P1]} — ${state.score[P2]}`;
  overlay.classList.remove('hidden');
}

// ===== SCREEN NAVIGATION =====
const screens = {};
function getScreen(id) {
  if (!screens[id]) screens[id] = document.getElementById(id);
  return screens[id];
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  getScreen(id).classList.add('active');
}

// ===== SKILL SELECTION GRID =====
function buildSkillGrid(containerId, selectedIds, maxSelect, onChanged) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const selected = new Set(selectedIds);
  SKILL_ORDER.forEach(skillId => {
    const def  = SKILL_DEFS[skillId];
    const card = document.createElement('div');
    card.className = 'skill-card' + (selected.has(skillId) ? ' selected' : '');
    card.dataset.skillId = skillId;
    card.innerHTML = `
      <div class="skill-icon">${def.icon}</div>
      <div class="skill-card-body">
        <div class="skill-card-name">${def.name}</div>
        <div class="skill-card-desc">${def.desc}</div>
      </div>
      <div class="skill-checkmark">${selected.has(skillId) ? '✓' : ''}</div>
    `;
    card.addEventListener('click', () => {
      if (selected.has(skillId)) {
        selected.delete(skillId);
        card.classList.remove('selected');
        card.querySelector('.skill-checkmark').textContent = '';
      } else if (selected.size < maxSelect) {
        selected.add(skillId);
        card.classList.add('selected');
        card.querySelector('.skill-checkmark').textContent = '✓';
      } else {
        showToast(`最大${maxSelect}つまで選択できます`); return;
      }
      onChanged([...selected]);
    });
    container.appendChild(card);
  });
  return selected;
}

// ===== GAME SETUP FLOW =====
let gameMode = null;
let p1SelectedSkills = [...loadDefaultSkills()];
let p2SelectedSkills = [...loadDefaultSkills()];
let skillSelectStep  = 0;

function startSkillSelectForP1(mode) {
  gameMode = mode;
  skillSelectStep = 0;
  p1SelectedSkills = [...loadDefaultSkills()];

  const confirmBtn = document.getElementById('btn-confirm-skills');
  buildSkillGrid('skill-select-grid', p1SelectedSkills, 3, (sel) => {
    p1SelectedSkills = sel;
    confirmBtn.disabled = sel.length !== 3;
  });
  document.getElementById('skill-select-title').textContent = mode === 'pvp' ? 'P1: スキルを3つ選択' : 'スキルを3つ選択';
  confirmBtn.disabled = p1SelectedSkills.length !== 3;
  showScreen('screen-skill-select');
}

function onConfirmSkills() {
  if (gameMode === 'pvp' && skillSelectStep === 0) {
    skillSelectStep = 1;
    p2SelectedSkills = [...loadDefaultSkills()];
    const confirmBtn = document.getElementById('btn-confirm-skills');
    buildSkillGrid('skill-select-grid', p2SelectedSkills, 3, (sel) => {
      p2SelectedSkills = sel;
      confirmBtn.disabled = sel.length !== 3;
    });
    document.getElementById('skill-select-title').textContent = 'P2: スキルを3つ選択';
    confirmBtn.disabled = p2SelectedSkills.length !== 3;
  } else {
    if (gameMode === 'ai') p2SelectedSkills = [...loadDefaultSkills()];
    startGame(gameMode, p1SelectedSkills, p2SelectedSkills);
  }
}

function startGame(mode, p1Skills, p2Skills) {
  state = createInitialState(mode, p1Skills, p2Skills);
  buildBoard();
  renderAll();
  hideSkillStatus();
  showAIThinking(false);
  document.getElementById('overlay-result').classList.add('hidden');
  document.getElementById('p1-name').textContent = mode === 'ai' ? 'あなた' : 'P1';
  document.getElementById('p2-name').textContent = mode === 'ai' ? 'AI' : 'P2';

  // Set difficulty badge
  const badge = document.getElementById('difficulty-badge');
  if (badge) {
    if (mode === 'ai') {
      const cfg = AI_CONFIG[aiDifficulty];
      badge.textContent = cfg.label;
      badge.className = `difficulty-badge ${cfg.cls}`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  showScreen('screen-game');

  // Show first turn announce, then start AI if needed
  showTurnAnnounce(state.currentPlayer, () => {
    if (state.currentPlayer === P2 && mode === 'ai') scheduleAI();
  });
}

function rematch() {
  document.getElementById('overlay-result').classList.add('hidden');
  const prevScore = { ...state.score };
  state = createInitialState(state.mode, state.skills[P1].available, state.skills[P2].available);
  state.score = prevScore;
  buildBoard();
  renderAll();
  hideSkillStatus();
  showAIThinking(false);

  showTurnAnnounce(state.currentPlayer, () => {
    if (state.currentPlayer === P2 && state.mode === 'ai') scheduleAI();
  });
}

// ===== INIT / EVENT BINDINGS =====
(function init() {
  // Title
  document.getElementById('btn-local').addEventListener('click', () => showScreen('screen-local-select'));
  document.getElementById('btn-skill-edit').addEventListener('click', () => {
    const defaults  = loadDefaultSkills();
    const saveBtn   = document.getElementById('btn-save-skills');
    let editSelected = [...defaults];
    buildSkillGrid('skill-edit-grid', editSelected, 3, (sel) => {
      editSelected = sel;
      saveBtn.disabled = sel.length !== 3;
    });
    saveBtn.disabled = editSelected.length !== 3;
    showScreen('screen-skill-edit');
  });
  document.getElementById('btn-howto').addEventListener('click', () => showScreen('screen-howto'));

  // Local select
  document.getElementById('back-from-local').addEventListener('click', () => showScreen('screen-title'));
  document.getElementById('btn-pvp').addEventListener('click', () => startSkillSelectForP1('pvp'));
  document.getElementById('btn-ai').addEventListener('click', () => showScreen('screen-ai-difficulty'));

  // Difficulty select
  document.getElementById('back-from-difficulty').addEventListener('click', () => showScreen('screen-local-select'));
  document.querySelectorAll('.difficulty-card').forEach(card => {
    card.addEventListener('click', () => {
      aiDifficulty = card.dataset.difficulty;
      startSkillSelectForP1('ai');
    });
  });

  // Skill select
  document.getElementById('back-from-skill-select').addEventListener('click', () => {
    if (skillSelectStep === 1) {
      skillSelectStep = 0;
      p1SelectedSkills = [...loadDefaultSkills()];
      const confirmBtn = document.getElementById('btn-confirm-skills');
      buildSkillGrid('skill-select-grid', p1SelectedSkills, 3, (sel) => {
        p1SelectedSkills = sel;
        confirmBtn.disabled = sel.length !== 3;
      });
      document.getElementById('skill-select-title').textContent = 'P1: スキルを3つ選択';
      confirmBtn.disabled = p1SelectedSkills.length !== 3;
    } else if (gameMode === 'ai') {
      showScreen('screen-ai-difficulty');
    } else {
      showScreen('screen-local-select');
    }
  });
  document.getElementById('btn-confirm-skills').addEventListener('click', onConfirmSkills);

  // Skill edit
  document.getElementById('back-from-skill-edit').addEventListener('click', () => showScreen('screen-title'));
  document.getElementById('btn-save-skills').addEventListener('click', () => {
    const selected = [...document.querySelectorAll('#skill-edit-grid .skill-card.selected')].map(c => c.dataset.skillId);
    if (selected.length === 3) {
      saveDefaultSkills(selected);
      showToast('✅ デフォルトスキルを保存しました');
      showScreen('screen-title');
    }
  });

  // How to
  document.getElementById('back-from-howto').addEventListener('click', () => showScreen('screen-title'));

  // Game
  document.getElementById('back-from-game').addEventListener('click', () => {
    if (confirm('ゲームを終了しますか？')) {
      showAIThinking(false);
      showScreen('screen-title');
    }
  });
  document.getElementById('btn-cancel-skill').addEventListener('click', cancelSkill);

  // Result
  document.getElementById('btn-rematch').addEventListener('click', rematch);
  document.getElementById('btn-to-title').addEventListener('click', () => {
    document.getElementById('overlay-result').classList.add('hidden');
    showAIThinking(false);
    showScreen('screen-title');
  });

  showScreen('screen-title');
})();
