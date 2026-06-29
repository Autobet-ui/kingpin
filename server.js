'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const dns      = require('dns');

// Force Google DNS
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const PORT = process.env.PORT || 3000;

// ── GOA API Config (from original Replit source) ──
const GOA_BASES = [
  'https://api.goa7777.com',
  'https://api.ar-lottery01.com',
  'https://api.goagamea.com',
];
const GOA_API = '/api/webapi';
const PUBLIC_HISTORY_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';

const BYPASS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://goagamea.com',
  'Referer': 'https://goagamea.com/',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

const EXCLUDED = ['signature', 'track', 'xosoBettingData'];

function makeRandom() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function signPayload(raw) {
  const enriched = { language: 0, random: makeRandom(), ...raw };
  const sorted = Object.keys(enriched).sort();
  const filtered = {};
  sorted.forEach(k => {
    const v = enriched[k];
    if (v !== null && v !== '' && !EXCLUDED.includes(k)) filtered[k] = v === 0 ? 0 : v;
  });
  enriched['signature'] = crypto.createHash('md5').update(JSON.stringify(filtered)).digest('hex').toUpperCase().slice(0, 32);
  enriched['timestamp'] = Math.floor(Date.now() / 1000);
  return enriched;
}

async function goaPost(endpoint, rawBody, token) {
  const body = signPayload(rawBody || {});
  const headers = { ...BYPASS_HEADERS, 'Content-Type': 'application/json' };
  if (token) { headers['Authorization'] = `Bearer ${token}`; headers['token'] = token; }

  for (const base of GOA_BASES) {
    try {
      const res = await fetch(`${base}${GOA_API}${endpoint}`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await res.json();
        console.log(`[GOA] ✅ ${base} → ${endpoint} code:${data.code}`);
        return data;
      }
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
    } catch (e) {
      console.warn(`[GOA] ❌ ${base}${endpoint}: ${e.message}`);
    }
  }
  throw new Error(`All GOA bases failed for ${endpoint}`);
}

// ── Express App ──
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, token');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST Routes ──
app.post('/api/goa/captcha', async (req, res) => {
  try { res.json(await goaPost('/Captcha', {})); }
  catch (e) { console.error('[captcha]', e.message); res.json({ code: -1, msg: e.message }); }
});

app.post('/api/goa/login', async (req, res) => {
  try { res.json(await goaPost('/Login', req.body)); }
  catch (e) { console.error('[login]', e.message); res.json({ code: -1, msg: e.message }); }
});

app.post('/api/goa/balance', async (req, res) => {
  const token = req.headers['token'] || req.headers['authorization'];
  try { res.json(await goaPost('/User/GetInfo', req.body, token)); }
  catch (e) { res.json({ code: -1, msg: e.message }); }
});

app.post('/api/goa/bet', async (req, res) => {
  const token = req.headers['token'] || req.headers['authorization'];
  try { res.json(await goaPost('/WinGo/WinGoBet', req.body, token)); }
  catch (e) { res.json({ code: -1, msg: e.message }); }
});

app.post('/api/goa/history', async (req, res) => {
  const token = req.headers['token'] || req.headers['authorization'];
  try { res.json(await goaPost('/WinGo/GetMyGameRecordList', req.body, token)); }
  catch (e) { res.json({ code: -1, msg: e.message }); }
});

app.post('/api/goa/result', async (req, res) => {
  const token = req.headers['token'] || req.headers['authorization'];
  try { res.json(await goaPost('/WinGo/GetIssueList', req.body, token)); }
  catch (e) { res.json({ code: -1, msg: e.message }); }
});

