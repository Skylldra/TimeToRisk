const socket = io();

let myState = null;
let amHost = false;
let hasJoined = false;

// ── Keyboard shortcut: Spacebar = Buzz ──────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    tryBuzz();
  }
});

// ── Enter key to join ────────────────────────────────────────────────────────
document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinGame();
});

// ── Join game ────────────────────────────────────────────────────────────────
function joinGame() {
  const nameInput = document.getElementById('player-name');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  amHost = document.getElementById('is-host').checked;
  hasJoined = true;

  socket.emit('join', { name, isHost: amHost });

  document.getElementById('join-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'grid';

  if (amHost) {
    document.getElementById('reset-btn').style.display = 'block';
  }
}

// ── Receive state updates ────────────────────────────────────────────────────
socket.on('gameState', (state) => {
  myState = state;
  // Sync host flag in case of reconnect
  const me = state.players.find(p => p.id === state.myId);
  if (me) amHost = me.isHost;
  renderGame(state);
});

// ── Render ───────────────────────────────────────────────────────────────────
function renderGame(state) {
  renderScoreBar(state);
  renderTurnIndicator(state);
  renderBoard(state);
  renderModal(state);
}

function renderScoreBar(state) {
  const bar = document.getElementById('score-bar');
  const nonHost = state.players.filter(p => !p.isHost);
  bar.innerHTML = nonHost.map(p => {
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
    el.textContent = 'Warte auf Spieler…';
    return;
  }
  const isMe = state.currentPlayerId === state.myId;
  if (isMe && !amHost) {
    el.textContent = '⭐ Du bist dran!';
  } else {
    el.textContent = `${esc(state.currentPlayerName)} ist dran`;
  }
}

function renderBoard(state) {
  const board = document.getElementById('board');
  const isMyTurn = state.currentPlayerId === state.myId && !amHost;
  let html = '';

  // Category headers
  for (const cat of state.categories) {
    html += `<div class="board-cell cat-header">${esc(cat.name)}</div>`;
  }

  // 5 rows of questions
  for (let qi = 0; qi < 5; qi++) {
    for (let ci = 0; ci < state.categories.length; ci++) {
      const q = state.categories[ci].questions[qi];
      const canSelect = isMyTurn && !q.answered && state.phase === 'board';
      const selectableClass = canSelect ? 'selectable' : '';
      const answeredClass = q.answered ? 'answered' : '';
      const clickAttr = canSelect
        ? `onclick="selectQuestion(${ci},${qi})"`
        : '';
      html += `
        <div class="board-cell q-cell ${answeredClass} ${selectableClass}" ${clickAttr}>
          ${q.answered ? '' : `<span>${q.points}</span>`}
        </div>`;
    }
  }

  board.innerHTML = html;
}

function renderModal(state) {
  const modal = document.getElementById('question-modal');

  // Hide modal when back on board
  if (state.phase === 'board' || !state.activeQuestion) {
    modal.style.display = 'none';
    return;
  }

  modal.style.display = 'flex';

  const q = state.activeQuestion;

  document.getElementById('modal-category').textContent = q.categoryName.toUpperCase();
  document.getElementById('modal-points').textContent = `${q.points} Punkte`;
  document.getElementById('modal-question').textContent = q.question;

  // Answer — host only
  const answerEl = document.getElementById('modal-answer');
  if (amHost && q.answer) {
    answerEl.textContent = `Antwort: ${q.answer}`;
    answerEl.style.display = 'block';
  } else {
    answerEl.style.display = 'none';
  }

  // Answerer / buzz / status text
  const answererEl = document.getElementById('modal-answerer');
  const statusEl   = document.getElementById('modal-status');

  statusEl.className = ''; // reset classes

  if (state.phase === 'correct') {
    answererEl.textContent = '';
    statusEl.textContent = 'Richtige Antwort! ✓';
    statusEl.classList.add('correct');
  } else if (state.phase === 'buzzering') {
    answererEl.textContent = '';
    statusEl.textContent = 'Falsche Antwort! Es kann gebuzzert werden.';
    statusEl.classList.add('wrong');
  } else if (state.phase === 'question') {
    if (state.buzzedById) {
      answererEl.textContent = '';
      statusEl.textContent = `⚡ ${esc(state.buzzedByName)} hat gebuzzert!`;
      statusEl.classList.add('buzzed');
    } else {
      answererEl.textContent = state.currentAnswererName
        ? `${esc(state.currentAnswererName)} antwortet…`
        : '';
      statusEl.textContent = '';
    }
  }

  // Host control buttons
  const hostControls = document.getElementById('host-controls');
  const btnCorrect   = document.getElementById('btn-correct');
  const btnWrong     = document.getElementById('btn-wrong');
  const btnClose     = document.getElementById('btn-close');

  if (amHost) {
    hostControls.style.display = 'flex';
    // Correct & Wrong only make sense when someone is answering
    const answering = state.phase === 'question';
    btnCorrect.style.display = answering ? 'inline-block' : 'none';
    btnWrong.style.display   = answering ? 'inline-block' : 'none';
    // Close available during buzzering (and question as emergency)
    btnClose.style.display =
      (state.phase === 'buzzering' || state.phase === 'question') ? 'inline-block' : 'none';
  } else {
    hostControls.style.display = 'none';
  }

  // Buzzer button
  const buzzerBtn = document.getElementById('buzzer-btn');
  const canBuzz =
    !amHost &&
    state.phase === 'buzzering' &&
    !state.wrongAnswererIds.includes(state.myId) &&
    !state.buzzedById;

  buzzerBtn.style.display = canBuzz ? 'block' : 'none';
}

// ── Actions ──────────────────────────────────────────────────────────────────
function selectQuestion(categoryIndex, questionIndex) {
  socket.emit('selectQuestion', { categoryIndex, questionIndex });
}

function answerCorrect() {
  socket.emit('answerCorrect');
}

function answerWrong() {
  socket.emit('answerWrong');
}

function tryBuzz() {
  if (!myState) return;
  if (amHost) return;
  if (myState.phase !== 'buzzering') return;
  if (myState.wrongAnswererIds.includes(myState.myId)) return;
  if (myState.buzzedById) return;
  socket.emit('buzz');
}

function buzz() {
  tryBuzz();
}

function closeQuestion() {
  socket.emit('closeQuestion');
}

function resetGame() {
  if (confirm('Spiel wirklich zurücksetzen? Alle Punkte werden gelöscht.')) {
    socket.emit('resetGame');
  }
}

// ── Util ─────────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
