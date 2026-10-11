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
// 공공데이터 우리말샘 API 단어 검증 라우트
// ==========================================
const URIMALSEM_API_KEY = "29ea410f-f9ec-4e8d-adfd-d7a6800565d1";
const URIMALSEM_URL = "https://opendict.korean.go.kr/api/search";

app.get('/api/check', async (req, res) => {
    const word = req.query.word;
    if (!word) {
        return res.json({ isValid: false });
    }
    
    try {
        const response = await axios.get(URIMALSEM_URL, {
            params: {
                key: URIMALSEM_API_KEY,
                q: word,
                req_type: "json",
                part: "word",
                num: 1
            }
        });

        const total = parseInt(response.data.channel?.total || 0);
        
        if (total > 0) {
            res.json({ isValid: true });
        } else {
            res.json({ isValid: false });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "API 요청 실패" });
    }
});

// ==========================================
// 스타 끄투 게임 로직
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
  const req = socket.request;
  const sessionUser = req.session?.passport?.user;

  if (!sessionUser) {
    socket.emit('systemMessage', '❌ GitHub 로그인이 필요합니다.');
    return;
  }

  const player = {
    id: socket.id,
    name: sessionUser.name,
    username: sessionUser.username,
    isGM: sessionUser.isGM,
    badge: sessionUser.isGM ? '👑 [GM]' : '🎮 [PLAYER]',
    bg: sessionUser.isGM ? 'gm-bg' : 'default-bg'
  };

  const existingIdx = gameState.players.findIndex(p => p.username === player.username);
  if (existingIdx !== -1) {
    gameState.players[existingIdx] = player;
  } else {
    gameState.players.push(player);
  }

  io.emit('updatePlayers', gameState.players);
  socket.emit('initSelf', player);
  socket.emit('systemMessage', `📢 ${player.name}(@${player.username})님 환영합니다! ${player.isGM ? '(👑 GM 권한이 부여되었습니다)' : ''}`);

  if (gameState.players.length === 1 && !gameState.isStarted) {
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

    socket.emit('systemMessage', `🔍 "${word}" 단어 확인 중...`);
    
    try {
        const response = await axios.get(URIMALSEM_URL, {
            params: {
                key: URIMALSEM_API_KEY,
                q: word,
                req_type: "json",
                part: "word",
                num: 10
            }
        });

        const channel = response.data.channel;
        const items = channel?.item;

        if (!items || channel.total === '0' || parseInt(channel.total || 0) === 0) {
            return socket.emit('systemMessage', `❌ "${word}"은(는) 우리말샘에 등재되지 않은 단어입니다.`);
        }

        const itemList = Array.isArray(items) ? items : [items];
        let isValidWord = false;

        for (let item of itemList) {
            const targetWord = item.word ? item.word.replace(/[^가-힣]/g, '') : '';
            if (targetWord === word) {
                isValidWord = true;
                break;
            }
        }

        if (!isValidWord) {
            return socket.emit('systemMessage', `❌ "${word}"은(는) 끄투에서 인정하지 않는 유효하지 않은 형태의 단어입니다.`);
        }

    } catch (error) {
        console.error(error);
        return socket.emit('systemMessage', '❌ 단어 검증 중 서버 오류가 발생했습니다.');
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 STAR KKUTU 서버 오픈: http://localhost:${PORT}`));
