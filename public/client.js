const socket = io();

let myState    = null;
let amHost     = false;
let hasJoined  = false;

// ── Floating background emojis ───────────────────────────────────────────────
const QUIZ_EMOJIS = ['🧠','💡','❓','🎯','🏆','⭐','🔍','📚','🎲','🤔','✨','🌟','💫','🎪','🏅'];

function initEmojis() {
  const container = document.getElementById('bg-emojis');
  for (let i = 0; i < 16; i++) {
    const el = document.createElement('div');
    el.className = 'emoji-float';
    el.textContent = QUIZ_EMOJIS[i % QUIZ_EMOJIS.length];
    el.style.left            = `${Math.random() * 98}%`;
    el.style.fontSize        = `${1.1 + Math.random() * 1.6}rem`;
    el.style.animationDuration = `${14 + Math.random() * 22}s`;
    el.style.animationDelay  = `-${Math.random() * 24}s`;
    container.appendChild(el);
  }
}

initEmojis();

// ── Spacebar → Buzz ──────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    tryBuzz();
  }
});

// ── Enter to join ────────────────────────────────────────────────────────────
document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinGame();
});

// ── Join ─────────────────────────────────────────────────────────────────────
function joinGame() {
  const nameInput = document.getElementById('player-name');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }

  amHost    = document.getElementById('is-host').checked;
  hasJoined = true;
  socket.emit('join', { name, isHost: amHost });

  document.getElementById('join-screen').style.display  = 'none';
  document.getElementById('game-screen').style.display  = 'flex';

  if (amHost) document.getElementById('host-buttons').style.display = 'flex';
}

// ── State updates ────────────────────────────────────────────────────────────
socket.on('gameState', (state) => {
  myState = state;
  const me = state.players.find(p => p.id === state.myId);
  if (me) {
    amHost = me.isHost;
    // Keep host-buttons in sync after reconnect
    document.getElementById('host-buttons').style.display =
      (hasJoined && amHost) ? 'flex' : 'none';
  }
  // Always refresh the join-screen player list (visible before joining)
  renderJoinPlayerList(state);
  if (hasJoined) renderGame(state);
});

