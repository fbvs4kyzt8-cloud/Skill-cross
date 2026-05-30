'use strict';

/* ============================================================
   SOUND MANAGER
   音声ファイルを一元管理。音量変更・ミュートは VOLUME 定数で制御。
   連続再生対応のため currentTime = 0 でリセットしてから play()。
   ============================================================ */
const SoundManager = (() => {
  // ── 音量設定（0.0 〜 1.0）─────────────────────────────────
  const VOLUME = {
    select : 0.5,
    place  : 0.55,
    win    : 0.7,
  };

  // ── Audio インスタンスを生成・プリロード ───────────────────
  function _load(path, volume) {
    const audio = new Audio(path);
    audio.preload = 'auto';
    audio.volume  = volume;
    return audio;
  }

  const _sounds = {
    select : _load('sounds/select.mp3', VOLUME.select),
    place  : _load('sounds/place.mp3',  VOLUME.place),
    win    : _load('sounds/win.mp3',    VOLUME.win),
  };

  // ── 再生（連続タップでも最初から鳴らす）──────────────────
  function play(name) {
    const audio = _sounds[name];
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {}); // autoplay policy エラーを無視
  }

  // ── 音量一括変更 API ──────────────────────────────────────
  function setVolume(name, vol) {
    if (_sounds[name]) _sounds[name].volume = Math.min(1, Math.max(0, vol));
  }
  function setAllVolumes(vol) {
    Object.keys(_sounds).forEach(k => setVolume(k, vol));
  }

  return { play, setVolume, setAllVolumes };
})();

/* ============================================================
   SKILL CROSS — Game Logic
   ============================================================ */

// ===== SKILL DEFINITIONS =====
const SKILL_DEFS = {
  double:   { id:'double',   icon:'⚡', name:'ダブル',    desc:'1ターンに2回駒を置く。同じ列（縦・横・斜め）には置けない' },
  delete:   { id:'delete',   icon:'🗑', name:'デリート',  desc:'相手の駒を1つ削除し、続けて自分の駒を1つ置ける' },
  switch:   { id:'switch',   icon:'🔄', name:'スイッチ',  desc:'自分の駒1つと相手の駒1つを入れ替える' },
  lock:     { id:'lock',     icon:'🔒', name:'ロック',    desc:'相手の次のターンのスキルを封じ、続けて駒を1つ置ける' },
  guard:    { id:'guard',    icon:'🛡', name:'ガード',    desc:'自分の駒1つをガード状態にする。デリート・スイッチを1回無効化（2ターン持続）。その後駒を置ける' },
  celllock: { id:'celllock', icon:'⛓', name:'マスロック', desc:'任意の1マスを2ターン封鎖。自分も相手も使用不可。続けて駒を1つ置ける' },
};
const SKILL_ORDER      = ['double','delete','switch','lock','guard','celllock'];
const DEFAULT_SELECTED = ['double','delete','guard'];
const GUARD_DURATION    = 2;
const CELLLOCK_DURATION = 2;

// ===== AI CONFIG =====
const AI_CONFIG = {
  easy:   { delay: 700,  label:'かんたん', cls:'easy'   },
  normal: { delay: 750,  label:'ふつう',   cls:'normal' },
  hard:   { delay: 900,  label:'つよい',   cls:'hard'   },
  max:    { delay: 1200, label:'最強',     cls:'max'    },
};

// ===== STORAGE =====
function loadDefaultSkills() {
  try {
    const parsed = JSON.parse(localStorage.getItem('skillcross_defaults') || '[]');
    const valid  = parsed.filter(id => SKILL_DEFS[id]);
    if (valid.length === 3) return valid;
  } catch(e) {}
  return [...DEFAULT_SELECTED];
}
function saveDefaultSkills(arr) {
  try { localStorage.setItem('skillcross_defaults', JSON.stringify(arr)); } catch(e) {}
}

// ===== CONSTANTS =====
const EMPTY = 0, P1 = 1, P2 = 2;
const BOARD_SIZE      = 5;
const WIN_LENGTH      = 4;
const STOCK_WIN_COUNT = 3;

// ===== GAME STATE =====
let state = {};
let aiDifficulty = 'normal';

function createInitialState(mode, p1Skills, p2Skills) {
  return {
    mode,
    aiDifficulty,
    board:     Array(BOARD_SIZE * BOARD_SIZE).fill(EMPTY),
    pieceAge:  Array(BOARD_SIZE * BOARD_SIZE).fill(null),
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
    guardedCells: {},
    lockedCells:  {},
    gameOver: false,
    winner:   null,
    winCells: [],
    score: { [P1]: 0, [P2]: 0 },
  };
}

/* ============================================================
   BATTLE MODE MODULE
   Handles Simple / Draft / Stock pre-game flow and post-game
   routing. Extend here for future online mode.
   ============================================================ */
