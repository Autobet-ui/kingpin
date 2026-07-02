'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const axios      = require('axios');
const path       = require('path');
const crypto     = require('crypto');

// ══════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════
const PORT     = process.env.PORT || 3000;
const GOA_BASE = 'https://api.goa7777.com';
const GOA_API  = GOA_BASE + '/api/webapi';
const TYPE_ID  = 30;  // WinGo 30S

const BYPASS_HEADERS = {
  'Content-Type'   : 'application/json',
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
  'Origin'         : 'https://goagamea.com',
  'Referer'        : 'https://goagamea.com/',
  'User-Agent'     : 'Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'sec-ch-ua'      : '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest' : 'empty',
  'sec-fetch-mode' : 'cors',
  'sec-fetch-site' : 'cross-site',
};

const accounts = {};

// ══════════════════════════════════════════════════
//  SIGNING
// ══════════════════════════════════════════════════
const EXCLUDED_FROM_SIGN = ['signature', 'track', 'xosoBettingData'];

function makeRandom() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function md5Hex(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function signPayload(data) {
  var enriched = Object.assign({ language: 0, random: makeRandom() }, data);
  var sorted = Object.keys(enriched).sort();
  var filtered = {};
  sorted.forEach(function(k) {
    var v = enriched[k];
    if (v !== null && v !== '' && EXCLUDED_FROM_SIGN.indexOf(k) === -1) {
      filtered[k] = v;
    }
  });
  enriched['signature'] = md5Hex(JSON.stringify(filtered)).toUpperCase().slice(0, 32);
  enriched['timestamp'] = Math.floor(Date.now() / 1000);
  return enriched;
}

// ══════════════════════════════════════════════════
//  GOA API
// ══════════════════════════════════════════════════
async function goaRequest(endpoint, payload, token) {
  var body = signPayload(payload || {});
  var headers = Object.assign({}, BYPASS_HEADERS);
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
    headers['token'] = token;
  }
  try {
    var r = await axios.post(GOA_API + endpoint, body, { headers, timeout: 12000 });
    return r.data;
  } catch(e) {
    var msg = e.response ? JSON.stringify(e.response.data) : e.message;
    throw new Error('GoaAPI ' + endpoint + ': ' + msg);
  }
}

// Captcha
async function getCaptcha() {
  return await goaRequest('/Captcha', {});
}

// Login
async function loginGoa(payload) {
  return await goaRequest('/Login', payload);
}

// Balance — tries multiple fields
async function getBalance(token) {
  try {
    var r = await goaRequest('/User/GetUserInfo', {}, token);
    if (r && r.code === 0 && r.data) {
      var d = r.data;
      var candidates = [d.money, d.balance, d.wallet, d.mainBalance, d.normalBalance, d.rechargeBalance, d.totalBalance];
      if (d.userInfo) candidates.push(d.userInfo.money, d.userInfo.balance);
      var vals = candidates.map(function(v){ return parseFloat(v || 0); }).filter(function(n){ return !isNaN(n) && n >= 0; });
      if (vals.length > 0) return Math.max.apply(null, vals);
    }
  } catch(e) {}
  // fallback to GetInfo
  try {
    var r2 = await goaRequest('/User/GetInfo', {}, token);
    if (r2 && r2.code === 0 && r2.data) {
      var d2 = r2.data;
      var v = parseFloat(d2.money || d2.balance || d2.wallet || 0);
      if (!isNaN(v) && v >= 0) return v;
    }
  } catch(e) {}
  return 0;
}

// Public history (no auth)
const PUBLIC_HISTORY_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';

async function fetchPublicList(size) {
  try {
    var url = PUBLIC_HISTORY_URL + '?pageNo=1&pageSize=' + (size || 50) + '&gameId=1';
    var res = await axios.get(url, {
      headers: {
        'Accept': 'application/json, */*',
        'User-Agent': BYPASS_HEADERS['User-Agent'],
      },
      timeout: 8000,
    });
    var data = res.data && (res.data.data || res.data);
    var list = (data && (data.list || data.issueList || data.data)) || (res.data && res.data.list) || [];
    if (Array.isArray(list) && list.length > 0) return list;
  } catch(e) {}
  return [];
}

