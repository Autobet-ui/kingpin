import type { Server as SocketIOServer, Socket } from "socket.io";
import md5 from "md5";

const GOA_BASE  = "https://api.goa7777.com";
const GOA_API   = `${GOA_BASE}/api/webapi`;
const TYPE_ID   = 30;   // WinGo 30-second

// Public 30S WinGo history — no auth needed (primary results source)
const PUBLIC_HISTORY_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json";

// Alternative GOA bases to try for balance / betting when default fails
const GOA_BASES = [
  "https://api.goa7777.com",
  "https://api.ar-lottery01.com",
  "https://api.goagamea.com",
];

const EXCLUDED = ["signature", "track", "xosoBettingData"];

const GOA_UA_HEADERS: Record<string, string> = {
  "User-Agent":      "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin":          "https://goagamea.com",
  "Referer":         "https://goagamea.com/",
  "sec-fetch-dest":  "empty",
  "sec-fetch-mode":  "cors",
  "sec-fetch-site":  "same-origin",
};

function makeRandom(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function signPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const enriched: Record<string, unknown> = { language: 0, random: makeRandom(), ...raw };
  const sorted = Object.keys(enriched).sort();
  const filtered: Record<string, unknown> = {};
  sorted.forEach(k => {
    const v = enriched[k];
    if (v !== null && v !== "" && !EXCLUDED.includes(k)) filtered[k] = v === 0 ? 0 : v;
  });
  enriched["signature"] = md5(JSON.stringify(filtered)).toUpperCase().slice(0, 32);
  enriched["timestamp"] = Math.floor(Date.now() / 1000);
  return enriched;
}