const BattleMode = (() => {

  // ── context ─────────────────────────────────────────────────
  let _pvpMode    = 'pvp';    // 'pvp' | 'ai'
  let _battleType = 'simple'; // 'simple' | 'draft' | 'stock'

  // skill buffers (simple / stock)
  let _p1Skills = [...DEFAULT_SELECTED];
  let _p2Skills = [...DEFAULT_SELECTED];

  // draft state
  const _draft = {
    picks: { [P1]: [], [P2]: [] },
    // Snake-draft order: P1→P2→P2→P1→P1→P2
    ORDER: [P1, P2, P2, P1, P1, P2],
    step:  0,
  };

  // stock state
  const _stock = {
    wins:   { [P1]: 0, [P2]: 0 },
    skills: { [P1]: [...DEFAULT_SELECTED], [P2]: [...DEFAULT_SELECTED] },
    loser:  null,
  };

  // skill-select callback (set by _openSkillSelect, fired by init's confirm button)
  let _onConfirm = null;

  // ── Public API ───────────────────────────────────────────────
  function setup(pvpMode, battleType) {
    _pvpMode    = pvpMode;
    _battleType = battleType;
  }

  function startFlow() {
    switch (_battleType) {
      case 'draft': _startDraft();     break;
      case 'stock': _startStockNew();  break;
      default:      _startSimple();    break;
    }
  }

  // Called by checkGameEnd after every match
  function onGameEnd(winner) {
    switch (_battleType) {
      case 'draft': _endDraft(winner);  break;
      case 'stock': _endStock(winner);  break;
      default:      _endSimple(winner); break;
    }
  }

  // Fired by the confirm button in init()
  function confirmSkills() {
    if (_onConfirm) { const cb = _onConfirm; _onConfirm = null; cb(); }
  }

  // Getters for render helpers
  function getBattleType() { return _battleType; }
  function getPvpMode()    { return _pvpMode; }
  function getStockWins()  { return { ..._stock.wins }; }

  // ── SIMPLE ──────────────────────────────────────────────────
  function _startSimple() {
    _p1Skills = [...loadDefaultSkills()];
    if (_pvpMode === 'ai') {
      _openSkillSelect({
        title: 'スキルを3つ選択',
        hint:  'あなたのスキルを選んでください',
        color: null,
        initial: _p1Skills,
        onChange: sel => { _p1Skills = sel; },
        onConfirm: () => {
          _p2Skills = [...loadDefaultSkills()];
          _launch('ai', _p1Skills, _p2Skills);
        },
      });
    } else {
      _openSkillSelect({
        title: 'P1: スキルを3つ選択',
        hint:  '6つのスキルから3つを選んでください',
        color: 'var(--p1)',
        initial: _p1Skills,
        onChange: sel => { _p1Skills = sel; },
        onConfirm: () => {
          _p2Skills = [...loadDefaultSkills()];
          _openSkillSelect({
            title: 'P2: スキルを3つ選択',
            hint:  '6つのスキルから3つを選んでください',
            color: 'var(--p2)',
            initial: _p2Skills,
            onChange: sel => { _p2Skills = sel; },
            onConfirm: () => { _launch('pvp', _p1Skills, _p2Skills); },
          });
        },
      });
    }
  }

  function _endSimple(winner) {
    _showResult({
      winner,
      sub: '',
      primaryLabel: 'リマッチ',
      onPrimary: () => { _launch(_pvpMode, _p1Skills, _p2Skills); },
      onTitle:   () => { showScreen('screen-title'); },
    });
  }

  // ── DRAFT ────────────────────────────────────────────────────
  function _startDraft() {
    _draft.picks = { [P1]: [], [P2]: [] };
    _draft.step  = 0;
    _renderDraft();
    showScreen('screen-draft');
  }

  function _renderDraft() {
    const picker   = _draft.ORDER[_draft.step];
    const takenIds = [..._draft.picks[P1], ..._draft.picks[P2]];
    const remain   = SKILL_ORDER.length - takenIds.length;

    // Status bar
    const label = document.getElementById('draft-turn-label');
    label.textContent = `${picker === P1 ? 'P1' : 'P2'} がスキルを選択中`;
    label.style.color = picker === P1 ? 'var(--p1)' : 'var(--p2)';
    document.getElementById('draft-count').textContent = `残り ${remain}`;

    // Active highlight
    document.getElementById('draft-picks-p1').classList.toggle('draft-active', picker === P1);
    document.getElementById('draft-picks-p2').classList.toggle('draft-active', picker === P2);

    // Slot renders
    [P1, P2].forEach(p => {
      const key   = p === P1 ? 'p1' : 'p2';
      const slots = document.getElementById(`draft-slots-${key}`);
      slots.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const sid = _draft.picks[p][i];
        const div = document.createElement('div');
        div.className = `draft-slot${sid ? ` filled ${key}-slot` : ''}`;
        if (sid) {
          const d = SKILL_DEFS[sid];
          div.innerHTML = `<span class="slot-icon">${d.icon}</span><span class="slot-name">${d.name}</span>`;
        } else {
          div.textContent = '— 未選択';
        }
        slots.appendChild(div);
      }
    });

    // Skill cards
    const grid = document.getElementById('draft-skill-grid');
    grid.innerHTML = '';
    SKILL_ORDER.forEach(sid => {
      const d    = SKILL_DEFS[sid];
      const taken = takenIds.includes(sid);
      const card  = document.createElement('div');
      card.className = `skill-card${taken ? ' draft-taken' : ' draft-selectable'}`;
      card.innerHTML = `
        <div class="skill-icon">${d.icon}</div>
        <div class="skill-card-body">
          <div class="skill-card-name">${d.name}</div>
          <div class="skill-card-desc">${d.desc}</div>
        </div>
        <div class="skill-checkmark"></div>`;
      if (!taken) card.addEventListener('click', () => _draftPick(sid));
      grid.appendChild(card);
    });
  }

  function _draftPick(sid) {
    const picker = _draft.ORDER[_draft.step];
    _draft.picks[picker].push(sid);
    _draft.step++;
    if (_draft.step >= _draft.ORDER.length) {
      _p1Skills = [..._draft.picks[P1]];
      _p2Skills = [..._draft.picks[P2]];
      _launch('pvp', _p1Skills, _p2Skills);
    } else {
      _renderDraft();
    }
  }

  function _endDraft(winner) {
    _showResult({
      winner,
      sub: '',
      primaryLabel: 'リマッチ（再ドラフト）',
      onPrimary: () => { _startDraft(); },
      onTitle:   () => { showScreen('screen-title'); },
    });
  }

  // ── STOCK ────────────────────────────────────────────────────
  function _startStockNew() {
    _stock.wins   = { [P1]: 0, [P2]: 0 };
    _stock.skills = { [P1]: [...loadDefaultSkills()], [P2]: [...loadDefaultSkills()] };
    _stock.loser  = null;
    _stockSelectBoth(() => { _launch('pvp', _stock.skills[P1], _stock.skills[P2]); });
  }

  function _stockSelectBoth(onDone) {
    _openSkillSelect({
      title: 'P1: スキルを3つ選択', hint: '6つのスキルから3つを選んでください', color: 'var(--p1)',
      initial: _stock.skills[P1], onChange: sel => { _stock.skills[P1] = sel; },
      onConfirm: () => {
        _openSkillSelect({
          title: 'P2: スキルを3つ選択', hint: '6つのスキルから3つを選んでください', color: 'var(--p2)',
          initial: _stock.skills[P2], onChange: sel => { _stock.skills[P2] = sel; },
          onConfirm: onDone,
        });
      },
    });
  }

  function _endStock(winner) {
    if (winner) {
      _stock.wins[winner]++;
      _stock.loser = winner === P1 ? P2 : P1;
    } else {
      _stock.loser = null;
    }

    // Series winner?
    if (_stock.wins[P1] >= STOCK_WIN_COUNT || _stock.wins[P2] >= STOCK_WIN_COUNT) {
      _showSeriesWin(_stock.wins[P1] >= STOCK_WIN_COUNT ? P1 : P2);
      return;
    }

    // Mid-series: show match result
    const loser = _stock.loser;
    const nextLabel = loser ? `${loser === P1 ? 'P1' : 'P2'} がスキルを再選択→次の試合へ` : '次の試合へ';
    _showResult({
      winner,
      sub: _buildStarHTML(),
      primaryLabel: nextLabel,
      onPrimary: () => {
        if (loser) {
          _openSkillSelect({
            title: `${loser === P1 ? 'P1' : 'P2'}: スキルを再選択`,
            hint: '敗者はスキルを変更できます',
            color: loser === P1 ? 'var(--p1)' : 'var(--p2)',
            initial: _stock.skills[loser],
            onChange: sel => { _stock.skills[loser] = sel; },
            onConfirm: () => { _launch('pvp', _stock.skills[P1], _stock.skills[P2]); },
          });
        } else {
          _launch('pvp', _stock.skills[P1], _stock.skills[P2]);
        }
      },
      onTitle: () => { showScreen('screen-title'); },
    });
  }

  function _showSeriesWin(winner) {
    const overlay = document.getElementById('overlay-series-win');
    const title   = document.getElementById('series-win-title');
    const stars   = document.getElementById('series-stars');

    title.textContent = `${winner === P1 ? 'P1' : 'P2'} の勝利！`;
    title.style.color = winner === P1 ? 'var(--p1)' : 'var(--p2)';

    stars.innerHTML = '';
    [P1, P2].forEach((p, i) => {
      const w = _stock.wins[p];
      for (let j = 0; j < STOCK_WIN_COUNT; j++) {
        const s = document.createElement('span');
        s.className   = 'series-star' + (j < w ? ' filled' : '');
        s.textContent = j < w ? '★' : '☆';
        s.style.color = p === P1 ? 'var(--p1)' : 'var(--p2)';
        stars.appendChild(s);
      }
      if (i === 0) {
        const sep = document.createElement('span');
        sep.style.cssText = 'margin:0 8px;color:var(--text-dim)';
        sep.textContent   = '—';
        stars.appendChild(sep);
      }
    });

    overlay.classList.remove('hidden');
  }

  // ── HELPERS ─────────────────────────────────────────────────

  function _launch(mode, p1s, p2s) { startGame(mode, p1s, p2s); }

  // Open skill-select screen, wiring up confirm callback
  function _openSkillSelect({ title, hint, color, initial, onChange, onConfirm }) {
    document.getElementById('skill-select-title').textContent = title;
    document.getElementById('skill-select-title').style.color = color || '';
    document.getElementById('skill-select-hint').textContent  = hint;

    const confirmBtn = document.getElementById('btn-confirm-skills');

    let selected = [...initial];
    buildSkillGrid('skill-select-grid', selected, 3, sel => {
      selected = sel;
      onChange(sel);
      confirmBtn.disabled = sel.length !== 3;
    });
    confirmBtn.disabled = selected.length !== 3;

    _onConfirm = onConfirm;
    showScreen('screen-skill-select');
  }

  // Generic result overlay builder
  function _showResult({ winner, sub, primaryLabel, onPrimary, onTitle }) {
    const overlay = document.getElementById('overlay-result');
    const icon    = document.getElementById('result-icon');
    const titleEl = document.getElementById('result-title');
    const subEl   = document.getElementById('result-sub');
    const actions = document.getElementById('result-actions');

    if (winner) {
      icon.textContent  = '🏆';
      titleEl.textContent = `${winner === P1 ? 'P1' : 'P2'} の勝利！`;
      titleEl.style.color = winner === P1 ? 'var(--p1)' : 'var(--p2)';
    } else {
      icon.textContent    = '🤝';
      titleEl.textContent = '引き分け';
      titleEl.style.color = 'var(--text)';
    }
    subEl.innerHTML  = sub || '';
    actions.innerHTML = '';

    const primary = _mkBtn('btn-primary', primaryLabel, () => {
      overlay.classList.add('hidden'); onPrimary();
    });
    const titleBtn = _mkBtn('btn-secondary-sm', 'タイトルへ', () => {
      overlay.classList.add('hidden'); onTitle();
    });
    actions.appendChild(primary);
    actions.appendChild(titleBtn);
    overlay.classList.remove('hidden');
  }

  function _buildStarHTML() {
    let html = '<div style="display:flex;gap:14px;justify-content:center;font-size:13px;margin-top:4px">';
    [P1, P2].forEach(p => {
      const w = _stock.wins[p];
      let stars = '';
      for (let i = 0; i < STOCK_WIN_COUNT; i++) stars += i < w ? '★' : '☆';
      const c = p === P1 ? 'var(--p1)' : 'var(--p2)';
      html += `<span style="color:${c};font-weight:700;">${p===P1?'P1':'P2'} ${stars}</span>`;
    });
    html += '</div>';
    return html;
  }

  function _mkBtn(cls, text, cb) {
    const b = document.createElement('button');
    b.className   = cls;
    b.textContent = text;
    b.addEventListener('click', cb);
    return b;
  }

  return { setup, startFlow, onGameEnd, confirmSkills, getBattleType, getPvpMode, getStockWins };
})();

