const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 6e6,
  cors: { origin: true, credentials: true }
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'local-data'));
const DATA_FILE = path.join(DATA_DIR, 'game-state.json');
const DEFAULT_ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 20);
const COUNTDOWN_MS = 3000;
const APP_VERSION = '3.0.0';

const DIFFICULTY_CATEGORIES = {
  easy:      { key:'easy',      label:'Facile',         emoji:'🟢', points:2 },
  medium:    { key:'medium',    label:'Moyen',          emoji:'🔵', points:5 },
  hard:      { key:'hard',      label:'Difficile',      emoji:'🟡', points:10 },
  very_hard: { key:'very_hard', label:'Très difficile', emoji:'🔴', points:15 },
  hc:        { key:'hc',        label:'Hors catégorie', emoji:'⚫', points:20 }
};

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '6mb' }));
app.get('/version', (_, res) => res.json({
  version: APP_VERSION,
  selectiveRecolor: true,
  tours: true,
  customColorPicker: true,
  finalPodium: true
}));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

function uid(prefix = '') { return prefix + crypto.randomBytes(6).toString('hex'); }
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function sanitizeName(name, max = 40) { return String(name || '').trim().slice(0, max).replace(/[<>]/g, ''); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n) || 0)); }

function defaultState() {
  return {
    roomCode: roomCode(),
    logos: [],
    tours: [],
    players: {},
    activeRound: null,
    activeTour: null,
    lastTourSummary: null,
    roundHistory: [],
    settings: { roundSeconds: DEFAULT_ROUND_SECONDS, resultDelaySeconds: 10 },
    createdAt: Date.now()
  };
}

function categoryFromLegacyPoints(points) {
  const n = Number(points) || 5;
  if (n <= 3) return 'easy';
  if (n <= 7) return 'medium';
  if (n <= 12) return 'hard';
  if (n <= 17) return 'very_hard';
  return 'hc';
}
function normalizeLogo(l) {
  const categoryKey = DIFFICULTY_CATEGORIES[l?.difficultyCategory] ? l.difficultyCategory : categoryFromLegacyPoints(l?.difficultyPoints);
  const cat = DIFFICULTY_CATEGORIES[categoryKey];
  return {
    ...l,
    id: l?.id || uid('l_'),
    colorTolerance: Number(l?.colorTolerance) || 42,
    difficultyMode: l?.difficultyMode === 'auto' || DIFFICULTY_CATEGORIES[l?.difficultyMode] ? l.difficultyMode : categoryKey,
    difficultyScore: clamp(Number(l?.difficultyScore) || Math.round((Number(l?.difficultyPoints) || cat.points) / 2), 1, 10),
    difficultyCategory: categoryKey,
    difficultyPoints: cat.points,
    notoriety: l?.notoriety || 'known',
    colorImportance: l?.colorImportance || 'secondary',
    colorDistinctiveness: l?.colorDistinctiveness || 'distinctive',
    targetAreaRatio: clamp(Number(l?.targetAreaRatio) || 0, 0, 1)
  };
}
function normalizeTour(t) {
  return {
    id: t?.id || uid('t_'),
    name: sanitizeName(t?.name || 'Tour sans nom', 50),
    logoIds: Array.isArray(t?.logoIds) ? t.logoIds.filter(Boolean) : [],
    createdAt: Number(t?.createdAt) || Date.now(),
    updatedAt: Number(t?.updatedAt) || Date.now()
  };
}
function historyDurationMs(h, settings) {
  return Math.max(0, Number(h?.durationMs) || (Number(settings?.roundSeconds) || DEFAULT_ROUND_SECONDS) * 1000);
}
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      loaded.activeRound = null;
      loaded.activeTour = null; // un déploiement ne reprend jamais un chrono/tour en cours
      loaded.settings ||= { roundSeconds: DEFAULT_ROUND_SECONDS, resultDelaySeconds: 10 };
      loaded.settings.resultDelaySeconds = clamp(loaded.settings.resultDelaySeconds || 10, 5, 30);
      loaded.logos = (loaded.logos || []).map(normalizeLogo);
      loaded.tours = (loaded.tours || []).map(normalizeTour);
      loaded.roundHistory ||= [];
      loaded.players ||= {};
      loaded.lastTourSummary ||= null;
      const totalDuration = loaded.roundHistory.reduce((sum, h) => sum + historyDurationMs(h, loaded.settings), 0);
      Object.values(loaded.players).forEach(p => {
        p.yellowTotal = Number(p.yellowTotal) || 0;
        p.yellowCount = Number(p.yellowCount) || 0;
        p.greenTime = Number(p.greenTime) || 0;
        p.mountainPoints = Number(p.mountainPoints) || 0;
        p.participatedDurationMs = Number.isFinite(Number(p.participatedDurationMs))
          ? Number(p.participatedDurationMs) || 0
          : Math.min(totalDuration, p.yellowCount * (Number(loaded.settings.roundSeconds) || DEFAULT_ROUND_SECONDS) * 1000);
      });
      return loaded;
    }
  } catch (e) { console.error('Unable to load state:', e); }
  return defaultState();
}

