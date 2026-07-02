'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const axios      = require('axios');
const path       = require('path');
const crypto     = require('crypto');

const PORT     = process.env.PORT || 3000;
const GOA_BASE = 'https://api.goa7777.com';
const GOA_API  = GOA_BASE + '/api/webapi';
const TYPE_ID  = 30;

const BYPASS_HEADERS = {
  'Content-Type'      : 'application/json',
  'Accept'            : 'application/json, text/plain, */*',
  'Accept-Language'   : 'en-US,en;q=0.9',
  'Origin'            : 'https://goagamea.com',
  'Referer'           : 'https://goagamea.com/',
  'User-Agent'        : 'Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  'sec-ch-ua'         : '"Not_A Brand";v="8","Chromium";v="120","Google Chrome";v="120"',
  'sec-ch-ua-mobile'  : '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest'    : 'empty',
  'sec-fetch-mode'    : 'cors',
  'sec-fetch-site'    : 'cross-site',
};

const accounts = {};

// ══════════════════════════════════════
//  SIGNING
// ══════════════════════════════════════
const EXCL = ['signature','track','xosoBettingData'];

function makeRandom() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    var r=Math.random()*16|0; return(c==='x'?r:(r&0x3)|0x8).toString(16);
  });
}
function md5(str){ return crypto.createHash('md5').update(str).digest('hex'); }

function signPayload(data) {
  var e = Object.assign({ language:0, random:makeRandom() }, data);
  var filtered = {};
  Object.keys(e).sort().forEach(k=>{
    if(e[k]!==null && e[k]!=='' && !EXCL.includes(k)) filtered[k]=e[k];
  });
  e.signature = md5(JSON.stringify(filtered)).toUpperCase().slice(0,32);
  e.timestamp = Math.floor(Date.now()/1000);
  return e;
}

// ══════════════════════════════════════
//  GOA API
// ══════════════════════════════════════
async function goaPost(endpoint, payload, token) {
  var body = signPayload(payload||{});
  var headers = Object.assign({}, BYPASS_HEADERS);
  if(token){ headers['Authorization']='Bearer '+token; headers['token']=token; }
  var r = await axios.post(GOA_API+endpoint, body, { headers, timeout:12000 });
  return r.data;
}

async function getCaptcha()      { return goaPost('/Captcha',{}); }
async function loginGoa(payload) { return goaPost('/Login', payload); }

// ══════════════════════════════════════
//  BALANCE — Fixed: tries multiple endpoints & fields
// ══════════════════════════════════════
async function getBalance(token) {
  if(!token) return 0;
  const endpoints = [
    '/Member/GetUserInfo',
    '/User/GetUserInfo',
    '/User/GetInfo',
    '/Member/UserInfo',
  ];
  for(var ep of endpoints) {
    try {
      var r = await goaPost(ep, {}, token);
      if(r && r.code===0 && r.data) {
        var d = r.data;
        // Extract all possible balance fields
        var cands = [
          d.money, d.balance, d.wallet, d.mainBalance,
          d.normalBalance, d.rechargeBalance, d.totalBalance,
          d.coinBalance, d.amount, d.availableBalance,
          d.userInfo && d.userInfo.money,
          d.userInfo && d.userInfo.balance,
          d.userInfo && d.userInfo.wallet,
        ].map(v=>parseFloat(v||0)).filter(n=>!isNaN(n)&&n>=0);
        if(cands.length>0) return Math.max(...cands);
      }
    } catch(e) { /* try next */ }
  }
  return 0;
}

// ══════════════════════════════════════
//  PUBLIC WINGO HISTORY — Multi-mode support
// ══════════════════════════════════════
const PUB_URLS = [
  'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json',
  'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json',
];

async function fetchPublicList(size, modeUrl) {
  var urls = modeUrl ? [modeUrl] : PUB_URLS;
  for(var url of urls) {
    try {
      var r = await axios.get(url+'?pageNo=1&pageSize='+(size||100)+'&gameId=1&t='+Date.now(),{
        headers:{'Accept':'application/json','User-Agent':BYPASS_HEADERS['User-Agent']},
        timeout:10000,
      });
      var data = r.data && (r.data.data||r.data);
      var list = (data&&(data.list||data.issueList||data.data))||(r.data&&r.data.list)||[];
      if(Array.isArray(list)&&list.length>0) return list;
    } catch(e) { /* try next */ }
  }
  return [];
}

// ══════════════════════════════════════
//  CURRENT ISSUE — Fixed
// ══════════════════════════════════════
async function getCurrentIssue(token, modeUrl) {
  // Primary: public source (most reliable, no auth needed)
  var list = await fetchPublicList(1, modeUrl);
  if(list.length>0) {
    var last = String(list[0].issueNumber||list[0].issue||'');
    if(last&&/^\d+$/.test(last)) {
      var next = String(BigInt(last)+1n);
      // Calculate real countdown from period number
      var periodLen = 30; // default 30s
      var epochSec = Math.floor(Date.now()/1000);
      var rem = periodLen - (epochSec % periodLen);
      return { issueNumber:next, remainTime:rem };
    }
  }
  // GOA fallback
  try {
    var r = await goaPost('/WinGo/GetCurrentIssue',{typeId:TYPE_ID},token);
    if(r&&r.code===0&&r.data) {
      return {
        issueNumber: String(r.data.issueNumber||r.data.issue||''),
        remainTime: Number(r.data.countdown||r.data.remainTime||r.data.endTime||30),
      };
    }
  } catch(e) {}
  return null;
}