/* ============================================================
   BOARD UTILS
   ============================================================ */
function idx(r, c) { return r * BOARD_SIZE + c; }
function pos(i)    { return { r: Math.floor(i / BOARD_SIZE), c: i % BOARD_SIZE }; }

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
    const f = board[line[0]];
    if (f !== EMPTY && line.every(i => board[i] === f)) return { winner: f, cells: line };
  }
  return null;
}
function isBoardFull(board) { return board.every(v => v !== EMPTY); }
function shareColumnRowDiag(i1, i2) {
  const {r:r1,c:c1} = pos(i1), {r:r2,c:c2} = pos(i2);
  return r1===r2 || c1===c2 || Math.abs(r1-r2)===Math.abs(c1-c2);
}

/* ============================================================
   GUARD & CELLLOCK UTILS
   ============================================================ */
function isCellLocked(i)     { const lc=state.lockedCells[i];  return !!(lc && state.turn < lc.expiresAtTurn); }
function isCellGuarded(i)    { const g=state.guardedCells[i];  return !!(g  && state.turn < g.expiresAtTurn);  }
function guardOwner(i)       { const g=state.guardedCells[i];  return (g && state.turn < g.expiresAtTurn) ? g.player : null; }
function guardTurnsLeft(i)   { const g=state.guardedCells[i];  return (g && state.turn < g.expiresAtTurn) ? g.expiresAtTurn - state.turn : 0; }
function cellLockLeft(i)     { const lc=state.lockedCells[i]; return (lc && state.turn < lc.expiresAtTurn) ? lc.expiresAtTurn - state.turn : 0; }

function expireEffects() {
  for (const k of Object.keys(state.guardedCells)) if (state.turn >= state.guardedCells[k].expiresAtTurn) delete state.guardedCells[k];
  for (const k of Object.keys(state.lockedCells))  if (state.turn >= state.lockedCells[k].expiresAtTurn)  delete state.lockedCells[k];
}

function tryDeleteCell(i, attacker) {
  if (isCellGuarded(i) && guardOwner(i) !== attacker) { delete state.guardedCells[i]; return 'guarded-broken'; }
  state.board[i] = EMPTY; state.pieceAge[i] = null; return 'ok';
}
function trySwitchCells(myIdx, oppIdx) {
  const opp = state.currentPlayer === P1 ? P2 : P1;
  if (guardOwner(myIdx) === opp || guardOwner(oppIdx) === opp) return false;
  const tv = state.board[myIdx], ta = state.pieceAge[myIdx];
  state.board[myIdx]    = state.board[oppIdx];    state.pieceAge[myIdx]    = state.pieceAge[oppIdx];
  state.board[oppIdx]   = tv;                     state.pieceAge[oppIdx]   = ta;
  const mg = state.guardedCells[myIdx]  ? {...state.guardedCells[myIdx]}  : null;
  const og = state.guardedCells[oppIdx] ? {...state.guardedCells[oppIdx]} : null;
  if (mg) state.guardedCells[oppIdx] = mg; else delete state.guardedCells[oppIdx];
  if (og) state.guardedCells[myIdx]  = og; else delete state.guardedCells[myIdx];
  return true;
}

/* ============================================================
   SKILL HELPERS
   ============================================================ */
function canUseSkill(p)      { return !state.locked[p]; }
function hasSkill(p, id)     { return state.skills[p].available.includes(id) && !state.skills[p].used.includes(id); }
function markSkillUsed(p,id) { state.skills[p].used.push(id); }
function getDeletable(atk)   { const opp=atk===P1?P2:P1; return state.board.map(v=>v===opp); }
function canDoublePlace(i1,i2,board) { return board[i2]===EMPTY && !shareColumnRowDiag(i1,i2); }
function wouldWin(board,player,i)   { const b=[...board]; b[i]=player; return !!checkWin(b); }

/* ============================================================
   BOARD EVALUATION
   ============================================================ */