// ── Join-screen: active player list ─────────────────────────────────────────
function renderJoinPlayerList(state) {
  const container = document.getElementById('join-players');
  if (!container) return;
  if (state.players.length === 0) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div class="jp-label">Bereits dabei — zum Wiederverbinden klicken</div>
    <div class="jp-list">
      ${state.players.map(p => `
        <button class="jp-chip ${p.connected ? 'online' : 'offline'}"
                data-name="${esc(p.name)}"
                data-host="${p.isHost}"
                onclick="rejoinAs(this)">
          <span class="jp-dot"></span>
          ${esc(p.name)}${p.isHost ? ' 👑' : ''}
        </button>`).join('')}
    </div>`;
}

function rejoinAs(btn) {
  document.getElementById('player-name').value = btn.dataset.name;
  document.getElementById('is-host').checked = btn.dataset.host === 'true';
  document.getElementById('player-name').focus();
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderGame(state) {
  renderScoreBar(state);
  renderTurnIndicator(state);
  renderBoard(state);
  renderModal(state);
}

function renderScoreBar(state) {
  const bar = document.getElementById('score-bar');
  bar.innerHTML = state.players
    .filter(p => !p.isHost)
    .map(p => {
      const active = p.id === state.currentPlayerId ? 'active-turn' : '';
      return `
        <div class="player-score ${active}">
          <div class="ps-name">${esc(p.name)}</div>
          <div class="ps-score">${p.score}</div>
        </div>`;
    }).join('');
}

function renderTurnIndicator(state) {
  const el = document.getElementById('turn-indicator');
  if (!state.currentPlayerName) {
    el.innerHTML = 'Warte auf Spieler…';
    return;
  }
  const isMe = state.currentPlayerId === state.myId && !amHost;
  if (isMe) {
    el.innerHTML = `<span class="highlight">⭐ Du bist dran!</span>`;
  } else {
    el.innerHTML = `<span class="highlight">${esc(state.currentPlayerName)}</span> ist dran`;
  }
}

function renderBoard(state) {
  const board = document.getElementById('board');
  // Host clicks questions on behalf of the current player
  const canClick = amHost && state.phase === 'board';
  let html = '';

  // Category headers
  for (const cat of state.categories) {
    html += `<div class="board-cell cat-header">${esc(cat.name)}</div>`;
  }

  // 5 rows of question tiles
  for (let qi = 0; qi < 5; qi++) {
    for (let ci = 0; ci < state.categories.length; ci++) {
      const q = state.categories[ci].questions[qi];
      const selectable = canClick && !q.answered;
      const clickAttr  = selectable ? `onclick="selectQuestion(${ci},${qi})"` : '';
      const classes    = [
        'board-cell q-cell',
        q.answered  ? 'answered'   : '',
        selectable  ? 'selectable' : '',
      ].filter(Boolean).join(' ');

      html += `<div class="${classes}" ${clickAttr}>
        ${q.answered ? '' : `<span class="pts">${q.points}</span>`}
      </div>`;
    }
  }

  board.innerHTML = html;
}

function renderModal(state) {
  const modal = document.getElementById('question-modal');

  if (state.phase === 'board' || !state.activeQuestion) {
    modal.style.display = 'none';
    return;
  }
  modal.style.display = 'flex';

  const q = state.activeQuestion;
  document.getElementById('modal-category').textContent = q.categoryName.toUpperCase();
  document.getElementById('modal-points').textContent   = `${q.points} Punkte`;
  document.getElementById('modal-question').textContent = q.question;

  // Answer — host only
  const answerEl = document.getElementById('modal-answer');
  if (amHost && q.answer) {
    answerEl.textContent = q.answer;
    answerEl.style.display = 'block';
  } else {
    answerEl.style.display = 'none';
  }

  // Status messages
  const answererEl = document.getElementById('modal-answerer');
  const statusEl   = document.getElementById('modal-status');
  statusEl.className = '';

  if (state.phase === 'correct') {
    answererEl.textContent = '';
    statusEl.textContent   = 'Richtige Antwort! ✓';
    statusEl.classList.add('correct');

  } else if (state.phase === 'buzzering') {
    answererEl.textContent = '';
    statusEl.textContent   = 'Falsche Antwort! Es kann gebuzzert werden.';
    statusEl.classList.add('wrong');

  } else if (state.phase === 'question') {
    if (state.buzzedById) {
      answererEl.textContent = '';
      statusEl.textContent   = `⚡ ${esc(state.buzzedByName)} hat gebuzzert!`;
      statusEl.classList.add('buzzed');
    } else {
      answererEl.textContent = state.currentAnswererName
        ? `${esc(state.currentAnswererName)} antwortet…`
        : '';
      statusEl.textContent = '';
    }
  }

  // Host controls
  const hostControls = document.getElementById('host-controls');
  const btnCorrect   = document.getElementById('btn-correct');
  const btnWrong     = document.getElementById('btn-wrong');
  const btnClose     = document.getElementById('btn-close');

  if (amHost) {
    hostControls.style.display = 'flex';
    const answering = state.phase === 'question';
    btnCorrect.style.display = answering ? 'inline-flex' : 'none';
    btnWrong.style.display   = answering ? 'inline-flex' : 'none';
    btnClose.style.display   = (state.phase === 'buzzering' || state.phase === 'question')
      ? 'inline-flex' : 'none';
  } else {
    hostControls.style.display = 'none';
  }

  // Buzzer
  const buzzerBtn = document.getElementById('buzzer-btn');
  const canBuzz =
    !amHost &&
    state.phase === 'buzzering' &&
    !state.wrongAnswererIds.includes(state.myId) &&
    !state.buzzedById;
  buzzerBtn.style.display = canBuzz ? 'block' : 'none';
}

// ── Full reset (everyone back to join screen) ────────────────────────────────
socket.on('fullReset', () => {
  hasJoined = false;
  amHost    = false;
  myState   = null;
  pmPlayerId = null;

  document.getElementById('game-screen').style.display    = 'none';
  document.getElementById('question-modal').style.display = 'none';
  document.getElementById('points-modal').style.display   = 'none';
  document.getElementById('host-buttons').style.display   = 'none';
  document.getElementById('join-screen').style.display    = 'flex';
  document.getElementById('player-name').value            = '';
  document.getElementById('is-host').checked              = false;
  document.getElementById('join-players').innerHTML       = '';
});

// ── Points modal ─────────────────────────────────────────────────────────────
let pmPlayerId = null;
let pmMode     = 'add';

function openPointsModal() {
  if (!amHost || !myState) return;
  pmPlayerId = null;
  pmMode     = 'add';

  // Render player list
  const players = myState.players.filter(p => !p.isHost);
  document.getElementById('pm-player-list').innerHTML = players.map(p => `
    <button class="pm-player-btn" data-id="${esc(p.id)}" data-name="${esc(p.name)}" onclick="pmSelectPlayer(this)">
      <span>${esc(p.name)}</span>
      <span class="pm-score-tag">${p.score} Punkte</span>
    </button>`).join('');

  document.getElementById('pm-step-1').style.display = 'block';
  document.getElementById('pm-step-2').style.display = 'none';
  document.getElementById('points-modal').style.display = 'flex';
}

function closePointsModal() {
  document.getElementById('points-modal').style.display = 'none';
}

function pmSelectPlayer(btn) {
  pmPlayerId = btn.dataset.id;
  document.getElementById('pm-chosen-player').textContent = btn.dataset.name;
  document.getElementById('pm-step-1').style.display = 'none';
  document.getElementById('pm-step-2').style.display = 'block';
  document.getElementById('pm-input').value = '';
  setPmMode('add');
  setTimeout(() => document.getElementById('pm-input').focus(), 50);
}

function setPmMode(mode) {
  pmMode = mode;
  document.getElementById('pm-btn-add').className =
    'pm-mode-btn' + (mode === 'add' ? ' active-add' : '');
  document.getElementById('pm-btn-sub').className =
    'pm-mode-btn' + (mode === 'sub' ? ' active-sub' : '');
}

function pmBack() {
  document.getElementById('pm-step-2').style.display = 'none';
  document.getElementById('pm-step-1').style.display = 'block';
  pmPlayerId = null;
}

function pmSave() {
  const raw = parseInt(document.getElementById('pm-input').value, 10);
  if (!pmPlayerId || isNaN(raw) || raw < 0) return;
  const amount = pmMode === 'sub' ? -raw : raw;
  socket.emit('adjustPoints', { playerId: pmPlayerId, amount });
  closePointsModal();
}

// ── Actions ──────────────────────────────────────────────────────────────────
function selectQuestion(ci, qi) { socket.emit('selectQuestion', { categoryIndex: ci, questionIndex: qi }); }
function answerCorrect()        { socket.emit('answerCorrect'); }
function answerWrong()          { socket.emit('answerWrong'); }
function closeQuestion()        { socket.emit('closeQuestion'); }

function tryBuzz() {
  if (!myState || amHost) return;
  if (myState.phase !== 'buzzering') return;
  if (myState.wrongAnswererIds.includes(myState.myId)) return;
  if (myState.buzzedById) return;
  socket.emit('buzz');
}

function buzz() { tryBuzz(); }

function resetGame() {
  if (confirm('Spiel komplett zurücksetzen? Alle Spieler werden entfernt und zum Startbildschirm weitergeleitet.')) {
    socket.emit('resetGame');
  }
}

// ── Util ─────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
