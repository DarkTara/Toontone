const socket = io();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let me = { id: localStorage.getItem('ttt-player-id'), name: localStorage.getItem('ttt-name') || '' };
let state = null, tickTimer = null, activeRoundId = null, lastRoundResult = null;
let roundRenderer = null, renderedRoundId = null, hasPickedColor = false, submittedThisRound = false;

$('name').value = me.name;
const roomFromUrl = new URLSearchParams(location.search).get('room');
$('code').value = (roomFromUrl || localStorage.getItem('ttt-room-code') || '').toUpperCase();

function ms(ms){ return (ms/1000).toFixed(1)+' s'; }
function qualNote(p){ return !p.qualified && p.totalRounds ? `<span class="qual-note">⚠ ${p.playedRounds}/${p.totalRounds}</span>` : ''; }
function standingsHtml(type, title, rows, scoreFn){
  return `<div class="jersey ${type}"><h3>${title}</h3>${rows.slice(0,7).map((p,i)=>`<div class="rank-row ${!p.qualified && type!=='polka'?'provisional':''}"><div class="rank-num">${i+1}</div><div class="rank-name">${esc(p.name)}${p.online?'<span class="online-dot"></span>':''}</div><div class="rank-score">${scoreFn(p)}</div></div>`).join('') || '<div class="muted tiny">Pas encore de classement.</div>'}</div>`;
}
function renderStandings(){
  if(!state) return;
  $('standings').innerHTML =
    standingsHtml('yellow','🟨 Maillot jaune',state.standings.yellow,p=>p.yellowCount?`${p.yellowAvg.toFixed(1)}%${qualNote(p)}`:'—') +
    standingsHtml('green','🟩 Maillot vert',state.standings.green,p=>p.yellowCount?`${ms(p.greenAdjusted)}${qualNote(p)}`:'—') +
    standingsHtml('polka','🔴 Maillot à pois',state.standings.polka,p=>`${p.mountainPoints} pts`);
}
function enterGame(){ $('joinView').classList.add('hidden'); $('gameView').classList.remove('hidden'); }
function showStatus(msg,bad=false){ $('joinStatus').textContent=msg; $('joinStatus').className='status '+(bad?'error':'success'); }

async function prepareRoundLogo(r){
  if(renderedRoundId===r.id && roundRenderer) return;
  renderedRoundId=r.id;
  roundRenderer=null;
  try{
    roundRenderer=await LogoTone.create($('logoCanvas'),r.logoImage,r.targetColor,r.colorTolerance||42);
    if(renderedRoundId!==r.id) return;
    roundRenderer.render(hasPickedColor ? $('colorPicker').value : null);
  }catch(e){ console.error(e); }
}

function setPlayControls(r){
  const participant = (r.participantIds || []).includes(me.id);
  const answered = submittedThisRound || (r.answeredPlayerIds || []).includes(me.id);
  $('spectatorRound').classList.toggle('hidden', participant);
  $('colorControls').classList.toggle('hidden', !participant || answered);
  $('locked').classList.toggle('hidden', !participant || !answered);
}

function startTicker(r){
  clearInterval(tickTimer);
  const draw=()=>{
    const now=Date.now();
    if(now < r.startedAt){
      const n=Math.max(1,Math.ceil((r.startedAt-now)/1000));
      $('countdownOverlay').classList.remove('hidden');
      $('countdownNumber').textContent=n;
      $('countdownMeta').textContent=`Étape ${r.roundNumber} · ${r.difficultyEmoji||'🏔️'} ${r.difficultyLabel||''} · ${r.difficultyPoints||0} pts`;
      $('roundContent').classList.add('countdown-hidden');
      $('timer').textContent='—';
      return;
    }
    $('countdownOverlay').classList.add('hidden');
    $('roundContent').classList.remove('countdown-hidden');
    setPlayControls(r);
    const left=Math.max(0,r.endsAt-now);
    $('timer').textContent=(left/1000).toFixed(1);
    if(left<=0) clearInterval(tickTimer);
  };
  draw(); tickTimer=setInterval(draw,100);
}

function renderState(next){
  state=next;
  $('roomPill').textContent='Salle '+next.roomCode;
  renderStandings();
  if(me.id && next.players.some(p=>p.id===me.id)) enterGame();
  if(next.activeRound){
    const r=next.activeRound;
    if(activeRoundId!==r.id){ submittedThisRound=false; }
    activeRoundId=r.id;
    $('waitingView').classList.add('hidden'); $('resultView').classList.add('hidden'); $('roundView').classList.remove('hidden');
    $('logoName').textContent=r.logoName;
    $('stageMeta').textContent=`ÉTAPE ${r.roundNumber} · ${r.difficultyEmoji||'🏔️'} ${r.difficultyLabel||''} · ${r.difficultyPoints||0} pts montagne`;
    if(renderedRoundId!==r.id){
      hasPickedColor=false; $('colorPicker').value='#A6A6A6'; $('hexReadout').textContent='#A6A6A6';
      prepareRoundLogo(r);
    }
    setPlayControls(r);
    startTicker(r);
  } else if(!lastRoundResult){
    activeRoundId=null; renderedRoundId=null; roundRenderer=null; hasPickedColor=false; submittedThisRound=false;
    clearInterval(tickTimer);
    $('roundView').classList.add('hidden'); $('resultView').classList.add('hidden'); $('waitingView').classList.remove('hidden');
  }
}