function evalBoard(board, player) {
  const opp=player===P1?P2:P1; let score=0;
  for (const line of ALL_LINES) {
    const vals=line.map(i=>board[i]);
    const mine=vals.filter(v=>v===player).length, oppn=vals.filter(v=>v===opp).length;
    if (mine>0&&oppn===0) score+=mine*mine;
    if (oppn>0&&mine===0) score-=oppn*oppn*1.2;
  }
  return score;
}
function evalBoardMax(board) {
  let bonus=0;
  for (const line of ALL_LINES) {
    const vals=line.map(i=>board[i]);
    const mine=vals.filter(v=>v===P2).length, oppn=vals.filter(v=>v===P1).length, em=vals.filter(v=>v===EMPTY).length;
    if (mine===3&&oppn===0&&em===1) bonus+=15;
    if (oppn===3&&mine===0&&em===1) bonus-=18;
  }
  return evalBoard(board,P2)+bonus;
}
function maxThreat(board, player) {
  let max=0; const opp=player===P1?P2:P1;
  for (const line of ALL_LINES) {
    const c=line.filter(i=>board[i]===player).length;
    if (line.every(i=>board[i]!==opp)&&c>max) max=c;
  }
  return max;
}
function minimax(board,player,depth,alpha,beta) {
  const win=checkWin(board);
  if (win) return win.winner===P2?1000+depth:-(1000+depth);
  if (depth===0||isBoardFull(board)) return evalBoardMax(board);
  const emp=board.map((v,i)=>v===EMPTY&&!isCellLocked(i)?i:-1).filter(i=>i>=0);
  if (!emp.length) return evalBoardMax(board);
  if (player===P2){
    let best=-Infinity;
    for(const i of emp){const b=[...board];b[i]=P2;best=Math.max(best,minimax(b,P1,depth-1,alpha,beta));alpha=Math.max(alpha,best);if(beta<=alpha)break;}
    return best;
  } else {
    let best=Infinity;
    for(const i of emp){const b=[...board];b[i]=P1;best=Math.min(best,minimax(b,P2,depth-1,alpha,beta));beta=Math.min(beta,best);if(beta<=alpha)break;}
    return best;
  }
}

/* ============================================================
   AI MOVE SELECTION
   ============================================================ */
function _emptyNonLocked(board) { return board.map((v,i)=>v===EMPTY&&!isCellLocked(i)?i:-1).filter(i=>i>=0); }

function aiBestMoveEasy(board){
  if(Math.random()<0.4){const e=_emptyNonLocked(board);return e.length?e[Math.floor(Math.random()*e.length)]:-1;}
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P2,i)) return i;
  for(const ln of ALL_LINES){const v=ln.map(i=>board[i]);if(v.filter(x=>x===P1).length===3&&v.includes(EMPTY)){const e=ln.find(i=>board[i]===EMPTY&&!isCellLocked(i));if(e!==undefined)return e;}}
  const e=_emptyNonLocked(board);return e.length?e[Math.floor(Math.random()*e.length)]:-1;
}
function aiBestMoveNormal(board){
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P2,i)) return i;
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P1,i)) return i;
  const e=_emptyNonLocked(board); if(!e.length) return -1;
  let best=e[0],bs=-Infinity;
  for(const i of e){const b=[...board];b[i]=P2;const s=evalBoard(b,P2);if(s>bs){bs=s;best=i;}}
  return best;
}
function aiBestMoveHard(board){
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P2,i)) return i;
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P1,i)) return i;
  for(const ln of ALL_LINES){const v=ln.map(i=>board[i]);if(v.filter(x=>x===P1).length===3&&v.includes(EMPTY)){const e=ln.find(i=>board[i]===EMPTY&&!isCellLocked(i));if(e!==undefined)return e;}}
  const e=_emptyNonLocked(board); if(!e.length) return -1;
  const ranked=e.map(i=>{const b=[...board];b[i]=P2;return{i,score:evalBoard(b,P2)};}).sort((a,b)=>b.score-a.score).slice(0,10);
  let best=ranked[0].i,bs=-Infinity;
  for(const{i}of ranked){const b=[...board];b[i]=P2;const s=minimax(b,P1,2,-Infinity,Infinity);if(s>bs){bs=s;best=i;}}
  return best;
}
function aiBestMoveMax(board){
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P2,i)) return i;
  for(let i=0;i<board.length;i++) if(board[i]===EMPTY&&!isCellLocked(i)&&wouldWin(board,P1,i)) return i;
  for(const ln of ALL_LINES){const v=ln.map(i=>board[i]);if(v.filter(x=>x===P1).length===3&&v.includes(EMPTY)){const e=ln.find(i=>board[i]===EMPTY&&!isCellLocked(i));if(e!==undefined)return e;}}
  const e=_emptyNonLocked(board); if(!e.length) return -1;
  const ranked=e.map(i=>{const b=[...board];b[i]=P2;return{i,score:evalBoardMax(b)};}).sort((a,b)=>b.score-a.score).slice(0,12);
  let best=ranked[0].i,bs=-Infinity;
  for(const{i}of ranked){const b=[...board];b[i]=P2;const s=minimax(b,P1,4,-Infinity,Infinity);if(s>bs){bs=s;best=i;}}
  return best;
}
function aiBestMove(board){
  switch(state.aiDifficulty){
    case 'easy': return aiBestMoveEasy(board);
    case 'hard': return aiBestMoveHard(board);
    case 'max':  return aiBestMoveMax(board);
    default:     return aiBestMoveNormal(board);
  }
}

/* ============================================================
   AI SKILL DECISIONS
   ============================================================ */
