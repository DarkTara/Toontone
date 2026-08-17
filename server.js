const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 4e6,
  cors: { origin: true, credentials: true }
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'local-data'));
const DATA_FILE = path.join(DATA_DIR, 'game-state.json');
const DEFAULT_ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 20);
const COUNTDOWN_MS = 3000;
const APP_VERSION = '2.3.0';

const DIFFICULTY_CATEGORIES = {
  easy:      { key:'easy',      label:'Facile',           emoji:'🟢', points:2 },
  medium:    { key:'medium',    label:'Moyen',            emoji:'🔵', points:5 },
  hard:      { key:'hard',      label:'Difficile',        emoji:'🟡', points:10 },
  very_hard: { key:'very_hard', label:'Très difficile',   emoji:'🔴', points:15 },
  hc:        { key:'hc',        label:'Hors catégorie',   emoji:'⚫', points:20 }
};

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '4mb' }));
app.get('/version', (req, res) => res.json({ version: APP_VERSION, selectiveRecolor: true, gameplay23: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function defaultState() {
  return {
    roomCode: roomCode(),
    logos: [],
    players: {},
    activeRound: null,
    roundHistory: [],
    settings: { roundSeconds: DEFAULT_ROUND_SECONDS },
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
    colorTolerance: Number(l?.colorTolerance) || 42,
    difficultyMode: l?.difficultyMode === 'auto' || DIFFICULTY_CATEGORIES[l?.difficultyMode] ? l.difficultyMode : categoryKey,
    difficultyScore: Math.max(1, Math.min(10, Number(l?.difficultyScore) || Math.max(1, Math.min(10, Math.round((Number(l?.difficultyPoints) || cat.points) / 2))))),
    difficultyCategory: categoryKey,
    difficultyPoints: cat.points,
    notoriety: l?.notoriety || 'known',
    colorImportance: l?.colorImportance || 'secondary',
    colorDistinctiveness: l?.colorDistinctiveness || 'distinctive',
    targetAreaRatio: Math.max(0, Math.min(1, Number(l?.targetAreaRatio) || 0))
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
      loaded.settings ||= { roundSeconds: DEFAULT_ROUND_SECONDS };
      loaded.logos = (loaded.logos || []).map(normalizeLogo);
      loaded.roundHistory ||= [];
      loaded.players ||= {};
      const totalDuration = loaded.roundHistory.reduce((sum, h) => sum + historyDurationMs(h, loaded.settings), 0);
      Object.values(loaded.players).forEach(p => {
        p.yellowTotal = Number(p.yellowTotal) || 0;
        p.yellowCount = Number(p.yellowCount) || 0;
        p.greenTime = Number(p.greenTime) || 0;
        p.mountainPoints = Number(p.mountainPoints) || 0;
        if (!Number.isFinite(Number(p.participatedDurationMs))) {
          p.participatedDurationMs = Math.min(totalDuration, p.yellowCount * (Number(loaded.settings.roundSeconds) || DEFAULT_ROUND_SECONDS) * 1000);
        } else {
          p.participatedDurationMs = Number(p.participatedDurationMs) || 0;
        }
      });
      return loaded;
    }
  } catch (e) {
    console.error('Unable to load state:', e);
  }
  return defaultState();
}

let state = loadState();
let roundTimer = null;

function saveState() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 24).replace(/[<>]/g, '');
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
    id: p.id,
    name: p.name,
    online: !!p.online,
    yellowAvg: playedRounds ? (Number(p.yellowTotal) || 0) / playedRounds : 0,
    yellowCount: playedRounds,
    playedRounds,
    totalRounds,
    minRounds,
    qualified,
    greenTime: Number(p.greenTime) || 0,
    greenAdjusted,
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

function basicSnapshot() {
  return {
    roomCode: state.roomCode,
    players: Object.values(state.players).map(publicPlayer),
    standings: standings(),
    completedRounds: state.roundHistory.length,
    activeRound: state.activeRound ? {
      id: state.activeRound.id,
      logoId: state.activeRound.logoId,
      logoName: state.activeRound.logoName,
      logoImage: state.activeRound.logoImage,
      targetColor: state.activeRound.targetColor,
      colorTolerance: state.activeRound.colorTolerance || 42,
      difficultyCategory: state.activeRound.difficultyCategory,
      difficultyLabel: state.activeRound.difficultyLabel,
      difficultyEmoji: state.activeRound.difficultyEmoji,
      difficultyPoints: state.activeRound.difficultyPoints,
      roundNumber: state.activeRound.roundNumber,
      participantIds: state.activeRound.participantIds || [],
      participantCount: (state.activeRound.participantIds || []).length,
      answeredPlayerIds: Object.keys(state.activeRound.answers || {}),
      startedAt: state.activeRound.startedAt,
      endsAt: state.activeRound.endsAt,
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
    roundHistory: state.roundHistory.slice(-30).reverse()
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
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.00000;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = v => v > 0.008856 ? Math.pow(v, 1/3) : (7.787 * v) + 16/116;
  x = f(x); y = f(y); z = f(z);
  return { L: 116*y - 16, a: 500*(x-y), b: 200*(y-z) };
}

function proximityPct(aHex, bHex) {
  const a = hexToRgb(aHex), b = hexToRgb(bHex);
  if (!a || !b) return 0;
  const la = rgbToLab(a), lb = rgbToLab(b);
  const dE = Math.sqrt((la.L-lb.L)**2 + (la.a-lb.a)**2 + (la.b-lb.b)**2);
  return Math.max(0, Math.min(100, 100 - dE));
}

function isValidDataImage(src) {
  return typeof src === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(src) && src.length < 3_000_000;
}

function areaDifficultyScore(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (r > 0.40) return 0;
  if (r > 0.15) return 1;
  if (r > 0.05) return 2;
  return 3;
}

function computeDifficulty(payload = {}) {
  const notorietyScore = { huge:0, known:1, lesser:2, niche:3 }[payload.notoriety] ?? 1;
  const importanceScore = { main:0, secondary:1, accent:2 }[payload.colorImportance] ?? 1;
  const distinctivenessScore = { iconic:0, distinctive:1, generic:2 }[payload.colorDistinctiveness] ?? 1;
  const areaScore = areaDifficultyScore(payload.targetAreaRatio);
  const score = Math.max(1, Math.min(10, 1 + notorietyScore + areaScore + importanceScore + distinctivenessScore));
  let autoKey = 'easy';
  if (score >= 9) autoKey = 'hc';
  else if (score >= 7) autoKey = 'very_hard';
  else if (score >= 5) autoKey = 'hard';
  else if (score >= 3) autoKey = 'medium';
  const requested = String(payload.difficultyMode || 'auto');
  const categoryKey = requested === 'auto' ? autoKey : (DIFFICULTY_CATEGORIES[requested] ? requested : autoKey);
  const cat = DIFFICULTY_CATEGORIES[categoryKey];
  return {
    difficultyMode: requested === 'auto' ? 'auto' : categoryKey,
    difficultyScore: score,
    difficultyCategory: categoryKey,
    difficultyLabel: cat.label,
    difficultyEmoji: cat.emoji,
    difficultyPoints: cat.points,
    notoriety: ['huge','known','lesser','niche'].includes(payload.notoriety) ? payload.notoriety : 'known',
    colorImportance: ['main','secondary','accent'].includes(payload.colorImportance) ? payload.colorImportance : 'secondary',
    colorDistinctiveness: ['iconic','distinctive','generic'].includes(payload.colorDistinctiveness) ? payload.colorDistinctiveness : 'distinctive',
    targetAreaRatio: Math.max(0, Math.min(1, Number(payload.targetAreaRatio) || 0))
  };
}

function leaderFromRows(rows, type) {
  if (type === 'polka') return rows.find(p => p.mountainPoints > 0) || null;
  return rows.find(p => p.qualified && p.yellowCount > 0) || null;
}

function rankMap(rows) {
  const m = new Map();
  rows.forEach((p, i) => m.set(p.id, i + 1));
  return m;
}

function leaderChanges(before, after) {
  const labels = {
    yellow: { jersey:'yellow', label:'Maillot jaune', emoji:'🟨' },
    green: { jersey:'green', label:'Maillot vert', emoji:'🟩' },
    polka: { jersey:'polka', label:'Maillot à pois', emoji:'🔴' }
  };
  return Object.keys(labels).map(type => {
    const b = leaderFromRows(before[type], type);
    const a = leaderFromRows(after[type], type);
    return {
      ...labels[type],
      before: b ? { id:b.id, name:b.name } : null,
      after: a ? { id:a.id, name:a.name } : null,
      changed: (b?.id || null) !== (a?.id || null)
    };
  }).filter(x => x.after);
}

function endRound(reason = 'timer') {
  if (!state.activeRound) return;
  if (roundTimer) clearTimeout(roundTimer);
  roundTimer = null;

  const round = state.activeRound;
  const logo = state.logos.find(l => l.id === round.logoId);
  if (!logo) {
    state.activeRound = null;
    saveState();
    emitState();
    return;
  }

  const beforeStandings = standings();
  const beforeYellowRanks = rankMap(beforeStandings.yellow);
  const durationMs = round.durationSeconds * 1000;
  const participantIds = round.participantIds || [];
  const results = participantIds.map(playerId => {
    const player = state.players[playerId];
    if (!player) return null;
    const answer = round.answers[player.id];
    const elapsedMs = answer ? Math.min(durationMs, Math.max(0, answer.at - round.startedAt)) : durationMs;
    const proximity = answer ? proximityPct(answer.color, logo.targetColor) : 0;
    return { playerId: player.id, name: player.name, color: answer?.color || null, proximity, elapsedMs, mountainGain:0 };
  }).filter(Boolean);

  results.sort((a,b) => b.proximity - a.proximity || a.elapsedMs - b.elapsedMs);

  results.forEach((r, idx) => {
    r.roundRank = idx + 1;
    const p = state.players[r.playerId];
    if (!p) return;
    p.yellowTotal = (p.yellowTotal || 0) + r.proximity;
    p.yellowCount = (p.yellowCount || 0) + 1;
    p.greenTime = (p.greenTime || 0) + r.elapsedMs;
    p.participatedDurationMs = (p.participatedDurationMs || 0) + durationMs;
    p.lastAnswer = { proximity: r.proximity, elapsedMs: r.elapsedMs, color: r.color, roundId: round.id };
  });

  const eligible = results.filter(r => r.color);
  const factors = [1, 0.75, 0.5, 0.3, 0.15];
  eligible.slice(0,5).forEach((r, idx) => {
    const gain = Math.max(1, Math.round(logo.difficultyPoints * factors[idx]));
    r.mountainGain = gain;
    const p = state.players[r.playerId];
    if (p) p.mountainPoints = (p.mountainPoints || 0) + gain;
  });

  const historyItem = {
    id: round.id,
    logoId: logo.id,
    logoName: logo.name,
    logoImage: logo.logoImage,
    targetColor: logo.targetColor,
    colorTolerance: logo.colorTolerance || 42,
    difficultyCategory: logo.difficultyCategory,
    difficultyLabel: DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.label || logo.difficultyLabel || 'Moyen',
    difficultyEmoji: DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.emoji || logo.difficultyEmoji || '🔵',
    difficultyPoints: logo.difficultyPoints,
    difficultyScore: logo.difficultyScore,
    roundNumber: round.roundNumber,
    durationMs,
    participantCount: participantIds.length,
    endedAt: Date.now(),
    reason,
    results: results.map(r => ({ ...r, proximity: Number(r.proximity.toFixed(1)) }))
  };

  state.roundHistory.push(historyItem);
  state.roundHistory = state.roundHistory.slice(-100);

  const afterStandings = standings();
  const afterYellowRanks = rankMap(afterStandings.yellow);
  historyItem.results.forEach(r => {
    r.yellowRankBefore = beforeStandings.yellow.length && state.roundHistory.length > 1 ? (beforeYellowRanks.get(r.playerId) || null) : null;
    r.yellowRankAfter = afterYellowRanks.get(r.playerId) || null;
    r.yellowRankDelta = r.yellowRankBefore && r.yellowRankAfter ? r.yellowRankBefore - r.yellowRankAfter : 0;
  });
  historyItem.leaderChanges = leaderChanges(beforeStandings, afterStandings);

  state.activeRound = null;
  saveState();

  io.emit('round-ended', historyItem);
  emitState();
}

io.on('connection', (socket) => {
  socket.emit('state', basicSnapshot());

  socket.on('join', ({ name, playerId, roomCode: code }, cb = () => {}) => {
    const cleanName = sanitizeName(name);
    if (!cleanName) return cb({ ok:false, error:'Nom requis.' });
    if (String(code || '').trim().toUpperCase() !== state.roomCode) return cb({ ok:false, error:'Code de salle incorrect.' });

    let p = playerId && state.players[playerId];
    if (!p) {
      const id = uid('p_');
      p = state.players[id] = {
        id,
        name: cleanName,
        yellowTotal: 0,
        yellowCount: 0,
        greenTime: 0,
        participatedDurationMs: 0,
        mountainPoints: 0,
        online: true,
        lastSeen: Date.now(),
        lastAnswer: null
      };
    } else {
      p.name = cleanName;
      p.online = true;
      p.lastSeen = Date.now();
    }
    socket.data.playerId = p.id;
    socket.join('players');
    saveState();
    emitState();
    cb({ ok:true, playerId:p.id, roomCode:state.roomCode, waitNextRound: !!state.activeRound && !(state.activeRound.participantIds || []).includes(p.id) });
  });

  socket.on('submit-color', ({ roundId, color }, cb = () => {}) => {
    const pid = socket.data.playerId;
    const round = state.activeRound;
    if (!pid || !state.players[pid]) return cb({ ok:false, error:'Joueur non connecté.' });
    if (!round || round.id !== roundId) return cb({ ok:false, error:'Cette manche est terminée.' });
    if (!(round.participantIds || []).includes(pid)) return cb({ ok:false, error:'Tu as rejoint pendant la manche : tu participeras à la prochaine étape.' });
    if (Date.now() < round.startedAt) return cb({ ok:false, error:'Le départ n’est pas encore donné.' });
    if (!/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return cb({ ok:false, error:'Couleur invalide.' });
    if (round.answers[pid]) return cb({ ok:false, error:'Réponse déjà envoyée.' });
    if (Date.now() > round.endsAt + 300) return cb({ ok:false, error:'Temps écoulé.' });

    round.answers[pid] = { color: color.toUpperCase(), at: Date.now() };
    state.players[pid].lastSeen = Date.now();
    saveState();
    io.to('admins').emit('admin-state', adminSnapshot());
    cb({ ok:true, elapsedMs: round.answers[pid].at - round.startedAt });
  });

  socket.on('admin-login', ({ password }, cb = () => {}) => {
    if (String(password || '') !== ADMIN_PASSWORD) return cb({ ok:false, error:'Mot de passe incorrect.' });
    socket.data.admin = true;
    socket.join('admins');
    cb({ ok:true, state:adminSnapshot(), insecureDefault: !process.env.ADMIN_PASSWORD });
  });

  socket.on('admin-add-logo', (payload, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    const name = sanitizeName(payload?.name);
    const targetColor = String(payload?.targetColor || '').toUpperCase();
    const colorTolerance = Math.max(5, Math.min(90, Number(payload?.colorTolerance) || 42));
    const logoImage = payload?.logoImage;
    if (!name) return cb({ ok:false, error:'Nom du logo requis.' });
    if (!/^#[0-9A-F]{6}$/.test(targetColor)) return cb({ ok:false, error:'Couleur cible invalide.' });
    if (!isValidDataImage(logoImage)) return cb({ ok:false, error:'Image invalide ou trop lourde (max ~2 Mo).' });
    const diff = computeDifficulty(payload);
    state.logos.push({ id:uid('l_'), name, targetColor, colorTolerance, logoImage, createdAt:Date.now(), ...diff });
    saveState();
    emitState();
    cb({ ok:true });
  });

  socket.on('admin-update-logo', (payload, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (state.activeRound?.logoId === payload?.logoId) return cb({ ok:false, error:'Impossible de modifier le logo pendant sa manche.' });
    const logo = state.logos.find(l => l.id === payload?.logoId);
    if (!logo) return cb({ ok:false, error:'Logo introuvable.' });
    const name = sanitizeName(payload?.name);
    const targetColor = String(payload?.targetColor || '').toUpperCase();
    const colorTolerance = Math.max(5, Math.min(90, Number(payload?.colorTolerance) || 42));
    const logoImage = payload?.logoImage || logo.logoImage;
    if (!name) return cb({ ok:false, error:'Nom du logo requis.' });
    if (!/^#[0-9A-F]{6}$/.test(targetColor)) return cb({ ok:false, error:'Couleur cible invalide.' });
    if (!isValidDataImage(logoImage)) return cb({ ok:false, error:'Image invalide ou trop lourde (max ~2 Mo).' });
    const diff = computeDifficulty(payload);
    Object.assign(logo, { name, targetColor, colorTolerance, logoImage, updatedAt:Date.now(), ...diff });
    saveState();
    emitState();
    cb({ ok:true });
  });

  socket.on('admin-delete-logo', ({ logoId }, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (state.activeRound?.logoId === logoId) return cb({ ok:false, error:'Impossible pendant la manche active.' });
    state.logos = state.logos.filter(l => l.id !== logoId);
    saveState(); emitState(); cb({ ok:true });
  });

  socket.on('admin-start-round', ({ logoId, durationSeconds }, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (state.activeRound) return cb({ ok:false, error:'Une manche est déjà en cours.' });
    const logo = state.logos.find(l => l.id === logoId);
    if (!logo) return cb({ ok:false, error:'Logo introuvable.' });
    const seconds = Math.max(5, Math.min(120, Number(durationSeconds) || state.settings.roundSeconds || 20));
    const now = Date.now();
    const startedAt = now + COUNTDOWN_MS;
    const participantIds = Object.values(state.players).filter(p => p.online).map(p => p.id);
    state.activeRound = {
      id: uid('r_'),
      logoId: logo.id,
      logoName: logo.name,
      logoImage: logo.logoImage,
      targetColor: logo.targetColor,
      colorTolerance: logo.colorTolerance || 42,
      difficultyCategory: logo.difficultyCategory,
      difficultyLabel: DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.label || 'Moyen',
      difficultyEmoji: DIFFICULTY_CATEGORIES[logo.difficultyCategory]?.emoji || '🔵',
      difficultyPoints: logo.difficultyPoints,
      roundNumber: state.roundHistory.length + 1,
      participantIds,
      durationSeconds: seconds,
      createdAt: now,
      startedAt,
      endsAt: startedAt + seconds*1000,
      answers: {}
    };
    saveState(); emitState();
    roundTimer = setTimeout(() => endRound('timer'), COUNTDOWN_MS + seconds*1000 + 80);
    cb({ ok:true, participantCount: participantIds.length });
  });

  socket.on('admin-end-round', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (!state.activeRound) return cb({ ok:false, error:'Aucune manche.' });
    if (Date.now() < state.activeRound.startedAt) return cb({ ok:false, error:'Le compte à rebours est encore en cours.' });
    endRound('manual');
    cb({ ok:true });
  });

  socket.on('admin-update-settings', ({ roundSeconds }, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    state.settings.roundSeconds = Math.max(5, Math.min(120, Number(roundSeconds) || 20));
    saveState(); emitState(); cb({ ok:true });
  });

  socket.on('admin-reset-scores', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (state.activeRound) return cb({ ok:false, error:'Termine la manche avant de réinitialiser.' });
    Object.values(state.players).forEach(p => {
      p.yellowTotal = 0; p.yellowCount = 0; p.greenTime = 0; p.participatedDurationMs = 0; p.mountainPoints = 0; p.lastAnswer = null;
    });
    state.roundHistory = [];
    saveState(); emitState(); cb({ ok:true });
  });

  socket.on('admin-clear-players', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (state.activeRound) return cb({ ok:false, error:'Termine la manche avant de vider les joueurs.' });
    state.players = {};
    state.roundHistory = [];
    saveState(); emitState(); cb({ ok:true });
  });

  socket.on('admin-new-room-code', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    state.roomCode = roomCode();
    saveState(); emitState(); cb({ ok:true, roomCode:state.roomCode });
  });

  socket.on('disconnect', () => {
    const pid = socket.data.playerId;
    if (pid && state.players[pid]) {
      state.players[pid].online = false;
      state.players[pid].lastSeen = Date.now();
      saveState(); emitState();
    }
  });
});

app.get('/health', (_, res) => res.json({ ok:true, roomCode:state.roomCode, players:Object.keys(state.players).length, version:APP_VERSION }));

server.listen(PORT, () => {
  console.log(`Toon Tone Tour ${APP_VERSION} listening on :${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set. Default password is "admin".');
});
