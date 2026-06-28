/**
 * KINGPIN 3.0 — Auto Bet Engine Backend
 * Node.js + Express + Socket.IO
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const axios     = require('axios');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

app.use(cors());
app.use(express.json());

// ── Serve static frontend files ──
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────
// GOA API CONFIG
// ─────────────────────────────────────────────────────────
const GOA_BASE     = 'https://api.goagamea.com';
const LOTTERY_BASE = 'https://api.goagamea.com';

const GOA_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 Chrome/96.0.4664.45',
  'Origin': 'https://goagamea.com',
  'Referer': 'https://goagamea.com/',
};

// ─────────────────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────────────────

// GET CAPTCHA
app.post('/api/goa/captcha', async (req, res) => {
  try {
    const r = await axios.post(`${GOA_BASE}/api/user/captcha`, {}, { headers: GOA_HEADERS, timeout: 10000 });
    res.json(r.data);
  } catch (e) {
    console.error('[captcha]', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// LOGIN
app.post('/api/goa/login', async (req, res) => {
  try {
    const r = await axios.post(`${GOA_BASE}/api/user/login`, req.body, { headers: GOA_HEADERS, timeout: 12000 });
    res.json(r.data);
  } catch (e) {
    console.error('[login]', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// ── Health check ──
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Fallback to index.html ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────
// PER-ACCOUNT STATE
// ─────────────────────────────────────────────────────────
const accounts = {}; // phone → AccountState

function makeAccount(phone) {
  return {
    phone,
    lotteryToken: '',
    webapiToken: '',
    pwd: '',
    balance: 0,
    engine: 'stopped',
    formula: 'PATTERN3',
    levels: [2, 4, 8, 16, 32, 64, 128],
    baseAmt: 2,
    maxLevel: 7,
    stopOnWin: false,
    stopOnWinAmt: 100,
    stopOnLoss: false,
    stopOnLossAmt: 500,
    watchCount: 3,
    currentLevel: 0,
    pnl: 0,
    bets: 0,
    wins: 0,
    losses: 0,
    log: [],
    betHistory: [],
    predHistory: [],
    currentPeriod: '',
    currentPred: '',
    countdown: 0,
    interval: null,
    periodInterval: null,
    betPlaced: false,
    watchRemain: 0,
    lastResult: null,
    waitingResult: false,
    resultIssue: '',
    locked: false,
    maxLevelHit: false,
  };
}

function getAccount(phone) {
  if (!accounts[phone]) accounts[phone] = makeAccount(phone);
  return accounts[phone];
}

// ─────────────────────────────────────────────────────────
// LOTTERY HELPERS
// ─────────────────────────────────────────────────────────
async function getBalance(acct) {
  try {
    const r = await axios.get(`${GOA_BASE}/api/user/info`, {
      headers: { ...GOA_HEADERS, 'Authorization': `Bearer ${acct.webapiToken}` },
      timeout: 8000
    });
    if (r.data && r.data.code === 0 && r.data.data) {
      acct.balance = parseFloat(r.data.data.balance || r.data.data.money || 0);
    }
  } catch(e) { /* silent */ }
}

async function getCurrentPeriod(acct) {
  try {
    const r = await axios.get(
      `${LOTTERY_BASE}/api/lottery/wingo/currentissue?lotteryType=1`,
      { headers: { ...GOA_HEADERS, 'Authorization': `Bearer ${acct.lotteryToken}` }, timeout: 8000 }
    );
    if (r.data && r.data.code === 0 && r.data.data) {
      return r.data.data;
    }
  } catch(e) { /* silent */ }
  return null;
}

async function getLastResult(acct) {
  try {
    const r = await axios.get(
      `${LOTTERY_BASE}/api/lottery/wingo/listissue?lotteryType=1&pageSize=5&pageNum=1`,
      { headers: { ...GOA_HEADERS, 'Authorization': `Bearer ${acct.lotteryToken}` }, timeout: 8000 }
    );
    if (r.data && r.data.code === 0 && r.data.data && r.data.data.list) {
      return r.data.data.list[0] || null;
    }
  } catch(e) { /* silent */ }
  return null;
}

async function placeBet(acct, side, amount) {
  // side: 'BIG' or 'SMALL'
  const betContent = side === 'BIG' ? 'WinGo_Big' : 'WinGo_Small';
  try {
    const r = await axios.post(
      `${LOTTERY_BASE}/api/lottery/wingo/bet`,
      {
        issueNumber: acct.currentPeriod,
        betContent,
        betAmount: amount,
        lotteryType: 1,
      },
      { headers: { ...GOA_HEADERS, 'Authorization': `Bearer ${acct.lotteryToken}` }, timeout: 8000 }
    );
    return r.data;
  } catch(e) {
    return { code: -1, msg: e.message };
  }
}

