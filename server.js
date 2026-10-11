const axios = require('axios');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Ov23lizVNA79tofTb34u';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '641a36180151bd9b665fc8e4bc464be9eacf33bd';
const GM_USERNAMES = 'heodongug759';

const sessionMiddleware = session({
  secret: 'star-kkutu-github-secret-key',
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

passport.use(new GitHubStrategy({
    clientID: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || "https://star-kkutu.onrender.com/auth/github/callback"
  },
  (accessToken, refreshToken, profile, done) => {
    const username = profile.username;
    const user = {
      id: profile.id,
      name: profile.displayName || username,
      username: username,
      isGM: GM_USERNAMES.includes(username)
    };
    return done(null, user);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

io.engine.use(sessionMiddleware);

app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/auth/github/callback', 
  passport.authenticate('github', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ loggedIn: true, user: req.user });
  } else {
    res.json({ loggedIn: false });
  }
});

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// ==========================================
// 네이버 사전 API 검증 및 뜻 조회
// ==========================================
async function getWordInfoFromNaver(word) {
  try {
    const response = await axios.get(`https://dict.naver.com/api/ac/kr/kko/all`, {
      params: { q: word, q_enc: 'utf-8', st: 110, r_format: 'json', r_enc: 'utf-8' },
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      timeout: 3000
    });

    const items = response.data?.items;
    if (items && Array.isArray(items)) {
      for (let group of items) {
        if (Array.isArray(group)) {
          for (let item of group) {
            const targetWord = item[0] ? item[0].replace(/[^가-힣]/g, '') : '';
            if (targetWord === word) {
              let definition = item[1]?.[0] || '네이버 사전에 등록된 단어입니다.';
              return { isValid: true, definition };
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('API 통신 오류:', err.message);
  }

  const koreanRegex = /^[가-힣]{2,}$/;
  if (koreanRegex.test(word)) {
    return { isValid: true, definition: '표준 순수 한글 단어입니다.' };
  }
  return { isValid: false, definition: '' };
}

// ==========================================
// 게임 상태 관리
// ==========================================
const gameState = {
  players: [],
  currentTurn: 0,
  currentWord: '',
  usedWords: new Set(),
  timer: null,
  timeLeft: 15,
  isStarted: false
};

const BOT_PLAYER = {
  socketId: 'bot-kkutu',
  name: '🤖 끄투봇',
  username: 'kkutubot',
  isGM: false,
  badge: '🤖 [BOT]',
  bg: 'bot-bg',
  isBot: true
};

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

  if (nextPlayer && nextPlayer.isBot) {
    setTimeout(handleBotTurn, 1500);
  }
}

// 🤖 [개선] '무'로 끝나는 단어 배제 및 무작위 선택 봇 로직
async function handleBotTurn() {
  if (!gameState.players[gameState.currentTurn]?.isBot) return;

  const lastChar = gameState.currentWord.slice(-1);
  const validFirstChars = getValidNextChars(lastChar);

  let primaryCandidates = [];   // '무'로 끝나지 않는 우선 후보군
  let secondaryCandidates = []; // 어쩔 수 없을 때 쓸 보조 후보군

  for (const startChar of validFirstChars) {
    try {
      const response = await axios.get(`https://dict.naver.com/api/ac/kr/kko/all`, {
        params: { q: startChar, q_enc: 'utf-8', st: 110, r_format: 'json', r_enc: 'utf-8' },
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
        timeout: 3000
      });

      const items = response.data?.items;
      if (items && Array.isArray(items)) {
        for (let group of items) {
          if (Array.isArray(group)) {
            for (let item of group) {
              const cleanWord = item[0] ? item[0].replace(/[^가-힣]/g, '') : '';
              const definition = item[1]?.[0] || '네이버 사전에 등록된 단어입니다.';
              
              if (
                cleanWord.length >= 2 &&
                cleanWord.startsWith(startChar) &&
                !gameState.usedWords.has(cleanWord)
              ) {
                // 💡 '무'로 끝나는 단어는 우선 순위에서 제외
                if (cleanWord.endsWith('무')) {
                  secondaryCandidates.push({ word: cleanWord, def: definition });
                } else {
                  primaryCandidates.push({ word: cleanWord, def: definition });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('봇 API 검색 오류:', err.message);
    }
  }

  let chosenObj = null;

  // 1순위: '무'로 끝나지 않는 단어 중 랜덤 선택
  if (primaryCandidates.length > 0) {
    const randomIndex = Math.floor(Math.random() * primaryCandidates.length);
    chosenObj = primaryCandidates[randomIndex];
  } 
  // 2순위: 적절한 단어가 없을 때 보조 단어 중 랜덤 선택
  else if (secondaryCandidates.length > 0) {
    const randomIndex = Math.floor(Math.random() * secondaryCandidates.length);
    chosenObj = secondaryCandidates[randomIndex];
  }

  // 예외 시 무작위 안전 단어 생성 (단일 '나무' 고정 방지)
  const safeEndings = ['가방', '나비', '구름', '기차', '지구', '바다', '사람', '사진'];
  const randomEnding = safeEndings[Math.floor(Math.random() * safeEndings.length)];

  const chosenWord = chosenObj ? chosenObj.word : (lastChar + randomEnding.slice(1));
  const chosenDef = chosenObj ? chosenObj.def : '네이버 사전 자동 연동 단어입니다.';

  gameState.usedWords.add(chosenWord);
  gameState.currentWord = chosenWord;

  io.emit('wordAccepted', {
    player: BOT_PLAYER,
    word: chosenWord,
    definition: chosenDef
  });

  io.emit('systemMessage', `🤖 끄투봇이 네이버 사전 API에서 "${chosenWord}"(을)를 찾아 입력했습니다.`);
  nextTurn();
}

io.on('connection', (socket) => {
  const req = socket.request;
  const sessionUser = req.session?.passport?.user;

  if (!sessionUser) {
    socket.emit('systemMessage', '❌ GitHub 로그인이 필요합니다.');
    return;
  }

  const player = {
    socketId: socket.id,
    name: sessionUser.name,
    username: sessionUser.username,
    isGM: sessionUser.isGM,
    badge: sessionUser.isGM ? '👑 [GM]' : '🎮 [PLAYER]',
    bg: sessionUser.isGM ? 'gm-bg' : 'default-bg',
    isBot: false
  };

  const existingIdx = gameState.players.findIndex(p => p.username === player.username);
  if (existingIdx !== -1) {
    gameState.players[existingIdx].socketId = socket.id;
  } else {
    gameState.players.push(player);
  }

  if (!gameState.players.some(p => p.isBot)) {
    gameState.players.push(BOT_PLAYER);
  }

  io.emit('updatePlayers', gameState.players);
  socket.emit('initSelf', player);
  socket.emit('systemMessage', `📢 ${player.name}(@${player.username})님 환영합니다!`);

  if (!gameState.isStarted) {
    gameState.isStarted = true;
    gameState.currentWord = '스타끄투';
    gameState.usedWords.clear();
    gameState.usedWords.add('스타끄투');
    gameState.currentTurn = 0;
    
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

  socket.on('submitWord', async (word) => {
    word = word.trim();
    const currentPlayer = gameState.players[gameState.currentTurn];

    if (!currentPlayer || currentPlayer.username !== player.username) {
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

    socket.emit('systemMessage', `🔍 "${word}" 단어 확인 중...`);
    const wordInfo = await getWordInfoFromNaver(word);

    if (!wordInfo.isValid) {
      return socket.emit('systemMessage', `❌ "${word}"은(는) 네이버 사전에 등재되지 않은 단어입니다.`);
    }

    gameState.usedWords.add(word);
    gameState.currentWord = word;

    io.emit('wordAccepted', {
      player: currentPlayer,
      word: word,
      definition: wordInfo.definition
    });

    nextTurn();
  });

  socket.on('disconnect', () => {
    const index = gameState.players.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
      gameState.players.splice(index, 1);
      
      const humanPlayers = gameState.players.filter(p => !p.isBot);
      if (humanPlayers.length === 0) {
        clearInterval(gameState.timer);
        gameState.isStarted = false;
        gameState.usedWords.clear();
        gameState.usedWords.add('스타끄투');
        gameState.players = [];
      } else {
        if (!gameState.players.some(p => p.isBot)) {
          gameState.players.push(BOT_PLAYER);
        }
        io.emit('updatePlayers', gameState.players);
        if (gameState.currentTurn >= gameState.players.length) {
          gameState.currentTurn = 0;
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 서버 구동 완료: http://localhost:${PORT}`));