async function renderResultLogos(hist, myColor){
  try{
    const myCanvas = $('resultMyLogoCanvas');
    const trueCanvas = $('resultTrueLogoCanvas');
    if(!hist?.logoImage || !myCanvas || !trueCanvas) return;
    const tol = hist.colorTolerance || 42;
    const mineRenderer = await LogoTone.create(myCanvas, hist.logoImage, hist.targetColor, tol);
    mineRenderer.render(myColor || null);
    const trueRenderer = await LogoTone.create(trueCanvas, hist.logoImage, hist.targetColor, tol);
    trueRenderer.renderOriginal();
  }catch(e){ console.error("Impossible d'afficher les logos de résultat", e); }
}

function renderJerseyChanges(hist){
  const changes=(hist.leaderChanges||[]).filter(c=>c.changed && c.after);
  $('jerseyChanges').innerHTML=changes.map((c,i)=>`<div class="jersey-change ${c.jersey}" style="animation-delay:${i*.14}s"><div class="jersey-change-icon">${c.emoji}</div><div><strong>${esc(c.after.name)}</strong> ${c.before?'prend':'endosse'} le <strong>${esc(c.label.toLowerCase())}</strong>${c.before?` à ${esc(c.before.name)}`:''} !</div></div>`).join('');
}

$('joinBtn').onclick=()=>{
  const name=$('name').value.trim(), roomCode=$('code').value.trim().toUpperCase();
  socket.emit('join',{name,playerId:me.id,roomCode},res=>{
    if(!res.ok) return showStatus(res.error,true);
    me.id=res.playerId; me.name=name;
    localStorage.setItem('ttt-player-id',me.id); localStorage.setItem('ttt-name',name); localStorage.setItem('ttt-room-code',res.roomCode);
    enterGame();
    if(res.waitNextRound) showStatus('Tu es dans la salle : la manche en cours est déjà partie, tu joueras la suivante.');
  });
};
$('code').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
$('colorPicker').addEventListener('input',e=>{
  const color=e.target.value.toUpperCase();
  hasPickedColor=true; $('hexReadout').textContent=color;
  if(roundRenderer) roundRenderer.render(color);
});
$('submitColor').onclick=()=>{
  if(!activeRoundId) return;
  $('submitColor').disabled=true;
  socket.emit('submit-color',{roundId:activeRoundId,color:$('colorPicker').value},res=>{
    $('submitColor').disabled=false;
    if(!res.ok) return alert(res.error);
    submittedThisRound=true;
    $('colorControls').classList.add('hidden'); $('locked').classList.remove('hidden');
  });
};

socket.on('state', renderState);
socket.on('round-ended', hist=>{
  lastRoundResult=hist; activeRoundId=null; clearInterval(tickTimer);
  $('roundView').classList.add('hidden'); $('waitingView').classList.add('hidden'); $('resultView').classList.remove('hidden');
  $('resultLogo').textContent=`Étape ${hist.roundNumber} · ${hist.logoName} · ${hist.difficultyEmoji||'🏔️'} ${hist.difficultyLabel||''}`;
  const mine=hist.results.find(r=>r.playerId===me.id);
  const winner=hist.results[0];
  $('targetSwatch').style.background=hist.targetColor;
  $('targetHex').textContent=hist.targetColor;
  $('mySwatch').style.background=mine?.color || '#777';
  $('myHex').textContent=mine?.color || '—';
  $('myResult').textContent=mine?.color?`${mine.proximity.toFixed(1)} % de proximité · ${ms(mine.elapsedMs)}`:'Pas de réponse sur cette manche.';

  const stats=[];
  if(mine){
    stats.push(`<span>🏁 <strong>${mine.roundRank}e</strong> / ${hist.participantCount}</span>`);
    if(mine.mountainGain) stats.push(`<span>🏔️ <strong>+${mine.mountainGain} pts</strong></span>`);
    else stats.push('<span>🏔️ +0 pt</span>');
    if(mine.color && winner) stats.push(`<span>🎯 Écart vainqueur <strong>-${Math.max(0,winner.proximity-mine.proximity).toFixed(1)} pt</strong></span>`);
    if(mine.yellowRankDelta>0) stats.push(`<span>📈 <strong>+${mine.yellowRankDelta} place${mine.yellowRankDelta>1?'s':''}</strong> au jaune</span>`);
    if(mine.yellowRankDelta<0) stats.push(`<span>📉 <strong>${mine.yellowRankDelta} place${mine.yellowRankDelta<-1?'s':''}</strong> au jaune</span>`);
    if(mine.yellowRankDelta===0 && mine.yellowRankAfter) stats.push(`<span>🟨 <strong>${mine.yellowRankAfter}e</strong> au général</span>`);
  }
  $('resultStats').innerHTML=stats.join('');
  renderResultLogos(hist, mine?.color || null);
  renderJerseyChanges(hist);
  $('podium').innerHTML=hist.results.slice(0,3).map((r,i)=>`<div class="${i===0?'first':i===1?'second':'third'}"><div>${['🥇','🥈','🥉'][i]}</div><div>${esc(r.name)}</div><div>${r.proximity.toFixed(1)}%</div><div class="tiny">${ms(r.elapsedMs)}${r.mountainGain?` · +${r.mountainGain} 🏔️`:''}</div></div>`).join('');
  setTimeout(()=>{
    if(!state?.activeRound){
      lastRoundResult=null; renderedRoundId=null; roundRenderer=null; hasPickedColor=false; submittedThisRound=false;
      $('resultView').classList.add('hidden'); $('waitingView').classList.remove('hidden');
    }
  },9000);
});

if(me.id && me.name && $('code').value){
  socket.emit('join',{name:me.name,playerId:me.id,roomCode:$('code').value},res=>{ if(res.ok) enterGame(); });
}