let state = loadState();
let roundTimer = null;
let autoTimer = null;

function saveState() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function clearTimers() {
  if (roundTimer) clearTimeout(roundTimer);
  if (autoTimer) clearTimeout(autoTimer);
  roundTimer = null;
  autoTimer = null;
}
function totalCompletedDurationMs() {
  return state.roundHistory.reduce((sum, h) => sum + historyDurationMs(h, state.settings), 0);
}
function publicPlayer(p) {
  const totalRounds = state.roundHistory.length;
  const minRounds = totalRounds ? Math.ceil(totalRounds * 0.5) : 0;
  const playedRounds = Number(p.yellowCount) || 0;
  const qualified = totalRounds === 0 || playedRounds >= minRounds;
  const totalDuration = totalCompletedDurationMs();
  const participatedDuration = Math.max(0, Number(p.participatedDurationMs) || 0);
  const missedDuration = Math.max(0, totalDuration - participatedDuration);
  const greenAdjusted = (Number(p.greenTime) || 0) + missedDuration;
  return {
    id: p.id, name: p.name, online: !!p.online,
    yellowAvg: playedRounds ? (Number(p.yellowTotal) || 0) / playedRounds : 0,
    yellowCount: playedRounds, playedRounds, totalRounds, minRounds, qualified,
    greenTime: Number(p.greenTime) || 0, greenAdjusted,
    mountainPoints: Number(p.mountainPoints) || 0,
    lastAnswer: p.lastAnswer || null
  };
}
function standings() {
  const players = Object.values(state.players).map(publicPlayer);
  const qualificationSort = (a, b) => Number(b.qualified) - Number(a.qualified);
  return {
    yellow: [...players].sort((a,b) => qualificationSort(a,b) || b.yellowAvg - a.yellowAvg || a.greenAdjusted - b.greenAdjusted),
    green: [...players].sort((a,b) => qualificationSort(a,b) || a.greenAdjusted - b.greenAdjusted || b.yellowAvg - a.yellowAvg),
    polka: [...players].sort((a,b) => b.mountainPoints - a.mountainPoints || b.yellowAvg - a.yellowAvg)
  };
}
function publicTour(t) {
  return { id:t.id, name:t.name, logoIds:[...t.logoIds], logoCount:t.logoIds.length, createdAt:t.createdAt, updatedAt:t.updatedAt };
}
function activeTourPublic() {
  if (!state.activeTour) return null;
  const t = state.activeTour;
  const nextLogoId = t.logoIds[t.currentIndex] || null;
  const nextLogo = state.logos.find(l => l.id === nextLogoId);
  return {
    sessionId:t.sessionId, tourId:t.tourId, name:t.name,
    currentIndex:t.currentIndex, completedStages:t.completedStages || 0,
    totalStages:t.logoIds.length, autoAdvance:!!t.autoAdvance,
    resultDelaySeconds:t.resultDelaySeconds, roundSeconds:t.roundSeconds,
    startedAt:t.startedAt, nextLogoId, nextLogoName:nextLogo?.name || null
  };
}
function basicSnapshot() {
  return {
    roomCode: state.roomCode,
    players: Object.values(state.players).map(publicPlayer),
    standings: standings(),
    completedRounds: state.roundHistory.length,
    activeTour: activeTourPublic(),
    lastTourSummary: state.lastTourSummary,
    activeRound: state.activeRound ? {
      id: state.activeRound.id, logoId: state.activeRound.logoId,
      logoName: state.activeRound.logoName, logoImage: state.activeRound.logoImage,
      targetColor: state.activeRound.targetColor,
      colorTolerance: state.activeRound.colorTolerance || 42,
      difficultyCategory: state.activeRound.difficultyCategory,
      difficultyLabel: state.activeRound.difficultyLabel,
      difficultyEmoji: state.activeRound.difficultyEmoji,
      difficultyPoints: state.activeRound.difficultyPoints,
      roundNumber: state.activeRound.roundNumber,
      tourName: state.activeRound.tourName || null,
      tourStageNumber: state.activeRound.tourStageNumber || null,
      tourStageCount: state.activeRound.tourStageCount || null,
      participantIds: state.activeRound.participantIds || [],
      participantCount: (state.activeRound.participantIds || []).length,
      answeredPlayerIds: Object.keys(state.activeRound.answers || {}),
      startedAt: state.activeRound.startedAt, endsAt: state.activeRound.endsAt,
      durationSeconds: state.activeRound.durationSeconds,
      answerCount: Object.keys(state.activeRound.answers || {}).length
    } : null,
    settings: state.settings
  };
}
function adminSnapshot() {
  return {
    ...basicSnapshot(),
    logos: state.logos.map(l => ({ ...l })),
    tours: state.tours.map(publicTour),
    roundHistory: state.roundHistory.slice(-50).reverse()
  };
}
function emitState() {
  io.emit('state', basicSnapshot());
  io.to('admins').emit('admin-state', adminSnapshot());
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}
function rgbToLab({r,g,b}) {
  let R = r/255, G = g/255, B = b/255;
  R = R > .04045 ? Math.pow((R+.055)/1.055,2.4) : R/12.92;
  G = G > .04045 ? Math.pow((G+.055)/1.055,2.4) : G/12.92;
  B = B > .04045 ? Math.pow((B+.055)/1.055,2.4) : B/12.92;
  let x=(R*.4124+G*.3576+B*.1805)/.95047, y=(R*.2126+G*.7152+B*.0722), z=(R*.0193+G*.1192+B*.9505)/1.08883;
  const f=v=>v>.008856?Math.pow(v,1/3):(7.787*v)+16/116;
  x=f(x);y=f(y);z=f(z);
  return {L:116*y-16,a:500*(x-y),b:200*(y-z)};
}
function proximityPct(aHex,bHex) {
  const a=hexToRgb(aHex), b=hexToRgb(bHex); if(!a||!b) return 0;
  const la=rgbToLab(a), lb=rgbToLab(b);
  const dE=Math.sqrt((la.L-lb.L)**2+(la.a-lb.a)**2+(la.b-lb.b)**2);
  return Math.max(0,Math.min(100,100-dE));
}
function isValidDataImage(src) {
  return typeof src === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(src) && src.length < 3_000_000;
}
function areaDifficultyScore(ratio) {
  const r=clamp(ratio,0,1); if(r>.40)return 0;if(r>.15)return 1;if(r>.05)return 2;return 3;
}
function computeDifficulty(payload={}) {
  const notorietyScore={huge:0,known:1,lesser:2,niche:3}[payload.notoriety]??1;
  const importanceScore={main:0,secondary:1,accent:2}[payload.colorImportance]??1;
  const distinctivenessScore={iconic:0,distinctive:1,generic:2}[payload.colorDistinctiveness]??1;
  const score=clamp(1+notorietyScore+areaDifficultyScore(payload.targetAreaRatio)+importanceScore+distinctivenessScore,1,10);
  let autoKey='easy'; if(score>=9)autoKey='hc';else if(score>=7)autoKey='very_hard';else if(score>=5)autoKey='hard';else if(score>=3)autoKey='medium';
  const requested=String(payload.difficultyMode||'auto');
  const categoryKey=requested==='auto'?autoKey:(DIFFICULTY_CATEGORIES[requested]?requested:autoKey);
  const cat=DIFFICULTY_CATEGORIES[categoryKey];
  return {
    difficultyMode: requested==='auto'?'auto':categoryKey, difficultyScore:score,
    difficultyCategory:categoryKey, difficultyLabel:cat.label, difficultyEmoji:cat.emoji, difficultyPoints:cat.points,
    notoriety:['huge','known','lesser','niche'].includes(payload.notoriety)?payload.notoriety:'known',
    colorImportance:['main','secondary','accent'].includes(payload.colorImportance)?payload.colorImportance:'secondary',
    colorDistinctiveness:['iconic','distinctive','generic'].includes(payload.colorDistinctiveness)?payload.colorDistinctiveness:'distinctive',
    targetAreaRatio:clamp(payload.targetAreaRatio,0,1)
  };
}
function leaderFromRows(rows,type) {
  if(type==='polka') return rows.find(p=>p.mountainPoints>0)||null;
  return rows.find(p=>p.qualified&&p.yellowCount>0)||null;
}
function rankMap(rows){const m=new Map();rows.forEach((p,i)=>m.set(p.id,i+1));return m;}
function leaderChanges(before,after) {
  const labels={yellow:{jersey:'yellow',label:'Maillot jaune',emoji:'🟨'},green:{jersey:'green',label:'Maillot vert',emoji:'🟩'},polka:{jersey:'polka',label:'Maillot à pois',emoji:'🔴'}};
  return Object.keys(labels).map(type=>{const b=leaderFromRows(before[type],type),a=leaderFromRows(after[type],type);return {...labels[type],before:b?{id:b.id,name:b.name}:null,after:a?{id:a.id,name:a.name}:null,changed:(b?.id||null)!==(a?.id||null)};}).filter(x=>x.after);
}