async function getLastResult(token, modeUrl) {
  var list = await fetchPublicList(1, modeUrl);
  if(list.length>0) return list[0];
  try {
    var r = await goaPost('/WinGo/GetIssueList',{pageNo:1,pageSize:1,typeId:TYPE_ID},token);
    if(r&&r.code===0&&r.data&&r.data.list&&r.data.list[0]) return r.data.list[0];
  } catch(e) {}
  return null;
}

async function getHistory(token, size, modeUrl) {
  var list = await fetchPublicList(size||100, modeUrl);
  if(list.length>=6) return list;
  try {
    var r = await goaPost('/WinGo/GetIssueList',{pageNo:1,pageSize:size||100,typeId:TYPE_ID},token);
    if(r&&r.code===0&&r.data&&r.data.list) return r.data.list;
  } catch(e) {}
  return list;
}

// Place bet
async function placeBet(token, issueNumber, predBS, amount) {
  var r = await goaPost('/WinGo/WinGoBet', {
    typeId      : TYPE_ID,
    issueNumber : String(issueNumber),
    betContent  : predBS==='BIG' ? 'Big' : 'Small',
    amount      : amount,
    multiple    : 1,
  }, token);
  return r;
}

async function getBetRecord(token, page) {
  return goaPost('/WinGo/GetMyGameRecordList',{pageNo:page||1,pageSize:20,typeId:TYPE_ID},token);
}

// ══════════════════════════════════════
//  PREDICTION FORMULAS (ALL 15)
// ══════════════════════════════════════

function toBS(rawList) {
  return rawList.map(item=>{
    var n=parseInt(String(item.number||item.num||'0'));
    return n>=5?'B':'S';
  });
}

var MIN_CONF=63, MIN_CONF_LOSS=72;
function shadowEngine(rawList, consecLosses) {
  var seq=toBS(rawList);
  if(seq.length<6) return {pred:'BIG',conf:55,reason:'Collecting data…',skip:false};
  var streak=1;
  for(var i=1;i<seq.length;i++){if(seq[i]===seq[0])streak++;else break;}
  var opp=seq[0]==='B'?'SMALL':'BIG';
  if(streak>=5) return {pred:opp,conf:92,reason:'L2-FIX: '+streak+'x'+seq[0]+' → reversal',skip:false};
  if(streak>=4) return {pred:opp,conf:85,reason:'L1-FIX: '+streak+'x'+seq[0]+' → reversal',skip:false};
  var V={BIG:0,SMALL:0},R=[];
  function vote(s,p,l){V[s]+=p;R.push(l+':'+s);}
  var oS=seq[0]==='B'?'SMALL':'BIG', sS=seq[0]==='B'?'BIG':'SMALL';
  if(streak>=3) vote(oS,Math.min(streak*11,44),'AntiStreak('+streak+'x'+seq[0]+')');
  else if(streak===1) vote(sS,6,'ShortContinue');
  var h5=seq.slice(0,Math.min(5,seq.length));
  if(h5.length>=5&&h5.every((v,i)=>i===0||v!==h5[i-1])) vote(oS,28,'Zigzag5');
  var L10=seq.slice(0,Math.min(10,seq.length));
  var b10=L10.filter(x=>x==='B').length, s10=L10.length-b10;
  if(b10>=7)vote('SMALL',22,'FreqBias(B'+b10+')');
  else if(s10>=7)vote('BIG',22,'FreqBias(S'+s10+')');
  else vote(b10>=s10?'BIG':'SMALL',4,'MildDom');
  if(seq.length>=4&&seq[0]===seq[1]&&seq[2]===seq[3]&&seq[0]!==seq[2]) vote(oS,18,'DblPair');
  if(seq.length>=3&&seq[0]===seq[2]&&seq[0]!==seq[1]) vote(seq[1]==='B'?'BIG':'SMALL',14,'Mirror');
  var b5=h5.filter(x=>x==='B').length,s5=h5.length-b5;
  if(b5>=4)vote('SMALL',14,'Mom5(B'+b5+')');
  else if(s5>=4)vote('BIG',14,'Mom5(S'+s5+')');
  if(seq.length>=3&&seq[0]===seq[1]&&seq[1]===seq[2]) vote(oS,20,'Triple');
  if(seq.length>=30){var L30=seq.slice(0,30);var b30=L30.filter(x=>x==='B').length,s30=L30.length-b30;if(b30>=19)vote('SMALL',10,'Trend30');else if(s30>=19)vote('BIG',10,'Trend30');}
  var total=V.BIG+V.SMALL;
  if(!total) return {pred:'BIG',conf:55,reason:'No signal',skip:false};
  var pF=V.BIG>V.SMALL?'BIG':'SMALL';
  var rawC=(V[pF]/total)*100, margin=Math.abs(V.BIG-V.SMALL);
  var conf=Math.min(95,Math.max(50,rawC+Math.min(margin*0.3,8)));
  conf=Math.round(conf*10)/10;
  var thr=consecLosses>=2?MIN_CONF_LOSS:MIN_CONF;
  return {pred:pF,conf,reason:'Shadow['+conf+'%] BIG='+V.BIG+' SMALL='+V.SMALL+' | '+R.slice(0,4).join(' | '),skip:conf<thr};
}