async function goaPost(path: string, body: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const signed = signPayload(body);
  const headers: Record<string, string> = { ...GOA_UA_HEADERS, "Content-Type": "application/json" };
  if (token) { headers["token"] = token; headers["Authorization"] = `Bearer ${token}`; }
  const res = await fetch(`${GOA_API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(signed),
  });
  if (!res.ok) throw new Error(`GOA ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── Domain Types ─────────────────────────────────────────────────────────────

interface Account {
  phone: string;
  lotteryToken: string;
  webapiToken: string;
  pwd: string;
  engine: "stopped" | "running";
  loggedIn: boolean;
  wins: number; losses: number; pnl: number;
  level: number; highestLevel: number;
  sessionStart: number;
  config: { baseAmt: number; maxLevel: number; formula: string; watchEnabled: boolean; watchCount: number };
  currentLevel: number;
  watchLossCount: number;
  watchActive: boolean;
  levels: number[];
  logs: LogEntry[];
  betHistory: BetHistRow[];
  predHistory: PredHistRow[];
  lastPrediction: string | null;   // "B" or "S"
  lastConf: number;                // 0–100 confidence from Shadow Engine
  lastResult: string | null;
  betPlaced: boolean;
  betPeriod: string | null;
  currentPeriod: string | null;
  balance: number;
  pollInterval?: ReturnType<typeof setInterval>;
}

interface LogEntry { type: string; msg: string; ts: number; t?: string; cls?: string; }
interface BetHistRow { issue: string; pred: string; level: number; amount: number; won: boolean; pnl: number; }
interface PredHistRow { forIssue: string; formula: string; pred: string; result: string; correct: boolean; }

const FORMULA_NAMES: Record<string, string> = {
  shadow: "⚡ Shadow Adaptive v14.0",
};

const accounts = new Map<string, Account>();
const socketViews = new Map<string, string>();

function buildLevels(base: number, max: number): number[] {
  const lvls: number[] = [];
  let amt = base;
  for (let i = 0; i < max; i++) { lvls.push(Math.round(amt)); amt *= 2; }
  return lvls;
}

function newAccount(phone: string): Account {
  return {
    phone, lotteryToken: "", webapiToken: "", pwd: "",
    engine: "stopped", loggedIn: false,
    wins: 0, losses: 0, pnl: 0, level: 1, highestLevel: 1, sessionStart: Date.now(),
    config: { baseAmt: 2, maxLevel: 10, formula: "shadow", watchEnabled: false, watchCount: 1 },
    currentLevel: 1, watchLossCount: 0, watchActive: false,
    levels: buildLevels(2, 10),
    logs: [], betHistory: [], predHistory: [],
    lastPrediction: null, lastConf: 0, lastResult: null,
    betPlaced: false, betPeriod: null, currentPeriod: null, balance: 0,
  };
}

function getOrCreate(phone: string): Account {
  if (!accounts.has(phone)) accounts.set(phone, newAccount(phone));
  return accounts.get(phone)!;
}

function ts(): string { return new Date().toLocaleTimeString("en-IN", { hour12: false }); }

function addLog(acct: Account, type: string, msg: string): LogEntry {
  const entry: LogEntry = { type, msg, ts: Date.now(), t: ts(), cls: type };
  acct.logs.unshift(entry);
  if (acct.logs.length > 200) acct.logs.pop();
  return entry;
}

// ─── State Snapshot (matches HTML renderState expectations) ───────────────────

function snap(acct: Account) {
  return {
    phone: acct.phone, loggedIn: acct.loggedIn, engine: acct.engine,
    balance: acct.balance,
    wins: acct.wins, losses: acct.losses, pnl: acct.pnl,
    level: acct.currentLevel, highestLevel: acct.highestLevel,
    sessionElapsed: Date.now() - acct.sessionStart,
    prediction: acct.lastPrediction ? {
      pred: acct.lastPrediction === "B" ? "BIG" : "SMALL",
      conf: acct.lastConf,
      forIssue: acct.currentPeriod ?? "",
      log: "",
      formula: acct.config.formula,
    } : null,
    formulaInfo: { name: FORMULA_NAMES[acct.config.formula] || acct.config.formula },
    levels: acct.levels, currentLevel: acct.currentLevel,
    watchEnabled: acct.config.watchEnabled, watchLossTarget: acct.config.watchCount,
    watchLossCount: acct.watchLossCount,
    betHistory: acct.betHistory.slice(0, 50),
    predHistory: acct.predHistory.slice(0, 50),
    formula: acct.config.formula,
  };
}

function broadcast(io: SocketIOServer, phone: string, event: string, data: unknown) {
  socketViews.forEach((vp, sid) => { if (vp === phone) io.to(sid).emit(event, data); });
}

// ─── GOA API helpers ──────────────────────────────────────────────────────────

function extractBalance(d: Record<string, unknown>): number {
  const candidates = [
    d?.["balance"], d?.["money"], d?.["wallet"],
    d?.["mainBalance"], d?.["normalBalance"], d?.["rechargeBalance"],
    d?.["totalBalance"], d?.["coinBalance"], d?.["amount"],
    (d?.["userInfo"] as Record<string,unknown>)?.["balance"],
    (d?.["userInfo"] as Record<string,unknown>)?.["money"],
  ];
  const vals = candidates
    .map(v => parseFloat(String(v ?? "")))
    .filter(n => !isNaN(n) && n >= 0);
  return vals.length > 0 ? Math.max(...vals) : -1;
}

async function fetchBalance(acct: Account): Promise<number> {
  const token = acct.lotteryToken || acct.webapiToken;
  if (!token) return acct.balance;

  // Try every known GOA base URL — some platforms have different domains
  for (const base of GOA_BASES) {
    try {
      const signed = signPayload({});
      const headers: Record<string, string> = {
        ...GOA_UA_HEADERS,
        "Content-Type": "application/json",
        "token": token,
        "Authorization": `Bearer ${token}`,
      };
      const res = await fetch(`${base}/api/webapi/User/GetInfo`, {
        method: "POST",
        headers,
        body: JSON.stringify(signed),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const json = await res.json() as Record<string, unknown>;
      if (json["code"] === 0) {
        const d = json["data"] as Record<string, unknown>;
        const bal = extractBalance(d);
        if (bal >= 0) return bal;
      }
    } catch (_) { continue; }
  }
  return acct.balance;
}

async function fetchCurrentPeriod(acct: Account): Promise<{ period: string; countdown: number; total: number } | null> {
  try {
    const r = await goaPost("/WinGo/GetCurrentIssue", { typeId: TYPE_ID }, acct.webapiToken || acct.lotteryToken);
    if (r["code"] === 0) {
      const d = r["data"] as Record<string, unknown>;
      return {
        period: String(d?.["issueNumber"] ?? d?.["issue"] ?? ""),
        countdown: Number(d?.["countdown"] ?? d?.["remainTime"] ?? d?.["endTime"] ?? 0),
        total: Number(d?.["totalTime"] ?? d?.["duration"] ?? 30),
      };
    }
  } catch (_) {}
  return null;
}

function parseResultList(list: Record<string, unknown>[]): string[] {
  return list.map(item => {
    const numStr = String(item["number"] ?? item["num"] ?? item["openNumber"] ?? item["winNumber"] ?? "");
    if (numStr !== "" && numStr !== "undefined" && !isNaN(parseInt(numStr))) {
      return parseInt(numStr) >= 5 ? "B" : "S";
    }
    // Fallback: colour / result text field
    const colour = String(item["colour"] ?? item["color"] ?? item["result"] ?? "").toLowerCase();
    if (colour.includes("big")) return "B";
    if (colour.includes("small")) return "S";
    return "B";
  });
}

// ── Public 30S WinGo history (no auth required) ──────────────────────────────
async function fetchResultsPublic(size = 50): Promise<string[]> {
  try {
    // Try GET with query params first
    const url = `${PUBLIC_HISTORY_URL}?pageNo=1&pageSize=${size}&gameId=1`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json, */*", "User-Agent": GOA_UA_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json() as Record<string, unknown>;
    const data = (json["data"] ?? json) as Record<string, unknown>;
    const list = (data?.["list"] ?? data?.["issueList"] ?? data?.["data"] ?? json?.["list"] ?? []) as Record<string, unknown>[];
    if (Array.isArray(list) && list.length > 0) return parseResultList(list);
  } catch (_) {}
  return [];
}

async function fetchLastResults(acct: Account, size = 50): Promise<string[]> {
  // Primary: public API (no auth, more reliable across platforms)
  const pub = await fetchResultsPublic(size);
  if (pub.length >= 6) return pub;

  // Fallback: GOA authenticated API
  try {
    const token = acct.lotteryToken || acct.webapiToken;
    const r = await goaPost("/WinGo/GetIssueList", { pageNo: 1, pageSize: size, typeId: TYPE_ID }, token);
    if (r["code"] === 0) {
      const d = r["data"] as Record<string, unknown>;
      const list = (d?.["list"] ?? d?.["issueList"] ?? []) as Record<string, unknown>[];
      if (Array.isArray(list) && list.length > 0) return parseResultList(list);
    }
  } catch (_) {}
  return pub; // return whatever public gave us (even if short)
}

async function placeBet(acct: Account, pred: string, amt: number, period: string): Promise<boolean> {
  try {
    // lotteryToken is used for WinGo game endpoints
    const token = acct.lotteryToken || acct.webapiToken;
    const r = await goaPost("/WinGo/WinGoBet", {
      typeId: TYPE_ID,
      issueNumber: period,
      amount: amt,
      betContent: pred === "B" ? "Big" : "Small",
      multiple: 1,
    }, token);
    return r["code"] === 0;
  } catch (_) { return false; }
}

async function checkBetResult(acct: Account, period: string): Promise<{ result: string; win: boolean; pnl: number } | null> {
  try {
    const r = await goaPost("/WinGo/GetIssueList", { pageNo: 1, pageSize: 5, typeId: TYPE_ID }, acct.webapiToken || acct.lotteryToken);
    if (r["code"] === 0) {
      const d = r["data"] as Record<string, unknown>;
      const list = (d?.["list"] ?? []) as Record<string, unknown>[];
      const row = list.find(i => String(i["issueNumber"] ?? i["issue"]) === period);
      if (row) {
        const num = parseInt(String(row["number"] ?? row["num"] ?? 0));
        const result = num >= 5 ? "B" : "S";
        const win = result === acct.lastPrediction;
        const amt = acct.levels[acct.currentLevel - 1] ?? acct.config.baseAmt;
        return { result, win, pnl: win ? +(amt * 0.95).toFixed(2) : -amt };
      }
    }
  } catch (_) {}
  return null;
}

// ─── Shadow Adaptive Engine v14.0 ────────────────────────────────────────────
// Multi-strategy voting engine ported from Python shadow_engine.py
// Target: 88-90% win rate via 8 independent strategies + level-fix detection

const MIN_CONF      = 63;   // skip below this confidence (normal)
const MIN_CONF_LOSS = 72;   // skip threshold after 2+ consecutive losses

function shadowEngine(
  seq: string[],
  consecLosses: number
): { pred: string; conf: number; reason: string; skip: boolean } {
  if (seq.length < 6) return { pred: "B", conf: 50, reason: "Collecting data...", skip: true };

  // ── Level-fix detection (overrides all strategies) ──
  let streak = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[0]) streak++;
    else break;
  }
  const opp = seq[0] === "B" ? "S" : "B";
  if (streak >= 5) return { pred: opp, conf: 92, reason: `L2-FIX: ${streak}x${seq[0]} → near-certain reversal`, skip: false };
  if (streak >= 4) return { pred: opp, conf: 85, reason: `L1-FIX: ${streak}x${seq[0]} → high-prob reversal`, skip: false };

  // ── Multi-strategy voting ──
  const votes: Record<"BIG" | "SMALL", number> = { BIG: 0, SMALL: 0 };
  const reasons: string[] = [];

  const vote = (side: "BIG" | "SMALL", pts: number, label: string) => {
    votes[side] += pts;
    reasons.push(`${label}+${pts}→${side}`);
  };

  // S1: Anti-streak (3+ same → reverse)
  const oppSide: "BIG" | "SMALL" = seq[0] === "B" ? "SMALL" : "BIG";
  const sameSide: "BIG" | "SMALL" = seq[0] === "B" ? "BIG" : "SMALL";
  if (streak >= 3) {
    vote(oppSide, Math.min(streak * 11, 44), `AntiStreak(${streak}x${seq[0]})`);
  } else if (streak === 1) {
    vote(sameSide, 6, "ShortContinue");
  }

  // S2: Zigzag (alternating last 5 → predict next flip)
  const h5 = seq.slice(0, Math.min(5, seq.length));
  if (h5.length >= 5 && h5.every((v, i) => i === 0 || v !== h5[i - 1])) {
    vote(oppSide, 28, "Zigzag-5");
  }

  // S3: Last-10 frequency bias
  const L10 = seq.slice(0, Math.min(10, seq.length));
  const bc10 = L10.filter(x => x === "B").length;
  const sc10 = L10.length - bc10;
  if (bc10 >= 7)      vote("SMALL", 22, `FreqBias(B${bc10}/10)`);
  else if (sc10 >= 7) vote("BIG",   22, `FreqBias(S${sc10}/10)`);
  else                vote(bc10 >= sc10 ? "BIG" : "SMALL", 4, "MildDom");

  // S4: Double-pair switch AABB → switch
  if (seq.length >= 4 && seq[0] === seq[1] && seq[2] === seq[3] && seq[0] !== seq[2]) {
    vote(oppSide, 18, `DblPair(${seq[1]}→switch)`);
  }

  // S5: Mirror reversal XYX → predict Y
  if (seq.length >= 3 && seq[0] === seq[2] && seq[0] !== seq[1]) {
    const yside: "BIG" | "SMALL" = seq[1] === "B" ? "BIG" : "SMALL";
    vote(yside, 14, `Mirror(XYX→${seq[1]})`);
  }

  // S6: Last-5 momentum
  const m5b = h5.filter(x => x === "B").length;
  const m5s = h5.length - m5b;
  if (m5b >= 4)      vote("SMALL", 14, `Mom5(B${m5b})`);
  else if (m5s >= 4) vote("BIG",   14, `Mom5(S${m5s})`);

  // S7: Triple-check (last 3 same → high reversal)
  if (seq.length >= 3 && seq[0] === seq[1] && seq[1] === seq[2]) {
    vote(oppSide, 20, `Triple(${seq[0]}→rev)`);
  }

  // S8: Long history trend (last 30)
  if (seq.length >= 30) {
    const L30 = seq.slice(0, 30);
    const b30 = L30.filter(x => x === "B").length;
    const s30 = L30.length - b30;
    if (b30 >= 19)      vote("SMALL", 10, `Trend30(B${b30})`);
    else if (s30 >= 19) vote("BIG",   10, `Trend30(S${s30})`);
  }

  const total = votes.BIG + votes.SMALL;
  if (total === 0) return { pred: "B", conf: 50, reason: "No signal", skip: true };

  const pickFull: "BIG" | "SMALL" = votes.BIG > votes.SMALL ? "BIG" : "SMALL";
  const pick = pickFull === "BIG" ? "B" : "S";
  const rawConf = (votes[pickFull] / total) * 100;
  const margin  = Math.abs(votes.BIG - votes.SMALL);
  let conf = Math.min(95, Math.max(50, rawConf));
  conf = Math.min(95, conf + Math.min(margin * 0.3, 8));
  conf = Math.round(conf * 10) / 10;

  const thr  = consecLosses >= 2 ? MIN_CONF_LOSS : MIN_CONF;
  const skip = conf < thr;
  const topReasons = reasons.slice(0, 3).join(" | ");
  return { pred: pick, conf, reason: `Shadow[${conf}%] BIG=${votes.BIG} SMALL=${votes.SMALL} | ${topReasons}`, skip };
}

function predict(_formula: string, history: string[], consecLosses = 0): { pred: string; conf: number; reason: string; skip?: boolean } {
  if (history.length === 0) return { pred: "B", conf: 50, reason: "No history — default BIG" };
  const result = shadowEngine(history, consecLosses);
  return { pred: result.pred, conf: result.conf, reason: result.reason, skip: result.skip };
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────

export function setupSocketHandlers(io: SocketIOServer) {
  io.on("connection", (socket: Socket) => {

    socket.on("auth", async (d: { lotteryToken: string; webapiToken: string; phone: string; pwd: string }) => {
      if (!d.phone) return;
      const acct = getOrCreate(d.phone);
      acct.lotteryToken = d.lotteryToken || acct.lotteryToken;
      acct.webapiToken  = d.webapiToken  || acct.webapiToken;
      acct.pwd          = d.pwd || acct.pwd;
      acct.loggedIn     = true;

      acct.balance = await fetchBalance(acct);
      startPolling(io, acct);
      socketViews.set(socket.id, d.phone);

      const allAccts = Array.from(accounts.values()).map(a => ({
        phone: a.phone, engine: a.engine, balance: a.balance, pnl: a.pnl, loggedIn: a.loggedIn,
      }));
      socket.emit("accountList", allAccts);
      socket.emit("state", snap(acct));
      socket.emit("logs", acct.logs);
    });

    socket.on("switchView", (d: { phone: string }) => {
      if (!d.phone) return;
      socketViews.set(socket.id, d.phone);
      const acct = accounts.get(d.phone);
      if (acct) { socket.emit("state", snap(acct)); socket.emit("logs", acct.logs); }
    });

    socket.on("start", (d: { phone: string }) => {
      const acct = accounts.get(d.phone);
      if (!acct || !acct.loggedIn) return;
      acct.engine = "running";
      acct.currentLevel = 1; acct.watchLossCount = 0;
      acct.watchActive = acct.config.watchEnabled;
      acct.sessionStart = Date.now();
      addLog(acct, "success", "🚀 Engine started");
      broadcast(io, d.phone, "state", snap(acct));
    });

    socket.on("stop", (d: { phone: string }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      acct.engine = "stopped"; acct.betPlaced = false;
      addLog(acct, "warn", "⏹ Engine stopped");
      broadcast(io, d.phone, "state", snap(acct));
    });

    socket.on("setLevels", (d: { phone: string; baseAmt?: number; maxLevel?: number; custom?: number[] }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      if (d.custom && Array.isArray(d.custom)) {
        acct.levels = d.custom;
        acct.config.maxLevel = d.custom.length;
        acct.config.baseAmt  = d.custom[0] ?? 2;
      } else {
        acct.config.baseAmt  = d.baseAmt  ?? acct.config.baseAmt;
        acct.config.maxLevel = d.maxLevel ?? acct.config.maxLevel;
        acct.levels = buildLevels(acct.config.baseAmt, acct.config.maxLevel);
      }
      acct.currentLevel = 1;
      broadcast(io, d.phone, "state", snap(acct));
    });

    socket.on("setWatch", (d: { phone: string; enabled: boolean; count: number }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      acct.config.watchEnabled = d.enabled;
      acct.config.watchCount   = d.count || 1;
      broadcast(io, d.phone, "state", snap(acct));
    });

    socket.on("setFormula", (d: { phone: string; formula: string }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      acct.config.formula = d.formula;
      broadcast(io, d.phone, "state", snap(acct));
    });

    socket.on("resetStats", (d: { phone: string }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      acct.wins = 0; acct.losses = 0; acct.pnl = 0;
      acct.level = 1; acct.highestLevel = 1;
      acct.currentLevel = 1; acct.sessionStart = Date.now();
      acct.betHistory = []; acct.predHistory = [];
      broadcast(io, d.phone, "state", snap(acct));
    });

    socket.on("logout", (d: { phone: string }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      if (acct.pollInterval) clearInterval(acct.pollInterval);
      accounts.delete(d.phone);
      broadcast(io, d.phone, "accountRemoved", { phone: d.phone });
    });

    socket.on("getBetRecord", async (d: { phone: string; page: number }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      try {
        const data = await goaPost("/WinGo/GetMyGameRecordList", {
          pageNo: d.page || 1, pageSize: 20, typeId: TYPE_ID,
        }, acct.webapiToken || acct.lotteryToken);
        socket.emit("betRecord", { result: data, page: d.page || 1 });
      } catch (e) {
        socket.emit("betRecord", { result: { code: -1, msg: String(e) }, page: 1 });
      }
    });

    socket.on("exportHistory", async (d: { phone: string; totalRecords: number }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      const pageSize = 100;
      const maxPages = Math.ceil((d.totalRecords || 500) / pageSize);
      const allList: unknown[] = [];

      for (let page = 1; page <= maxPages; page++) {
        try {
          const data = await goaPost("/WinGo/GetIssueList", {
            pageNo: page, pageSize, typeId: TYPE_ID,
          }, acct.webapiToken || acct.lotteryToken);
          socket.emit("exportHistoryProgress", { page, maxPages, total: allList.length, done: false });
          if (data["code"] === 0) {
            const dd = data["data"] as Record<string, unknown>;
            const list = (dd?.["list"] ?? []) as unknown[];
            if (!Array.isArray(list) || list.length === 0) {
              socket.emit("exportHistoryProgress", { page, maxPages, total: allList.length, done: true });
              break;
            }
            allList.push(...list);
          }
        } catch (e) {
          socket.emit("exportHistoryProgress", { page, maxPages, total: allList.length, error: String(e) });
        }
        await new Promise(r => setTimeout(r, 200));
      }
      socket.emit("exportHistoryResult", { ok: true, list: allList });
    });

    socket.on("nexusWarmup", async (d: { phone: string }) => {
      const acct = accounts.get(d.phone);
      if (!acct) return;
      const maxPages = 5;
      const allList: unknown[] = [];
      for (let page = 1; page <= maxPages; page++) {
        try {
          const data = await goaPost("/WinGo/GetIssueList", { pageNo: page, pageSize: 100, typeId: TYPE_ID }, acct.webapiToken || acct.lotteryToken);
          if (data["code"] === 0) {
            const dd = data["data"] as Record<string, unknown>;
            const list = (dd?.["list"] ?? []) as unknown[];
            if (Array.isArray(list)) allList.push(...list);
          }
          socket.emit("nexusWarmupProgress", { page, maxPages, total: allList.length });
        } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
      }
      socket.emit("nexusWarmupDone", { ok: true, total: allList.length });
    });

    socket.on("nexusPredict", (d: Record<string, unknown>) => {
      socket.emit("nexusDecision", {
        pred: "B", pct: 55, reason: "Nexus prediction",
        stake: 1, level: 1,
        stats: { bets: 0, wins: 0, acc: "—%", rollAcc: "—%", streak: 0, maxLevel: 1, maxConsecLoss: 0 },
        recentRows: [], ...d,
      });
    });

    socket.on("disconnect", () => { socketViews.delete(socket.id); });
  });
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

function startPolling(io: SocketIOServer, acct: Account) {
  if (acct.pollInterval) return;

  let lastPeriod = "";

  acct.pollInterval = setInterval(async () => {
    if (!acct.loggedIn) return;
    try {
      const pd = await fetchCurrentPeriod(acct);
      if (!pd) return;

      const { period, countdown, total } = pd;
      acct.currentPeriod = period;
      broadcast(io, acct.phone, "countdown", { secs: countdown, total });

      const periodChanged = period !== lastPeriod;

      // ── Result check when period rolls over ──
      if (periodChanged && lastPeriod && acct.betPlaced && acct.lastPrediction) {
        await new Promise(r => setTimeout(r, 2000));
        const rd = await checkBetResult(acct, lastPeriod);
        if (rd) {
          const { result, win, pnl } = rd;
          acct.lastResult = result;
          const predLabel = acct.lastPrediction === "B" ? "BIG" : "SMALL";
          const resLabel  = result === "B" ? "BIG" : "SMALL";
          const amt       = acct.levels[acct.currentLevel - 1] ?? acct.config.baseAmt;

          if (win) {
            acct.wins++; acct.pnl += pnl; acct.currentLevel = 1;
            const log = addLog(acct, "success", `✅ WIN — Period ${lastPeriod} | ${predLabel} | +₹${pnl.toFixed(2)}`);
            broadcast(io, acct.phone, "log", log);
            broadcast(io, acct.phone, "toast", { title: "✅ WIN", msg: `+₹${pnl.toFixed(2)}`, type: "success" });
          } else {
            acct.losses++; acct.pnl += pnl;
            acct.currentLevel = Math.min(acct.currentLevel + 1, acct.levels.length);
            const log = addLog(acct, "error", `❌ LOSS — Period ${lastPeriod} | ${predLabel} → ${resLabel} | -₹${amt}`);
            broadcast(io, acct.phone, "log", log);
            broadcast(io, acct.phone, "toast", { title: "❌ LOSS", msg: `-₹${amt}`, type: "error" });
          }

          if (acct.currentLevel > acct.highestLevel) acct.highestLevel = acct.currentLevel;

          acct.betHistory.unshift({ issue: lastPeriod, pred: predLabel, level: acct.currentLevel, amount: amt, won: win, pnl });
          if (acct.betHistory.length > 200) acct.betHistory.pop();

          acct.predHistory.unshift({ forIssue: lastPeriod, formula: acct.config.formula, pred: predLabel, result: resLabel, correct: win });
          if (acct.predHistory.length > 200) acct.predHistory.pop();

          if (acct.currentLevel > acct.levels.length) {
            acct.engine = "stopped";
            broadcast(io, acct.phone, "maxLevel", { msg: "All martingale levels exhausted. Engine stopped." });
          }

          acct.balance = await fetchBalance(acct);
          broadcast(io, acct.phone, "state", snap(acct));
        }
        acct.betPlaced = false; acct.betPeriod = null;
      }

      // ── New period: predict ──
      if (periodChanged) {
        lastPeriod = period;
        if (acct.engine === "running") {
          const history = await fetchLastResults(acct, 50);
          const { pred, conf, reason, skip } = predict(acct.config.formula, history, acct.losses);
          acct.lastConf = conf;
          if (skip) {
            acct.lastPrediction = null;
            const log = addLog(acct, "warn", `⏸ SKIP — confidence too low @ Period ${period}`);
            broadcast(io, acct.phone, "log", log);
            broadcast(io, acct.phone, "betStatus", {
              cls: "watch", icon: "⏸", label: "SKIPPED",
              detail: "Confidence below threshold — waiting for stronger signal",
              timer: `${countdown}s`, bar: 0,
            });
          } else {
            acct.lastPrediction = pred;
            const predLabel = pred === "B" ? "BIG" : "SMALL";
            const log = addLog(acct, "info", `🔮 Period ${period} — ${predLabel} | ${reason}`);
            broadcast(io, acct.phone, "log", log);
          }
          broadcast(io, acct.phone, "state", snap(acct));
        }
      }

      // ── Bet window: 5s–20s remaining ──
      if (acct.engine === "running" && acct.lastPrediction && !acct.betPlaced && countdown > 5 && countdown <= 20) {
        if (acct.config.watchEnabled && acct.watchActive) {
          if (acct.watchLossCount < acct.config.watchCount) {
            broadcast(io, acct.phone, "betStatus", {
              cls: "watch", icon: "👁️", label: "WATCHING",
              detail: `Watch loss ${acct.watchLossCount}/${acct.config.watchCount} — not betting yet`,
              timer: `${countdown}s`, bar: Math.round(countdown / total * 100),
            });
          } else {
            acct.watchActive = false;
          }
        }

        if (!acct.config.watchEnabled || !acct.watchActive) {
          const amt = acct.levels[acct.currentLevel - 1] ?? acct.config.baseAmt;
          const predLabel = acct.lastPrediction === "B" ? "BIG" : "SMALL";

          broadcast(io, acct.phone, "betStatus", {
            cls: "betting", icon: "🎰", label: `BETTING LV${acct.currentLevel}`,
            detail: `${predLabel} — ₹${amt}`, timer: `${countdown}s`, bar: Math.round(countdown / total * 100),
          });

          const ok = await placeBet(acct, acct.lastPrediction, amt, period);
          if (ok) {
            acct.betPlaced = true; acct.betPeriod = period;
            const log = addLog(acct, "warn", `🎯 BET PLACED — ${predLabel} ₹${amt} LV${acct.currentLevel} @ ${period}`);
            broadcast(io, acct.phone, "log", log);
          } else {
            addLog(acct, "error", `⚠️ Bet failed — Period ${period}`);
          }
        }
      }

    } catch (e) {
      addLog(acct, "error", `🔴 Poll error: ${e}`);
    }
  }, 3000);
}
