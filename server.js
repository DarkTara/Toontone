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
const APP_VERSION = '3.3.0';

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
  finalPodium: true,
  fullStageRanking: true,
  answerExplorer: true,
  extendedStats: true,
  secureClientAnswer: true,
  scoringModel: 'CIEDE2000',
  tourHistory: true,
  difficultyCalibration: true,
  tourAnimations: true,
  autoEndWhenAllAnswered: true,
  randomTourOrder: true,
  incidentControls: true,
  quickPreparation: true
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
    tourHistory: [],
    roundHistory: [],
    settings: { roundSeconds: DEFAULT_ROUND_SECONDS, resultDelaySeconds: 10, autoEndWhenAllAnswered: true },
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
    targetAreaRatio: clamp(Number(l?.targetAreaRatio) || 0, 0, 1),
    playImage: typeof l?.playImage === 'string' ? l.playImage : null,
    maskBits: typeof l?.maskBits === 'string' ? l.maskBits : null,
    maskWidth: Number(l?.maskWidth) || 0,
    maskHeight: Number(l?.maskHeight) || 0,
    secureAssetsVersion: Number(l?.secureAssetsVersion) || 0,
    calibrationRounds: Number(l?.calibrationRounds) || 0,
    calibrationAnswers: Number(l?.calibrationAnswers) || 0,
    calibrationProximityTotal: Number(l?.calibrationProximityTotal) || 0,
    calibrationUpdatedAt: Number(l?.calibrationUpdatedAt) || null
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
      loaded.settings ||= { roundSeconds: DEFAULT_ROUND_SECONDS, resultDelaySeconds: 10, autoEndWhenAllAnswered: true };
      loaded.settings.resultDelaySeconds = clamp(loaded.settings.resultDelaySeconds || 10, 5, 30);
      loaded.settings.autoEndWhenAllAnswered = loaded.settings.autoEndWhenAllAnswered !== false;
      loaded.logos = (loaded.logos || []).map(normalizeLogo);
      loaded.tours = (loaded.tours || []).map(normalizeTour);
      loaded.roundHistory ||= [];
      loaded.players ||= {};
      loaded.lastTourSummary ||= null;
      loaded.tourHistory = Array.isArray(loaded.tourHistory) ? loaded.tourHistory.slice(-50) : [];
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
let completionTimer = null;