async function getBetRecord(acct, page = 1) {
  try {
    const r = await axios.get(
      `${LOTTERY_BASE}/api/lottery/wingo/mybet?lotteryType=1&pageSize=10&pageNum=${page}`,
      { headers: { ...GOA_HEADERS, 'Authorization': `Bearer ${acct.lotteryToken}` }, timeout: 10000 }
    );
    return r.data;
  } catch(e) {
    return { code: -1, msg: e.message };
  }
}

async function getHistory(acct, page = 1, pageSize = 100) {
  try {
    const r = await axios.get(
      `${LOTTERY_BASE}/api/lottery/wingo/listissue?lotteryType=1&pageSize=${pageSize}&pageNum=${page}`,
      { headers: { ...GOA_HEADERS, 'Authorization': `Bearer ${acct.lotteryToken}` }, timeout: 12000 }
    );
    return r.data;
  } catch(e) {
    return { code: -1, msg: e.message };
  }
}

// ─────────────────────────────────────────────────────────
// PREDICTION FORMULAS
// ─────────────────────────────────────────────────────────
function predict(formula, history) {
  // history: array of 'BIG'/'SMALL' strings, latest first
  if (!history || history.length === 0) return 'BIG';

  const last = history[0];
  const last3 = history.slice(0, 3);
  const last5 = history.slice(0, 5);

  switch (formula) {
    case 'ANTI':
      return last === 'BIG' ? 'SMALL' : 'BIG';

    case 'FOLLOW':
      return last;

    case 'PATTERN3': {
      // If last 3 same → switch
      if (last3.length >= 3 && last3.every(x => x === last3[0])) {
        return last3[0] === 'BIG' ? 'SMALL' : 'BIG';
      }
      return last === 'BIG' ? 'SMALL' : 'BIG';
    }

    case 'MAJORITY5': {
      if (last5.length < 3) return last === 'BIG' ? 'SMALL' : 'BIG';
      const bigs = last5.filter(x => x === 'BIG').length;
      return bigs >= 3 ? 'SMALL' : 'BIG';
    }

    case 'NEXUS': {
      // Alternating streak detector
      if (last5.length >= 4) {
        const isAlt = last5.slice(0, 4).every((v, i, a) => i === 0 || v !== a[i-1]);
        if (isAlt) return last === 'BIG' ? 'BIG' : 'SMALL';
      }
      return last === 'BIG' ? 'SMALL' : 'BIG';
    }

    default:
      return last === 'BIG' ? 'SMALL' : 'BIG';
  }
}

// ─────────────────────────────────────────────────────────
// ENGINE CORE
// ─────────────────────────────────────────────────────────
function addLog(acct, type, msg) {
  const entry = { type, msg, ts: Date.now() };
  acct.log.unshift(entry);
  if (acct.log.length > 200) acct.log.pop();
  return entry;
}

function getState(acct) {
  return {
    phone: acct.phone,
    balance: acct.balance,
    engine: acct.engine,
    formula: acct.formula,
    levels: acct.levels,
    baseAmt: acct.baseAmt,
    maxLevel: acct.maxLevel,
    stopOnWin: acct.stopOnWin,
    stopOnWinAmt: acct.stopOnWinAmt,
    stopOnLoss: acct.stopOnLoss,
    stopOnLossAmt: acct.stopOnLossAmt,
    watchCount: acct.watchCount,
    currentLevel: acct.currentLevel,
    pnl: acct.pnl,
    bets: acct.bets,
    wins: acct.wins,
    losses: acct.losses,
    log: acct.log,
    betHistory: acct.betHistory,
    predHistory: acct.predHistory,
    currentPeriod: acct.currentPeriod,
    currentPred: acct.currentPred,
    countdown: acct.countdown,
    betPlaced: acct.betPlaced,
    watchRemain: acct.watchRemain,
    maxLevelHit: acct.maxLevelHit,
    loggedIn: !!acct.lotteryToken,
  };
}

function broadcastState(acct) {
  io.emit('state', getState(acct));
  // Update account list
  const list = Object.values(accounts).map(a => ({
    phone: a.phone,
    engine: a.engine,
    balance: a.balance,
    pnl: a.pnl,
    loggedIn: !!a.lotteryToken,
  }));
  io.emit('accountList', list);
}