// Current issue (public → GOA fallback)
async function getCurrentIssue(token) {
  // Public source first
  var list = await fetchPublicList(1);
  if (list.length > 0) {
    var last = String(list[0].issueNumber || list[0].issue || '');
    if (last && /^\d+$/.test(last)) {
      var next = String(BigInt(last) + 1n);
      var secsIntoCycle = Math.floor(Date.now() / 1000) % 30;
      return { issueNumber: next, remainTime: 30 - secsIntoCycle };
    }
  }
  // GOA API fallback
  try {
    var r = await goaRequest('/WinGo/GetCurrentIssue', { typeId: TYPE_ID }, token);
    if (r && r.code === 0 && r.data) {
      return {
        issueNumber: String(r.data.issueNumber || r.data.issue || ''),
        remainTime: Number(r.data.countdown || r.data.remainTime || r.data.endTime || 30),
      };
    }
  } catch(e) {}
  // Last fallback
  try {
    var r2 = await goaRequest('/WinGo/GetIssueList', { pageNo: 1, pageSize: 1, typeId: TYPE_ID }, token);
    if (r2 && r2.code === 0 && r2.data && r2.data.list && r2.data.list[0]) {
      var item = r2.data.list[0];
      var lastIssue = String(item.issueNumber || item.issue || '');
      if (lastIssue && /^\d+$/.test(lastIssue)) {
        var nextPeriod = String(BigInt(lastIssue) + 1n);
        var secsIntoCycle2 = Math.floor(Date.now() / 1000) % 30;
        return { issueNumber: nextPeriod, remainTime: 30 - secsIntoCycle2 };
      }
    }
  } catch(e) {}
  return null;
}

// Last result
async function getLastResult(token) {
  var list = await fetchPublicList(1);
  if (list.length > 0) return list[0];
  try {
    var r = await goaRequest('/WinGo/GetIssueList', { pageNo: 1, pageSize: 1, typeId: TYPE_ID }, token);
    if (r && r.code === 0 && r.data && r.data.list && r.data.list[0]) return r.data.list[0];
  } catch(e) {}
  return null;
}

// History for prediction
async function getHistory(token, size) {
  var list = await fetchPublicList(size || 50);
  if (list.length > 0) return list;
  try {
    var r = await goaRequest('/WinGo/GetIssueList', { pageNo: 1, pageSize: size || 50, typeId: TYPE_ID }, token);
    if (r && r.code === 0 && r.data && r.data.list) return r.data.list;
  } catch(e) {}
  return [];
}

// ── PLACE BET (correct GOA API format) ──────────────
async function placeBet(token, issueNumber, predBS, amount) {
  // GOA WinGo bet: betContent is 'Big' or 'Small', typeId=30, multiple=1
  var r = await goaRequest('/WinGo/WinGoBet', {
    typeId      : TYPE_ID,
    issueNumber : String(issueNumber),
    betContent  : predBS === 'BIG' ? 'Big' : 'Small',
    amount      : amount,
    multiple    : 1,
  }, token);
  return r;
}

// Bet record
async function getBetRecord(token, page) {
  return await goaRequest('/WinGo/GetMyGameRecordList', {
    pageNo  : page || 1,
    pageSize: 20,
    typeId  : TYPE_ID,
  }, token);
}

// ══════════════════════════════════════════════════
//  SHADOW ADAPTIVE ENGINE v14.0
// ══════════════════════════════════════════════════
const MIN_CONF = 63;
const MIN_CONF_LOSS = 72;