function resetScoresOnly() {
  Object.values(state.players).forEach(p=>{
    p.yellowTotal=0;p.yellowCount=0;p.greenTime=0;p.participatedDurationMs=0;p.mountainPoints=0;p.lastAnswer=null;
  });
  state.roundHistory=[];
}

function startRoundInternal(logoId,durationSeconds,meta={}) {
  if(state.activeRound) return {ok:false,error:'Une manche est déjà en cours.'};
  const logo=state.logos.find(l=>l.id===logoId); if(!logo)return {ok:false,error:'Logo introuvable.'};
  const seconds=clamp(durationSeconds||state.settings.roundSeconds||20,5,120);
  const now=Date.now(), startedAt=now+COUNTDOWN_MS;
  const participantIds=Object.values(state.players).filter(p=>p.online).map(p=>p.id);
  state.activeRound={
    id:uid('r_'),logoId:logo.id,logoName:logo.name,logoImage:logo.logoImage,targetColor:logo.targetColor,colorTolerance:logo.colorTolerance||42,
    difficultyCategory:logo.difficultyCategory,difficultyLabel:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.label||'Moyen',difficultyEmoji:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.emoji||'🔵',difficultyPoints:logo.difficultyPoints,
    roundNumber:meta.roundNumber||state.roundHistory.length+1,
    tourSessionId:meta.tourSessionId||null,tourId:meta.tourId||null,tourName:meta.tourName||null,tourStageNumber:meta.tourStageNumber||null,tourStageCount:meta.tourStageCount||null,
    participantIds,durationSeconds:seconds,createdAt:now,startedAt,endsAt:startedAt+seconds*1000,answers:{}
  };
  saveState();emitState();
  roundTimer=setTimeout(()=>endRound('timer'),COUNTDOWN_MS+seconds*1000+100);
  return {ok:true,participantCount:participantIds.length};
}