function aiDecideSkillEasy(){
  if(Math.random()>0.2) return null;
  const av=state.skills[P2].available.filter(s=>!state.skills[P2].used.includes(s));
  return av.length?av[Math.floor(Math.random()*av.length)]:null;
}
function aiDecideSkillNormal(){
  const ai=P2,opp=P1; if(!canUseSkill(ai)) return null;
  const av=state.skills[ai].available.filter(s=>!state.skills[ai].used.includes(s)); if(!av.length) return null;
  const ot=maxThreat(state.board,opp);
  if(av.includes('lock')){const oa=state.skills[opp].available.filter(s=>!state.skills[opp].used.includes(s));if(oa.length>=2)return'lock';}
  if(av.includes('delete')&&ot>=3){for(const ln of ALL_LINES){if(ln.map(i=>state.board[i]).filter(v=>v===opp).length>=3)return'delete';}}
  if(av.includes('double')&&maxThreat(state.board,ai)>=2){const b1=aiBestMoveNormal(state.board);if(b1>=0){const bt=[...state.board];bt[b1]=ai;const b2=aiBestMoveNormal(bt);if(b2>=0&&!shareColumnRowDiag(b1,b2))return'double';}}
  if(av.includes('guard')&&maxThreat(state.board,ai)>=2) return'guard';
  return null;
}
function aiDecideSkillHard(){
  const ai=P2,opp=P1; if(!canUseSkill(ai)) return null;
  const av=state.skills[ai].available.filter(s=>!state.skills[ai].used.includes(s)); if(!av.length) return null;
  const oa=state.skills[opp].available.filter(s=>!state.skills[opp].used.includes(s));
  const mt=maxThreat(state.board,ai), ot=maxThreat(state.board,opp);
  if(av.includes('lock')&&oa.length>=1&&mt<3)return'lock';
  if(av.includes('delete')&&ot>=3){for(const ln of ALL_LINES){if(ln.map(i=>state.board[i]).filter(v=>v===opp).length>=3)return'delete';}}
  if(av.includes('celllock')&&ot>=2){for(const ln of ALL_LINES){const v=ln.map(i=>state.board[i]);if(v.filter(x=>x===opp).length>=2&&v.some(x=>x===EMPTY)){const t=ln.find(i=>state.board[i]===EMPTY&&!isCellLocked(i));if(t!==undefined)return'celllock';}}}
  if(av.includes('double')&&mt>=2){const b1=aiBestMoveHard(state.board);if(b1>=0){const bt=[...state.board];bt[b1]=ai;const b2=aiBestMoveHard(bt);if(b2>=0&&!shareColumnRowDiag(b1,b2))return'double';}}
  if(av.includes('guard')&&mt>=2)return'guard';
  if(av.includes('switch')&&mt>=2){const mp=state.board.map((v,i)=>v===ai?i:-1).filter(i=>i>=0),op=state.board.map((v,i)=>v===opp?i:-1).filter(i=>i>=0);for(const mi of mp)for(const oi of op){const b=[...state.board];b[mi]=opp;b[oi]=ai;if(evalBoard(b,ai)>evalBoard(state.board,ai)+4)return'switch';}}
  return null;
}
function aiDecideSkillMax(){
  const ai=P2,opp=P1; if(!canUseSkill(ai)) return null;
  const av=state.skills[ai].available.filter(s=>!state.skills[ai].used.includes(s)); if(!av.length) return null;
  const oa=state.skills[opp].available.filter(s=>!state.skills[opp].used.includes(s));
  const mt=maxThreat(state.board,ai), ot=maxThreat(state.board,opp);
  if(av.includes('double')){const b1=aiBestMoveMax(state.board);if(b1>=0){const bt=[...state.board];bt[b1]=ai;const b2=aiBestMoveMax(bt);if(b2>=0&&!shareColumnRowDiag(b1,b2)){const t=[...bt];t[b2]=ai;if(checkWin(t))return'double';if(mt>=2)return'double';}}}
  if(ot>=3){if(av.includes('delete'))return'delete';if(av.includes('celllock')){for(const ln of ALL_LINES){const v=ln.map(i=>state.board[i]);if(v.filter(x=>x===opp).length>=3){const t=ln.find(i=>state.board[i]===EMPTY&&!isCellLocked(i));if(t!==undefined)return'celllock';}}}}
  if(av.includes('lock')&&oa.length>=2&&mt>=2)return'lock';
  if(av.includes('celllock')&&ot>=2){for(const ln of ALL_LINES){const v=ln.map(i=>state.board[i]);if(v.filter(x=>x===opp).length>=2&&v.some(x=>x===EMPTY)){const t=ln.find(i=>state.board[i]===EMPTY&&!isCellLocked(i));if(t!==undefined)return'celllock';}}}
  if(av.includes('switch')){const mp=state.board.map((v,i)=>v===ai?i:-1).filter(i=>i>=0),op=state.board.map((v,i)=>v===opp?i:-1).filter(i=>i>=0),base=evalBoardMax(state.board);for(const mi of mp)for(const oi of op){const b=[...state.board];b[mi]=opp;b[oi]=ai;if(evalBoardMax(b)>base+6)return'switch';}}
  if(av.includes('guard')&&mt>=2){const mp=state.board.map((v,i)=>v===ai?i:-1).filter(i=>i>=0);if(mp.some(pi=>!isCellGuarded(pi)))return'guard';}
  if(av.includes('lock')&&oa.length>=1&&mt>=1)return'lock';
  return null;
}
function aiDecideSkill(){
  switch(state.aiDifficulty){
    case 'easy': return aiDecideSkillEasy();
    case 'hard': return aiDecideSkillHard();
    case 'max':  return aiDecideSkillMax();
    default:     return aiDecideSkillNormal();
  }
}

/* ============================================================
   CORE GAME FLOW
   ============================================================ */
function placePiece(i){ if(isCellLocked(i))return false; state.board[i]=state.currentPlayer; state.pieceAge[i]=state.turn; SoundManager.play('place'); return true; }

function nextTurn(){
  state.turn++; expireEffects();
  state.currentPlayer = state.currentPlayer===P1?P2:P1;
  if(state.pendingLockFor===state.currentPlayer){state.locked[state.currentPlayer]=true;state.pendingLockFor=null;}
  else state.locked[state.currentPlayer]=false;
  state.phase='normal'; state.activeSkill=null; state.skillState={};
  renderAll();
  if(!state.gameOver) showTurnAnnounce(state.currentPlayer, ()=>{
    if(state.mode==='ai'&&state.currentPlayer===P2&&!state.gameOver) scheduleAI();
  });
}

function checkGameEnd(){
  const result=checkWin(state.board);
  if(result){
    state.gameOver=true; state.winner=result.winner; state.winCells=result.cells; state.score[result.winner]++;
    SoundManager.play('win');
    renderAll();
    setTimeout(()=>BattleMode.onGameEnd(state.winner), 450);
    return true;
  }
  if(isBoardFull(state.board)){
    state.gameOver=true; state.winner=null;
    renderAll();
    setTimeout(()=>BattleMode.onGameEnd(null), 450);
    return true;
  }
  return false;
}

/* ── AI execution ── */
function scheduleAI(){ showAIThinking(true); setTimeout(aiTurn, AI_CONFIG[state.aiDifficulty].delay); }
function aiTurn(){
  showAIThinking(false); if(state.gameOver)return;
  const sk=aiDecideSkill(); if(sk){aiExecSkill(sk);return;}
  const mv=aiBestMove(state.board);
  if(mv>=0){placePiece(mv);renderAll();if(!checkGameEnd())nextTurn();}else nextTurn();
}
function aiPlaceNext(ms){
  setTimeout(()=>{const mv=aiBestMove(state.board);if(mv>=0){placePiece(mv);renderAll();if(!checkGameEnd())nextTurn();}else nextTurn();},ms);
}

function aiExecSkill(sid){
  markSkillUsed(P2,sid);
  const diff=state.aiDifficulty;
  switch(sid){
    case'double':{
      const b1=aiBestMove(state.board);if(b1<0){nextTurn();return;}
      placePiece(b1);renderAll();
      const bt=[...state.board];
      const cands=_emptyNonLocked(bt).filter(i=>!shareColumnRowDiag(b1,i));
      if(cands.length){
        let best=cands[Math.floor(Math.random()*cands.length)],bs=-Infinity;
        if(diff!=='easy')for(const i of cands){const b=[...bt];b[i]=P2;const s=evalBoard(b,P2);if(s>bs){bs=s;best=i;}}
        setTimeout(()=>{placePiece(best);renderAll();if(!checkGameEnd())nextTurn();},280);
      }else{if(!checkGameEnd())nextTurn();}
      break;
    }
    case'delete':{
      const opp=P1; let target=-1,bs=-Infinity;
      for(let i=0;i<state.board.length;i++){if(state.board[i]!==opp)continue;const b=[...state.board];b[i]=EMPTY;const s=-evalBoard(b,P1);if(s>bs){bs=s;target=i;}}
      if(diff==='easy'){const all=state.board.map((v,i)=>v===opp?i:-1).filter(i=>i>=0);if(all.length)target=all[Math.floor(Math.random()*all.length)];}
      if(target>=0){const r=tryDeleteCell(target,P2);if(r==='guarded-broken')showToast('🛡 ガードが発動！削除を防いだ');}
      renderAll();setTimeout(()=>{if(!checkGameEnd())aiPlaceNext(0);},200);
      break;
    }
    case'switch':{
      const mp=state.board.map((v,i)=>v===P2?i:-1).filter(i=>i>=0),op=state.board.map((v,i)=>v===P1?i:-1).filter(i=>i>=0);
      let bm=-1,bo=-1,bs=-Infinity;
      for(const mi of mp)for(const oi of op){const b=[...state.board];b[mi]=P1;b[oi]=P2;const s=evalBoard(b,P2);if(s>bs){bs=s;bm=mi;bo=oi;}}
      if(bm>=0&&bo>=0){const ok=trySwitchCells(bm,bo);if(!ok)showToast('🛡 ガードがスイッチを防いだ！');}
      renderAll();if(!checkGameEnd())nextTurn();break;
    }
    case'lock':{ state.pendingLockFor=P1; showToast('🔒 AIがロックを使用！あなたの次のターン、スキルは使えない'); renderAll(); aiPlaceNext(350); break; }
    case'guard':{
      const mp=state.board.map((v,i)=>v===P2?i:-1).filter(i=>i>=0);
      let best=mp[0]??-1,bs=-Infinity;
      for(const pi of mp){if(isCellGuarded(pi))continue;let s=0;for(const ln of ALL_LINES)if(ln.includes(pi)&&ln.filter(i=>state.board[i]===P2).length>=2)s++;if(s>bs){bs=s;best=pi;}}
      if(best>=0){state.guardedCells[best]={player:P2,expiresAtTurn:state.turn+GUARD_DURATION};showToast('🛡 AIがガードを使用！');}
      renderAll();aiPlaceNext(350);break;
    }
    case'celllock':{
      let target=-1,bs=-Infinity;
      for(const ln of ALL_LINES){const v=ln.map(i=>state.board[i]);const oc=v.filter(x=>x===P1).length;if(!oc)continue;for(const ci of ln){if(state.board[ci]!==EMPTY||isCellLocked(ci))continue;if(oc>bs){bs=oc;target=ci;}}}
      if(target>=0){state.lockedCells[target]={expiresAtTurn:state.turn+CELLLOCK_DURATION};showToast('⛓ AIがマスロックを使用！');}
      renderAll();aiPlaceNext(350);break;
    }
    default: nextTurn();
  }
}

