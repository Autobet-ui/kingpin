'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const axios     = require('axios');
const path      = require('path');
const https     = require('https');
const dns       = require('dns');

// Force Google DNS for resolving GOA API domains
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

// ══════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════
const PORT       = process.env.PORT || 3000;
// Use IP if DNS fails on Railway
const GOA_IP     = process.env.GOA_API_IP || '104.21.79.243';
const GOA_BASE   = 'https://api.goagamea.com';   // Goa Games API base
const GAME_CODE  = 'WinGo_30S';

// Common headers to mimic the mobile app
const GOA_HEADERS = {
  'Content-Type'   : 'application/json',
  'Accept'         : 'application/json',
  'Origin'         : 'https://goagamea.com',
  'Referer'        : 'https://goagamea.com/',
  'User-Agent'     : 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'x-forwarded-for': '103.21.' + Math.floor(Math.random()*255) + '.' + Math.floor(Math.random()*255),
  'CF-IPCountry'   : 'IN',
  'X-Country-Code' : 'IN',
};

// goaRequest with retry on multiple domains
const GOA_DOMAINS = ['https://api.goagamea.com', 'https://www.goagamea.com'];

// ══════════════════════════════════════════════════
//  ACCOUNT STORE  (phone → session)
// ══════════════════════════════════════════════════
const accounts = {};   // phone → { lotteryToken, webapiToken, pwd, engine, state, interval }

// ══════════════════════════════════════════════════
//  PREDICTION FORMULAS
// ══════════════════════════════════════════════════
const FORMULAS = {
  kingpin3: formulaKingpin3,
  zigzag:   formulaZigzag,
  oracle:   formulaOracle,
  kaala:    formulaKaala,
  titan_v3: formulaTitan,
  dna3:     formulaDna3,
  // default fallback
};

function formulaKingpin3(history) {
  if (!history || history.length < 2) return 'BIG';
  var last = history.slice(-2).map(h => h.bs);
  var votes = 0;
  // 4-modular vote
  if (last[0] === 'BIG')   votes++;
  if (last[1] === 'SMALL') votes++;
  if ((last[0] === 'BIG') === (last[1] === 'BIG')) votes++;
  var streak = 1; var i = history.length - 2;
  while (i >= 0 && history[i].bs === history[history.length-1].bs) { streak++; i--; }
  if (streak >= 3) votes++;  // streak break
  return votes >= 2 ? 'BIG' : 'SMALL';
}

function formulaZigzag(history) {
  if (!history || history.length === 0) return 'BIG';
  var last = history[history.length - 1].bs;
  return last === 'BIG' ? 'SMALL' : 'BIG';
}

function formulaOracle(history) {
  if (!history || history.length < 5) return formulaZigzag(history);
  var recentBS = history.slice(-10).map(h => h.bs);
  var bigCount = recentBS.filter(b => b === 'BIG').length;
  var ratio = bigCount / recentBS.length;
  // Mean reversion
  if (ratio > 0.65) return 'SMALL';
  if (ratio < 0.35) return 'BIG';
  return formulaZigzag(history);
}

function formulaKaala(history) {
  if (!history || history.length < 3) return 'BIG';
  var h = history.slice(-18).map(h => h.bs);
  var streak = 1;
  for (var i = h.length - 2; i >= 0; i--) {
    if (h[i] === h[h.length-1]) streak++; else break;
  }
  if (streak >= 4) return h[h.length-1] === 'BIG' ? 'SMALL' : 'BIG';
  return formulaOracle(history);
}

function formulaTitan(history) {
  if (!history || history.length < 3) return 'BIG';
  var last3 = history.slice(-3).map(h => h.bs);
  var losses = history.slice(-3).filter(h => h.result === 'loss').length;
  if (losses >= 3) {
    // Recovery: flip last prediction
    return last3[last3.length-1] === 'BIG' ? 'SMALL' : 'BIG';
  }
  return formulaOracle(history);
}

function formulaDna3(history) {
  if (!history || history.length < 3) return 'BIG';
  var triplet = history.slice(-3).map(h => h.bs).join('-');
  var patterns = {
    'BIG-BIG-BIG':     'SMALL',
    'SMALL-SMALL-SMALL': 'BIG',
    'BIG-SMALL-BIG':   'SMALL',
    'SMALL-BIG-SMALL': 'BIG',
    'BIG-BIG-SMALL':   'BIG',
    'SMALL-SMALL-BIG': 'SMALL',
  };
  return patterns[triplet] || formulaZigzag(history);
}