function saveState() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function clearTimers() {
  if (roundTimer) clearTimeout(roundTimer);
  if (autoTimer) clearTimeout(autoTimer);
  if (completionTimer) clearTimeout(completionTimer);
  roundTimer = null;
  autoTimer = null;
  completionTimer = null;
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
    randomOrder:!!t.randomOrder, autoEndWhenAllAnswered:t.autoEndWhenAllAnswered!==false,
    resultDelaySeconds:t.resultDelaySeconds, roundSeconds:t.roundSeconds,
    skippedStages:Array.isArray(t.skippedStages)?t.skippedStages:[],
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
      logoName: state.activeRound.logoName,
      playImage: state.activeRound.playImage,
      maskBits: state.activeRound.maskBits,
      maskWidth: state.activeRound.maskWidth,
      maskHeight: state.activeRound.maskHeight,
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
      paused: !!state.activeRound.paused,
      pausedAt: state.activeRound.pausedAt || null,
      pauseRemainingMs: state.activeRound.pauseRemainingMs ?? null,
      autoEndWhenAllAnswered: state.activeRound.autoEndWhenAllAnswered !== false,
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
    logos: state.logos.map(l => ({ ...l, calibration: calibrationForLogo(l), secureReady: hasSecureAssets(l) })),
    tours: state.tours.map(publicTour),
    roundHistory: state.roundHistory.slice(-50).reverse(),
    tourHistory: state.tourHistory.slice(-50).reverse()
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
function deg2rad(d){return d*Math.PI/180;}
function rad2deg(r){return r*180/Math.PI;}
function deltaE2000(lab1,lab2){
  const L1=lab1.L,a1=lab1.a,b1=lab1.b,L2=lab2.L,a2=lab2.a,b2=lab2.b;
  const C1=Math.sqrt(a1*a1+b1*b1),C2=Math.sqrt(a2*a2+b2*b2),Cbar=(C1+C2)/2;
  const G=.5*(1-Math.sqrt(Math.pow(Cbar,7)/(Math.pow(Cbar,7)+Math.pow(25,7))));
  const ap1=(1+G)*a1,ap2=(1+G)*a2,Cp1=Math.sqrt(ap1*ap1+b1*b1),Cp2=Math.sqrt(ap2*ap2+b2*b2);
  let hp1=rad2deg(Math.atan2(b1,ap1));if(hp1<0)hp1+=360;let hp2=rad2deg(Math.atan2(b2,ap2));if(hp2<0)hp2+=360;
  const dLp=L2-L1,dCp=Cp2-Cp1;let dhp=0;
  if(Cp1*Cp2!==0){dhp=hp2-hp1;if(dhp>180)dhp-=360;else if(dhp<-180)dhp+=360;}
  const dHp=2*Math.sqrt(Cp1*Cp2)*Math.sin(deg2rad(dhp/2));
  const Lbar=(L1+L2)/2,Cpbar=(Cp1+Cp2)/2;let hpbar=hp1+hp2;
  if(Cp1*Cp2===0)hpbar=hp1+hp2;else if(Math.abs(hp1-hp2)<=180)hpbar=(hp1+hp2)/2;else if(hp1+hp2<360)hpbar=(hp1+hp2+360)/2;else hpbar=(hp1+hp2-360)/2;
  const T=1-.17*Math.cos(deg2rad(hpbar-30))+.24*Math.cos(deg2rad(2*hpbar))+.32*Math.cos(deg2rad(3*hpbar+6))-.20*Math.cos(deg2rad(4*hpbar-63));
  const dTheta=30*Math.exp(-Math.pow((hpbar-275)/25,2));
  const Rc=2*Math.sqrt(Math.pow(Cpbar,7)/(Math.pow(Cpbar,7)+Math.pow(25,7)));
  const Sl=1+(.015*Math.pow(Lbar-50,2))/Math.sqrt(20+Math.pow(Lbar-50,2)),Sc=1+.045*Cpbar,Sh=1+.015*Cpbar*T;
  const Rt=-Math.sin(deg2rad(2*dTheta))*Rc;
  const x=dLp/Sl,y=dCp/Sc,z=dHp/Sh;
  return Math.sqrt(x*x+y*y+z*z+Rt*y*z);
}
function colorScore(aHex,bHex) {
  const a=hexToRgb(aHex),b=hexToRgb(bHex);if(!a||!b)return {proximity:0,deltaE00:100};
  const dE=deltaE2000(rgbToLab(a),rgbToLab(b));
  return {proximity:Math.max(0,Math.min(100,100-2*dE)),deltaE00:dE};
}
function proximityPct(aHex,bHex){return colorScore(aHex,bHex).proximity;}
function isValidDataImage(src) {
  return typeof src === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(src) && src.length < 3_000_000;
}
function hasSecureAssets(logo){
  return !!(logo && isValidDataImage(logo.playImage) && typeof logo.maskBits==='string' && logo.maskBits.length>0 && logo.maskBits.length<1_000_000 && Number(logo.maskWidth)>0 && Number(logo.maskHeight)>0);
}
function calibrationCategory(avg){if(avg>=90)return 'easy';if(avg>=82)return 'medium';if(avg>=72)return 'hard';if(avg>=62)return 'very_hard';return 'hc';}
function calibrationForLogo(logo){
  const answers=Number(logo?.calibrationAnswers)||0,rounds=Number(logo?.calibrationRounds)||0,avg=answers?(Number(logo.calibrationProximityTotal)||0)/answers:0;
  const suggestedCategory=answers>=10?calibrationCategory(avg):null;
  const confidence=answers<10?'insufficient':answers<30?'emerging':answers<60?'reliable':'strong';
  return {rounds,answers,averageProximity:avg,suggestedCategory,confidence,eligible:answers>=10,currentCategory:logo?.difficultyCategory||'medium',changed:!!suggestedCategory&&suggestedCategory!==logo?.difficultyCategory};
}
function updateCalibration(logo,results){
  const answered=(results||[]).filter(r=>r.color);if(!answered.length)return;
  logo.calibrationRounds=(Number(logo.calibrationRounds)||0)+1;logo.calibrationAnswers=(Number(logo.calibrationAnswers)||0)+answered.length;logo.calibrationProximityTotal=(Number(logo.calibrationProximityTotal)||0)+answered.reduce((sum,r)=>sum+(Number(r.proximity)||0),0);logo.calibrationUpdatedAt=Date.now();
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

function shuffleArray(items) {
  const a=[...items];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function emitToPlayer(playerId,event,payload={}) {
  for(const s of io.sockets.sockets.values()) if(s.data.playerId===playerId) s.emit(event,payload);
}
function scheduleRoundTimer(round=state.activeRound) {
  if(roundTimer) clearTimeout(roundTimer); roundTimer=null;
  if(!round || round.paused) return;
  const wait=Math.max(0,round.endsAt-Date.now())+100;
  roundTimer=setTimeout(()=>{if(state.activeRound?.id===round.id)endRound('timer');},wait);
}
function maybeAutoEndRound() {
  const r=state.activeRound;
  if(completionTimer){clearTimeout(completionTimer);completionTimer=null;}
  if(!r || r.paused || r.autoEndWhenAllAnswered===false || Date.now()<r.startedAt) return false;
  const participants=r.participantIds||[], answers=r.answers||{};
  if(!participants.length || participants.some(id=>!answers[id])) return false;
  const id=r.id;
  completionTimer=setTimeout(()=>{
    completionTimer=null;
    const current=state.activeRound;
    if(current?.id===id && !current.paused && (current.participantIds||[]).length>0 && (current.participantIds||[]).every(pid=>current.answers?.[pid])) endRound('all_answered');
  },450);
  return true;
}
function cancelActiveRound(mode='replay') {
  const round=state.activeRound;if(!round)return {ok:false,error:'Aucune étape en cours.'};
  if(roundTimer)clearTimeout(roundTimer);roundTimer=null;if(completionTimer)clearTimeout(completionTimer);completionTimer=null;
  state.activeRound=null;
  const isTour=!!(state.activeTour&&round.tourSessionId===state.activeTour.sessionId);
  if(isTour){
    state.activeTour.incidents ||= [];
    state.activeTour.incidents.push({type:mode==='skip'?'stage_skipped':'stage_cancelled',stageNumber:round.tourStageNumber,logoName:round.logoName,at:Date.now()});
    if(mode==='skip'){
      state.activeTour.skippedStages ||= [];
      state.activeTour.skippedStages.push({stageNumber:round.tourStageNumber,logoId:round.logoId,logoName:round.logoName,at:Date.now()});
      state.activeTour.currentIndex=round.tourStageNumber;
      state.activeTour.completedStages=Math.max(state.activeTour.completedStages||0,round.tourStageNumber);
    } else {
      state.activeTour.currentIndex=Math.max(0,(round.tourStageNumber||1)-1);
      state.activeTour.completedStages=Math.min(state.activeTour.completedStages||0,state.activeTour.currentIndex);
    }
  }
  saveState();io.emit('round-cancelled',{mode,isTour,logoName:round.logoName,stageNumber:round.tourStageNumber||round.roundNumber});emitState();
  if(isTour&&mode==='skip')scheduleTourContinuation();
  else if(isTour&&mode==='replay'&&state.activeTour?.autoAdvance){if(autoTimer)clearTimeout(autoTimer);autoTimer=setTimeout(()=>{autoTimer=null;launchCurrentTourStage();},1200);}
  return {ok:true,isTour,mode};
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
  if(!hasSecureAssets(logo))return {ok:false,error:'Ce logo doit être sécurisé avant de jouer. Laisse la page admin ouverte quelques secondes : la V3.3 le prépare automatiquement.'};
  const seconds=clamp(durationSeconds||state.settings.roundSeconds||20,5,120);
  const now=Date.now(), startedAt=now+COUNTDOWN_MS;
  const participantIds=Object.values(state.players).filter(p=>p.online).map(p=>p.id);
  state.activeRound={
    id:uid('r_'),logoId:logo.id,logoName:logo.name,playImage:logo.playImage,maskBits:logo.maskBits,maskWidth:logo.maskWidth,maskHeight:logo.maskHeight,targetColor:logo.targetColor,
    difficultyCategory:logo.difficultyCategory,difficultyLabel:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.label||'Moyen',difficultyEmoji:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.emoji||'🔵',difficultyPoints:logo.difficultyPoints,
    roundNumber:meta.roundNumber||state.roundHistory.length+1,
    tourSessionId:meta.tourSessionId||null,tourId:meta.tourId||null,tourName:meta.tourName||null,tourStageNumber:meta.tourStageNumber||null,tourStageCount:meta.tourStageCount||null,
    participantIds,durationSeconds:seconds,createdAt:now,startedAt,endsAt:startedAt+seconds*1000,answers:{},
    paused:false,pausedAt:null,pauseRemainingMs:null,totalPausedMs:0,
    autoEndWhenAllAnswered:meta.autoEndWhenAllAnswered!==undefined?!!meta.autoEndWhenAllAnswered:state.settings.autoEndWhenAllAnswered!==false
  };
  saveState();emitState();
  scheduleRoundTimer(state.activeRound);
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
function median(values) {
  if(!values.length)return 0;
  const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function buildTourSummary(activeTour, reason='finished') {
  const rounds=state.roundHistory.filter(h=>h.tourSessionId===activeTour.sessionId);
  const s=aggregateTourStandings(rounds);
  const answered=rounds.flatMap(h=>h.results.filter(r=>r.color));
  const allResults=rounds.flatMap(h=>h.results||[]);
  const totalOpportunities=allResults.length;
  const stageStats=rounds.map((h,idx)=>{
    const answers=(h.results||[]).filter(r=>r.color);
    const avg=answers.length?answers.reduce((x,r)=>x+(Number(r.proximity)||0),0)/answers.length:0;
    const avgTime=answers.length?answers.reduce((x,r)=>x+(Number(r.elapsedMs)||0),0)/answers.length:0;
    const gap=answers.length>=2?Math.max(0,(Number(answers[0].proximity)||0)-(Number(answers[1].proximity)||0)):null;
    return {
      id:h.id,stageNumber:h.tourStageNumber||h.roundNumber||idx+1,logoName:h.logoName,
      difficultyPoints:h.difficultyPoints||0,difficultyLabel:h.difficultyLabel||'',difficultyEmoji:h.difficultyEmoji||'🏔️',
      averageProximity:avg,averageTimeMs:avgTime,responseRate:(h.results?.length||0)?answers.length/h.results.length*100:0,
      answerCount:answers.length,participantCount:h.results?.length||0,winner:answers[0]?{name:answers[0].name,proximity:answers[0].proximity}:null,gapTop2:gap
    };
  });
  const hardest=[...rounds].sort((a,b)=>(b.difficultyPoints||0)-(a.difficultyPoints||0))[0]||null;
  const easiestPractice=[...stageStats].filter(x=>x.answerCount).sort((a,b)=>b.averageProximity-a.averageProximity)[0]||null;
  const toughestPractice=[...stageStats].filter(x=>x.answerCount).sort((a,b)=>a.averageProximity-b.averageProximity)[0]||null;
  const closestFinish=[...stageStats].filter(x=>x.gapTop2!==null).sort((a,b)=>a.gapTop2-b.gapTop2)[0]||null;

  const yellowRanks=rankMap(s.yellow),greenRanks=rankMap(s.green),polkaRanks=rankMap(s.polka);
  const byPlayer=new Map();
  rounds.forEach(h=>(h.results||[]).forEach(r=>{
    if(!byPlayer.has(r.playerId))byPlayer.set(r.playerId,{playerId:r.playerId,name:r.name,played:0,answers:0,proxTotal:0,bestProximity:0,timeTotal:0,fastestTimeMs:null,wins:0,podiums:0,mountainPoints:0});
    const p=byPlayer.get(r.playerId);p.played++;
    if(r.color){p.answers++;p.proxTotal+=Number(r.proximity)||0;p.bestProximity=Math.max(p.bestProximity,Number(r.proximity)||0);p.timeTotal+=Number(r.elapsedMs)||0;p.fastestTimeMs=p.fastestTimeMs===null?Number(r.elapsedMs)||0:Math.min(p.fastestTimeMs,Number(r.elapsedMs)||0);}
    if(r.roundRank===1)p.wins++;if(r.roundRank<=3)p.podiums++;p.mountainPoints+=Number(r.mountainGain)||0;
  }));
  const yellowById=new Map(s.yellow.map(p=>[p.id,p]));
  const playerStats=[...byPlayer.values()].map(p=>({
    ...p,averageProximity:p.answers?p.proxTotal/p.answers:0,averageTimeMs:p.answers?p.timeTotal/p.answers:0,
    responseRate:p.played?p.answers/p.played*100:0,yellowAverage:yellowById.get(p.playerId)?.yellowAvg||0,
    yellowRank:yellowRanks.get(p.playerId)||null,greenRank:greenRanks.get(p.playerId)||null,polkaRank:polkaRanks.get(p.playerId)||null
  })).sort((a,b)=>(a.yellowRank||999)-(b.yellowRank||999));

  const stages=rounds.map((h,idx)=>({
    id:h.id,stageNumber:h.tourStageNumber||h.roundNumber||idx+1,logoName:h.logoName,targetColor:h.targetColor,
    difficultyPoints:h.difficultyPoints||0,difficultyLabel:h.difficultyLabel||'',difficultyEmoji:h.difficultyEmoji||'🏔️',
    participantCount:h.participantCount||h.results?.length||0,
    results:(h.results||[]).map(r=>({playerId:r.playerId,name:r.name,color:r.color,proximity:r.proximity,elapsedMs:r.elapsedMs,roundRank:r.roundRank,mountainGain:r.mountainGain||0}))
  }));

  return {
    id:uid('summary_'),sessionId:activeTour.sessionId,tourId:activeTour.tourId,name:activeTour.name,reason,endedAt:Date.now(),
    completedStages:rounds.length+(activeTour.skippedStages?.length||0),scoredStages:rounds.length,processedStages:rounds.length+(activeTour.skippedStages?.length||0),totalStages:activeTour.logoIds.length,
    skippedStages:activeTour.skippedStages||[],incidents:activeTour.incidents||[],randomOrder:!!activeTour.randomOrder,
    scoringModel:'CIEDE2000',scoreFormula:'max(0, 100 - 2 × ΔE00)',
    standings:s,awards:buildAwards(rounds,s),playerStats,stages,
    stats:{
      players:new Set(allResults.map(r=>r.playerId)).size,skippedStages:activeTour.skippedStages?.length||0,
      answers:answered.length,totalOpportunities,responseRate:totalOpportunities?answered.length/totalOpportunities*100:0,
      averageProximity:answered.length?answered.reduce((x,r)=>x+(Number(r.proximity)||0),0)/answered.length:0,
      medianProximity:median(answered.map(r=>Number(r.proximity)||0)),
      averageResponseTimeMs:answered.length?answered.reduce((x,r)=>x+(Number(r.elapsedMs)||0),0)/answered.length:0,
      over90:answered.filter(r=>(Number(r.proximity)||0)>=90).length,
      over95:answered.filter(r=>(Number(r.proximity)||0)>=95).length,
      hardestLogo:hardest?{name:hardest.logoName,points:hardest.difficultyPoints}:null,
      easiestInPractice:easiestPractice,toughestInPractice:toughestPractice,closestFinish
    }
  };
}
function finalizeTour(reason='finished') {
  if(!state.activeTour)return null;
  if(state.activeRound)return null;
  if(autoTimer)clearTimeout(autoTimer);autoTimer=null;
  const summary=buildTourSummary(state.activeTour,reason);
  state.lastTourSummary=summary;state.tourHistory.push(summary);state.tourHistory=state.tourHistory.slice(-50);state.activeTour=null;saveState();
  io.emit('tour-ended',summary);emitState();return summary;
}
function launchCurrentTourStage() {
  const t=state.activeTour;if(!t||state.activeRound)return {ok:false,error:'Tour indisponible.'};
  if(t.currentIndex>=t.logoIds.length){finalizeTour('finished');return {ok:true,finished:true};}
  const logoId=t.logoIds[t.currentIndex];
  const res=startRoundInternal(logoId,t.roundSeconds,{
    roundNumber:t.currentIndex+1,tourSessionId:t.sessionId,tourId:t.tourId,tourName:t.name,tourStageNumber:t.currentIndex+1,tourStageCount:t.logoIds.length,
    autoEndWhenAllAnswered:t.autoEndWhenAllAnswered!==false
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
  if(roundTimer)clearTimeout(roundTimer);roundTimer=null;if(completionTimer)clearTimeout(completionTimer);completionTimer=null;
  const round=state.activeRound, logo=state.logos.find(l=>l.id===round.logoId);
  if(!logo){state.activeRound=null;saveState();emitState();return;}
  const beforeStandings=standings(), beforeYellowRanks=rankMap(beforeStandings.yellow);
  const durationMs=round.durationSeconds*1000, participantIds=round.participantIds||[];
  const results=participantIds.map(playerId=>{
    const player=state.players[playerId];if(!player)return null;
    const answer=round.answers[player.id];const elapsedMs=answer?Math.min(durationMs,Math.max(0,Number(answer.elapsedMs ?? (answer.at-round.startedAt-(round.totalPausedMs||0))))):durationMs;const score=answer?colorScore(answer.color,logo.targetColor):{proximity:0,deltaE00:null};
    return {playerId:player.id,name:player.name,color:answer?.color||null,proximity:score.proximity,deltaE00:score.deltaE00,elapsedMs,mountainGain:0};
  }).filter(Boolean).sort((a,b)=>b.proximity-a.proximity||a.elapsedMs-b.elapsedMs);
  results.forEach((r,idx)=>{r.roundRank=idx+1;const p=state.players[r.playerId];if(!p)return;p.yellowTotal=(p.yellowTotal||0)+r.proximity;p.yellowCount=(p.yellowCount||0)+1;p.greenTime=(p.greenTime||0)+r.elapsedMs;p.participatedDurationMs=(p.participatedDurationMs||0)+durationMs;p.lastAnswer={proximity:r.proximity,elapsedMs:r.elapsedMs,color:r.color,roundId:round.id};});
  const eligible=results.filter(r=>r.color),factors=[1,.75,.5,.3,.15];
  eligible.slice(0,5).forEach((r,idx)=>{const gain=Math.max(1,Math.round(logo.difficultyPoints*factors[idx]));r.mountainGain=gain;const p=state.players[r.playerId];if(p)p.mountainPoints=(p.mountainPoints||0)+gain;});
  updateCalibration(logo,results);
  const historyItem={
    id:round.id,logoId:logo.id,logoName:logo.name,targetColor:logo.targetColor,colorTolerance:logo.colorTolerance||42,
    difficultyCategory:logo.difficultyCategory,difficultyLabel:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.label||'Moyen',difficultyEmoji:DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.emoji||'🔵',difficultyPoints:logo.difficultyPoints,difficultyScore:logo.difficultyScore,
    roundNumber:round.roundNumber,durationMs,participantCount:participantIds.length,endedAt:Date.now(),reason,
    tourSessionId:round.tourSessionId||null,tourId:round.tourId||null,tourName:round.tourName||null,tourStageNumber:round.tourStageNumber||null,tourStageCount:round.tourStageCount||null,
    results:results.map(r=>({...r,proximity:Number(r.proximity.toFixed(1)),deltaE00:r.deltaE00===null?null:Number(r.deltaE00.toFixed(3))}))
  };
  state.roundHistory.push(historyItem);state.roundHistory=state.roundHistory.slice(-300);
  const afterStandings=standings(),afterYellowRanks=rankMap(afterStandings.yellow);
  historyItem.results.forEach(r=>{r.yellowRankBefore=beforeStandings.yellow.length&&state.roundHistory.length>1?(beforeYellowRanks.get(r.playerId)||null):null;r.yellowRankAfter=afterYellowRanks.get(r.playerId)||null;r.yellowRankDelta=r.yellowRankBefore&&r.yellowRankAfter?r.yellowRankBefore-r.yellowRankAfter:0;});
  historyItem.leaderChanges=leaderChanges(beforeStandings,afterStandings);
  const resultPayload={...historyItem,logoImage:logo.logoImage};
  state.activeRound=null;
  if(state.activeTour&&round.tourSessionId===state.activeTour.sessionId){state.activeTour.completedStages=round.tourStageNumber;state.activeTour.currentIndex=round.tourStageNumber;}
  saveState();io.emit('round-ended',resultPayload);emitState();
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
    if(!(round.participantIds||[]).includes(pid))return cb({ok:false,error:'Tu as rejoint pendant la manche : tu participeras à la prochaine étape.'});if(Date.now()<round.startedAt)return cb({ok:false,error:'Le départ n’est pas encore donné.'});if(round.paused)return cb({ok:false,error:'La direction de course a mis l’étape en pause.'});
    if(!/^#[0-9a-fA-F]{6}$/.test(String(color||'')))return cb({ok:false,error:'Couleur invalide.'});if(round.answers[pid])return cb({ok:false,error:'Réponse déjà envoyée.'});if(Date.now()>round.endsAt+300)return cb({ok:false,error:'Temps écoulé.'});
    const at=Date.now(),elapsedMs=Math.min(round.durationSeconds*1000,Math.max(0,at-round.startedAt-(round.totalPausedMs||0)));
    round.answers[pid]={color:color.toUpperCase(),at,elapsedMs};state.players[pid].lastSeen=Date.now();saveState();io.to('admins').emit('admin-state',adminSnapshot());cb({ok:true,elapsedMs});maybeAutoEndRound();
  });

  socket.on('admin-login',({password},cb=()=>{})=>{if(String(password||'')!==ADMIN_PASSWORD)return cb({ok:false,error:'Mot de passe incorrect.'});socket.data.admin=true;socket.join('admins');cb({ok:true,state:adminSnapshot(),insecureDefault:!process.env.ADMIN_PASSWORD});});
  const adminOnly=(cb)=>{if(!socket.data.admin){cb?.({ok:false,error:'Non autorisé.'});return false;}return true;};

  socket.on('admin-upgrade-logo-assets',({logoId,playImage,maskBits,maskWidth,maskHeight,secureAssetsVersion},cb=()=>{})=>{
    if(!adminOnly(cb))return;const logo=state.logos.find(l=>l.id===logoId);if(!logo)return cb({ok:false,error:'Logo introuvable.'});
    const candidate={playImage,maskBits,maskWidth,maskHeight};if(!hasSecureAssets(candidate))return cb({ok:false,error:'Données de masque invalides.'});
    Object.assign(logo,{playImage,maskBits,maskWidth:Number(maskWidth),maskHeight:Number(maskHeight),secureAssetsVersion:Number(secureAssetsVersion)||1});saveState();emitState();cb({ok:true});
  });
  socket.on('admin-apply-calibration',({logoId},cb=()=>{})=>{
    if(!adminOnly(cb))return;const logo=state.logos.find(l=>l.id===logoId);if(!logo)return cb({ok:false,error:'Logo introuvable.'});const cal=calibrationForLogo(logo);if(!cal.eligible||!cal.suggestedCategory)return cb({ok:false,error:'Pas encore assez de réponses pour étalonner ce logo.'});
    const cat=DIFFICULTY_CATEGORIES[cal.suggestedCategory];logo.difficultyMode=cal.suggestedCategory;logo.difficultyCategory=cal.suggestedCategory;logo.difficultyLabel=cat.label;logo.difficultyEmoji=cat.emoji;logo.difficultyPoints=cat.points;logo.calibrationAppliedAt=Date.now();saveState();emitState();cb({ok:true,category:cal.suggestedCategory});
  });
  socket.on('admin-apply-all-calibrations',(_,cb=()=>{})=>{
    if(!adminOnly(cb))return;let changed=0;for(const logo of state.logos){const cal=calibrationForLogo(logo);if(!cal.eligible||!cal.changed)continue;const cat=DIFFICULTY_CATEGORIES[cal.suggestedCategory];logo.difficultyMode=cal.suggestedCategory;logo.difficultyCategory=cal.suggestedCategory;logo.difficultyLabel=cat.label;logo.difficultyEmoji=cat.emoji;logo.difficultyPoints=cat.points;logo.calibrationAppliedAt=Date.now();changed++;}saveState();emitState();cb({ok:true,changed});
  });
  socket.on('admin-clear-tour-history',(_,cb=()=>{})=>{if(!adminOnly(cb))return;state.tourHistory=[];saveState();emitState();cb({ok:true});});

  socket.on('admin-add-logo',(payload,cb=()=>{})=>{
    if(!adminOnly(cb))return;const name=sanitizeName(payload?.name,40),targetColor=String(payload?.targetColor||'').toUpperCase(),colorTolerance=clamp(payload?.colorTolerance||42,5,90),logoImage=payload?.logoImage;
    if(!name)return cb({ok:false,error:'Nom du logo requis.'});if(!/^#[0-9A-F]{6}$/.test(targetColor))return cb({ok:false,error:'Couleur cible invalide.'});if(!isValidDataImage(logoImage))return cb({ok:false,error:'Image invalide ou trop lourde (max ~2 Mo).'});
    const diff=computeDifficulty(payload);const secure={playImage:payload?.playImage||null,maskBits:payload?.maskBits||null,maskWidth:Number(payload?.maskWidth)||0,maskHeight:Number(payload?.maskHeight)||0,secureAssetsVersion:Number(payload?.secureAssetsVersion)||0};state.logos.push({id:uid('l_'),name,targetColor,colorTolerance,logoImage,createdAt:Date.now(),...secure,...diff});saveState();emitState();cb({ok:true});
  });
  socket.on('admin-update-logo',(payload,cb=()=>{})=>{
    if(!adminOnly(cb))return;if(state.activeRound?.logoId===payload?.logoId)return cb({ok:false,error:'Impossible de modifier le logo pendant sa manche.'});const logo=state.logos.find(l=>l.id===payload?.logoId);if(!logo)return cb({ok:false,error:'Logo introuvable.'});
    const name=sanitizeName(payload?.name,40),targetColor=String(payload?.targetColor||'').toUpperCase(),colorTolerance=clamp(payload?.colorTolerance||42,5,90),logoImage=payload?.logoImage||logo.logoImage;
    if(!name)return cb({ok:false,error:'Nom du logo requis.'});if(!/^#[0-9A-F]{6}$/.test(targetColor))return cb({ok:false,error:'Couleur cible invalide.'});if(!isValidDataImage(logoImage))return cb({ok:false,error:'Image invalide ou trop lourde.'});
    Object.assign(logo,{name,targetColor,colorTolerance,logoImage,playImage:payload?.playImage||null,maskBits:payload?.maskBits||null,maskWidth:Number(payload?.maskWidth)||0,maskHeight:Number(payload?.maskHeight)||0,secureAssetsVersion:Number(payload?.secureAssetsVersion)||0,updatedAt:Date.now(),...computeDifficulty(payload)});saveState();emitState();cb({ok:true});
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
    let logoIds=tour.logoIds.filter(id=>state.logos.some(l=>l.id===id));if(!logoIds.length)return cb({ok:false,error:'Ce Tour ne contient plus de logo valide.'});const unsecured=logoIds.map(id=>state.logos.find(l=>l.id===id)).filter(l=>l&&!hasSecureAssets(l));if(unsecured.length)return cb({ok:false,error:`Sécurisation en cours pour ${unsecured.length} logo(s) : ${unsecured.slice(0,3).map(l=>l.name).join(', ')}. Réessaie dans quelques secondes.`});if(payload?.resetScores!==false)resetScoresOnly();
    const randomOrder=!!payload?.randomOrder;if(randomOrder)logoIds=shuffleArray(logoIds);
    state.lastTourSummary=null;state.activeTour={sessionId:uid('tour_'),tourId:tour.id,name:tour.name,logoIds,currentIndex:0,completedStages:0,autoAdvance:!!payload?.autoAdvance,randomOrder,autoEndWhenAllAnswered:payload?.autoEndWhenAllAnswered!==false,skippedStages:[],incidents:[],resultDelaySeconds:clamp(payload?.resultDelaySeconds||state.settings.resultDelaySeconds||10,5,30),roundSeconds:clamp(payload?.roundSeconds||state.settings.roundSeconds||20,5,120),startedAt:Date.now()};saveState();emitState();
    const result=launchCurrentTourStage();cb(result);
  });
  socket.on('admin-next-tour-round',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeTour)return cb({ok:false,error:'Aucun Tour en cours.'});if(state.activeRound)return cb({ok:false,error:'Une étape est déjà en cours.'});if(autoTimer){clearTimeout(autoTimer);autoTimer=null;}cb(launchCurrentTourStage());});
  socket.on('admin-finish-tour',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeTour)return cb({ok:false,error:'Aucun Tour en cours.'});if(state.activeRound)return cb({ok:false,error:'Termine l’étape en cours avant le Tour.'});const summary=finalizeTour('manual');cb({ok:true,summary});});
  socket.on('admin-toggle-auto-tour',({autoAdvance},cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeTour)return cb({ok:false,error:'Aucun Tour en cours.'});state.activeTour.autoAdvance=!!autoAdvance;if(!state.activeTour.autoAdvance&&autoTimer){clearTimeout(autoTimer);autoTimer=null;}saveState();emitState();if(state.activeTour.autoAdvance&&!state.activeRound&&!autoTimer)scheduleTourContinuation();cb({ok:true});});

  socket.on('admin-pause-round',(_,cb=()=>{})=>{
    if(!adminOnly(cb))return;const r=state.activeRound;if(!r)return cb({ok:false,error:'Aucune étape en cours.'});if(r.paused)return cb({ok:false,error:'L’étape est déjà en pause.'});if(Date.now()<r.startedAt)return cb({ok:false,error:'Attends le GO avant de mettre en pause.'});
    if(roundTimer)clearTimeout(roundTimer);roundTimer=null;if(completionTimer)clearTimeout(completionTimer);completionTimer=null;
    r.paused=true;r.pausedAt=Date.now();r.pauseRemainingMs=Math.max(0,r.endsAt-r.pausedAt);if(state.activeTour)state.activeTour.incidents?.push({type:'pause',stageNumber:r.tourStageNumber,at:Date.now()});saveState();emitState();cb({ok:true});
  });
  socket.on('admin-resume-round',(_,cb=()=>{})=>{
    if(!adminOnly(cb))return;const r=state.activeRound;if(!r)return cb({ok:false,error:'Aucune étape en cours.'});if(!r.paused)return cb({ok:false,error:'L’étape n’est pas en pause.'});
    const now=Date.now(),pauseMs=Math.max(0,now-(r.pausedAt||now));r.totalPausedMs=(r.totalPausedMs||0)+pauseMs;r.endsAt=now+Math.max(0,Number(r.pauseRemainingMs)||0);r.paused=false;r.pausedAt=null;r.pauseRemainingMs=null;if(state.activeTour)state.activeTour.incidents?.push({type:'resume',stageNumber:r.tourStageNumber,at:now,pauseMs});saveState();emitState();scheduleRoundTimer(r);maybeAutoEndRound();cb({ok:true});
  });
  socket.on('admin-add-round-time',({seconds},cb=()=>{})=>{
    if(!adminOnly(cb))return;const r=state.activeRound;if(!r)return cb({ok:false,error:'Aucune étape en cours.'});const add=clamp(seconds||10,1,60);r.durationSeconds=clamp(r.durationSeconds+add,5,180);r.endsAt+=add*1000;if(r.paused)r.pauseRemainingMs=(Number(r.pauseRemainingMs)||0)+add*1000;else scheduleRoundTimer(r);if(state.activeTour)state.activeTour.incidents?.push({type:'extra_time',stageNumber:r.tourStageNumber,at:Date.now(),seconds:add});saveState();emitState();cb({ok:true,seconds:add});
  });
  socket.on('admin-cancel-round',({mode},cb=()=>{})=>{if(!adminOnly(cb))return;cb(cancelActiveRound(mode==='skip'?'skip':'replay'));});
  socket.on('admin-reset-player-answer',({playerId},cb=()=>{})=>{
    if(!adminOnly(cb))return;const r=state.activeRound;if(!r)return cb({ok:false,error:'Aucune étape en cours.'});if(!(r.participantIds||[]).includes(playerId))return cb({ok:false,error:'Ce joueur ne participe pas à cette étape.'});if(!r.answers?.[playerId])return cb({ok:false,error:'Ce joueur n’a pas encore répondu.'});delete r.answers[playerId];if(completionTimer)clearTimeout(completionTimer);completionTimer=null;if(state.activeTour)state.activeTour.incidents?.push({type:'answer_reset',stageNumber:r.tourStageNumber,playerId,at:Date.now()});saveState();emitToPlayer(playerId,'answer-reset',{roundId:r.id});emitState();cb({ok:true});
  });
  socket.on('admin-exclude-player-from-round',({playerId},cb=()=>{})=>{
    if(!adminOnly(cb))return;const r=state.activeRound;if(!r)return cb({ok:false,error:'Aucune étape en cours.'});if(!(r.participantIds||[]).includes(playerId))return cb({ok:false,error:'Ce joueur est déjà hors de l’étape.'});delete r.answers?.[playerId];r.participantIds=r.participantIds.filter(id=>id!==playerId);if(state.activeTour)state.activeTour.incidents?.push({type:'player_excluded',stageNumber:r.tourStageNumber,playerId,at:Date.now()});saveState();emitToPlayer(playerId,'round-excluded',{roundId:r.id});emitState();maybeAutoEndRound();cb({ok:true});
  });
  socket.on('admin-rename-player',({playerId,name},cb=()=>{})=>{if(!adminOnly(cb))return;const p=state.players[playerId];if(!p)return cb({ok:false,error:'Joueur introuvable.'});const clean=sanitizeName(name,24);if(!clean)return cb({ok:false,error:'Nom invalide.'});p.name=clean;saveState();emitState();cb({ok:true,name:clean});});
  socket.on('admin-remove-player',({playerId},cb=()=>{})=>{
    if(!adminOnly(cb))return;const p=state.players[playerId];if(!p)return cb({ok:false,error:'Joueur introuvable.'});if(state.activeRound){delete state.activeRound.answers?.[playerId];state.activeRound.participantIds=(state.activeRound.participantIds||[]).filter(id=>id!==playerId);}delete state.players[playerId];emitToPlayer(playerId,'player-removed',{});saveState();emitState();maybeAutoEndRound();cb({ok:true});
  });

  socket.on('admin-start-round',({logoId,durationSeconds,autoEndWhenAllAnswered},cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeTour)return cb({ok:false,error:'Un Tour est en cours : utilise “Étape suivante”.'});cb(startRoundInternal(logoId,durationSeconds,{autoEndWhenAllAnswered:autoEndWhenAllAnswered!==undefined?!!autoEndWhenAllAnswered:state.settings.autoEndWhenAllAnswered!==false}));});
  socket.on('admin-end-round',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(!state.activeRound)return cb({ok:false,error:'Aucune manche.'});if(Date.now()<state.activeRound.startedAt)return cb({ok:false,error:'Le compte à rebours est encore en cours.'});endRound('manual');cb({ok:true});});
  socket.on('admin-update-settings',({roundSeconds,resultDelaySeconds,autoEndWhenAllAnswered},cb=()=>{})=>{if(!adminOnly(cb))return;if(roundSeconds!==undefined)state.settings.roundSeconds=clamp(roundSeconds,5,120);if(resultDelaySeconds!==undefined)state.settings.resultDelaySeconds=clamp(resultDelaySeconds,5,30);if(autoEndWhenAllAnswered!==undefined)state.settings.autoEndWhenAllAnswered=!!autoEndWhenAllAnswered;saveState();emitState();cb({ok:true});});
  socket.on('admin-reset-scores',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Termine la course avant de réinitialiser.'});resetScoresOnly();state.lastTourSummary=null;saveState();emitState();cb({ok:true});});
  socket.on('admin-clear-players',(_,cb=()=>{})=>{if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Termine la course avant de vider les joueurs.'});state.players={};state.roundHistory=[];state.lastTourSummary=null;saveState();emitState();cb({ok:true});});
  socket.on('admin-new-room-code',(_,cb=()=>{})=>{if(!adminOnly(cb))return;state.roomCode=roomCode();saveState();emitState();cb({ok:true,roomCode:state.roomCode});});

  socket.on('admin-export-pack',(_,cb=()=>{})=>{if(!adminOnly(cb))return;cb({ok:true,pack:{format:'toon-tone-tour-pack',version:5,exportedAt:Date.now(),logos:state.logos,tours:state.tours}});});
  socket.on('admin-import-pack',({pack},cb=()=>{})=>{
    if(!adminOnly(cb))return;if(state.activeRound||state.activeTour)return cb({ok:false,error:'Import impossible pendant une course.'});if(!pack||!Array.isArray(pack.logos))return cb({ok:false,error:'Fichier de pack invalide.'});
    const idMap=new Map();let added=0;
    for(const raw of pack.logos.slice(0,200)){if(!isValidDataImage(raw.logoImage)||!/^#[0-9A-Fa-f]{6}$/.test(String(raw.targetColor||'')))continue;const old=raw.id,newId=uid('l_');idMap.set(old,newId);state.logos.push(normalizeLogo({...raw,id:newId,name:sanitizeName(raw.name,40),targetColor:String(raw.targetColor).toUpperCase(),createdAt:Date.now()}));added++;}
    let tourAdded=0;for(const raw of (Array.isArray(pack.tours)?pack.tours:[]).slice(0,50)){const ids=(raw.logoIds||[]).map(id=>idMap.get(id)).filter(Boolean);if(!ids.length)continue;state.tours.push({id:uid('t_'),name:sanitizeName(raw.name||'Tour importé',50),logoIds:ids,createdAt:Date.now(),updatedAt:Date.now()});tourAdded++;}
    saveState();emitState();cb({ok:true,added,tourAdded});
  });

  socket.on('disconnect',()=>{const pid=socket.data.playerId;if(pid&&state.players[pid]){state.players[pid].online=false;state.players[pid].lastSeen=Date.now();saveState();emitState();}});
});

app.get('/health',(_,res)=>res.json({ok:true,roomCode:state.roomCode,players:Object.keys(state.players).length,version:APP_VERSION,activeTour:!!state.activeTour,scoringModel:'CIEDE2000',autoEndWhenAllAnswered:state.settings.autoEndWhenAllAnswered!==false}));
server.listen(PORT,()=>{console.log(`Toon Tone Tour ${APP_VERSION} listening on :${PORT}`);console.log(`Data directory: ${DATA_DIR}`);if(!process.env.ADMIN_PASSWORD)console.warn('WARNING: ADMIN_PASSWORD is not set. Default password is "admin".');});