/* ============================================================
   PLAYER SKILL ACTIVATION
   ============================================================ */
const BONUS_PHASES = new Set(['lock-place','delete-place','guard-place','celllock-place']);

function activateSkill(player,sid){
  if(state.gameOver)return;
  if(state.currentPlayer!==player){showToast('自分のターンではありません');return;}
  if(BONUS_PHASES.has(state.phase)){showToast('先に駒を置いてターンを終了してください');return;}
  if(!canUseSkill(player)){showToast('🔒 ロック中はスキルを使えない！');return;}
  if(!hasSkill(player,sid)){showToast('このスキルは使用済みです');return;}
  if(state.activeSkill===sid){cancelSkill();return;}
  state.activeSkill=sid; state.skillState={};
  switch(sid){
    case'double':   state.phase='double-1';  showSkillStatus('⚡ ダブル ①: 1つ目の駒を置いてください（即勝利不可）');        break;
    case'delete':   state.phase='delete';    showSkillStatus('🗑 デリート ①: 削除する相手の駒を選んでください');               break;
    case'switch':   state.phase='switch-1';  showSkillStatus('🔄 スイッチ ①: 入れ替える自分の駒を選んでください');            break;
    case'guard':    state.phase='guard';     showSkillStatus('🛡 ガード: ガードする自分の駒を選んでください');                 break;
    case'lock':
      markSkillUsed(player,sid); state.pendingLockFor=player===P1?P2:P1;
      state.activeSkill=null; state.phase='lock-place';
      showSkillStatus('🔒 ロック発動！続けて駒を1つ置いてください'); renderAll(); return;
    case'celllock':
      markSkillUsed(player,sid); state.activeSkill=null; state.phase='celllock';
      showSkillStatus('⛓ マスロック: 封鎖するマスを選んでください'); renderAll(); return;
    default: state.phase='normal';
  }
  renderAll();
}

function cancelSkill(){
  if(BONUS_PHASES.has(state.phase)){showToast('先に駒を置いてターンを終了してください');return;}
  if(state.phase==='celllock'){
    // un-mark since target not yet chosen
    const p=state.currentPlayer;
    state.skills[p].used=state.skills[p].used.filter(s=>s!=='celllock');
  }
  if(state.phase==='double-2'&&state.skillState.firstIndex!==undefined){
    state.board[state.skillState.firstIndex]=EMPTY; state.pieceAge[state.skillState.firstIndex]=null;
  }
  state.phase='normal'; state.activeSkill=null; state.skillState={};
  hideSkillStatus(); renderAll();
}

/* ============================================================
   CELL CLICK HANDLER
   ============================================================ */
function onCellClick(i){
  if(state.gameOver)return;
  if(state.mode==='ai'&&state.currentPlayer===P2)return;
  const player=state.currentPlayer, opp=player===P1?P2:P1;
  switch(state.phase){
    case'normal':{
      if(state.board[i]!==EMPTY)return;
      if(isCellLocked(i)){showToast('⛓ このマスは封鎖中です');return;}
      placePiece(i);renderAll();if(!checkGameEnd())nextTurn();break;
    }
    case'lock-place':case'delete-place':case'guard-place':case'celllock-place':{
      if(state.board[i]!==EMPTY){showToast('空きマスを選んでください');return;}
      if(isCellLocked(i)){showToast('⛓ このマスは封鎖中です');return;}
      placePiece(i);state.phase='normal';state.skillState={};hideSkillStatus();renderAll();if(!checkGameEnd())nextTurn();break;
    }
    case'double-1':{
      if(state.board[i]!==EMPTY){showToast('空きマスを選んでください');return;}
      if(isCellLocked(i)){showToast('⛓ このマスは封鎖中です');return;}
      if(wouldWin(state.board,player,i)){showToast('この1手だけで即勝利はできません');return;}
      placePiece(i);state.skillState.firstIndex=i;state.phase='double-2';
      showSkillStatus('⚡ ダブル ②: 2つ目の駒を置いてください（同じ列は不可）');renderAll();break;
    }
    case'double-2':{
      if(state.board[i]!==EMPTY){showToast('空きマスを選んでください');return;}
      if(isCellLocked(i)){showToast('⛓ このマスは封鎖中です');return;}
      if(!canDoublePlace(state.skillState.firstIndex,i,state.board)){showToast('同じ列・行・斜めには置けません');return;}
      markSkillUsed(player,'double');placePiece(i);
      state.phase='normal';state.activeSkill=null;hideSkillStatus();renderAll();if(!checkGameEnd())nextTurn();break;
    }
    case'delete':{
      const del=getDeletable(player);
      if(!del[i]){showToast('相手の駒を選んでください');return;}
      markSkillUsed(player,'delete');
      const res=tryDeleteCell(i,player);
      if(res==='guarded-broken'){
        showToast('🛡 ガードが発動！削除を防いだ');
        state.phase='normal';state.activeSkill=null;hideSkillStatus();renderAll();if(!checkGameEnd())nextTurn();
      }else{
        state.phase='delete-place';state.activeSkill=null;
        showSkillStatus('🗑 デリート ②: 続けて自分の駒を置いてください');renderAll();
      }
      break;
    }
    case'switch-1':{
      if(state.board[i]!==player){showToast('自分の駒を選んでください');return;}
      state.skillState.myPiece=i;state.phase='switch-2';
      showSkillStatus('🔄 スイッチ ②: 入れ替える相手の駒を選んでください');renderAll();break;
    }
    case'switch-2':{
      if(state.board[i]!==opp){showToast('相手の駒を選んでください');return;}
      markSkillUsed(player,'switch');
      const ok=trySwitchCells(state.skillState.myPiece,i);
      if(!ok)showToast('🛡 ガードがスイッチを防いだ！');
      state.phase='normal';state.activeSkill=null;state.skillState={};hideSkillStatus();renderAll();if(!checkGameEnd())nextTurn();break;
    }
    case'guard':{
      if(state.board[i]!==player){showToast('自分の駒を選んでください');return;}
      if(isCellGuarded(i)){showToast('すでにガード中の駒です');return;}
      markSkillUsed(player,'guard');
      state.guardedCells[i]={player,expiresAtTurn:state.turn+GUARD_DURATION};
      state.phase='guard-place';state.activeSkill=null;
      showSkillStatus('🛡 ガード発動！続けて駒を1つ置いてください');renderAll();break;
    }
    case'celllock':{
      if(state.board[i]!==EMPTY){showToast('空きマスを選んでください');return;}
      if(isCellLocked(i)){showToast('すでに封鎖中のマスです');return;}
      state.lockedCells[i]={expiresAtTurn:state.turn+CELLLOCK_DURATION};
      state.phase='celllock-place';state.activeSkill=null;
      showSkillStatus('⛓ マスロック発動！続けて駒を1つ置いてください');renderAll();break;
    }
  }
}

