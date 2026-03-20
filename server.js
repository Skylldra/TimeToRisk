const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const questions = require('./questions.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
let state = createInitialState();

function createInitialState() {
  return {
    players: [],
    currentBoardIndex: 0,
    currentTurnIndex: 0,
    questionOwnerTurnIndex: 0,
    answeredQuestions: [],
    // 'board' | 'question' | 'buzzering' | 'correct' | 'boardComplete'
    phase: 'board',
    activeQuestion: null,   // { categoryIndex, questionIndex }
    currentAnswererId: null,
    buzzedById: null,
    wrongAnswererIds: [],
  };
}

function getCurrentCategories() {
  return questions.boards[state.currentBoardIndex].categories;
}

function getNonHostPlayers() {
  return state.players.filter(p => !p.isHost);
}

function getCurrentPlayer() {
  const nonHost = getNonHostPlayers();
  if (nonHost.length === 0) return null;
  return nonHost[state.currentTurnIndex % nonHost.length];
}

function isAnswered(catIdx, qIdx) {
  return state.answeredQuestions.some(
    q => q.categoryIndex === catIdx && q.questionIndex === qIdx
  );
}

function isBoardComplete() {
  const cats = getCurrentCategories();
  let total = 0;
  for (const cat of cats) total += cat.questions.length;
  return state.answeredQuestions.length >= total;
}

function resolvePhaseAfterQuestion() {
  if (!isBoardComplete()) return 'board';
  if (state.currentBoardIndex < questions.boards.length - 1) return 'boardComplete';
  return 'gameOver';
}

function getStateForPlayer(playerId) {
  const player = state.players.find(p => p.id === playerId);
  const isHost = player?.isHost || false;
  const currentPlayer = getCurrentPlayer();
  const answerer = state.currentAnswererId
    ? state.players.find(p => p.id === state.currentAnswererId)
    : null;
  const buzzer = state.buzzedById
    ? state.players.find(p => p.id === state.buzzedById)
    : null;

  let activeQuestionData = null;
  if (state.activeQuestion !== null) {
    const { categoryIndex, questionIndex } = state.activeQuestion;
    const cats = getCurrentCategories();
    const q = cats[categoryIndex].questions[questionIndex];
    activeQuestionData = {
      categoryIndex,
      questionIndex,
      categoryName: cats[categoryIndex].name,
      points: q.points,
      question: q.question,
      answer: isHost ? q.answer : null,
      image: q.image || null,
    };
  }

  const cats = getCurrentCategories();

  return {
    myId: playerId,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected !== false,
      score: p.score,
      isHost: p.isHost,
    })),
    currentPlayerId: currentPlayer?.id || null,
    currentPlayerName: currentPlayer?.name || null,
    categories: cats.map((cat, ci) => ({
      name: cat.name,
      questions: cat.questions.map((q, qi) => ({
        points: q.points,
        answered: isAnswered(ci, qi),
      })),
    })),
    phase: state.phase,
    activeQuestion: activeQuestionData,
    currentAnswererId: state.currentAnswererId,
    currentAnswererName: answerer?.name || null,
    buzzedById: state.buzzedById,
    buzzedByName: buzzer?.name || null,
    wrongAnswererIds: state.wrongAnswererIds,
    currentBoardIndex: state.currentBoardIndex,
    totalBoards: questions.boards.length,
    boardName: questions.boards[state.currentBoardIndex].name || null,
  };
}

function broadcastState() {
  for (const player of state.players) {
    const socket = io.sockets.sockets.get(player.id);
    if (socket) {
      socket.emit('gameState', getStateForPlayer(player.id));
    }
  }
}