function aggregateTourStandings(rounds) {
  const totalRounds=rounds.length, minRounds=totalRounds?Math.ceil(totalRounds*.5):0;
  const rows=new Map();
  const ensure=(id,name)=>{if(!rows.has(id))rows.set(id,{id,name,yellowTotal:0,yellowCount:0,greenTime:0,participatedDurationMs:0,mountainPoints:0,podiums:0,wins:0});return rows.get(id);};
  Object.values(state.players).forEach(p=>ensure(p.id,p.name));
  const totalDuration=rounds.reduce((s,h)=>s+historyDurationMs(h,state.settings),0);
  rounds.forEach(h=>h.results.forEach(r=>{
    const p=ensure(r.playerId,r.name);p.yellowTotal+=Number(r.proximity)||0;p.yellowCount++;p.greenTime+=Number(r.elapsedMs)||0;p.participatedDurationMs+=historyDurationMs(h,state.settings);p.mountainPoints+=Number(r.mountainGain)||0;
    if(r.roundRank<=3)p.podiums++;if(r.roundRank===1)p.wins++;
  }));
  const list=[...rows.values()].map(p=>({
    id:p.id,name:p.name,playedRounds:p.yellowCount,totalRounds,minRounds,qualified:totalRounds===0||p.yellowCount>=minRounds,
    yellowAvg:p.yellowCount?p.yellowTotal/p.yellowCount:0,
    greenAdjusted:p.greenTime+Math.max(0,totalDuration-p.participatedDurationMs),
    mountainPoints:p.mountainPoints,podiums:p.podiums,wins:p.wins
  })).filter(p=>p.playedRounds>0);
  const q=(a,b)=>Number(b.qualified)-Number(a.qualified);
  return {
    yellow:[...list].sort((a,b)=>q(a,b)||b.yellowAvg-a.yellowAvg||a.greenAdjusted-b.greenAdjusted),
    green:[...list].sort((a,b)=>q(a,b)||a.greenAdjusted-b.greenAdjusted||b.yellowAvg-a.yellowAvg),
    polka:[...list].sort((a,b)=>b.mountainPoints-a.mountainPoints||b.yellowAvg-a.yellowAvg)
  };
}
function stddev(values){if(!values.length)return Infinity;const avg=values.reduce((a,b)=>a+b,0)/values.length;return Math.sqrt(values.reduce((s,v)=>s+(v-avg)**2,0)/values.length);}
function buildAwards(rounds, tourStandings) {
  const answers=[]; const perPlayer=new Map();
  rounds.forEach(h=>h.results.forEach(r=>{
    if(!r.color)return;
    answers.push({...r,logoName:h.logoName,difficultyPoints:h.difficultyPoints});
    if(!perPlayer.has(r.playerId))perPlayer.set(r.playerId,{id:r.playerId,name:r.name,values:[],rankGain:0,podiums:0});
    const p=perPlayer.get(r.playerId);p.values.push(Number(r.proximity)||0);p.rankGain+=Math.max(0,Number(r.yellowRankDelta)||0);if(r.roundRank<=3)p.podiums++;
  }));
  const best=[...answers].sort((a,b)=>b.proximity-a.proximity||a.elapsedMs-b.elapsedMs)[0];
  const fastPool=answers.filter(a=>a.proximity>=80); const fast=[...(fastPool.length?fastPool:answers)].sort((a,b)=>a.elapsedMs-b.elapsedMs||b.proximity-a.proximity)[0];
  const regular=[...perPlayer.values()].filter(p=>p.values.length>=Math.max(2,Math.ceil(rounds.length*.5))).map(p=>({...p,deviation:stddev(p.values)})).sort((a,b)=>a.deviation-b.deviation)[0];
  const comeback=[...perPlayer.values()].sort((a,b)=>b.rankGain-a.rankGain||b.podiums-a.podiums)[0];
  const polka=tourStandings.polka[0];
  return [
    best&&{key:'eye',emoji:'🎯',title:'Œil de lynx',playerId:best.playerId,name:best.name,detail:`${best.proximity.toFixed(1)} % sur ${best.logoName}`},
    fast&&{key:'sprint',emoji:'⚡',title:'Sprinteur',playerId:fast.playerId,name:fast.name,detail:`${(fast.elapsedMs/1000).toFixed(1)} s · ${fast.proximity.toFixed(1)} %`},
    regular&&{key:'regular',emoji:'📏',title:'Régularité',playerId:regular.id,name:regular.name,detail:`écart-type ${regular.deviation.toFixed(1)}`},
    comeback&&comeback.rankGain>0&&{key:'comeback',emoji:'📈',title:'Remontada',playerId:comeback.id,name:comeback.name,detail:`+${comeback.rankGain} places cumulées`},
    polka&&{key:'climber',emoji:'🏔️',title:'Grimpeur',playerId:polka.id,name:polka.name,detail:`${polka.mountainPoints} pts montagne`}
  ].filter(Boolean);
}
function buildTourSummary(activeTour, reason='finished') {
  const rounds=state.roundHistory.filter(h=>h.tourSessionId===activeTour.sessionId);
  const s=aggregateTourStandings(rounds);
  const answered=rounds.flatMap(h=>h.results.filter(r=>r.color));
  const hardest=[...rounds].sort((a,b)=>b.difficultyPoints-a.difficultyPoints||((a.results.reduce((x,r)=>x+r.proximity,0)/(a.results.length||1))-(b.results.reduce((x,r)=>x+r.proximity,0)/(b.results.length||1))))[0]||null;
  return {
    id:uid('summary_'),sessionId:activeTour.sessionId,tourId:activeTour.tourId,name:activeTour.name,reason,endedAt:Date.now(),
    completedStages:rounds.length,totalStages:activeTour.logoIds.length,
    standings:s,awards:buildAwards(rounds,s),
    stats:{
      players:new Set(rounds.flatMap(h=>h.results.map(r=>r.playerId))).size,
      answers:answered.length,
      averageProximity:answered.length?answered.reduce((x,r)=>x+r.proximity,0)/answered.length:0,
      hardestLogo:hardest?{name:hardest.logoName,points:hardest.difficultyPoints}:null
    }
  };
}
function finalizeTour(reason='finished') {
  if(!state.activeTour)return null;
  if(state.activeRound)return null;
  if(autoTimer)clearTimeout(autoTimer);autoTimer=null;
  const summary=buildTourSummary(state.activeTour,reason);
  state.lastTourSummary=summary;state.activeTour=null;saveState();
  io.emit('tour-ended',summary);emitState();return summary;
}
function launchCurrentTourStage() {
  const t=state.activeTour;if(!t||state.activeRound)return {ok:false,error:'Tour indisponible.'};
  if(t.currentIndex>=t.logoIds.length){finalizeTour('finished');return {ok:true,finished:true};}
  const logoId=t.logoIds[t.currentIndex];
  const res=startRoundInternal(logoId,t.roundSeconds,{
    roundNumber:t.currentIndex+1,tourSessionId:t.sessionId,tourId:t.tourId,tourName:t.name,tourStageNumber:t.currentIndex+1,tourStageCount:t.logoIds.length
  });
  if(!res.ok){t.currentIndex++;saveState();return launchCurrentTourStage();}
  return res;
}
function scheduleTourContinuation() {
  const t=state.activeTour;if(!t)return;
  const delay=(t.resultDelaySeconds||10)*1000;
  if(t.currentIndex>=t.logoIds.length){autoTimer=setTimeout(()=>finalizeTour('finished'),delay);return;}
  if(t.autoAdvance){autoTimer=setTimeout(()=>{autoTimer=null;launchCurrentTourStage();},delay);}
}