app.get('/api/goa/period', async (req, res) => {
  const token = req.headers['token'] || req.headers['authorization'];
  try { res.json(await goaPost('/WinGo/GetIssueList', { pageNo: 1, pageSize: 1, typeId: 30 }, token)); }
  catch (e) { res.json({ code: -1, msg: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.IO Engine ──
const accounts = {};

function makeAccount(phone) {
  return {
    phone, lotteryToken: '', webapiToken: '', balance: 0,
    engine: 'stopped', formula: 'PATTERN3',
    levels: [2,4,8,16,32,64,128], currentLevel: 0,
    pnl: 0, bets: 0, wins: 0, losses: 0,
    log: [], predHistory: [], betHistory: [],
    currentPeriod: '', currentPred: '', countdown: 0,
    betPlaced: false, waitingResult: false, resultIssue: '',
    watchCount: 3, watchRemain: 0, stopOnWin: false, stopOnWinAmt: 100,
    stopOnLoss: false, stopOnLossAmt: 500, maxLevelHit: false,
    locked: false, interval: null,
  };
}

function addLog(acct, type, msg) {
  const entry = { type, msg, ts: Date.now() };
  acct.log.unshift(entry);
  if (acct.log.length > 200) acct.log.pop();
}

function getState(acct) {
  return {
    phone: acct.phone, balance: acct.balance, engine: acct.engine,
    formula: acct.formula, levels: acct.levels, currentLevel: acct.currentLevel,
    pnl: acct.pnl, bets: acct.bets, wins: acct.wins, losses: acct.losses,
    log: acct.log, predHistory: acct.predHistory, betHistory: acct.betHistory,
    currentPeriod: acct.currentPeriod, currentPred: acct.currentPred,
    countdown: acct.countdown, betPlaced: acct.betPlaced,
    watchRemain: acct.watchRemain, maxLevelHit: acct.maxLevelHit,
    stopOnWin: acct.stopOnWin, stopOnWinAmt: acct.stopOnWinAmt,
    stopOnLoss: acct.stopOnLoss, stopOnLossAmt: acct.stopOnLossAmt,
    loggedIn: !!acct.lotteryToken,
  };
}

function broadcastState(acct) {
  io.emit('state', getState(acct));
  io.emit('accountList', Object.values(accounts).map(a => ({
    phone: a.phone, engine: a.engine, balance: a.balance, pnl: a.pnl, loggedIn: !!a.lotteryToken,
  })));
}

function stopEngine(acct, reason) {
  if (acct.interval) { clearInterval(acct.interval); acct.interval = null; }
  acct.engine = 'stopped'; acct.betPlaced = false; acct.waitingResult = false; acct.locked = false;
  addLog(acct, 'warn', reason || 'Engine stopped');
  broadcastState(acct);
}

function predict(formula, history) {
  if (!history || history.length === 0) return 'BIG';
  const last = history[0];
  switch (formula) {
    case 'ANTI': return last === 'BIG' ? 'SMALL' : 'BIG';
    case 'FOLLOW': return last;
    case 'PATTERN3': {
      const l3 = history.slice(0, 3);
      if (l3.length >= 3 && l3.every(x => x === l3[0])) return l3[0] === 'BIG' ? 'SMALL' : 'BIG';
      return last === 'BIG' ? 'SMALL' : 'BIG';
    }
    case 'MAJORITY5': {
      const l5 = history.slice(0, 5);
      return l5.filter(x => x === 'BIG').length >= 3 ? 'SMALL' : 'BIG';
    }
    default: return last === 'BIG' ? 'SMALL' : 'BIG';
  }
}

async function engineTick(acct) {
  if (acct.engine !== 'running' || acct.locked) return;
  acct.locked = true;
  try {
    // Get current period via public history
    let histData = null;
    try {
      const r = await fetch(PUBLIC_HISTORY_URL + '?pageNo=1&pageSize=5&typeId=30');
      histData = await r.json();
    } catch(e) {}

    if (!histData || !histData.data || !histData.data.list) { acct.locked = false; return; }

    const list = histData.data.list;
    const latest = list[0];
    const issue = String(latest.issueNumber || latest.issue || '');
    const cd = parseInt(latest.remainTime || latest.countDown || 30);
    acct.countdown = cd;

    if (issue && issue !== acct.currentPeriod) {
      // Check result of previous bet
      if (acct.waitingResult && acct.resultIssue) {
        const prev = list.find(x => String(x.issueNumber || x.issue) === acct.resultIssue);
        if (prev) {
          const num = parseInt(prev.number !== undefined ? prev.number : prev.openNumber);
          const result = num >= 5 ? 'BIG' : 'SMALL';
          const won = result === acct.currentPred;
          const betAmt = acct.levels[acct.currentLevel] || acct.levels[0];
          if (won) {
            acct.wins++; acct.pnl += betAmt * 0.96; acct.currentLevel = 0;
            addLog(acct, 'success', `✅ WIN — ${acct.resultIssue.slice(-5)} | +₹${(betAmt*0.96).toFixed(2)}`);
            if (acct.stopOnWin && acct.pnl >= acct.stopOnWinAmt) { stopEngine(acct, `🏆 Stop-on-Win ₹${acct.pnl.toFixed(2)}`); acct.locked=false; return; }
          } else {
            acct.losses++; acct.pnl -= betAmt;
            addLog(acct, 'error', `❌ LOSS — ${acct.resultIssue.slice(-5)} | -₹${betAmt.toFixed(2)}`);
            if (acct.currentLevel < acct.levels.length - 1) {
              acct.currentLevel++;
              addLog(acct, 'warn', `📈 Level → LV${acct.currentLevel+1} | Next: ₹${acct.levels[acct.currentLevel]}`);
            } else { acct.maxLevelHit = true; stopEngine(acct, '🚨 Max level reached'); acct.locked=false; return; }
            if (acct.stopOnLoss && Math.abs(acct.pnl) >= acct.stopOnLossAmt) { stopEngine(acct, `🛑 Stop-on-Loss -₹${Math.abs(acct.pnl).toFixed(2)}`); acct.locked=false; return; }
          }
          acct.bets++; acct.waitingResult = false;
        }
      }

      acct.currentPeriod = issue; acct.betPlaced = false;
      const histArr = list.map(x => parseInt(x.number !== undefined ? x.number : x.openNumber) >= 5 ? 'BIG' : 'SMALL');

      if (acct.watchRemain > 0) {
        acct.watchRemain--;
        addLog(acct, 'info', `👁 Watching — ${acct.watchRemain} left`);
        broadcastState(acct); acct.locked = false; return;
      }

      const pred = predict(acct.formula, histArr);
      acct.currentPred = pred;
      acct.predHistory.unshift({ forIssue: issue, pred, result: null });
      if (acct.predHistory.length > 50) acct.predHistory.pop();
      addLog(acct, 'info', `🔮 Period ${issue.slice(-5)} | Pred: ${pred} | LV${acct.currentLevel+1}`);
    }

    // Place bet window: 25s > cd > 5s
    if (!acct.betPlaced && cd <= 25 && cd > 5 && acct.lotteryToken) {
      const betAmt = acct.levels[acct.currentLevel] || acct.levels[0];
      const typeId = acct.currentPred === 'BIG' ? 2 : 1;
      addLog(acct, 'info', `💰 Betting ₹${betAmt} on ${acct.currentPred}...`);
      try {
        const betRes = await goaPost('/WinGo/WinGoBet', {
          issueNumber: acct.currentPeriod, typeId, betAmount: betAmt, gameType: 1,
        }, acct.lotteryToken);
        if (betRes && betRes.code === 0) {
          acct.betPlaced = true; acct.waitingResult = true; acct.resultIssue = acct.currentPeriod;
          addLog(acct, 'success', `✅ Bet: ₹${betAmt} on ${acct.currentPred}`);
        } else {
          addLog(acct, 'error', `❌ Bet fail: ${betRes?.msg || 'unknown'}`);
        }
      } catch(e) { addLog(acct, 'error', `❌ Bet error: ${e.message}`); }
    }

    // Balance refresh every ~15s
    if (!acct._lastBal || Date.now() - acct._lastBal > 15000) {
      acct._lastBal = Date.now();
      try {
        const b = await goaPost('/User/GetInfo', {}, acct.lotteryToken);
        if (b && b.code === 0 && b.data) acct.balance = parseFloat(b.data.balance || b.data.money || acct.balance);
      } catch(e) {}
    }

    broadcastState(acct);
  } catch(e) {
    addLog(acct, 'error', 'Tick error: ' + e.message);
  }
  acct.locked = false;
}

io.on('connection', socket => {
  console.log('[+] Socket connected:', socket.id);
  socket.emit('accountList', Object.values(accounts).map(a => ({
    phone: a.phone, engine: a.engine, balance: a.balance, pnl: a.pnl, loggedIn: !!a.lotteryToken,
  })));

  socket.on('auth', async d => {
    if (!accounts[d.phone]) accounts[d.phone] = makeAccount(d.phone);
    const acct = accounts[d.phone];
    acct.lotteryToken = d.token || d.lotteryToken || acct.lotteryToken;
    acct.webapiToken  = d.webapiToken || acct.webapiToken;
    addLog(acct, 'info', `🔑 Authenticated: ...${d.phone.slice(-4)}`);
    broadcastState(acct);
    socket.emit('state', getState(acct));
  });

  socket.on('start', d => {
    if (!accounts[d.phone]) return;
    const acct = accounts[d.phone];
    if (acct.engine === 'running') return;
    if (d.formula)      acct.formula      = d.formula;
    if (d.baseAmt)      acct.levels = Array.from({length: d.maxLevel||7}, (_,i) => parseFloat((parseFloat(d.baseAmt)*Math.pow(2,i)).toFixed(2)));
    if (d.levels)       acct.levels = d.levels;
    if (d.stopOnWin !== undefined)    acct.stopOnWin    = d.stopOnWin;
    if (d.stopOnWinAmt !== undefined) acct.stopOnWinAmt = parseFloat(d.stopOnWinAmt);
    if (d.stopOnLoss !== undefined)   acct.stopOnLoss   = d.stopOnLoss;
    if (d.stopOnLossAmt !== undefined)acct.stopOnLossAmt= parseFloat(d.stopOnLossAmt);
    if (d.watchCount !== undefined)   acct.watchCount   = parseInt(d.watchCount);
    acct.engine = 'running'; acct.maxLevelHit = false;
    acct.watchRemain = acct.watchCount; acct.currentLevel = 0;
    acct.betPlaced = false; acct.waitingResult = false; acct.locked = false;
    addLog(acct, 'success', `▶ Engine started | ${acct.formula} | LVs: [${acct.levels.join(',')}]`);
    if (acct.interval) clearInterval(acct.interval);
    acct.interval = setInterval(() => engineTick(acct), 2000);
    engineTick(acct);
    broadcastState(acct);
  });

  socket.on('stop', d => {
    if (!accounts[d.phone]) return;
    stopEngine(accounts[d.phone], '⏹ Stopped by user');
  });

  socket.on('setFormula', d => {
    if (!accounts[d.phone]) return;
    accounts[d.phone].formula = d.formula;
    addLog(accounts[d.phone], 'info', `📐 Formula: ${d.formula}`);
    broadcastState(accounts[d.phone]);
  });

  socket.on('resetStats', d => {
    if (!accounts[d.phone]) return;
    const a = accounts[d.phone];
    a.pnl=0; a.bets=0; a.wins=0; a.losses=0; a.currentLevel=0; a.maxLevelHit=false;
    a.predHistory=[]; a.betHistory=[];
    addLog(a, 'info', '🔄 Stats reset');
    broadcastState(a);
  });

  socket.on('logout', d => {
    if (!accounts[d.phone]) return;
    stopEngine(accounts[d.phone], '🔓 Logged out');
    delete accounts[d.phone];
    io.emit('accountList', Object.values(accounts).map(a => ({
      phone: a.phone, engine: a.engine, balance: a.balance, pnl: a.pnl, loggedIn: !!a.lotteryToken,
    })));
  });

  socket.on('disconnect', () => console.log('[-] Socket disconnected:', socket.id));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[KINGPIN 3.0] Server running on port ${PORT}`);
});