function stopEngine(acct, reason) {
  if (acct.interval) { clearInterval(acct.interval); acct.interval = null; }
  acct.engine = 'stopped';
  acct.betPlaced = false;
  acct.waitingResult = false;
  addLog(acct, 'warn', reason || 'Engine stopped');
  broadcastState(acct);
}

async function engineTick(acct) {
  if (acct.engine !== 'running' || acct.locked) return;
  acct.locked = true;

  try {
    // Get current period
    const period = await getCurrentPeriod(acct);
    if (!period) { acct.locked = false; return; }

    const issue   = period.issueNumber || period.issue || '';
    const cd      = parseInt(period.remainTime || period.countdown || 0);
    acct.countdown = cd;

    // New period
    if (issue !== acct.currentPeriod) {
      // Check result of previous bet
      if (acct.waitingResult && acct.resultIssue) {
        const last = await getLastResult(acct);
        if (last && last.issueNumber === acct.resultIssue) {
          const num    = parseInt(last.number !== undefined ? last.number : last.openNumber);
          const result = num >= 5 ? 'BIG' : 'SMALL';
          const won    = result === acct.currentPred;
          const betAmt = acct.levels[acct.currentLevel] || acct.baseAmt;

          if (won) {
            acct.wins++;
            acct.pnl += betAmt * 0.96; // ~96% payout
            acct.currentLevel = 0;
            addLog(acct, 'success', `✅ WIN — Period ${acct.resultIssue.slice(-5)} | Result: ${result} | +₹${(betAmt * 0.96).toFixed(2)}`);

            // Update pred history
            const ph = acct.predHistory.find(p => p.forIssue === acct.resultIssue);
            if (ph) { ph.result = result; ph.correct = true; }

            // Stop on win check
            if (acct.stopOnWin && acct.pnl >= acct.stopOnWinAmt) {
              stopEngine(acct, `🏆 Stop-on-Win triggered at ₹${acct.pnl.toFixed(2)}`);
              acct.locked = false; return;
            }
          } else {
            acct.losses++;
            acct.pnl -= betAmt;
            addLog(acct, 'error', `❌ LOSS — Period ${acct.resultIssue.slice(-5)} | Result: ${result} | -₹${betAmt.toFixed(2)}`);

            const ph = acct.predHistory.find(p => p.forIssue === acct.resultIssue);
            if (ph) { ph.result = result; ph.correct = false; }

            // Level up
            if (acct.currentLevel < acct.levels.length - 1) {
              acct.currentLevel++;
              addLog(acct, 'warn', `📈 Level up → LV${acct.currentLevel + 1} | Next bet: ₹${acct.levels[acct.currentLevel]}`);
            } else {
              acct.maxLevelHit = true;
              stopEngine(acct, '🚨 Max level reached — engine stopped');
              acct.locked = false; return;
            }

            // Stop on loss check
            if (acct.stopOnLoss && Math.abs(acct.pnl) >= acct.stopOnLossAmt) {
              stopEngine(acct, `🛑 Stop-on-Loss triggered at -₹${Math.abs(acct.pnl).toFixed(2)}`);
              acct.locked = false; return;
            }
          }
          acct.bets++;
          acct.waitingResult = false;
        }
      }

      // New period setup
      acct.currentPeriod = issue;
      acct.betPlaced = false;

      // Get history for prediction
      const histRes = await getHistory(acct, 1, 20);
      let histArr = [];
      if (histRes && histRes.code === 0 && histRes.data && histRes.data.list) {
        histArr = histRes.data.list.map(h => {
          const n = parseInt(h.number !== undefined ? h.number : h.openNumber);
          return n >= 5 ? 'BIG' : 'SMALL';
        });
      }

      // Watch mode
      if (acct.watchRemain > 0) {
        acct.watchRemain--;
        addLog(acct, 'info', `👁 Watching — ${acct.watchRemain} periods left`);
        broadcastState(acct);
        acct.locked = false;
        return;
      }

      // Make prediction
      const pred = predict(acct.formula, histArr);
      acct.currentPred = pred;
      acct.predHistory.unshift({ forIssue: issue, pred, result: null, correct: null, formula: acct.formula });
      if (acct.predHistory.length > 100) acct.predHistory.pop();
      addLog(acct, 'info', `🔮 Period ${issue.slice(-5)} | Pred: ${pred} | LV${acct.currentLevel + 1}`);
    }

    // Place bet (30s > cd > 5s window)
    if (!acct.betPlaced && cd <= 30 && cd > 5) {
      const betAmt = acct.levels[acct.currentLevel] || acct.baseAmt;
      addLog(acct, 'info', `💰 Placing ₹${betAmt} on ${acct.currentPred}...`);

      const betRes = await placeBet(acct, acct.currentPred, betAmt);
      if (betRes && betRes.code === 0) {
        acct.betPlaced = true;
        acct.waitingResult = true;
        acct.resultIssue = acct.currentPeriod;
        addLog(acct, 'success', `✅ Bet placed: ₹${betAmt} on ${acct.currentPred} | Period ${acct.currentPeriod.slice(-5)}`);
      } else {
        addLog(acct, 'error', `❌ Bet failed: ${betRes?.msg || 'unknown error'}`);
      }
    }

    // Refresh balance every 5 ticks
    if (Date.now() % 10000 < 2000) {
      await getBalance(acct);
    }

    broadcastState(acct);
  } catch(e) {
    addLog(acct, 'error', 'Engine error: ' + e.message);
  }

  acct.locked = false;
}