var GRR=['BIG','SMALL','SMALL']; var grrIdx=0;
function formulaFHaa(rawList, level) {
  var pos=grrIdx%3; var pred=GRR[pos];
  if(level>=8) pred=pred==='BIG'?'SMALL':'BIG';
  grrIdx++;
  return {pred,conf:75,reason:'FHaa-GRR pos='+(pos+1)+'/3'+(level>=8?' [L8-FLIP]':''),skip:false};
}

function formulaEIP(rawList) {
  var seq=toBS(rawList);
  if(seq.length<4) return {pred:'BIG',conf:55,reason:'EIP: collecting',skip:false};
  var bigPos=[],smallPos=[];
  seq.slice(0,20).forEach((v,i)=>{if(v==='B')bigPos.push(i);else smallPos.push(i);});
  function avgInterval(pos){
    if(pos.length<2) return 2;
    var sum=0;for(var i=1;i<pos.length;i++)sum+=pos[i]-pos[i-1];
    return sum/(pos.length-1);
  }
  var bigAvg=avgInterval(bigPos), smallAvg=avgInterval(smallPos);
  var lastBig=bigPos[0]||999, lastSmall=smallPos[0]||999;
  var bigDue=(lastBig/bigAvg), smallDue=(lastSmall/smallAvg);
  var pred=bigDue>=smallDue?'BIG':'SMALL';
  var conf=Math.min(85,55+Math.abs(bigDue-smallDue)*10);
  return {pred,conf:Math.round(conf),reason:'EIP: bigDue='+bigDue.toFixed(2)+' smallDue='+smallDue.toFixed(2),skip:conf<55};
}

function formulaZigzag(rawList) {
  var seq=toBS(rawList);
  if(!seq.length) return {pred:'BIG',conf:60,reason:'Zigzag: default',skip:false};
  var realPred=seq[0]==='B'?'SMALL':'BIG';
  return {pred:realPred,conf:62,reason:'Zigzag: flip from '+seq[0],skip:false};
}

function formulaOracle(rawList) {
  var seq=toBS(rawList);
  if(seq.length<5) return formulaZigzag(rawList);
  var recent=seq.slice(0,10);
  var bigCount=recent.filter(x=>x==='B').length;
  var ratio=bigCount/recent.length;
  if(ratio>0.65) return {pred:'SMALL',conf:72,reason:'Oracle: BIG heavy ('+bigCount+'/10)',skip:false};
  if(ratio<0.35) return {pred:'BIG',conf:72,reason:'Oracle: SMALL heavy ('+(10-bigCount)+'/10)',skip:false};
  return formulaZigzag(rawList);
}

function formulaKaala(rawList) {
  var seq=toBS(rawList);
  if(seq.length<3) return {pred:'BIG',conf:60,reason:'Kaala: default',skip:false};
  var streak=1;
  for(var i=1;i<seq.length;i++){if(seq[i]===seq[0])streak++;else break;}
  if(streak>=4) {
    var opp=seq[0]==='B'?'SMALL':'BIG';
    return {pred:opp,conf:80,reason:'Kaala: '+streak+'x streak → reverse',skip:false};
  }
  return formulaOracle(rawList);
}

function formulaDna3(rawList) {
  var seq=toBS(rawList);
  if(seq.length<3) return {pred:'BIG',conf:60,reason:'DNA3: default',skip:false};
  var triplet=seq.slice(0,3).join('-');
  var patterns={
    'B-B-B':'SMALL','S-S-S':'BIG',
    'B-S-B':'SMALL','S-B-S':'BIG',
    'B-B-S':'BIG','S-S-B':'SMALL',
    'B-S-S':'BIG','S-B-B':'SMALL',
  };
  var pred=patterns[triplet];
  if(pred) return {pred,conf:70,reason:'DNA3: pattern '+triplet+'→'+pred,skip:false};
  return formulaZigzag(rawList);
}

function formulaTitan(rawList, consecLosses) {
  var seq=toBS(rawList);
  if(seq.length<3) return {pred:'BIG',conf:60,reason:'Titan: default',skip:false};
  if(consecLosses>=3) {
    var opp=seq[0]==='B'?'SMALL':'BIG';
    return {pred:opp,conf:78,reason:'Titan: Recovery after '+consecLosses+' losses',skip:false};
  }
  return formulaOracle(rawList);
}