/* ============================================================
   UI HELPERS
   ============================================================ */
function showSkillStatus(t){ document.getElementById('skill-status-text').textContent=t; document.getElementById('skill-status-bar').classList.remove('hidden'); }
function hideSkillStatus(){ document.getElementById('skill-status-bar').classList.add('hidden'); }

let _toastTimer=null;
function showToast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.remove('hidden');
  if(_toastTimer)clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>el.classList.add('hidden'),2200);
}
function showAIThinking(v){ const el=document.getElementById('overlay-ai-thinking'); if(el)el.classList.toggle('hidden',!v); }

/* ============================================================
   TURN ANNOUNCE
   ============================================================ */
function _setAnnounce(txt, color){
  const overlay=document.getElementById('overlay-turn'), textEl=document.getElementById('turn-announce-text');
  overlay.classList.remove('show','hide','hidden');
  textEl.textContent=txt; textEl.style.color=color; textEl.style.borderColor=color;
  overlay.offsetHeight; // force reflow
  overlay.classList.add('show');
}
function _dismissAnnounce(cb){
  const overlay=document.getElementById('overlay-turn');
  overlay.classList.remove('show'); overlay.classList.add('hide');
  setTimeout(()=>{ overlay.classList.add('hidden'); overlay.classList.remove('hide'); if(cb)cb(); }, 200);
}

function showFirstTurnAnnounce(player, cb){
  const txt   = state.mode==='ai' ? (player===P1?'🎯 あなたが先攻です！':'🤖 相手が先攻です') : (player===P1?'🎯 PLAYER 1 FIRST':'🎯 PLAYER 2 FIRST');
  const color = player===P1?'var(--p1)':'var(--p2)';
  _setAnnounce(txt, color);
  setTimeout(()=>_dismissAnnounce(()=>showTurnAnnounce(player,cb)), 1400);
}

let _turnAnnTimer=null;
function showTurnAnnounce(player, cb){
  if(_turnAnnTimer)clearTimeout(_turnAnnTimer);
  const locked = !!state.locked[player];
  let txt = state.mode==='ai' ? (player===P1?'あなたのターン':'相手のターン') : (player===P1?'P1 のターン':'P2 のターン');
  if(locked) txt+='  🔒';
  _setAnnounce(txt, player===P1?'var(--p1)':'var(--p2)');
  _turnAnnTimer=setTimeout(()=>_dismissAnnounce(cb), 750);
}

/* ============================================================
   RENDER
   ============================================================ */
function renderAll(){ renderBoard(); renderPanels(); renderTurnIndicator(); }

function renderBoard(){
  const boardEl=document.getElementById('board'), player=state.currentPlayer, opp=player===P1?P2:P1;
  const del=state.phase==='delete'?getDeletable(player):null;
  boardEl.querySelectorAll('.cell').forEach((cell,i)=>{
    cell.className='cell'; cell.innerHTML='';
    if(isCellLocked(i)){
      cell.classList.add('cell-locked');
      const ic=document.createElement('div'); ic.className='cell-lock-icon';
      ic.textContent=`⛓${cellLockLeft(i)}`; cell.appendChild(ic); return;
    }
    const val=state.board[i];
    if(val!==EMPTY){
      cell.classList.add(val===P1?'piece-p1':'piece-p2');
      const p=document.createElement('div'); p.className='cell-piece'; cell.appendChild(p);
      if(isCellGuarded(i)){
        cell.classList.add(guardOwner(i)===P1?'guarded-p1':'guarded-p2');
        const sh=document.createElement('div'); sh.className='guard-shield';
        sh.textContent=`🛡${guardTurnsLeft(i)}`; cell.appendChild(sh);
      }
    }
    if(state.winCells.includes(i)) cell.classList.add('winning-cell');
    switch(state.phase){
      case'delete':        if(del&&del[i]) cell.classList.add('deletable'); break;
      case'delete-place':case'lock-place':case'guard-place':case'celllock-place':
        if(val===EMPTY) cell.classList.add('hint-cell'); break;
      case'guard':         if(val===player&&!isCellGuarded(i)) cell.classList.add('selectable-for-skill'); break;
      case'celllock':      if(val===EMPTY) cell.classList.add('selectable-for-skill'); break;
      case'switch-1':      if(val===player) cell.classList.add('selectable-for-skill'); break;
      case'switch-2':
        if(i===state.skillState.myPiece) cell.classList.add('active-skill');
        if(val===opp) cell.classList.add('selectable-for-skill'); break;
      case'double-2':
        if(i===state.skillState.firstIndex) cell.classList.add('active-skill');
        if(val===EMPTY&&!isCellLocked(i)&&!shareColumnRowDiag(state.skillState.firstIndex,i)) cell.classList.add('hint-cell'); break;
    }
  });
}

function buildBoard(){
  const el=document.getElementById('board'); el.innerHTML='';
  for(let i=0;i<BOARD_SIZE*BOARD_SIZE;i++){
    const c=document.createElement('div'); c.className='cell'; c.dataset.index=i;
    c.addEventListener('click',()=>onCellClick(i)); el.appendChild(c);
  }
}

function renderPanels(){
  renderPlayerPanel(P1); renderPlayerPanel(P2);
  document.getElementById('panel-p1').classList.toggle('active-player',state.currentPlayer===P1);
  document.getElementById('panel-p2').classList.toggle('active-player',state.currentPlayer===P2);
  document.getElementById('lock-p1').classList.toggle('visible',!!state.locked[P1]);
  document.getElementById('lock-p2').classList.toggle('visible',!!state.locked[P2]);

  const scoreEl=document.getElementById('game-score');
  if(BattleMode.getBattleType()==='stock'){
    const w=BattleMode.getStockWins();
    const stars=p=>{let s='';for(let i=0;i<STOCK_WIN_COUNT;i++)s+=i<w[p]?'★':'☆';return s;};
    scoreEl.innerHTML=`<span style="color:var(--p1)">${stars(P1)}</span> <span style="color:var(--text-dim)">—</span> <span style="color:var(--p2)">${stars(P2)}</span>`;
  }else{
    scoreEl.textContent=`${state.score[P1]} — ${state.score[P2]}`;
  }
}

function renderPlayerPanel(player){
  const el=document.getElementById(player===P1?'p1-skills':'p2-skills');
  el.innerHTML='';
  const psk=state.skills[player], isCur=state.currentPlayer===player, isAI=state.mode==='ai'&&player===P2;
  psk.available.forEach(sid=>{
    const d=SKILL_DEFS[sid], used=psk.used.includes(sid), active=state.activeSkill===sid&&isCur;
    if(isAI){
      const div=document.createElement('div');
      div.className='enemy-skill-display'+(used?' used':'');
      div.title=d.name; div.innerHTML=`<span>${d.icon}</span><span class="skill-label">${d.name}</span>`;
      el.appendChild(div);
    }else{
      const btn=document.createElement('button');
      btn.className='panel-skill-btn'+(used?' used':'')+(active?' active-skill':'');
      btn.title=`${d.name}: ${d.desc}`; btn.innerHTML=`<span>${d.icon}</span><span class="skill-label">${d.name}</span>`;
      if(!used&&isCur) btn.addEventListener('click',()=>activateSkill(player,sid)); else btn.disabled=true;
      el.appendChild(btn);
    }
  });
}