// ─────────────────────────────────────────────────────────
// SOCKET.IO EVENTS
// ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+] Client connected:', socket.id);
  let viewPhone = null;

  // Send account list on connect
  const list = Object.values(accounts).map(a => ({
    phone: a.phone, engine: a.engine, balance: a.balance, pnl: a.pnl, loggedIn: !!a.lotteryToken,
  }));
  socket.emit('accountList', list);

  // ── AUTH ──
  socket.on('auth', async (d) => {
    const acct = getAccount(d.phone);
    acct.lotteryToken = d.lotteryToken || acct.lotteryToken;
    acct.webapiToken  = d.webapiToken  || acct.webapiToken;
    acct.pwd          = d.pwd          || acct.pwd;
    addLog(acct, 'info', `🔑 Account authenticated: ...${d.phone.slice(-4)}`);
    await getBalance(acct);
    broadcastState(acct);
    if (!viewPhone) {
      viewPhone = d.phone;
      socket.emit('state', getState(acct));
    }
  });

  // ── SWITCH VIEW ──
  socket.on('switchView', (d) => {
    viewPhone = d.phone;
    const acct = accounts[d.phone];
    if (acct) socket.emit('state', getState(acct));
  });

  // ── START ENGINE ──
  socket.on('start', (d) => {
    const acct = accounts[d.phone];
    if (!acct || !acct.lotteryToken) { socket.emit('toast', { type: 'error', title: 'Not logged in', msg: 'Auth first' }); return; }
    if (acct.engine === 'running') return;

    // Apply config
    if (d.baseAmt)      acct.baseAmt      = parseFloat(d.baseAmt);
    if (d.maxLevel)     acct.maxLevel     = parseInt(d.maxLevel);
    if (d.formula)      acct.formula      = d.formula;
    if (d.stopOnWin  !== undefined)    acct.stopOnWin    = d.stopOnWin;
    if (d.stopOnWinAmt !== undefined)  acct.stopOnWinAmt = parseFloat(d.stopOnWinAmt);
    if (d.stopOnLoss !== undefined)    acct.stopOnLoss   = d.stopOnLoss;
    if (d.stopOnLossAmt !== undefined) acct.stopOnLossAmt = parseFloat(d.stopOnLossAmt);
    if (d.watchCount !== undefined)    acct.watchCount   = parseInt(d.watchCount);
    if (d.levels)       acct.levels       = d.levels;

    // Build levels array from baseAmt if not given
    if (!d.levels) {
      acct.levels = Array.from({ length: acct.maxLevel }, (_, i) => {
        return parseFloat((acct.baseAmt * Math.pow(2, i)).toFixed(2));
      });
    }

    acct.engine       = 'running';
    acct.maxLevelHit  = false;
    acct.watchRemain  = acct.watchCount;
    acct.betPlaced    = false;
    acct.waitingResult = false;
    acct.locked       = false;

    addLog(acct, 'success', `▶ Engine started | Formula: ${acct.formula} | Watch: ${acct.watchCount} | Levels: [${acct.levels.join(', ')}]`);

    if (acct.interval) clearInterval(acct.interval);
    acct.interval = setInterval(() => engineTick(acct), 2000);
    engineTick(acct);
    broadcastState(acct);
  });

  // ── STOP ENGINE ──
  socket.on('stop', (d) => {
    const acct = accounts[d.phone];
    if (!acct) return;
    stopEngine(acct, '⏹ Engine stopped by user');
  });

  // ── SET FORMULA ──
  socket.on('setFormula', (d) => {
    const acct = accounts[d.phone];
    if (!acct) return;
    acct.formula = d.formula;
    addLog(acct, 'info', `📐 Formula changed to: ${d.formula}`);
    broadcastState(acct);
  });

  // ── SET LEVELS ──
  socket.on('setLevels', (d) => {
    const acct = accounts[d.phone];
    if (!acct) return;
    acct.levels = d.custom;
    acct.currentLevel = 0;
    addLog(acct, 'info', `📊 Levels updated: [${d.custom.join(', ')}]`);
    broadcastState(acct);
  });

  // ── GET BET RECORD ──
  socket.on('getBetRecord', async (d) => {
    const acct = accounts[d.phone];
    if (!acct || !acct.lotteryToken) return;
    const result = await getBetRecord(acct, d.page || 1);
    socket.emit('betRecord', { result, page: d.page || 1 });
  });

  // ── EXPORT HISTORY ──
  socket.on('exportHistory', async (d) => {
    const acct = accounts[d.phone];
    if (!acct || !acct.lotteryToken) return;
    const totalWant = d.totalRecords || 500;
    const pageSize  = 100;
    const maxPages  = Math.ceil(totalWant / pageSize);
    let all = [];

    for (let page = 1; page <= maxPages; page++) {
      let retries = 0;
      while (retries < 3) {
        try {
          socket.emit('exportHistoryProgress', { page, maxPages, total: all.length, retrying: retries > 0 ? retries : 0 });
          const r = await getHistory(acct, page, pageSize);
          if (r && r.code === 0 && r.data && r.data.list && r.data.list.length > 0) {
            all = all.concat(r.data.list);
            break;
          } else {
            socket.emit('exportHistoryProgress', { page, maxPages, total: all.length, done: true });
            page = maxPages + 1; break;
          }
        } catch(e) {
          retries++;
          if (retries >= 3) socket.emit('exportHistoryProgress', { page, maxPages, total: all.length, error: e.message });
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (all.length >= totalWant) break;
      await new Promise(r => setTimeout(r, 400));
    }

    socket.emit('exportHistoryResult', { ok: true, list: all.slice(0, totalWant) });
  });

  // ── NEXUS WARMUP ──
  socket.on('nexusWarmup', async (d) => {
    const acct = accounts[d.phone];
    if (!acct || !acct.lotteryToken) return;
    const pageSize = 100, maxPages = 5;
    let all = [];
    for (let page = 1; page <= maxPages; page++) {
      socket.emit('nexusWarmupProgress', { page, maxPages, total: all.length, status: `Fetching page ${page}/${maxPages}...` });
      const r = await getHistory(acct, page, pageSize);
      if (r && r.code === 0 && r.data && r.data.list) {
        all = all.concat(r.data.list);
      } else break;
      await new Promise(r => setTimeout(r, 500));
    }
    const histArr = all.map(h => {
      const n = parseInt(h.number !== undefined ? h.number : h.openNumber);
      return n >= 5 ? 'BIG' : 'SMALL';
    });
    socket.emit('nexusWarmupDone', { ok: true, records: histArr.length, msg: `${histArr.length} records loaded` });
    // Auto-start
    acct.engine = 'running';
    acct.watchRemain = 0;
    addLog(acct, 'success', `⚡ Nexus warmup complete — ${histArr.length} records — engine starting`);
    if (acct.interval) clearInterval(acct.interval);
    acct.interval = setInterval(() => engineTick(acct), 2000);
    broadcastState(acct);
  });

  // ── LOGOUT ──
  socket.on('logout', (d) => {
    const acct = accounts[d.phone];
    if (!acct) return;
    stopEngine(acct, '🔓 Logged out');
    delete accounts[d.phone];
    const list = Object.values(accounts).map(a => ({
      phone: a.phone, engine: a.engine, balance: a.balance, pnl: a.pnl, loggedIn: !!a.lotteryToken,
    }));
    io.emit('accountList', list);
    io.emit('accountRemoved', { phone: d.phone });
  });

  // ── RESET STATS ──
  socket.on('resetStats', (d) => {
    const acct = accounts[d.phone];
    if (!acct) return;
    acct.pnl = 0; acct.bets = 0; acct.wins = 0; acct.losses = 0;
    acct.currentLevel = 0; acct.maxLevelHit = false;
    acct.predHistory = []; acct.betHistory = [];
    addLog(acct, 'info', '🔄 Stats reset');
    broadcastState(acct);
  });

  socket.on('disconnect', () => {
    console.log('[-] Client disconnected:', socket.id);
  });
});

// ─────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ KINGPIN Server running on port ${PORT}`);
});
