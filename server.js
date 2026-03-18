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
    currentTurnIndex: 0,
    answeredQuestions: [],
    // 'board' | 'question' | 'buzzering' | 'correct'
    phase: 'board',
    activeQuestion: null,   // { categoryIndex, questionIndex }
    currentAnswererId: null,
    buzzedById: null,
    wrongAnswererIds: [],
  };
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
    const q = questions.categories[categoryIndex].questions[questionIndex];
    activeQuestionData = {
      categoryIndex,
      questionIndex,
      categoryName: questions.categories[categoryIndex].name,
      points: q.points,
      question: q.question,
      answer: isHost ? q.answer : null,
    };
  }

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
    categories: questions.categories.map((cat, ci) => ({
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
  // Send current state on connect (before joining)
  socket.emit('gameState', getStateForPlayer(socket.id));

  socket.on('join', ({ name, isHost }) => {
    const trimmed = (name || 'Spieler').trim().slice(0, 24);

    // Reconnect: find a disconnected player with the same name
    const existing = state.players.find(p => p.name === trimmed && p.connected === false);

    if (existing) {
      const oldId = existing.id;
      existing.id = socket.id;
      existing.connected = true;
      // Update any state references that held the old socket id
      if (state.currentAnswererId === oldId) state.currentAnswererId = socket.id;
      if (state.buzzedById === oldId) state.buzzedById = socket.id;
      const wi = state.wrongAnswererIds.indexOf(oldId);
      if (wi !== -1) state.wrongAnswererIds[wi] = socket.id;
    } else {
      // New player — remove any stale entry with this socket id first
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
    if (!player?.isHost) return;  // Only the host clicks questions
    if (state.phase !== 'board') return;
    if (isAnswered(categoryIndex, questionIndex)) return;

    state.activeQuestion = { categoryIndex, questionIndex };
    state.phase = 'question';
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
    const points = questions.categories[categoryIndex].questions[questionIndex].points;
    const answererId = state.currentAnswererId;

    // Award points
    const answerer = state.players.find(p => p.id === answererId);
    if (answerer) answerer.score += points;

    // The correct answerer gets the next turn
    const nonHost = getNonHostPlayers();
    const answererIndex = nonHost.findIndex(p => p.id === answererId);
    if (answererIndex !== -1) state.currentTurnIndex = answererIndex;

    // Mark question answered immediately so board updates
    state.answeredQuestions.push({ categoryIndex, questionIndex });
    state.phase = 'correct';
    broadcastState();

    // Auto-close modal after 2 seconds
    setTimeout(() => {
      state.activeQuestion = null;
      state.phase = 'board';
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
    const points = questions.categories[categoryIndex].questions[questionIndex].points;
    const penalty = Math.floor(points / 2);

    // Deduct half the question's points from the wrong answerer
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

    // Advance to next player in rotation
    const nonHost = getNonHostPlayers();
    if (nonHost.length > 0) {
      state.currentTurnIndex = (state.currentTurnIndex + 1) % nonHost.length;
    }

    state.answeredQuestions.push({ ...state.activeQuestion });
    state.activeQuestion = null;
    state.phase = 'board';
    state.currentAnswererId = null;
    state.buzzedById = null;
    state.wrongAnswererIds = [];
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
    // Full reset: kick everyone out and wipe all state
    io.emit('fullReset');
    state = createInitialState();
  });

  socket.on('disconnect', () => {
    const player = state.players.find(p => p.id === socket.id);
    if (player) {
      // Keep the player in state (so they can reconnect) but mark as disconnected
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