function endRound(reason='timer') {
  if(!state.activeRound)return;
  if(roundTimer)clearTimeout(roundTimer);roundTimer=null;
  const round=state.activeRound, logo=state.logos.find(l=>l.id===round.logoId);
  if(!logo){state.activeRound=null;saveState();emitState();return;}
  const beforeStandings=standings(), beforeYellowRanks=rankMap(beforeStandings.yellow);
  const durationMs=round.durationSeconds*1000, participantIds=round.participantIds||[];
  const results=participantIds.map(playerId=>{
    const player=state.players[playerId];if(!player)return null;
    const answer=round.answers[player.id];const elapsedMs=answer?Math.min(durationMs,Math.max(0,answer.at-round.startedAt)):durationMs;
    return {playerId:player.id,name:player.name,color:answer?.color||null,proximity:answer?proximityPct(answer.color,logo.targetColor):0,elapsedMs,mountainGain:0};
  }).filter(Boolean).sort((a,b)=>b.proximity-a.proximity||a.elapsedMs-b.elapsedMs);
  results.forEach((r,idx)=>{r.roundRank=idx+1;const p=state.players[r.playerId];if(!p)return;p.yellowTotal=(p.yellowTotal||0)+r.proximity;p.yellowCount=(p.yellowCount||0)+1;p.greenTime=(p.greenTime||0)+r.elapsedMs;p.participatedDurationMs=(p.participatedDurationMs||0)+durationMs;p.lastAnswer={proximity:r.proximity,elapsedMs:r.elapsedMs,color:r.color,roundId:round.id};});
  const eligible=results.filter(r=>r.color),factors=[1,.75,.5,.3,.15];
  eligible.slice(0,5).forEach((r,idx)=>{const gain=Math.max(1,Math.round(logo.difficultyPoints*factors[idx]));r.mountainGain=gain;const p=state.players[r.playerId];if(p)p.mountainPoints=(p.mountainPoints||0)+gain;});
  const historyItem={
    id:round.id,logoId:logo.id,logoName:logo.name,logoImage:logo.logoImage,targetColor:logo.targetColor,colorTolerance:logo.colorTolerance||42,
    difficultyCategory:logo.difficultyCategory,difficultyLabel:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.label||'Moyen',difficultyEmoji:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.emoji||'🔵',difficultyPoints:logo.difficultyPoints,difficultyScore:logo.difficultyScore,
    roundNumber:round.roundNumber,durationMs,participantCount:participantIds.length,endedAt:Date.now(),reason,
    tourSessionId:round.tourSessionId||null,tourId:round.tourId||null,tourName:round.tourName||null,tourStageNumber:round.tourStageNumber||null,tourStageCount:round.tourStageCount||null,
    results:results.map(r=>({...r,proximity:Number(r.proximity.toFixed(1))}))
  };
  state.roundHistory.push(historyItem);state.roundHistory=state.roundHistory.slice(-300);
  const afterStandings=standings(),afterYellowRanks=rankMap(afterStandings.yellow);
  historyItem.results.forEach(r=>{r.yellowRankBefore=beforeStandings.yellow.length&&state.roundHistory.length>1?(beforeYellowRanks.get(r.playerId)||null):null;r.yellowRankAfter=afterYellowRanks.get(r.playerId)||null;r.yellowRankDelta=r.yellowRankBefore&&r.yellowRankAfter?r.yellowRankBefore-r.yellowRankAfter:0;});
  historyItem.leaderChanges=leaderChanges(beforeStandings,afterStandings);
  state.activeRound=null;
  if(state.activeTour&&round.tourSessionId===state.activeTour.sessionId){state.activeTour.completedStages=round.tourStageNumber;state.activeTour.currentIndex=round.tourStageNumber;}
  saveState();io.emit('round-ended',historyItem);emitState();
  if(state.activeTour&&round.tourSessionId===state.activeTour.sessionId)scheduleTourContinuation();
}