function formulaKingpin3(rawList) {
  var seq=toBS(rawList);
  if(seq.length<2) return {pred:'BIG',conf:60,reason:'KP3: default',skip:false};
  var last=seq.slice(0,2);
  var votes=0;
  if(last[0]==='B') votes++;
  if(last[1]==='S') votes++;
  if((last[0]==='B')===(last[1]==='B')) votes++;
  var streak=1;
  for(var i=1;i<seq.length;i++){if(seq[i]===seq[0])streak++;else break;}
  if(streak>=3) votes++;
  var pred=votes>=2?'BIG':'SMALL';
  return {pred,conf:65,reason:'KP3: votes='+votes+'/4 streak='+streak,skip:false};
}

function formulaN1N2(rawList) {
  var nums=rawList.slice(0,10).map(item=>parseInt(String(item.number||0)));
  if(nums.length<3) return {pred:'BIG',conf:58,reason:'N1N2: default',skip:false};
  var sum=nums.slice(0,3).reduce((a,b)=>a+b,0);
  var avg=sum/3;
  var pred=avg>=5?'BIG':'SMALL';
  return {pred,conf:62,reason:'N1N2: avg3='+avg.toFixed(1),skip:false};
}

function formulaHacksoon(rawList) {
  var seq=toBS(rawList);
  if(seq.length<5) return {pred:'BIG',conf:60,reason:'Hacksoon: default',skip:false};
  var streak=1;
  for(var i=1;i<seq.length;i++){if(seq[i]===seq[0])streak++;else break;}
  var zigzag=seq.slice(0,4).every((v,i)=>i===0||v!==seq[i-1]);
  if(zigzag) {
    var pred=seq[0]==='B'?'SMALL':'BIG';
    return {pred,conf:74,reason:'Hacksoon: Zigzag detected → '+pred,skip:false};
  }
  if(streak>=3) {
    var opp=seq[0]==='B'?'SMALL':'BIG';
    return {pred:opp,conf:72,reason:'Hacksoon: streak '+streak+' → '+opp,skip:false};
  }
  return formulaOracle(rawList);
}

function formulaKubera(rawList) {
  var seq=toBS(rawList);
  if(seq.length<5) return {pred:'BIG',conf:60,reason:'Kubera: default',skip:false};
  var score=0;
  var weights=[5,4,3,2,1];
  seq.slice(0,5).forEach((v,i)=>{score+=v==='B'?weights[i]:-weights[i];});
  var pred=score>0?'BIG':'SMALL';
  var conf=Math.min(85,55+Math.abs(score)*2);
  return {pred,conf:Math.round(conf),reason:'Kubera: score='+score,skip:conf<55};
}

function formulaItachi(rawList) {
  var seq=toBS(rawList);
  if(seq.length<6) return {pred:'BIG',conf:60,reason:'Itachi: default',skip:false};
  var last3=seq.slice(0,3);
  var bigIn3=last3.filter(x=>x==='B').length;
  var streak=1;
  for(var i=1;i<seq.length;i++){if(seq[i]===seq[0])streak++;else break;}
  if(streak>=4) return {pred:seq[0]==='B'?'SMALL':'BIG',conf:82,reason:'Itachi: long streak '+streak+' reversal',skip:false};
  var pred=bigIn3>=2?'BIG':'SMALL';
  var conf=streak>=2?70:63;
  return {pred,conf,reason:'Itachi: big3='+bigIn3+'/3 streak='+streak,skip:false};
}

function formulaZN1P(rawList) {
  var nums=rawList.slice(0,10).map(item=>parseInt(String(item.number||0)));
  if(nums.length<3) return {pred:'BIG',conf:60,reason:'ZN1P: default',skip:false};
  var zeros=nums.filter(n=>n===0||n===5).length;
  var nonzeros=nums.length-zeros;
  var last=nums[0];
  if(zeros>nonzeros) {
    return {pred:last>=5?'SMALL':'BIG',conf:68,reason:'ZN1P: boundary heavy → opposite',skip:false};
  }
  return {pred:last>=5?'BIG':'SMALL',conf:63,reason:'ZN1P: follow trend',skip:false};
}

function formulaKutty(rawList) {
  var seq=toBS(rawList);
  if(seq.length<4) return {pred:'BIG',conf:60,reason:'Kutty: default',skip:false};
  var bigCount=seq.slice(0,4).filter(x=>x==='B').length;
  var pred=bigCount>=3?'BIG':bigCount<=1?'SMALL':seq[0]==='B'?'SMALL':'BIG';
  return {pred,conf:65,reason:'Kutty: big4='+bigCount+'/4',skip:false};
}

