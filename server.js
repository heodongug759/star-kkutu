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

// ==========================================
// [설정] GitHub OAuth 키 & GM 깃허브 아이디 목록
// ==========================================
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Ov23lizVNA79tofTb34u';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '641a36180151bd9b665fc8e4bc464be9eacf33bd';

// GM 권한을 줄 깃허브 닉네임(Username) 목록
const GM_USERNAMES = 'heodongug759';

// 세션 설정
const sessionMiddleware = session({
  secret: 'star-kkutu-github-secret-key',
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// Passport 깃허브 전략 설정
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

// Express 세션을 Socket.io와 공유
io.engine.use(sessionMiddleware);

// ==========================================
// 깃허브 로그인 인증 라우트
// ==========================================
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
// 💡 [Linux x86_64 최적화] 네이버 사전 API 단어 검증
// ==========================================
async function verifyWordWithNaver(word) {
  try {
    const response = await axios.get(`https://dict.naver.com/api/ac/kr/kko/all`, {
      params: {
        q: word,
        q_enc: 'utf-8',
        st: 110,
        r_format: 'json',
        r_enc: 'utf-8'
      },
      headers: {
        // 리눅스 민트 x86_64 환경 표준 크롬 User-Agent 적용
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 3000
    });

    const items = response.data?.items;
    if (items && Array.isArray(items)) {
      for (let group of items) {
        if (Array.isArray(group)) {
          for (let item of group) {
            const targetWord = item[0] ? item[0].replace(/[^가-힣]/g, '') : '';
            if (targetWord === word) {
              return true;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('네이버 사전 API 통신 예외:', err.message);
  }

  // 네트워크 예외 시 순수 한글 2글자 이상 기본 규칙 적용
  const koreanRegex = /^[가-힣]{2,}$/;
  return koreanRegex.test(word);
}

app.get('/api/check', async (req, res) => {
  const word = req.query.word;
  if (!word || word.length < 2) {
    return res.json({ isValid: false });
  }
  const isValid = await verifyWordWithNaver(word);
  res.json({ isValid });
});

// ==========================================
// 스타 끄투 게임 로직 (리눅스 서버 및 봇 연동)
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

async function handleBotTurn() {
  if (!gameState.players[gameState.currentTurn]?.isBot) return;

  const lastChar = gameState.currentWord.slice(-1);
  const validFirstChars = getValidNextChars(lastChar);

  let chosenWord = '';

  const botDictionary = {
    '사': ['사과', '사자', '사랑', '사막', '사진', '사람'],
    '과': ['과학', '과자', '과일', '과정', '과목'],
    '학': ['학생', '학교', '학원', '학습'],
    '교': ['교실', '교복', '교과서', '교통'],
    '나': ['나무', '나비', '나팔', '나라'],
    '무': ['무궁화', '무지개', '무대'],
    '구': ['구름', '구두', '구슬'],
    '바': ['바나나', '바다', '바람', '바위']
  };

  for (const startChar of validFirstChars) {
    const candidateList = botDictionary[startChar] || [startChar + '나무', startChar + '나라', startChar + '구름'];
    for (let word of candidateList) {
      if (!gameState.usedWords.has(word)) {
        chosenWord = word;
        break;
      }
    }
    if (chosenWord) break;
  }

  if (!chosenWord) {
    chosenWord = lastChar + '가방';
  }

  gameState.usedWords.add(chosenWord);
  gameState.currentWord = chosenWord;

  io.emit('wordAccepted', {
    player: BOT_PLAYER,
    word: chosenWord
  });

  io.emit('systemMessage', `🤖 끄투봇이 "${chosenWord}"(을)를 입력했습니다!`);
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
    const isValid = await verifyWordWithNaver(word);

    if (!isValid) {
      return socket.emit('systemMessage', `❌ "${word}"은(는) 네이버 사전에 등재되지 않은 단어입니다.`);
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
    const index = gameState.players.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
      gameState.players.splice(index, 1);
      
      const humanPlayers = gameState.players.filter(p => !p.isBot);
      if (humanPlayers.length === 0) {
        clearInterval(gameState.timer);
        gameState.isStarted = false;
        gameState.usedWords.clear();
        gameState.players = [];
      } else {
        if (!gameState.players.some(p => p.isBot)) {
          gameState.players.push(BOT_PLAYER);
        }
        io.emit('updatePlayers', gameState.players);
        if (gameState.currentTurn >= gameState.players.length) {
          gameState.currentTurn = 0;
          nextTurn();
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 STAR KKUTU 서버 오픈: http://localhost:${PORT}`));