function renderTurnIndicator(){
  const el=document.getElementById('turn-indicator'), lb=document.getElementById('turn-label');
  if(state.gameOver){lb.textContent=state.winner?`${playerName(state.winner)} の勝利！`:'引き分け';el.className='turn-indicator';return;}
  lb.textContent=`${playerName(state.currentPlayer)} のターン${state.locked[state.currentPlayer]?' 🔒':''}`;
  el.className=`turn-indicator turn-p${state.currentPlayer}`;
}
function playerName(p){ return state.mode==='ai'?(p===P1?'あなた':'AI'):(p===P1?'P1':'P2'); }

/* ============================================================
   SCREEN NAV
   ============================================================ */
const _sc={};
function getScreen(id){ if(!_sc[id])_sc[id]=document.getElementById(id); return _sc[id]; }
function showScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); getScreen(id).classList.add('active'); SoundManager.play('select'); }

/* ============================================================
   SKILL GRID BUILDER (shared)
   ============================================================ */
function buildSkillGrid(containerId, selectedIds, maxSelect, onChanged){
  const container=document.getElementById(containerId); container.innerHTML='';
  const selected=new Set(selectedIds);
  SKILL_ORDER.forEach(sid=>{
    const d=SKILL_DEFS[sid];
    const card=document.createElement('div');
    card.className='skill-card'+(selected.has(sid)?' selected':'');
    card.dataset.skillId=sid;
    card.innerHTML=`<div class="skill-icon">${d.icon}</div><div class="skill-card-body"><div class="skill-card-name">${d.name}</div><div class="skill-card-desc">${d.desc}</div></div><div class="skill-checkmark">${selected.has(sid)?'✓':''}</div>`;
    card.addEventListener('click',()=>{
      if(selected.has(sid)){selected.delete(sid);card.classList.remove('selected');card.querySelector('.skill-checkmark').textContent='';}
      else if(selected.size<maxSelect){selected.add(sid);card.classList.add('selected');card.querySelector('.skill-checkmark').textContent='✓';}
      else{showToast(`最大${maxSelect}つまで選択できます`);return;}
      onChanged([...selected]);
    });
    container.appendChild(card);
  });
  return selected;
}

/* ============================================================
   startGame (called by BattleMode)
   ============================================================ */
function startGame(mode, p1Skills, p2Skills){
  state=createInitialState(mode,p1Skills,p2Skills);
  buildBoard(); renderAll(); hideSkillStatus(); showAIThinking(false);
  document.getElementById('overlay-result').classList.add('hidden');
  document.getElementById('overlay-series-win').classList.add('hidden');
  document.getElementById('p1-name').textContent=mode==='ai'?'あなた':'P1';
  document.getElementById('p2-name').textContent=mode==='ai'?'AI':'P2';

  // Mode badge
  const modeLabels={simple:'MODE : SIMPLE',draft:'MODE : DRAFT',stock:'MODE : STOCK'};
  document.getElementById('mode-badge').textContent=modeLabels[BattleMode.getBattleType()]||'';

  // Difficulty badge (AI only)
  const db=document.getElementById('difficulty-badge');
  if(db){
    if(mode==='ai'){const cfg=AI_CONFIG[aiDifficulty];db.textContent=cfg.label;db.className=`difficulty-badge ${cfg.cls}`;db.style.display='';}
    else db.style.display='none';
  }

  showScreen('screen-game');
  showFirstTurnAnnounce(state.currentPlayer,()=>{
    if(state.currentPlayer===P2&&mode==='ai') scheduleAI();
  });
}

/* ============================================================
   INIT — wire up all buttons once
   ============================================================ */
(function init(){
  // Title
  document.getElementById('btn-local').addEventListener('click',()=>showScreen('screen-local-select'));
  document.getElementById('btn-skill-edit').addEventListener('click',()=>{
    const defaults=loadDefaultSkills(), saveBtn=document.getElementById('btn-save-skills');
    let editSel=[...defaults];
    buildSkillGrid('skill-edit-grid',editSel,3,sel=>{editSel=sel;saveBtn.disabled=sel.length!==3;});
    saveBtn.disabled=editSel.length!==3; showScreen('screen-skill-edit');
  });
  document.getElementById('btn-howto').addEventListener('click',()=>showScreen('screen-howto'));

  // Local select
  document.getElementById('back-from-local').addEventListener('click',()=>showScreen('screen-title'));
  document.getElementById('btn-pvp').addEventListener('click',()=>showScreen('screen-battle-mode'));
  document.getElementById('btn-ai').addEventListener('click',()=>showScreen('screen-ai-difficulty'));

  // Battle mode select (PvP only)
  document.getElementById('back-from-battle-mode').addEventListener('click',()=>showScreen('screen-local-select'));
  document.querySelectorAll('.battle-mode-card').forEach(card=>{
    card.addEventListener('click',()=>{
      BattleMode.setup('pvp', card.dataset.battleMode);
      BattleMode.startFlow();
    });
  });

  // AI difficulty
  document.getElementById('back-from-difficulty').addEventListener('click',()=>showScreen('screen-local-select'));
  document.querySelectorAll('.difficulty-card').forEach(card=>{
    card.addEventListener('click',()=>{
      aiDifficulty=card.dataset.difficulty;
      BattleMode.setup('ai','simple');
      BattleMode.startFlow();
    });
  });

  // Skill select screen
  document.getElementById('btn-confirm-skills').addEventListener('click',()=>BattleMode.confirmSkills());
  document.getElementById('back-from-skill-select').addEventListener('click',()=>{
    // Navigate back to appropriate screen
    if(BattleMode.getPvpMode()==='ai') showScreen('screen-ai-difficulty');
    else showScreen('screen-battle-mode');
  });

  // Draft back
  document.getElementById('back-from-draft').addEventListener('click',()=>showScreen('screen-battle-mode'));

  // Skill edit
  document.getElementById('back-from-skill-edit').addEventListener('click',()=>showScreen('screen-title'));
  document.getElementById('btn-save-skills').addEventListener('click',()=>{
    const sel=[...document.querySelectorAll('#skill-edit-grid .skill-card.selected')].map(c=>c.dataset.skillId);
    if(sel.length===3){saveDefaultSkills(sel);showToast('✅ デフォルトスキルを保存しました');showScreen('screen-title');}
  });

  // Howto
  document.getElementById('back-from-howto').addEventListener('click',()=>showScreen('screen-title'));

  // In-game
  document.getElementById('back-from-game').addEventListener('click',()=>{
    if(confirm('ゲームを終了しますか？')){showAIThinking(false);showScreen('screen-title');}
  });
  document.getElementById('btn-cancel-skill').addEventListener('click',cancelSkill);

  // Series win overlay
  document.getElementById('btn-series-again').addEventListener('click',()=>{
    document.getElementById('overlay-series-win').classList.add('hidden');
    BattleMode.setup(BattleMode.getPvpMode(),'stock');
    BattleMode.startFlow();
  });
  document.getElementById('btn-series-title').addEventListener('click',()=>{
    document.getElementById('overlay-series-win').classList.add('hidden');
    showScreen('screen-title');
  });

  showScreen('screen-title');
})();