io.on('connection', socket=>{
  socket.emit('state',basicSnapshot());
  socket.on('join',({name,playerId,roomCode:code},cb=()=>{})=>{
    const cleanName=sanitizeName(name,24);if(!cleanName)return cb({ok:false,error:'Nom requis.'});if(String(code||'').trim().toUpperCase()!==state.roomCode)return cb({ok:false,error:'Code de salle incorrect.'});
    let p=playerId&&state.players[playerId];
    if(!p){const id=uid('p_');p=state.players[id]={id,name:cleanName,yellowTotal:0,yellowCount:0,greenTime:0,participatedDurationMs:0,mountainPoints:0,online:true,lastSeen:Date.now(),lastAnswer:null};}
    else{p.name=cleanName;p.online=true;p.lastSeen=Date.now();}
    socket.data.playerId=p.id;socket.join('players');saveState();emitState();
    cb({ok:true,playerId:p.id,roomCode:state.roomCode,waitNextRound:!!state.activeRound&&!(state.activeRound.participantIds||[]).includes(p.id)});
  });
  socket.on('submit-color',({roundId,color},cb=()=>{})=>{
    const pid=socket.data.playerId,round=state.activeRound;if(!pid||!state.players[pid])return cb({ok:false,error:'Joueur non connecté.'});if(!round||round.id!==roundId)return cb({ok:false,error:'Cette manche est terminée.'});
    if(!(round.participantIds||[]).includes(pid))return cb({ok:false,error:'Tu as rejoint pendant la manche : tu participeras à la prochaine étape.'});if(Date.now()<round.startedAt)return cb({ok:false,error:'Le départ n’est pas encore donné.'});
    if(!/^#[0-9a-fA-F]{6}$/.test(String(color||'')))return cb({ok:false,error:'Couleur invalide.'});if(round.answers[pid])return cb({ok:false,error:'Réponse déjà envoyée.'});if(Date.now()>round.endsAt+300)return cb({ok:false,error:'Temps écoulé.'});
    round.answers[pid]={color:color.toUpperCase(),at:Date.now()};state.players[pid].lastSeen=Date.now();saveState();io.to('admins').emit('admin-state',adminSnapshot());cb({ok:true,elapsedMs:round.answers[pid].at-round.startedAt});
  });

  socket.on('admin-login',({password},cb=()=>{})=>{if(String(password||'')!==ADMIN_PASSWORD)return cb({ok:false,error:'Mot de passe incorrect.'});socket.data.admin=true;socket.join('admins');cb({ok:true,state:adminSnapshot(),insecureDefault:!process.env.ADMIN_PASSWORD});});
  const adminOnly=(cb)=>{if(!socket.data.admin){cb?.({ok:false,error:'Non autorisé.'});return false;}return true;};

  socket.on('admin-add-logo',(payload,cb=()=>{})=>{
    if(!adminOnly(cb))return;const name=sanitizeName(payload?.name,40),targetColor=String(payload?.targetColor||'').toUpperCase(),colorTolerance=clamp(payload?.colorTolerance||42,5,90),logoImage=payload?.logoImage;
    if(!name)return cb({ok:false,error:'Nom du logo requis.'});if(!/^#[0-9A-F]{6}$/.test(targetColor))return cb({ok:false,error:'Couleur cible invalide.'});if(!isValidDataImage(logoImage))return cb({ok:false,error:'Image invalide ou trop lourde (max ~2 Mo).'});
    const diff=computeDifficulty(payload);state.logos.push({id:uid('l_'),name,targetColor,colorTolerance,logoImage,createdAt:Date.now(),...diff});saveState();emitState();cb({ok:true});
  });
  socket.on('admin-update-logo',(payload,cb=()=>{})=>{
    if(!adminOnly(cb))return;if(state.activeRound?.logoId===payload?.logoId)return cb({ok:false,error:'Impossible de modifier le logo pendant sa manche.'});const logo=state.logos.find(l=>l.id===payload?.logoId);if(!logo)return cb({ok:false,error:'Logo introuvable.'});
    const name=sanitizeName(payload?.name,40),targetColor=String(payload?.targetColor||'').toUpperCase(),colorTolerance=clamp(payload?.colorTolerance||42,5,90),logoImage=payload?.logoImage||logo.logoImage;
    if(!name)return cb({ok:false,error:'Nom du logo requis.'});if(!/^#[0-9A-F]{6}$/.test(targetColor))return cb({ok:false,error:'Couleur cible invalide.'});if(!isValidDataImage(logoImage))return cb({ok:false,error:'Image invalide ou trop lourde.'});
    Object.assign(logo,{name,targetColor,colorTolerance,logoImage,updatedAt:Date.now(),...computeDifficulty(payload)});saveState();emitState();cb({ok:true});
  });
  socket.on('admin-delete-logo',({logoId},cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeRound?.logoId===logoId)return cb({ok:false,error:'Impossible pendant la manche active.'});state.logos=state.logos.filter(l=>l.id!==logoId);state.tours.forEach(t=>t.logoIds=t.logoIds.filter(id=>id!==logoId));saveState();emitState();cb({ok:true});});

  socket.on('admin-save-tour',(payload,cb=()=>{})=>{
    if(!adminOnly(cb))return;if(state.activeTour)return cb({ok:false,error:'Termine le Tour en cours avant de modifier les parcours.'});
    const name=sanitizeName(payload?.name,50);const validIds=(Array.isArray(payload?.logoIds)?payload.logoIds:[]).filter(id=>state.logos.some(l=>l.id===id));if(!name)return cb({ok:false,error:'Nom du Tour requis.'});if(!validIds.length)return cb({ok:false,error:'Ajoute au moins un logo au Tour.'});
    let tour=payload?.tourId&&state.tours.find(t=>t.id===payload.tourId);if(tour)Object.assign(tour,{name,logoIds:validIds,updatedAt:Date.now()});else{tour={id:uid('t_'),name,logoIds:validIds,createdAt:Date.now(),updatedAt:Date.now()};state.tours.push(tour);}saveState();emitState();cb({ok:true,tour:publicTour(tour)});
  });
  socket.on('admin-delete-tour',({tourId},cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeTour?.tourId===tourId)return cb({ok:false,error:'Ce Tour est en cours.'});state.tours=state.tours.filter(t=>t.id!==tourId);saveState();emitState();cb({ok:true});});
  socket.on('admin-start-tour',(payload,cb=()=>{})=>{
    if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Une course est déjà en cours.'});const tour=state.tours.find(t=>t.id===payload?.tourId);if(!tour)return cb({ok:false,error:'Tour introuvable.'});
    const logoIds=tour.logoIds.filter(id=>state.logos.some(l=>l.id===id));if(!logoIds.length)return cb({ok:false,error:'Ce Tour ne contient plus de logo valide.'});if(payload?.resetScores!==false)resetScoresOnly();
    state.lastTourSummary=null;state.activeTour={sessionId:uid('tour_'),tourId:tour.id,name:tour.name,logoIds,currentIndex:0,completedStages:0,autoAdvance:!!payload?.autoAdvance,resultDelaySeconds:clamp(payload?.resultDelaySeconds||state.settings.resultDelaySeconds||10,5,30),roundSeconds:clamp(payload?.roundSeconds||state.settings.roundSeconds||20,5,120),startedAt:Date.now()};saveState();emitState();
    const result=launchCurrentTourStage();cb(result);
  });
  socket.on('admin-next-tour-round',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeTour)return cb({ok:false,error:'Aucun Tour en cours.'});if(state.activeRound)return cb({ok:false,error:'Une étape est déjà en cours.'});if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}cb(launchCurrentTourStage());});
  socket.on('admin-finish-tour',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeTour)return cb({ok:false,error:'Aucun Tour en cours.'});if(state.activeRound)return cb({ok:false,error:'Termine l’étape en cours avant le Tour.'});const summary=finalizeTour('manual');cb({ok:true,summary});});
  socket.on('admin-toggle-auto-tour',({autoAdvance},cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeTour)return cb({ok:false,error:'Aucun Tour en cours.'});state.activeTour.autoAdvance=!!autoAdvance;saveState();emitState();if(state.activeTour.autoAdvance&&!state.activeRound&&!autoTimer)scheduleTourContinuation();cb({ok:true});});

  socket.on('admin-start-round',({logoId,durationSeconds},cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeTour)return cb({ok:false,error:'Un Tour est en cours : utilise “Étape suivante”.'});cb(startRoundInternal(logoId,durationSeconds));});
  socket.on('admin-end-round',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeRound)return cb({ok:false,error:'Aucune manche.'});if(Date.now()<state.activeRound.startedAt)return cb({ok:false,error:'Le compte à rebours est encore en cours.'});endRound('manual');cb({ok:true});});
  socket.on('admin-update-settings',({roundSeconds,resultDelaySeconds},cb=()=>{})=>{if(!adminOnly(cb))return;if(roundSeconds!==undefined)state.settings.roundSeconds=clamp(roundSeconds,5,120);if(resultDelaySeconds!==undefined)state.settings.resultDelaySeconds=clamp(resultDelaySeconds,5,30);saveState();emitState();cb({ok:true});});
  socket.on('admin-reset-scores',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Termine la course avant de réinitialiser.'});resetScoresOnly();state.lastTourSummary=null;saveState();emitState();cb({ok:true});});
  socket.on('admin-clear-players',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Termine la course avant de vider les joueurs.'});state.players={};state.roundHistory=[];state.lastTourSummary=null;saveState();emitState();cb({ok:true});});
  socket.on('admin-new-room-code',(_,cb=()=>{})=>{if(!adminOnly(cb))return;state.roomCode=roomCode();saveState();emitState();cb({ok:true,roomCode:state.roomCode});});

  socket.on('admin-export-pack',(_,cb=()=>{})=>{if(!adminOnly(cb))return;cb({ok:true,pack:{format:'toon-tone-tour-pack',version:3,exportedAt:Date.now(),logos:state.logos,tours:state.tours}});});
  socket.on('admin-import-pack',({pack},cb=()=>{})=>{
    if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Import impossible pendant une course.'});if(!pack||!Array.isArray(pack.logos))return cb({ok:false,error:'Fichier de pack invalide.'});
    const idMap=new Map();let added=0;
    for(const raw of pack.logos.slice(0,200)){if(!isValidDataImage(raw.logoImage)||!/^#[0-9A-Fa-f]{6}$/.test(String(raw.targetColor||'')))continue;const old=raw.id,newId=uid('l_');idMap.set(old,newId);state.logos.push(normalizeLogo({...raw,id:newId,name:sanitizeName(raw.name,40),targetColor:String(raw.targetColor).toUpperCase(),createdAt:Date.now()}));added++;}
    let tourAdded=0;for(const raw of (Array.isArray(pack.tours)?pack.tours:[]).slice(0,50)){const ids=(raw.logoIds||[]).map(id=>idMap.get(id)).filter(Boolean);if(!ids.length)continue;state.tours.push({id:uid('t_'),name:sanitizeName(raw.name||'Tour importé',50),logoIds:ids,createdAt:Date.now(),updatedAt:Date.now()});tourAdded++;}
    saveState();emitState();cb({ok:true,added,tourAdded});
  });

  socket.on('disconnect',()=>{const pid=socket.data.playerId;if(pid&&state.players[pid]){state.players[pid].online=false;state.players[pid].lastSeen=Date.now();saveState();emitState();}});
});

app.get('/health',(_,res)=>res.json({ok:true,roomCode:state.roomCode,players:Object.keys(state.players).length,version:APP_VERSION,activeTour:!!state.activeTour}));
server.listen(PORT,()=>{console.log(`Toon Tone Tour ${APP_VERSION} listening on :${PORT}`);console.log(`Data directory: ${DATA_DIR}`);if(!process.env.ADMIN_PASSWORD)console.warn('WARNING: ADMIN_PASSWORD is not set. Default password is "admin".');});