function shadowEngine(rawList, consecLosses) {
  // Convert to B/S sequence (most recent first)
  var seq = rawList.map(function(item) {
    var n = parseInt(String(item.number || item.num || '0'));
    return n >= 5 ? 'B' : 'S';
  });

  if (seq.length < 6) {
    return { pred: 'BIG', conf: 50, reason: 'Collecting data…', skip: true };
  }

  // L2-FIX: 5+ streak → near-certain reversal
  var streak = 1;
  for (var i = 1; i < seq.length; i++) {
    if (seq[i] === seq[0]) streak++; else break;
  }
  var opp = seq[0] === 'B' ? 'SMALL' : 'BIG';
  var oppShort = seq[0] === 'B' ? 'S' : 'B';
  if (streak >= 5) return { pred: opp, conf: 92, reason: 'L2-FIX: ' + streak + 'x' + seq[0] + ' → reversal', skip: false };
  if (streak >= 4) return { pred: opp, conf: 85, reason: 'L1-FIX: ' + streak + 'x' + seq[0] + ' → reversal', skip: false };

  // 8-strategy voting
  var votes = { BIG: 0, SMALL: 0 };
  var reasons = [];

  function vote(side, pts, label) {
    votes[side] += pts;
    reasons.push(label + ':' + side);
  }

  var oppSide  = seq[0] === 'B' ? 'SMALL' : 'BIG';
  var sameSide = seq[0] === 'B' ? 'BIG' : 'SMALL';

  // 1. Anti-streak
  if (streak >= 3) vote(oppSide, Math.min(streak * 11, 44), 'AntiStreak(' + streak + 'x' + seq[0] + ')');
  else if (streak === 1) vote(sameSide, 6, 'ShortContinue');

  // 2. Zigzag-5
  var h5 = seq.slice(0, Math.min(5, seq.length));
  if (h5.length >= 5 && h5.every(function(v, i) { return i === 0 || v !== h5[i - 1]; })) vote(oppSide, 28, 'Zigzag5');

  // 3. FreqBias (last 10)
  var L10 = seq.slice(0, Math.min(10, seq.length));
  var b10 = L10.filter(function(x) { return x === 'B'; }).length;
  var s10 = L10.length - b10;
  if (b10 >= 7) vote('SMALL', 22, 'FreqBias(B' + b10 + '/10)');
  else if (s10 >= 7) vote('BIG', 22, 'FreqBias(S' + s10 + '/10)');
  else vote(b10 >= s10 ? 'BIG' : 'SMALL', 4, 'MildDom');

  // 4. DblPair
  if (seq.length >= 4 && seq[0] === seq[1] && seq[2] === seq[3] && seq[0] !== seq[2]) vote(oppSide, 18, 'DblPair');

  // 5. Mirror XYX
  if (seq.length >= 3 && seq[0] === seq[2] && seq[0] !== seq[1]) vote(seq[1] === 'B' ? 'BIG' : 'SMALL', 14, 'Mirror');

  // 6. Momentum-5
  var b5 = h5.filter(function(x) { return x === 'B'; }).length;
  var s5 = h5.length - b5;
  if (b5 >= 4) vote('SMALL', 14, 'Mom5(B' + b5 + ')');
  else if (s5 >= 4) vote('BIG', 14, 'Mom5(S' + s5 + ')');

  // 7. Triple
  if (seq.length >= 3 && seq[0] === seq[1] && seq[1] === seq[2]) vote(oppSide, 20, 'Triple');

  // 8. Trend30
  if (seq.length >= 30) {
    var L30 = seq.slice(0, 30);
    var b30 = L30.filter(function(x) { return x === 'B'; }).length;
    var s30 = L30.length - b30;
    if (b30 >= 19) vote('SMALL', 10, 'Trend30');
    else if (s30 >= 19) vote('BIG', 10, 'Trend30');
  }

  var total = votes.BIG + votes.SMALL;
  if (!total) return { pred: 'BIG', conf: 50, reason: 'No signal', skip: true };

  var pickFull = votes.BIG > votes.SMALL ? 'BIG' : 'SMALL';
  var rawConf  = (votes[pickFull] / total) * 100;
  var margin   = Math.abs(votes.BIG - votes.SMALL);
  var conf     = Math.min(95, Math.max(50, rawConf + Math.min(margin * 0.3, 8)));
  conf = Math.round(conf * 10) / 10;

  var thr = consecLosses >= 2 ? MIN_CONF_LOSS : MIN_CONF;
  var log = 'Shadow[' + conf + '%] BIG=' + votes.BIG + ' SMALL=' + votes.SMALL + ' | ' + reasons.slice(0, 4).join(' | ');

  return { pred: pickFull, conf: conf, reason: log, skip: conf < thr };
}