// ── NEW: SUM Formula ──
function formulaSum(rawList) {
  // Uses next issue number from rawList[0]
  if(!rawList||!rawList.length) return {pred:'BIG',conf:60,reason:'SUM: no data',skip:false};
  var lastIssue = String(rawList[0].issueNumber||rawList[0].issue||'0');
  var nextIssue = String(BigInt(lastIssue)+1n);
  var s = nextIssue;
  if(s.length<5) return {pred:'BIG',conf:60,reason:'SUM: short period',skip:false};
  var last5 = s.slice(-5);
  var sum = last5.split('').reduce((a,c)=>a+parseInt(c),0);
  var division = sum/3;
  var lastDigit = Math.floor(division)%10;
  var pred = lastDigit<=4?'BIG':'SMALL';
  return {pred,conf:72,reason:'SUM: '+last5+'→'+sum+'÷3='+division.toFixed(2)+'→['+lastDigit+']→'+pred,skip:false};
}

const FORMULA_INFO = {
  shadow  : { name:'⚡ Shadow Adaptive v14.0' },
  FHaa    : { name:'🔁 FHaa (GRR Loop)' },
  eip     : { name:'🤖 EIP (Interval Pattern)' },
  zigzag  : { name:'⚡ ZigZag' },
  oracle  : { name:'🔮 ORACLE' },
  kaala   : { name:'🕶️ Kaala' },
  dna3    : { name:'🧬 DNA 3' },
  titan_v3: { name:'⚡ TITAN v3' },
  kingpin3: { name:'👑 KINGPIN 3.0' },
  n1n2    : { name:'🎲 N1/N2' },
  hacksoon: { name:'🔮 Hacksoon' },
  kubera  : { name:'💰 Kubera v2' },
  itachi  : { name:'🔥 Itachi V30' },
  zn1p    : { name:'🗳️ ZN1P' },
  kutty   : { name:'⭐ KUTTY' },
  sum     : { name:'∑ SUM Formula' },
};

function runFormula(formulaKey, rawList, level, consecLosses) {
  try {
    switch(formulaKey) {
      case 'shadow'  : return shadowEngine(rawList, consecLosses||0);
      case 'FHaa'    : return formulaFHaa(rawList, level||1);
      case 'eip'     : return formulaEIP(rawList);
      case 'zigzag'  : return formulaZigzag(rawList);
      case 'oracle'  : return formulaOracle(rawList);
      case 'kaala'   : return formulaKaala(rawList);
      case 'dna3'    : return formulaDna3(rawList);
      case 'titan_v3': return formulaTitan(rawList, consecLosses||0);
      case 'kingpin3': return formulaKingpin3(rawList);
      case 'n1n2'    : return formulaN1N2(rawList);
      case 'hacksoon': return formulaHacksoon(rawList);
      case 'kubera'  : return formulaKubera(rawList);
      case 'itachi'  : return formulaItachi(rawList);
      case 'zn1p'    : return formulaZN1P(rawList);
      case 'kutty'   : return formulaKutty(rawList);
      case 'sum'     : return formulaSum(rawList);
      default        : return shadowEngine(rawList, consecLosses||0);
    }
  } catch(e) {
    return {pred:'BIG',conf:60,reason:'Error: '+e.message,skip:false};
  }
}

// ══════════════════════════════════════
//  MARTINGALE
// ══════════════════════════════════════
function buildLevels(base, max) {
  var lvls=[base];
  for(var i=1;i<max;i++) lvls.push(Math.round(lvls[i-1]*2));
  return lvls;
}

// ══════════════════════════════════════
//  ACCOUNT STATE
// ══════════════════════════════════════
function makeState(phone) {
  return {
    phone, lotteryToken:'', webapiToken:'', pwd:'',
    engine:'stopped', balance:0, wins:0, losses:0, pnl:0,
    level:1, highestLevel:1,
    formula:'shadow', formulaInfo:FORMULA_INFO.shadow,
    baseAmt:2, maxLevel:10, levels:buildLevels(2,10),
    watchEnabled:false, watchLossTarget:1, watchCount:0,
    history:[], betHistory:[], predHistory:[], logs:[],
    currentIssue:null, prediction:null, sessionStart:null,
    loggedIn:true, _interval:null, consecLosses:0,
    modeUrl: PUB_URLS[0],
  };
}

// ══════════════════════════════════════
//  EXPRESS + SOCKET.IO
// ══════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{origin:'*'} });

app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.post('/api/goa/captcha', async (req,res) => {
  try { res.json(await getCaptcha()); }
  catch(e) { res.json({code:-1,msg:e.message}); }
});

app.post('/api/goa/login', async (req,res) => {
  try { res.json(await loginGoa(req.body)); }
  catch(e) { res.json({code:-1,msg:e.message}); }
});

// Balance API endpoint (direct call)
app.post('/api/balance', async (req,res) => {
  var token = req.body.token;
  if(!token) return res.json({code:-1,msg:'No token'});
  try {
    var bal = await getBalance(token);
    res.json({code:0,balance:bal});
  } catch(e) { res.json({code:-1,msg:e.message,balance:0}); }
});

// Formula list endpoint
app.get('/api/formulas', (req,res) => {
  res.json(FORMULA_INFO);
});