function predict(formulaKey, history) {
  var fn = FORMULAS[formulaKey] || FORMULAS['kingpin3'];
  try { return fn(history); } catch(e) { return 'BIG'; }
}

// ══════════════════════════════════════════════════
//  MARTINGALE LEVELS
// ══════════════════════════════════════════════════
function buildLevels(baseAmt, maxLevel) {
  var levels = [baseAmt];
  for (var i = 1; i < maxLevel; i++) {
    levels.push(Math.round(levels[i-1] * 2.1));
  }
  return levels;
}

// ══════════════════════════════════════════════════
//  ACCOUNT STATE (default)
// ══════════════════════════════════════════════════
function makeState(phone) {
  return {
    phone,
    lotteryToken : '',
    webapiToken  : '',
    pwd          : '',
    engine       : 'stopped',   // stopped | running
    balance      : 0,
    wins         : 0,
    losses       : 0,
    pnl          : 0,
    level        : 1,
    highestLevel : 1,
    formula      : 'kingpin3',
    formulaInfo  : { name: '👑 KINGPIN 3.0' },
    baseAmt      : 2,
    maxLevel     : 10,
    levels       : buildLevels(2, 10),
    watchEnabled : false,
    watchLossTarget : 1,
    watchCount   : 0,
    history      : [],    // [{issue, number, bs, pred, result}]
    betHistory   : [],
    predHistory  : [],
    logs         : [],
    currentIssue : null,
    prediction   : null,
    sessionStart : null,
    sessionElapsed: 0,
    loggedIn     : true,
    // nexus
    nexus        : false,
  };
}