// --- Socket Events ---
io.on('connection', (socket) => {
  socket.emit('gameState', getStateForPlayer(socket.id));

  socket.on('join', ({ name, isHost }) => {
    const trimmed = (name || 'Spieler').trim().slice(0, 24);

    const existing = state.players.find(p => p.name === trimmed && p.connected === false);

    if (existing) {
      const oldId = existing.id;
      existing.id = socket.id;
      existing.connected = true;
      if (state.currentAnswererId === oldId) state.currentAnswererId = socket.id;
      if (state.buzzedById === oldId) state.buzzedById = socket.id;
      const wi = state.wrongAnswererIds.indexOf(oldId);
      if (wi !== -1) state.wrongAnswererIds[wi] = socket.id;
    } else {
      state.players = state.players.filter(p => p.id !== socket.id);
      state.players.push({
        id: socket.id,
        name: trimmed,
        score: 0,
        isHost: !!isHost,
        connected: true,
      });
    }
    broadcastState();
  });

  socket.on('selectQuestion', ({ categoryIndex, questionIndex }) => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (state.phase !== 'board') return;
    if (isAnswered(categoryIndex, questionIndex)) return;

    state.activeQuestion = { categoryIndex, questionIndex };
    state.phase = 'question';
    state.questionOwnerTurnIndex = state.currentTurnIndex;
    state.currentAnswererId = getCurrentPlayer()?.id || null;
    state.buzzedById = null;
    state.wrongAnswererIds = [];
    broadcastState();
  });

  socket.on('answerCorrect', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (state.phase !== 'question' || !state.activeQuestion) return;

    const { categoryIndex, questionIndex } = state.activeQuestion;
    const cats = getCurrentCategories();
    const points = cats[categoryIndex].questions[questionIndex].points;
    const answererId = state.currentAnswererId;

    // Award points (half if answered after a buzz)
    const awarded = state.buzzedById ? Math.floor(points / 2) : points;
    const answerer = state.players.find(p => p.id === answererId);
    if (answerer) answerer.score += awarded;

    // Advance to the player after whoever owned this question's turn
    const nonHost = getNonHostPlayers();
    if (nonHost.length > 0) {
      state.currentTurnIndex = (state.questionOwnerTurnIndex + 1) % nonHost.length;
    }

    state.answeredQuestions.push({ categoryIndex, questionIndex });
    state.phase = 'correct';
    broadcastState();

    // Auto-close modal after 2 seconds
    setTimeout(() => {
      state.activeQuestion = null;
      state.phase = resolvePhaseAfterQuestion();
      state.currentAnswererId = null;
      state.buzzedById = null;
      state.wrongAnswererIds = [];
      broadcastState();
    }, 2000);
  });

  socket.on('answerWrong', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (state.phase !== 'question' || !state.activeQuestion) return;

    const { categoryIndex, questionIndex } = state.activeQuestion;
    const cats = getCurrentCategories();
    const points = cats[categoryIndex].questions[questionIndex].points;
    const penalty = Math.floor(points / 2);

    const wrongPlayer = state.players.find(p => p.id === state.currentAnswererId);
    if (wrongPlayer) wrongPlayer.score -= penalty;

    if (state.currentAnswererId && !state.wrongAnswererIds.includes(state.currentAnswererId)) {
      state.wrongAnswererIds.push(state.currentAnswererId);
    }

    state.buzzedById = null;
    state.currentAnswererId = null;
    state.phase = 'buzzering';
    broadcastState();
  });

  socket.on('buzz', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player || player.isHost) return;
    if (state.phase !== 'buzzering') return;
    if (state.wrongAnswererIds.includes(socket.id)) return;
    if (state.buzzedById) return;

    state.buzzedById = socket.id;
    state.currentAnswererId = socket.id;
    state.phase = 'question';
    broadcastState();
  });

  socket.on('closeQuestion', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (!state.activeQuestion) return;
    if (state.phase === 'correct') return;

    const nonHost = getNonHostPlayers();
    if (nonHost.length > 0) {
      state.currentTurnIndex = (state.questionOwnerTurnIndex + 1) % nonHost.length;
    }

    state.answeredQuestions.push({ ...state.activeQuestion });
    state.activeQuestion = null;
    state.phase = resolvePhaseAfterQuestion();
    state.currentAnswererId = null;
    state.buzzedById = null;
    state.wrongAnswererIds = [];
    broadcastState();
  });

  socket.on('startNextBoard', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (state.phase !== 'boardComplete') return;
    if (state.currentBoardIndex >= questions.boards.length - 1) return;

    state.currentBoardIndex++;
    state.answeredQuestions = [];
    state.activeQuestion = null;
    state.currentAnswererId = null;
    state.buzzedById = null;
    state.wrongAnswererIds = [];

    // Player with fewest points goes first
    const nonHost = getNonHostPlayers();
    if (nonHost.length > 0) {
      let minScore = Infinity;
      let minIndex = 0;
      nonHost.forEach((p, i) => {
        if (p.score < minScore) { minScore = p.score; minIndex = i; }
      });
      state.currentTurnIndex = minIndex;
      state.questionOwnerTurnIndex = minIndex;
    }

    state.phase = 'board';
    io.emit('nextBoardStarted');
    broadcastState();
  });

  socket.on('adjustPoints', ({ playerId, amount }) => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    const target = state.players.find(p => p.id === playerId && !p.isHost);
    if (!target) return;
    target.score += amount;
    broadcastState();
  });

  socket.on('resetGame', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    io.emit('fullReset');
    state = createInitialState();
  });

  socket.on('disconnect', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      const nonHost = getNonHostPlayers();
      if (nonHost.length > 0) {
        state.currentTurnIndex = state.currentTurnIndex % nonHost.length;
      } else {
        state.currentTurnIndex = 0;
      }
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`TimeToRisk server running on http://localhost:${PORT}`);
});
