const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// GM 목록 (닉네임 기준)
const GM_LIST = ['star', 'GM', 'admin', "hello"];

const gameState = {
  players: [],        // { id, name, isGM, bg, badge }
  currentTurn: 0,
  currentWord: '',
  usedWords: new Set(),
  timer: null,
  timeLeft: 15,
  isStarted: false
};

// 두음법칙 변환
function getValidNextChars(char) {
  const chars = [char];
  const code = char.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11172) return chars;

  const initial = Math.floor(code / 588);
  const vowel = Math.floor((code % 588) / 28);
  const tail = code % 28;

  if (initial === 5) {
    if ([2, 4, 18, 20].includes(vowel)) {
      chars.push(String.fromCharCode(0xac00 + (11 * 588) + (vowel * 28) + tail));
    } else {
      chars.push(String.fromCharCode(0xac00 + (2 * 588) + (vowel * 28) + tail));
    }
  } else if (initial === 2) {
    if ([2, 4, 18, 20].includes(vowel)) {
      chars.push(String.fromCharCode(0xac00 + (11 * 588) + (vowel * 28) + tail));
    }
  }
  return chars;
}

function startTimer() {
  clearInterval(gameState.timer);
  gameState.timeLeft = 15;
  io.emit('timerTick', gameState.timeLeft);

  gameState.timer = setInterval(() => {
    gameState.timeLeft--;
    io.emit('timerTick', gameState.timeLeft);

    if (gameState.timeLeft <= 0) {
      clearInterval(gameState.timer);
      const prevPlayer = gameState.players[gameState.currentTurn];
      io.emit('systemMessage', `⏰ [시간 초과] ${prevPlayer ? prevPlayer.name : '유저'}님의 턴이 넘어갔습니다!`);
      nextTurn();
    }
  }, 1000);
}

function nextTurn() {
  if (gameState.players.length === 0) return;
  gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
  const nextPlayer = gameState.players[gameState.currentTurn];
  
  io.emit('turnChange', {
    currentPlayer: nextPlayer,
    currentWord: gameState.currentWord
  });
  
  startTimer();
}

io.on('connection', (socket) => {
  socket.on('joinGame', (nickname) => {
    const cleanName = nickname.trim() || `유저_${socket.id.slice(0, 4)}`;
    const isGM = GM_LIST.includes(cleanName);

    const player = {
      id: socket.id,
      name: cleanName,
      isGM: isGM,
      badge: isGM ? '👑 [GM]' : '🎮 [PLAYER]',
      bg: isGM ? 'gm-bg' : 'default-bg' // GM 전용 골드 그라데이션 배경
    };

    gameState.players.push(player);

    io.emit('updatePlayers', gameState.players);
    socket.emit('initSelf', player);
    socket.emit('systemMessage', `📢 ${player.name}님 환영합니다! ${isGM ? '(GM 권한이 활성화되었습니다)' : ''}`);

    if (gameState.players.length === 1 && !gameState.isStarted) {
      gameState.isStarted = true;
      gameState.currentWord = '스타끄투'; // 첫 제시어를 '스타끄투'로 변경
      gameState.usedWords.add('스타끄투');
      
      io.emit('gameStart', {
        currentWord: gameState.currentWord,
        currentPlayer: gameState.players[0]
      });
      startTimer();
    } else {

      socket.emit('gameState', {
        currentWord: gameState.currentWord,
        currentPlayer: gameState.players[gameState.currentTurn]
      });
    }
  });

  socket.on('submitWord', (word) => {
    word = word.trim();
    const currentPlayer = gameState.players[gameState.currentTurn];

    if (!currentPlayer || socket.id !== currentPlayer.id) {
      return socket.emit('systemMessage', '❌ 본인 턴에만 입력 가능합니다.');
    }

    if (word.length < 2) {
      return socket.emit('systemMessage', '❌ 2글자 이상 입력하세요.');
    }

    if (gameState.usedWords.has(word)) {
      return socket.emit('systemMessage', '❌ 이미 사용한 단어입니다.');
    }

    const lastChar = gameState.currentWord.slice(-1);
    const validFirstChars = getValidNextChars(lastChar);

    if (!validFirstChars.includes(word[0])) {
      return socket.emit('systemMessage', `❌ '${lastChar}'(으)로 시작해 주세요.`);
    }

    gameState.usedWords.add(word);
    gameState.currentWord = word;

    io.emit('wordAccepted', {
      player: currentPlayer,
      word: word
    });

    nextTurn();
  });

  socket.on('disconnect', () => {
    const index = gameState.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
      const p = gameState.players.splice(index, 1)[0];
      io.emit('systemMessage', `👋 ${p.name}님이 퇴장했습니다.`);
      io.emit('updatePlayers', gameState.players);

      if (gameState.players.length === 0) {
        clearInterval(gameState.timer);
        gameState.isStarted = false;
        gameState.usedWords.clear();
      } else if (gameState.currentTurn >= gameState.players.length) {
        gameState.currentTurn = 0;
        nextTurn();
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 끄투 게임 서버 오픈: http://localhost:${PORT}`));
