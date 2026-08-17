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
const APP_VERSION = '2.1.0';

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: '4mb' }));
app.get('/version', (req, res) => res.json({ version: APP_VERSION, selectiveRecolor: true }));
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

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.activeRound = null; // never restore a running timer after a restart
      state.settings ||= { roundSeconds: DEFAULT_ROUND_SECONDS };
      state.logos = (state.logos || []).map(l => ({ ...l, colorTolerance: Number(l.colorTolerance) || 42 }));
      return state;
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

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    online: !!p.online,
    yellowAvg: p.yellowCount ? p.yellowTotal / p.yellowCount : 0,
    yellowCount: p.yellowCount || 0,
    greenTime: p.greenTime || 0,
    mountainPoints: p.mountainPoints || 0,
    lastAnswer: p.lastAnswer || null
  };
}

function standings() {
  const players = Object.values(state.players).map(publicPlayer);
  return {
    yellow: [...players].sort((a,b) => b.yellowAvg - a.yellowAvg || a.greenTime - b.greenTime),
    green: [...players].sort((a,b) => a.greenTime - b.greenTime || b.yellowAvg - a.yellowAvg),
    polka: [...players].sort((a,b) => b.mountainPoints - a.mountainPoints || b.yellowAvg - a.yellowAvg)
  };
}

function basicSnapshot() {
  return {
    roomCode: state.roomCode,
    players: Object.values(state.players).map(publicPlayer),
    standings: standings(),
    activeRound: state.activeRound ? {
      id: state.activeRound.id,
      logoId: state.activeRound.logoId,
      logoName: state.activeRound.logoName,
      logoImage: state.activeRound.logoImage,
      targetColor: state.activeRound.targetColor,
      colorTolerance: state.activeRound.colorTolerance || 42,
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

  const durationMs = round.durationSeconds * 1000;
  const results = Object.values(state.players).map(player => {
    const answer = round.answers[player.id];
    const elapsedMs = answer ? Math.min(durationMs, Math.max(0, answer.at - round.startedAt)) : durationMs;
    const proximity = answer ? proximityPct(answer.color, logo.targetColor) : 0;
    return { playerId: player.id, name: player.name, color: answer?.color || null, proximity, elapsedMs };
  });

  results.sort((a,b) => b.proximity - a.proximity || a.elapsedMs - b.elapsedMs);

  results.forEach((r) => {
    const p = state.players[r.playerId];
    if (!p) return;
    p.yellowTotal = (p.yellowTotal || 0) + r.proximity;
    p.yellowCount = (p.yellowCount || 0) + 1;
    p.greenTime = (p.greenTime || 0) + r.elapsedMs;
    p.lastAnswer = { proximity: r.proximity, elapsedMs: r.elapsedMs, color: r.color, roundId: round.id };
  });

  // Maillot à pois : les 3 meilleurs du logo marquent selon sa difficulté.
  const eligible = results.filter(r => r.color);
  const factors = [1, 0.6, 0.3];
  eligible.slice(0,3).forEach((r, idx) => {
    const p = state.players[r.playerId];
    if (p) p.mountainPoints = (p.mountainPoints || 0) + Math.max(1, Math.round(logo.difficultyPoints * factors[idx]));
  });

  const historyItem = {
    id: round.id,
    logoId: logo.id,
    logoName: logo.name,
    targetColor: logo.targetColor,
    difficultyPoints: logo.difficultyPoints,
    endedAt: Date.now(),
    reason,
    results: results.map(r => ({ ...r, proximity: Number(r.proximity.toFixed(1)) }))
  };
  state.roundHistory.push(historyItem);
  state.roundHistory = state.roundHistory.slice(-100);
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
    cb({ ok:true, playerId:p.id, roomCode:state.roomCode });
  });

  socket.on('submit-color', ({ roundId, color }, cb = () => {}) => {
    const pid = socket.data.playerId;
    const round = state.activeRound;
    if (!pid || !state.players[pid]) return cb({ ok:false, error:'Joueur non connecté.' });
    if (!round || round.id !== roundId) return cb({ ok:false, error:'Cette manche est terminée.' });
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
    const difficultyPoints = Math.max(1, Math.min(50, Number(payload?.difficultyPoints) || 5));
    const colorTolerance = Math.max(5, Math.min(90, Number(payload?.colorTolerance) || 42));
    const logoImage = payload?.logoImage;
    if (!name) return cb({ ok:false, error:'Nom du logo requis.' });
    if (!/^#[0-9A-F]{6}$/.test(targetColor)) return cb({ ok:false, error:'Couleur cible invalide.' });
    if (!isValidDataImage(logoImage)) return cb({ ok:false, error:'Image invalide ou trop lourde (max ~2 Mo).' });

    state.logos.push({ id:uid('l_'), name, targetColor, colorTolerance, difficultyPoints, logoImage, createdAt:Date.now() });
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
    const startedAt = Date.now();
    state.activeRound = {
      id: uid('r_'),
      logoId: logo.id,
      logoName: logo.name,
      logoImage: logo.logoImage,
      targetColor: logo.targetColor,
      colorTolerance: logo.colorTolerance || 42,
      durationSeconds: seconds,
      startedAt,
      endsAt: startedAt + seconds*1000,
      answers: {}
    };
    saveState(); emitState();
    roundTimer = setTimeout(() => endRound('timer'), seconds*1000 + 80);
    cb({ ok:true });
  });

  socket.on('admin-end-round', (_, cb = () => {}) => {
    if (!socket.data.admin) return cb({ ok:false, error:'Non autorisé.' });
    if (!state.activeRound) return cb({ ok:false, error:'Aucune manche.' });
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
      p.yellowTotal = 0; p.yellowCount = 0; p.greenTime = 0; p.mountainPoints = 0; p.lastAnswer = null;
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

app.get('/health', (_, res) => res.json({ ok:true, roomCode:state.roomCode, players:Object.keys(state.players).length }));

server.listen(PORT, () => {
  console.log(`Toon Tone Tour listening on :${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set. Default password is "admin".');
});