// ══════════════════════════════════════════════════
//  MARTINGALE LEVELS
// ══════════════════════════════════════════════════
function buildLevels(baseAmt, maxLevel) {
  var levels = [baseAmt];
  for (var i = 1; i < maxLevel; i++) {
    levels.push(Math.round(levels[i - 1] * 2));
  }
  return levels;
}

// ══════════════════════════════════════════════════
//  ACCOUNT STATE
// ══════════════════════════════════════════════════
function makeState(phone) {
  return {
    phone,
    lotteryToken : '',
    webapiToken  : '',
    pwd          : '',
    engine       : 'stopped',
    balance      : 0,
    wins         : 0,
    losses       : 0,
    pnl          : 0,
    level        : 1,
    highestLevel : 1,
    formula      : 'shadow',
    formulaInfo  : { name: '⚡ Shadow Adaptive v14.0' },
    baseAmt      : 2,
    maxLevel     : 10,
    levels       : buildLevels(2, 10),
    watchEnabled : false,
    watchLossTarget: 1,
    watchCount   : 0,
    history      : [],
    betHistory   : [],
    predHistory  : [],
    logs         : [],
    currentIssue : null,
    prediction   : null,
    sessionStart : null,
    loggedIn     : true,
    _interval    : null,
    consecLosses : 0,
  };
}

// ══════════════════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ══════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST PROXY ─────────────────────────────────────
app.post('/api/goa/captcha', async (req, res) => {
  try {
    var data = await getCaptcha();
    res.json(data);
  } catch(e) {
    res.json({ code: -1, msg: e.message });
  }
});

app.post('/api/goa/login', async (req, res) => {
  try {
    var data = await loginGoa(req.body);
    res.json(data);
  } catch(e) {
    res.json({ code: -1, msg: e.message });
  }
});