// ── SOCKET.IO ─────────────────────────
io.on('connection', socket => {
  console.log('[KP] Connected:', socket.id);
  var viewPhone = null;

  socket.on('auth', async d => {
    var phone = d.phone; if(!phone) return;
    if(!accounts[phone]) accounts[phone]=makeState(phone);
    var st = accounts[phone];
    st.lotteryToken = d.lotteryToken||st.lotteryToken;
    st.webapiToken  = d.webapiToken||st.webapiToken;
    st.pwd          = d.pwd||st.pwd;
    st.loggedIn     = true;
    viewPhone = phone;
    socket.join('acct:'+phone);

    // ✅ Fixed: fetch balance with retry
    try {
      var bal = await getBalance(st.webapiToken||st.lotteryToken);
      st.balance = bal;
    } catch(e){ st.balance=0; }

    emitState(phone, socket);
    broadcastAccountList();
  });

  socket.on('switchView', d => {
    if(!d||!d.phone) return;
    viewPhone = d.phone;
    socket.join('acct:'+d.phone);
    emitState(d.phone, socket);
  });

  socket.on('start', async d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    if(st.engine!=='stopped') return;
    st.engine='running'; st.sessionStart=Date.now();
    st.consecLosses=0; st.watchCount=0;
    log(phone,'▶ Engine started','ok');
    emitState(phone); broadcastAccountList();
    startEngine(phone);
  });

  socket.on('stop', d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    st.engine='stopped';
    if(st._interval){clearInterval(st._interval);st._interval=null;}
    log(phone,'■ Engine stopped','warn');
    emitState(phone); broadcastAccountList();
  });

  socket.on('logout', d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    if(st._interval){clearInterval(st._interval);st._interval=null;}
    delete accounts[phone];
    io.emit('accountRemoved',{phone});
    broadcastAccountList();
  });

  socket.on('resetStats', d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    st.wins=0; st.losses=0; st.pnl=0; st.level=1; st.highestLevel=1;
    st.betHistory=[]; st.predHistory=[]; st.consecLosses=0;
    st.sessionStart=Date.now();
    emitState(phone);
  });

  socket.on('setFormula', d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    st.formula = d.formula||'shadow';
    st.formulaInfo = FORMULA_INFO[st.formula]||{name:st.formula};
    if(st.formula==='FHaa') grrIdx=0;
    log(phone,'🧠 Formula: '+(st.formulaInfo.name),'info');
    emitState(phone);
    // ✅ Immediately emit updated formulaInfo to UI
    io.to('acct:'+phone).emit('formulaChanged',{formula:st.formula,formulaInfo:st.formulaInfo});
  });

  socket.on('setLevels', d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    if(d.custom&&Array.isArray(d.custom)){
      st.levels=d.custom; st.maxLevel=d.custom.length; st.baseAmt=d.custom[0]||2;
    } else {
      st.baseAmt=d.baseAmt||st.baseAmt; st.maxLevel=d.maxLevel||st.maxLevel;
      st.levels=buildLevels(st.baseAmt,st.maxLevel);
    }
    st.level=1; emitState(phone);
  });

  socket.on('setWatch', d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    st.watchEnabled=d.enabled; st.watchLossTarget=d.count||1;
    emitState(phone);
  });

  socket.on('getBetRecord', async d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    try {
      var result=await getBetRecord(st.webapiToken||st.lotteryToken, d.page||1);
      socket.emit('betRecord',{result,page:d.page||1});
    } catch(e) {
      socket.emit('betRecord',{result:{code:-1,msg:e.message},page:1});
    }
  });

  // ✅ Fixed: CSV export — fetch from public API properly
  socket.on('exportHistory', async d => {
    var phone=d&&d.phone;
    var total=d&&d.totalRecords||500;
    if(!phone||!accounts[phone]){
      socket.emit('exportHistoryResult',{ok:false,list:[],msg:'Account not found'});
      return;
    }
    var st = accounts[phone];
    var all=[];
    var pageSize=100;
    var maxPages=Math.ceil(total/pageSize);

    for(var page=1;page<=maxPages;page++){
      socket.emit('exportHistoryProgress',{page,maxPages,total:all.length});
      try {
        // Fetch from public URL — no auth needed
        var r = await axios.get(
          (st.modeUrl||PUB_URLS[0])+'?pageNo='+page+'&pageSize='+pageSize+'&gameId=1&t='+Date.now(),
          { headers:{'Accept':'application/json','User-Agent':BYPASS_HEADERS['User-Agent']}, timeout:10000 }
        );
        var data = r.data&&(r.data.data||r.data);
        var list = (data&&(data.list||data.issueList))||(r.data&&r.data.list)||[];
        if(Array.isArray(list)&&list.length>0) {
          all=all.concat(list);
        } else {
          break; // No more data
        }
      } catch(e){
        socket.emit('exportHistoryProgress',{page,maxPages,total:all.length,error:e.message});
      }
      if(all.length>=total) break;
      await new Promise(r=>setTimeout(r,300));
    }

    // Format for CSV
    var formatted = all.slice(0,total).map(item=>{
      var num = parseInt(item.number||item.num||0);
      return {
        issueNumber: item.issueNumber||item.issue||'',
        number: num,
        bigSmall: num>=5?'BIG':'SMALL',
        color: num===0||num===5?'Violet':(num%2===0?'Red':'Green'),
        time: item.startTime||item.time||'',
      };
    });

    socket.emit('exportHistoryResult',{ok:true,list:formatted,total:formatted.length});
  });

  // ✅ Balance refresh on demand
  socket.on('refreshBalance', async d => {
    var phone=d&&d.phone; if(!phone||!accounts[phone]) return;
    var st=accounts[phone];
    try {
      st.balance = await getBalance(st.webapiToken||st.lotteryToken);
    } catch(e){ }
    socket.emit('balanceUpdate',{phone,balance:st.balance});
    broadcastAccountList();
  });

  socket.on('disconnect', ()=>{console.log('[KP] Disconnected:',socket.id);});
});