// ══════════════════════════════════════════════════
//  GOA GAMES API CALLS
// ══════════════════════════════════════════════════
async function goaRequest(endpoint, payload, token) {
  var headers = { ...GOA_HEADERS };
  headers['x-forwarded-for'] = '103.' + Math.floor(Math.random()*50+1) + '.' + Math.floor(Math.random()*255) + '.' + Math.floor(Math.random()*255);
  if (token) headers['Authorization'] = 'Bearer ' + token;

  // Try 1: Normal domain
  // Try 2: IP with Host header (bypasses DNS issue on Railway)
  const attempts = [
    { url: GOA_BASE + endpoint, headers: { ...headers } },
    { url: 'https://' + GOA_IP + endpoint, headers: { ...headers, 'Host': 'api.goagamea.com' } },
    { url: 'https://' + GOA_IP + endpoint, headers: { ...headers, 'Host': 'goagamea.com' } },
  ];

  var lastErr = null;
  for (var attempt of attempts) {
    try {
      var r = await axios.post(attempt.url, payload || {}, {
        headers: attempt.headers,
        timeout: 15000,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      console.log('[KP] Success via:', attempt.url.substring(0, 40));
      return r.data;
    } catch(e) {
      lastErr = e.response ? JSON.stringify(e.response.data) : e.message;
      console.log('[KP] Failed:', attempt.url.substring(0, 40), '-', lastErr.substring(0, 80));
    }
  }
  throw new Error('GoaAPI ' + endpoint + ': ' + lastErr);
}

// GET captcha
async function getCaptcha() {
  return await goaRequest('/api/webapi/GetCaptcha', {});
}

// POST login
async function loginGoa(payload) {
  return await goaRequest('/api/webapi/Login', payload);
}

// GET balance
async function getBalance(token) {
  var r = await goaRequest('/api/webapi/GetUserInfo', {}, token);
  if (r && r.code === 0 && r.data) return parseFloat(r.data.money || r.data.balance || 0);
  return 0;
}

// GET current issue / countdown
async function getCurrentIssue(token) {
  var r = await goaRequest('/api/webapi/GetGameIssue', { gameCode: GAME_CODE }, token);
  if (r && r.code === 0 && r.data) return r.data;
  return null;
}

// GET last result
async function getLastResult(token) {
  var r = await goaRequest('/api/webapi/GetGameResult', { gameCode: GAME_CODE, pageNo: 1, pageSize: 1 }, token);
  if (r && r.code === 0 && r.data && r.data.list && r.data.list[0]) return r.data.list[0];
  return null;
}

// GET history for prediction
async function getHistory(token, size) {
  var r = await goaRequest('/api/webapi/GetGameResult', { gameCode: GAME_CODE, pageNo: 1, pageSize: size || 20 }, token);
  if (r && r.code === 0 && r.data && r.data.list) return r.data.list;
  return [];
}

// PLACE BET
async function placeBet(token, issueNumber, predBS, amount) {
  // Goa Games bet content format: WinGo_30S_Big or WinGo_30S_Small
  var betContent = GAME_CODE + (predBS === 'BIG' ? '_Big' : '_Small');
  var r = await goaRequest('/api/webapi/PlaceBet', {
    gameCode    : GAME_CODE,
    issueNumber : issueNumber,
    betContent  : betContent,
    betAmount   : amount,
    multiple    : 1,
  }, token);
  return r;
}

// GET bet record
async function getBetRecord(token, page) {
  return await goaRequest('/api/webapi/GetBetRecord', {
    gameCode: GAME_CODE,
    pageNo  : page || 1,
    pageSize: 20,
  }, token);
}

// ══════════════════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ══════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── REST PROXY ROUTES ──
app.post('/api/goa/captcha', async (req, res) => {
  try {
    console.log('[KP] Captcha request received');
    var data = await getCaptcha();
    console.log('[KP] Captcha response code:', data && data.code);
    res.json(data);
  } catch(e) {
    console.error('[KP] Captcha error:', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

app.post('/api/goa/login', async (req, res) => {
  try {
    console.log('[KP] Login request received for:', req.body && req.body.username);
    var data = await loginGoa(req.body);
    console.log('[KP] Login response code:', data && data.code);
    res.json(data);
  } catch(e) {
    console.error('[KP] Login error:', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── SOCKET.IO ──
io.on('connection', (socket) => {
  console.log('[KP] Client connected:', socket.id);

  var viewPhone = null;  // which account this socket is watching

  // ─ AUTH ─
  socket.on('auth', async (d) => {
    var phone = d.phone;
    if (!phone) return;

    if (!accounts[phone]) accounts[phone] = makeState(phone);
    var st = accounts[phone];
    st.lotteryToken = d.lotteryToken || st.lotteryToken;
    st.webapiToken  = d.webapiToken  || st.webapiToken;
    st.pwd          = d.pwd          || st.pwd;
    st.loggedIn     = true;

    // Fetch balance
    try { st.balance = await getBalance(st.webapiToken); } catch(e) {}

    viewPhone = phone;
    socket.join('acct:' + phone);

    emitState(phone, socket);
    broadcastAccountList();
  });

  // ─ SWITCH VIEW ─
  socket.on('switchView', (d) => {
    if (!d || !d.phone) return;
    viewPhone = d.phone;
    socket.join('acct:' + d.phone);
    emitState(d.phone, socket);
  });

  // ─ START ENGINE ─
  socket.on('start', async (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    if (st.engine !== 'stopped') return;

    st.engine       = 'running';
    st.sessionStart = Date.now();
    log(phone, '▶ Engine started', 'ok');
    emitState(phone);
    broadcastAccountList();

    startEngine(phone);
  });

  // ─ STOP ENGINE ─
  socket.on('stop', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    st.engine = 'stopped';
    if (st._interval) { clearInterval(st._interval); st._interval = null; }
    log(phone, '■ Engine stopped', 'warn');
    emitState(phone);
    broadcastAccountList();
  });

  // ─ LOGOUT ─
  socket.on('logout', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    if (st._interval) { clearInterval(st._interval); st._interval = null; }
    delete accounts[phone];
    io.emit('accountRemoved', { phone });
    broadcastAccountList();
  });

  // ─ RESET STATS ─
  socket.on('resetStats', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    st.wins = 0; st.losses = 0; st.pnl = 0;
    st.level = 1; st.highestLevel = 1;
    st.betHistory = []; st.predHistory = [];
    st.sessionStart = Date.now();
    emitState(phone);
  });

  // ─ SET FORMULA ─
  socket.on('setFormula', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    st.formula = d.formula || 'kingpin3';
    var FNAMES = {
      kingpin3:'👑 KINGPIN 3.0', zigzag:'⚡ ZigZag', oracle:'🔮 ORACLE',
      kaala:'🕶️ Kaala', titan_v3:'⚡ TITAN v3', dna3:'🧬 DNA 3',
      patdb_v4:'🎯 PAT_DB v4.0', cobra_strike:'🐍 Cobra Strike',
      itachi:'🔥 Itachi V30', kubera:'💰 Kubera v2',
      hacksoon:'🔮 Hacksoon', n1n2:'🎲 N1/N2',
      zn1p:'🗳️ ZN1P', eip:'🤖 EIP', kutty:'⭐ KUTTY',
    };
    st.formulaInfo = { name: FNAMES[st.formula] || st.formula };
    emitState(phone);
    log(phone, '🧠 Formula: ' + st.formulaInfo.name, 'info');
  });

  // ─ SET LEVELS ─
  socket.on('setLevels', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    if (d.custom && Array.isArray(d.custom)) {
      st.levels   = d.custom;
      st.maxLevel = d.custom.length;
      st.baseAmt  = d.custom[0] || 2;
    } else {
      st.baseAmt  = d.baseAmt  || st.baseAmt;
      st.maxLevel = d.maxLevel || st.maxLevel;
      st.levels   = buildLevels(st.baseAmt, st.maxLevel);
    }
    st.level = 1;
    emitState(phone);
  });

  // ─ SET WATCH ─
  socket.on('setWatch', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    st.watchEnabled    = d.enabled;
    st.watchLossTarget = d.count || 1;
    emitState(phone);
  });

  // ─ GET BET RECORD ─
  socket.on('getBetRecord', async (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    try {
      var result = await getBetRecord(st.webapiToken, d.page || 1);
      socket.emit('betRecord', { result, page: d.page || 1 });
    } catch(e) {
      socket.emit('betRecord', { result: { code: -1, msg: e.message }, page: 1 });
    }
  });

  socket.on('disconnect', () => {
    console.log('[KP] Client disconnected:', socket.id);
  });
});

// ══════════════════════════════════════════════════
//  ENGINE LOOP
// ══════════════════════════════════════════════════
async function startEngine(phone) {
  var st = accounts[phone];
  if (!st) return;

  var lastIssue = null;
  var pendingBet = null;   // { issue, pred, amount, level }

  async function tick() {
    if (!accounts[phone] || st.engine !== 'running') return;
    try {
      // 1. Get current issue info
      var issue = await getCurrentIssue(st.webapiToken);
      if (!issue) return;

      var issueNo  = issue.issueNumber || issue.issue;
      var countdown = parseInt(issue.remainTime || issue.countDown || 30);

      // Emit countdown
      io.to('acct:' + phone).emit('countdown', { secs: countdown, total: 30 });

      // 2. Check if new round started — fetch result for previous issue
      if (lastIssue && issueNo !== lastIssue) {
        var lastResult = await getLastResult(st.webapiToken);
        if (lastResult && String(lastResult.issueNumber) === String(lastIssue)) {
          var num  = parseInt(lastResult.number);
          var bs   = num >= 5 ? 'BIG' : 'SMALL';

          // Update history
          st.history.push({ issue: lastIssue, number: num, bs });
          if (st.history.length > 50) st.history = st.history.slice(-50);

          // Check pending bet result
          if (pendingBet && String(pendingBet.issue) === String(lastIssue)) {
            var won = pendingBet.pred === bs;
            var pnl = won ? pendingBet.amount * 0.95 : -pendingBet.amount;
            st.pnl += pnl;

            if (won) {
              st.wins++;
              st.level = 1;
              log(phone, '✅ WIN  #' + String(lastIssue).slice(-5) + '  ' + bs + '  +₹' + (pendingBet.amount * 0.95).toFixed(2), 'win');
            } else {
              st.losses++;
              st.level = Math.min(st.level + 1, st.maxLevel);
              if (st.level > st.highestLevel) st.highestLevel = st.level;
              log(phone, '❌ LOSS #' + String(lastIssue).slice(-5) + '  ' + bs + '  -₹' + pendingBet.amount, 'loss');
            }

            // Record bet history
            st.betHistory.unshift({ issue: lastIssue, pred: pendingBet.pred, level: pendingBet.level, amount: pendingBet.amount, won, pnl: pnl });
            if (st.betHistory.length > 100) st.betHistory = st.betHistory.slice(0, 100);

            pendingBet = null;

            if (st.level > st.maxLevel) {
              st.engine = 'stopped';
              io.to('acct:' + phone).emit('maxLevel', { msg: 'All levels exhausted. Restart to continue.' });
              log(phone, '🚨 MAX LEVEL reached — engine stopped', 'warn');
              emitState(phone);
              broadcastAccountList();
              return;
            }
          }

          // Refresh balance
          try { st.balance = await getBalance(st.webapiToken); } catch(e) {}
          emitState(phone);
          broadcastAccountList();
        }
      }

      // 3. Place bet for new issue (only once per issue, with time left > 5s)
      if (issueNo !== lastIssue) {
        lastIssue = issueNo;

        // Build prediction
        var rawHistory = (await getHistory(st.webapiToken, 20)).map(r => ({
          issue : r.issueNumber,
          number: parseInt(r.number),
          bs    : parseInt(r.number) >= 5 ? 'BIG' : 'SMALL',
        }));

        var predBS = predict(st.formula, rawHistory);

        var predInfo = { pred: predBS, forIssue: issueNo, formula: st.formula };
        st.prediction = predInfo;
        st.predHistory.unshift({ forIssue: issueNo, pred: predBS, formula: st.formula });
        if (st.predHistory.length > 100) st.predHistory = st.predHistory.slice(0, 100);

        log(phone, '🔮 Pred #' + String(issueNo).slice(-5) + ' → ' + predBS + ' (LV' + st.level + ')', 'info');

        // Watch mode: skip real bet if watching
        if (st.watchEnabled && st.watchCount < st.watchLossTarget) {
          st.watchCount++;
          log(phone, '👁️ Watch mode — skipping bet (' + st.watchCount + '/' + st.watchLossTarget + ')', 'warn');
          emitState(phone);
          return;
        }
        st.watchCount = 0;

        // Place bet if time allows (> 5s)
        if (countdown > 5) {
          var amount = st.levels[st.level - 1] || st.baseAmt;
          io.to('acct:' + phone).emit('betStatus', {
            cls: 'betting', icon: '💰', label: 'PLACING BET',
            detail: predBS + '  ₹' + amount + '  LV' + st.level,
            bar: 60,
          });

          try {
            var betResult = await placeBet(st.webapiToken, issueNo, predBS, amount);
            if (betResult && betResult.code === 0) {
              pendingBet = { issue: issueNo, pred: predBS, amount, level: st.level };
              log(phone, '💰 Bet placed: ' + predBS + ' ₹' + amount + ' #' + String(issueNo).slice(-5), 'ok');
              io.to('acct:' + phone).emit('betStatus', {
                cls: 'placed', icon: '✅', label: 'BET PLACED',
                detail: predBS + '  ₹' + amount + '  LV' + st.level,
                bar: 100,
              });
            } else {
              log(phone, '⚠️ Bet failed: ' + (betResult && betResult.msg || 'unknown'), 'warn');
            }
          } catch(e) {
            log(phone, '⚠️ Bet error: ' + e.message, 'warn');
          }

          emitState(phone);
        }
      }

    } catch(err) {
      log(phone, '⚠️ Tick error: ' + err.message, 'warn');
    }
  }

  // Run tick every 3 seconds
  st._interval = setInterval(tick, 3000);
  tick();
}

// ══════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════
function log(phone, msg, cls) {
  var st = accounts[phone];
  if (!st) return;
  var t = new Date().toLocaleTimeString('en-IN', { hour12: false });
  var entry = { t, msg, cls: cls || 'info' };
  st.logs.unshift(entry);
  if (st.logs.length > 50) st.logs = st.logs.slice(0, 50);
  io.to('acct:' + phone).emit('log', entry);
}

function emitState(phone, target) {
  var st = accounts[phone];
  if (!st) return;
  var snap = {
    phone,
    engine       : st.engine,
    balance      : st.balance,
    wins         : st.wins,
    losses       : st.losses,
    pnl          : st.pnl,
    level        : st.level,
    highestLevel : st.highestLevel,
    formula      : st.formula,
    formulaInfo  : st.formulaInfo,
    levels       : st.levels,
    watchEnabled : st.watchEnabled,
    watchLossTarget: st.watchLossTarget,
    betHistory   : st.betHistory,
    predHistory  : st.predHistory,
    prediction   : st.prediction,
    loggedIn     : st.loggedIn,
    sessionElapsed: st.sessionStart ? Date.now() - st.sessionStart : 0,
  };
  if (target) {
    target.emit('state', snap);
    target.emit('logs', st.logs);
  } else {
    io.to('acct:' + phone).emit('state', snap);
  }
}

function broadcastAccountList() {
  var list = Object.values(accounts).map(st => ({
    phone  : st.phone,
    engine : st.engine,
    balance: st.balance,
    pnl    : st.pnl,
  }));
  io.emit('accountList', list);
}

// ══════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
  console.log('[KINGPIN 3.0] Server running on port ' + PORT);
});