// ── SOCKET.IO ─────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[KP] Client connected:', socket.id);
  var viewPhone = null;

  socket.on('auth', async (d) => {
    var phone = d.phone;
    if (!phone) return;
    if (!accounts[phone]) accounts[phone] = makeState(phone);
    var st = accounts[phone];
    st.lotteryToken = d.lotteryToken || st.lotteryToken;
    st.webapiToken  = d.webapiToken  || st.webapiToken;
    st.pwd          = d.pwd          || st.pwd;
    st.loggedIn     = true;
    viewPhone = phone;
    socket.join('acct:' + phone);
    try {
      st.balance = await getBalance(st.webapiToken || st.lotteryToken);
    } catch(e) {}
    emitState(phone, socket);
    broadcastAccountList();
  });

  socket.on('switchView', (d) => {
    if (!d || !d.phone) return;
    viewPhone = d.phone;
    socket.join('acct:' + d.phone);
    emitState(d.phone, socket);
  });

  socket.on('start', async (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    if (st.engine !== 'stopped') return;
    st.engine = 'running';
    st.sessionStart = Date.now();
    st.consecLosses = 0;
    st.watchCount = 0;
    log(phone, '▶ Engine started', 'ok');
    emitState(phone);
    broadcastAccountList();
    startEngine(phone);
  });

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

  socket.on('logout', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    if (st._interval) { clearInterval(st._interval); st._interval = null; }
    delete accounts[phone];
    io.emit('accountRemoved', { phone });
    broadcastAccountList();
  });

  socket.on('resetStats', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    st.wins = 0; st.losses = 0; st.pnl = 0;
    st.level = 1; st.highestLevel = 1;
    st.betHistory = []; st.predHistory = [];
    st.consecLosses = 0;
    st.sessionStart = Date.now();
    emitState(phone);
  });

  socket.on('setLevels', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    if (d.custom && Array.isArray(d.custom)) {
      st.levels = d.custom;
      st.maxLevel = d.custom.length;
      st.baseAmt = d.custom[0] || 2;
    } else {
      st.baseAmt  = d.baseAmt  || st.baseAmt;
      st.maxLevel = d.maxLevel || st.maxLevel;
      st.levels   = buildLevels(st.baseAmt, st.maxLevel);
    }
    st.level = 1;
    emitState(phone);
  });

  socket.on('setWatch', (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    st.watchEnabled     = d.enabled;
    st.watchLossTarget  = d.count || 1;
    emitState(phone);
  });

  socket.on('getBetRecord', async (d) => {
    var phone = d && d.phone;
    if (!phone || !accounts[phone]) return;
    var st = accounts[phone];
    try {
      var result = await getBetRecord(st.webapiToken || st.lotteryToken, d.page || 1);
      socket.emit('betRecord', { result, page: d.page || 1 });
    } catch(e) {
      socket.emit('betRecord', { result: { code: -1, msg: e.message }, page: 1 });
    }
  });

  socket.on('exportHistory', async (d) => {
    var phone = d && d.phone;
    var totalWant = (d && d.totalRecords) || 500;
    if (!phone || !accounts[phone]) {
      socket.emit('exportHistoryResult', { ok: false, list: [] });
      return;
    }
    var all = [];
    var pageSize = 100;
    var maxPages = Math.ceil(totalWant / pageSize);
    for (var page = 1; page <= maxPages; page++) {
      try {
        socket.emit('exportHistoryProgress', { page, maxPages, total: all.length });
        var list = await fetchPublicList(pageSize);
        if (list && list.length > 0) {
          all = all.concat(list);
        } else {
          socket.emit('exportHistoryProgress', { page, maxPages, total: all.length, done: true });
          break;
        }
      } catch(e) {
        socket.emit('exportHistoryProgress', { page, maxPages, total: all.length, error: e.message });
      }
      if (all.length >= totalWant) break;
      await new Promise(r => setTimeout(r, 300));
    }
    socket.emit('exportHistoryResult', { ok: true, list: all.slice(0, totalWant) });
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

  var lastIssue  = null;
  var pendingBet = null;   // { issue, pred, amount, level }

  async function tick() {
    if (!accounts[phone] || st.engine !== 'running') return;
    try {
      var token = st.webapiToken || st.lotteryToken;

      // 1. Get current issue
      var issue = await getCurrentIssue(token);
      if (!issue) return;

      var issueNo   = String(issue.issueNumber || issue.issue || '');
      var countdown = parseInt(issue.remainTime || issue.countDown || 30);

      // Emit countdown to UI
      io.to('acct:' + phone).emit('countdown', { secs: countdown, total: 30 });

      // 2. New period started — check result of last bet
      if (lastIssue && issueNo !== lastIssue) {
        // Wait a moment for result to propagate
        await new Promise(r => setTimeout(r, 2000));

        var lastResult = await getLastResult(token);
        if (lastResult && String(lastResult.issueNumber || lastResult.issue) === String(lastIssue)) {
          var num = parseInt(lastResult.number);
          var bs  = num >= 5 ? 'BIG' : 'SMALL';

          // Update history
          st.history.push({ issue: lastIssue, number: num, bs });
          if (st.history.length > 100) st.history = st.history.slice(-100);

          // Check pending bet result
          if (pendingBet && String(pendingBet.issue) === String(lastIssue)) {
            var won = pendingBet.pred === bs;
            var pnl = won ? +(pendingBet.amount * 0.95).toFixed(2) : -pendingBet.amount;

            if (won) {
              st.wins++;
              st.pnl += pnl;
              st.level = 1;
              st.consecLosses = 0;
              log(phone, '✅ WIN  #' + String(lastIssue).slice(-5) + '  ' + bs + '  +₹' + pnl.toFixed(2), 'win');
              io.to('acct:' + phone).emit('betStatus', {
                cls: 'win', icon: '✅', label: 'WIN!',
                detail: pendingBet.pred + '  +₹' + pnl.toFixed(2), bar: 100,
              });
              io.to('acct:' + phone).emit('toast', { title: '✅ WIN', msg: '+₹' + pnl.toFixed(2), type: 'success' });
            } else {
              st.losses++;
              st.pnl -= pendingBet.amount;
              st.consecLosses++;
              st.level = Math.min(st.level + 1, st.maxLevel);
              if (st.level > st.highestLevel) st.highestLevel = st.level;
              log(phone, '❌ LOSS #' + String(lastIssue).slice(-5) + '  ' + pendingBet.pred + ' → ' + bs + '  -₹' + pendingBet.amount, 'loss');
              io.to('acct:' + phone).emit('betStatus', {
                cls: 'loss', icon: '❌', label: 'LOSS',
                detail: pendingBet.pred + ' → ' + bs + '  -₹' + pendingBet.amount, bar: 0,
              });
              io.to('acct:' + phone).emit('toast', { title: '❌ LOSS', msg: '-₹' + pendingBet.amount, type: 'error' });
            }

            // Record bet history
            st.betHistory.unshift({
              issue: lastIssue, pred: pendingBet.pred,
              level: pendingBet.level, amount: pendingBet.amount, won, pnl,
            });
            if (st.betHistory.length > 100) st.betHistory = st.betHistory.slice(0, 100);

            // Update pred history with result
            var ph = st.predHistory.find(function(p) { return String(p.forIssue) === String(lastIssue); });
            if (ph) { ph.result = bs; ph.correct = won; }

            pendingBet = null;

            // Check max level
            if (st.level > st.maxLevel) {
              st.engine = 'stopped';
              if (st._interval) { clearInterval(st._interval); st._interval = null; }
              io.to('acct:' + phone).emit('maxLevel', { msg: 'All levels exhausted. Restart to continue.' });
              log(phone, '🚨 MAX LEVEL reached — engine stopped', 'warn');
              emitState(phone);
              broadcastAccountList();
              return;
            }

            // Refresh balance
            try { st.balance = await getBalance(token); } catch(e) {}
            emitState(phone);
            broadcastAccountList();
          }
        }
      }

      // 3. New issue — predict & bet
      if (issueNo !== lastIssue) {
        lastIssue = issueNo;

        // Fetch history for Shadow Engine
        var rawHistory = await getHistory(token, 50);

        // Shadow Adaptive Engine v14.0
        var eng = shadowEngine(rawHistory, st.consecLosses);

        var predBS   = eng.pred;
        var predConf = eng.conf;
        var predLog  = eng.reason;
        var skip     = eng.skip;

        // Store prediction
        st.prediction = {
          pred: predBS, conf: predConf, forIssue: issueNo,
          formula: 'shadow', log: predLog,
        };
        st.predHistory.unshift({
          forIssue: issueNo, pred: predBS, formula: 'shadow',
          conf: predConf, reason: predLog,
        });
        if (st.predHistory.length > 100) st.predHistory = st.predHistory.slice(0, 100);

        if (skip) {
          log(phone, '⏸ SKIP #' + issueNo.slice(-5) + ' — conf ' + predConf + '% below threshold', 'warn');
          io.to('acct:' + phone).emit('betStatus', {
            cls: 'watch', icon: '⏸', label: 'SKIP',
            detail: 'Confidence ' + predConf + '% < ' + (st.consecLosses >= 2 ? 72 : 63) + '%', bar: 0,
          });
          emitState(phone);
          return;
        }

        log(phone, '🔮 Pred #' + issueNo.slice(-5) + ' → ' + predBS + ' [' + predConf + '%] LV' + st.level, 'info');

        // Watch mode
        if (st.watchEnabled && st.watchCount < st.watchLossTarget) {
          st.watchCount++;
          log(phone, '👁️ Watch mode (' + st.watchCount + '/' + st.watchLossTarget + ') — skipping real bet', 'warn');
          io.to('acct:' + phone).emit('betStatus', {
            cls: 'watch', icon: '👁️', label: 'WATCHING',
            detail: 'Watch ' + st.watchCount + '/' + st.watchLossTarget + ' losses before betting',
            bar: Math.round(st.watchCount / st.watchLossTarget * 100),
          });
          emitState(phone);
          return;
        }
        st.watchCount = 0;

        // Place bet if time allows (>5s remaining)
        if (countdown > 5) {
          var amount = st.levels[st.level - 1] || st.baseAmt;
          io.to('acct:' + phone).emit('betStatus', {
            cls: 'betting', icon: '💰', label: 'PLACING BET LV' + st.level,
            detail: predBS + '  ₹' + amount + '  [' + predConf + '%]',
            bar: 60, timer: countdown + 's',
          });

          try {
            var betResult = await placeBet(token, issueNo, predBS, amount);
            if (betResult && betResult.code === 0) {
              pendingBet = { issue: issueNo, pred: predBS, amount, level: st.level };
              log(phone, '💰 BET PLACED: ' + predBS + ' ₹' + amount + ' LV' + st.level + ' #' + issueNo.slice(-5), 'ok');
              io.to('acct:' + phone).emit('betStatus', {
                cls: 'placed', icon: '✅', label: 'BET PLACED',
                detail: predBS + '  ₹' + amount + '  LV' + st.level,
                bar: 100,
              });
            } else {
              var errMsg = (betResult && betResult.msg) || 'unknown error';
              log(phone, '⚠️ Bet failed: ' + errMsg, 'warn');
              io.to('acct:' + phone).emit('betStatus', {
                cls: 'loss', icon: '⚠️', label: 'BET FAILED',
                detail: errMsg, bar: 0,
              });
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
  if (st.logs.length > 100) st.logs = st.logs.slice(0, 100);
  io.to('acct:' + phone).emit('log', entry);
}

function emitState(phone, target) {
  var st = accounts[phone];
  if (!st) return;
  var snap = {
    phone,
    engine          : st.engine,
    balance         : st.balance,
    wins            : st.wins,
    losses          : st.losses,
    pnl             : st.pnl,
    level           : st.level,
    highestLevel    : st.highestLevel,
    formula         : st.formula,
    formulaInfo     : st.formulaInfo,
    levels          : st.levels,
    watchEnabled    : st.watchEnabled,
    watchLossTarget : st.watchLossTarget,
    betHistory      : st.betHistory,
    predHistory     : st.predHistory,
    prediction      : st.prediction,
    loggedIn        : st.loggedIn,
    sessionElapsed  : st.sessionStart ? Date.now() - st.sessionStart : 0,
  };
  if (target) {
    target.emit('state', snap);
    target.emit('logs', st.logs);
  } else {
    io.to('acct:' + phone).emit('state', snap);
  }
}

function broadcastAccountList() {
  var list = Object.values(accounts).map(function(st) {
    return { phone: st.phone, engine: st.engine, balance: st.balance, pnl: st.pnl };
  });
  io.emit('accountList', list);
}

// ══════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
  console.log('[KINGPIN 3.0] Server running on port ' + PORT);
});