// ══════════════════════════════════════
//  ENGINE LOOP — Fixed
// ══════════════════════════════════════
async function startEngine(phone) {
  var st=accounts[phone]; if(!st) return;
  var lastIssue=null, pendingBet=null;

  async function tick() {
    if(!accounts[phone]||st.engine!=='running') return;
    try {
      var token=st.webapiToken||st.lotteryToken;
      var issue=await getCurrentIssue(token, st.modeUrl);
      if(!issue||!issue.issueNumber) return;

      var issueNo  = String(issue.issueNumber||'');
      var countdown= parseInt(issue.remainTime||30);

      io.to('acct:'+phone).emit('countdown',{secs:countdown,total:30});

      // ✅ New period detected → check last result
      if(lastIssue && issueNo!==lastIssue) {
        await new Promise(r=>setTimeout(r,2500));
        var lastResult=await getLastResult(token, st.modeUrl);
        if(lastResult) {
          var resultIss = String(lastResult.issueNumber||lastResult.issue||'');
          var num=parseInt(lastResult.number||lastResult.num||0);
          var bs=num>=5?'BIG':'SMALL';

          st.history.push({issue:lastIssue,number:num,bs});
          if(st.history.length>200) st.history=st.history.slice(-200);

          if(pendingBet && String(pendingBet.issue)===String(lastIssue)) {
            var won=pendingBet.pred===bs;
            var pnl=won?+(pendingBet.amount*0.95).toFixed(2):-pendingBet.amount;
            if(won) {
              st.wins++; st.pnl+=pnl; st.level=1; st.consecLosses=0;
              log(phone,'✅ WIN  #'+String(lastIssue).slice(-5)+'  '+bs+'  +₹'+pnl.toFixed(2),'win');
              io.to('acct:'+phone).emit('betStatus',{cls:'win',icon:'✅',label:'WIN!',detail:pendingBet.pred+'  +₹'+pnl.toFixed(2),bar:100});
              io.to('acct:'+phone).emit('toast',{title:'✅ WIN',msg:'+₹'+pnl.toFixed(2),type:'success'});
            } else {
              st.losses++; st.pnl-=pendingBet.amount; st.consecLosses++;
              st.level=Math.min(st.level+1,st.maxLevel);
              if(st.level>st.highestLevel) st.highestLevel=st.level;
              log(phone,'❌ LOSS #'+String(lastIssue).slice(-5)+'  '+pendingBet.pred+' → '+bs+'  -₹'+pendingBet.amount,'loss');
              io.to('acct:'+phone).emit('betStatus',{cls:'loss',icon:'❌',label:'LOSS',detail:pendingBet.pred+' → '+bs+'  -₹'+pendingBet.amount,bar:0});
              io.to('acct:'+phone).emit('toast',{title:'❌ LOSS',msg:'-₹'+pendingBet.amount,type:'error'});
            }
            st.betHistory.unshift({issue:lastIssue,pred:pendingBet.pred,level:pendingBet.level,amount:pendingBet.amount,won,pnl});
            if(st.betHistory.length>100) st.betHistory=st.betHistory.slice(0,100);
            var ph=st.predHistory.find(p=>String(p.forIssue)===String(lastIssue));
            if(ph){ph.result=bs;ph.correct=won;}
            pendingBet=null;

            if(st.level>st.maxLevel) {
              st.engine='stopped';
              if(st._interval){clearInterval(st._interval);st._interval=null;}
              io.to('acct:'+phone).emit('maxLevel',{msg:'All levels exhausted. Restart to continue.'});
              log(phone,'🚨 MAX LEVEL — engine stopped','warn');
              emitState(phone); broadcastAccountList(); return;
            }
            // ✅ Refresh balance after result
            try{st.balance=await getBalance(token);}catch(e){}
            emitState(phone); broadcastAccountList();
          }
        }
      }

      // ✅ New issue → predict & bet
      if(issueNo!==lastIssue) {
        lastIssue=issueNo;
        var rawHistory=await getHistory(token,100,st.modeUrl);

        // ✅ Always run formula — no skip due to empty data
        if(rawHistory.length===0) {
          log(phone,'⚠️ No history data yet, retrying...','warn');
          return;
        }

        var eng=runFormula(st.formula, rawHistory, st.level, st.consecLosses);
        var predBS=eng.pred, predConf=eng.conf, predReason=eng.reason, skip=eng.skip;

        st.prediction={pred:predBS,conf:predConf,forIssue:issueNo,formula:st.formula,log:predReason};
        st.predHistory.unshift({forIssue:issueNo,pred:predBS,formula:st.formula,conf:predConf,reason:predReason});
        if(st.predHistory.length>100) st.predHistory=st.predHistory.slice(0,100);

        // ✅ Always emit prediction to UI (even if skip)
        emitState(phone);

        if(skip) {
          log(phone,'⏸ SKIP #'+issueNo.slice(-5)+' conf='+predConf+'% < threshold','warn');
          io.to('acct:'+phone).emit('betStatus',{cls:'watch',icon:'⏸',label:'SKIP',detail:'Confidence '+predConf+'% below threshold',bar:0});
          return;
        }

        log(phone,'🔮 #'+issueNo.slice(-5)+' → '+predBS+' ['+predConf+'%] '+st.formula+' LV'+st.level,'info');

        // Watch mode
        if(st.watchEnabled && st.watchCount<st.watchLossTarget) {
          st.watchCount++;
          log(phone,'👁️ Watch ('+st.watchCount+'/'+st.watchLossTarget+') — skip real bet','warn');
          io.to('acct:'+phone).emit('betStatus',{cls:'watch',icon:'👁️',label:'WATCHING',detail:'Watch '+st.watchCount+'/'+st.watchLossTarget,bar:Math.round(st.watchCount/st.watchLossTarget*100)});
          return;
        }
        st.watchCount=0;

        if(countdown>5) {
          var amount=st.levels[st.level-1]||st.baseAmt;
          io.to('acct:'+phone).emit('betStatus',{cls:'betting',icon:'💰',label:'BETTING LV'+st.level,detail:predBS+'  ₹'+amount+'  ['+predConf+'%]',bar:60,timer:countdown+'s'});
          try {
            var betResult=await placeBet(token,issueNo,predBS,amount);
            if(betResult&&betResult.code===0) {
              pendingBet={issue:issueNo,pred:predBS,amount,level:st.level};
              log(phone,'💰 BET: '+predBS+' ₹'+amount+' LV'+st.level+' #'+issueNo.slice(-5),'ok');
              io.to('acct:'+phone).emit('betStatus',{cls:'placed',icon:'✅',label:'BET PLACED',detail:predBS+'  ₹'+amount+'  LV'+st.level,bar:100});
            } else {
              var errMsg=(betResult&&betResult.msg)||'unknown';
              log(phone,'⚠️ Bet failed: '+errMsg,'warn');
              io.to('acct:'+phone).emit('betStatus',{cls:'loss',icon:'⚠️',label:'BET FAILED',detail:errMsg,bar:0});
            }
          } catch(e) { log(phone,'⚠️ Bet error: '+e.message,'warn'); }
          emitState(phone);
        }
      }
    } catch(err) { log(phone,'⚠️ Tick: '+err.message,'warn'); }
  }

  st._interval=setInterval(tick,3000);
  tick();
}

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
function log(phone,msg,cls) {
  var st=accounts[phone]; if(!st) return;
  var t=new Date().toLocaleTimeString('en-IN',{hour12:false});
  var entry={t,msg,cls:cls||'info'};
  st.logs.unshift(entry); if(st.logs.length>100) st.logs=st.logs.slice(0,100);
  io.to('acct:'+phone).emit('log',entry);
}

function emitState(phone,target) {
  var st=accounts[phone]; if(!st) return;
  var snap={
    phone, engine:st.engine, balance:st.balance, wins:st.wins, losses:st.losses, pnl:st.pnl,
    level:st.level, highestLevel:st.highestLevel, formula:st.formula, formulaInfo:st.formulaInfo,
    levels:st.levels, watchEnabled:st.watchEnabled, watchLossTarget:st.watchLossTarget,
    betHistory:st.betHistory, predHistory:st.predHistory, prediction:st.prediction,
    loggedIn:st.loggedIn, sessionElapsed:st.sessionStart?Date.now()-st.sessionStart:0,
    formulaList: FORMULA_INFO,
  };
  if(target){target.emit('state',snap);target.emit('logs',st.logs);}
  else io.to('acct:'+phone).emit('state',snap);
}

function broadcastAccountList() {
  var list=Object.values(accounts).map(st=>({phone:st.phone,engine:st.engine,balance:st.balance,pnl:st.pnl}));
  io.emit('accountList',list);
}

server.listen(PORT,'0.0.0.0',()=>console.log('[KINGPIN 3.0] Port '+PORT));
