const socket = io();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let me = { id: localStorage.getItem('ttt-player-id'), name: localStorage.getItem('ttt-name') || '' };
let state = null, tickTimer = null, activeRoundId = null, lastRoundResult = null;
let roundRenderer = null, renderedRoundId = null, hasPickedColor = false;

$('name').value = me.name;
const roomFromUrl = new URLSearchParams(location.search).get('room');
$('code').value = (roomFromUrl || localStorage.getItem('ttt-room-code') || '').toUpperCase();

function ms(ms){return (ms/1000).toFixed(1)+' s'}
function standingsHtml(type, title, rows, scoreFn){
  return `<div class="jersey ${type}"><h3>${title}</h3>${rows.slice(0,7).map((p,i)=>`<div class="rank-row"><div class="rank-num">${i+1}</div><div class="rank-name">${esc(p.name)}${p.online?'<span class="online-dot"></span>':''}</div><div class="rank-score">${scoreFn(p)}</div></div>`).join('') || '<div class="muted tiny">Pas encore de classement.</div>'}</div>`;
}
function renderStandings(){
  if(!state) return;
  $('standings').innerHTML = standingsHtml('yellow','🟨 Maillot jaune',state.standings.yellow,p=>p.yellowCount?`${p.yellowAvg.toFixed(1)}%`:'—') + standingsHtml('green','🟩 Maillot vert',state.standings.green,p=>p.yellowCount?ms(p.greenTime):'—') + standingsHtml('polka','🔴 Maillot à pois',state.standings.polka,p=>`${p.mountainPoints} pts`);
}
function enterGame(){ $('joinView').classList.add('hidden'); $('gameView').classList.remove('hidden'); }
function showStatus(msg,bad=false){ $('joinStatus').textContent=msg;$('joinStatus').className='status '+(bad?'error':'success'); }

async function prepareRoundLogo(r){
  if(renderedRoundId===r.id && roundRenderer) return;
  renderedRoundId=r.id;
  roundRenderer=null;
  try{
    roundRenderer=await LogoTone.create($('logoCanvas'),r.logoImage,r.targetColor,r.colorTolerance||42);
    if(renderedRoundId!==r.id) return;
    const mine=state?.players.find(p=>p.id===me.id);
    const savedAnswer=mine?.lastAnswer?.roundId===r.id ? mine.lastAnswer.color : null;
    roundRenderer.render(savedAnswer || (hasPickedColor ? $('colorPicker').value : null));
  }catch(e){
    console.error(e);
  }
}

function renderState(next){
  state=next; $('roomPill').textContent='Salle '+next.roomCode; renderStandings();
  if(me.id && next.players.some(p=>p.id===me.id)) enterGame();
  if(next.activeRound){
    const r=next.activeRound; activeRoundId=r.id;
    $('waitingView').classList.add('hidden'); $('resultView').classList.add('hidden'); $('roundView').classList.remove('hidden');
    $('logoName').textContent=r.logoName;
    const already = next.players.find(p=>p.id===me.id)?.lastAnswer?.roundId===r.id;
    $('colorControls').classList.toggle('hidden',!!already); $('locked').classList.toggle('hidden',!already);
    if(renderedRoundId!==r.id){
      hasPickedColor=false; $('colorPicker').value='#A6A6A6'; $('hexReadout').textContent='#A6A6A6';
      prepareRoundLogo(r);
    }
    startTicker(r.endsAt);
  } else if(!lastRoundResult){
    activeRoundId=null; renderedRoundId=null; roundRenderer=null; hasPickedColor=false; clearInterval(tickTimer); $('roundView').classList.add('hidden'); $('resultView').classList.add('hidden'); $('waitingView').classList.remove('hidden');
  }
}
function startTicker(endsAt){ clearInterval(tickTimer); const draw=()=>{const left=Math.max(0,endsAt-Date.now());$('timer').textContent=(left/1000).toFixed(1);if(left<=0) clearInterval(tickTimer)};draw();tickTimer=setInterval(draw,100); }

$('joinBtn').onclick=()=>{
  const name=$('name').value.trim(), roomCode=$('code').value.trim().toUpperCase();
  socket.emit('join',{name,playerId:me.id,roomCode},res=>{
    if(!res.ok) return showStatus(res.error,true);
    me.id=res.playerId;me.name=name;localStorage.setItem('ttt-player-id',me.id);localStorage.setItem('ttt-name',name);localStorage.setItem('ttt-room-code',res.roomCode);enterGame();
  });
};
$('code').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
$('colorPicker').addEventListener('input',e=>{
  const color=e.target.value.toUpperCase();
  hasPickedColor=true; $('hexReadout').textContent=color;
  if(roundRenderer) roundRenderer.render(color);
});
$('submitColor').onclick=()=>{
  if(!activeRoundId)return;
  $('submitColor').disabled=true;
  socket.emit('submit-color',{roundId:activeRoundId,color:$('colorPicker').value},res=>{
    $('submitColor').disabled=false;
    if(!res.ok) return alert(res.error);
    $('colorControls').classList.add('hidden');$('locked').classList.remove('hidden');
  });
};

socket.on('state', renderState);
socket.on('round-ended', hist=>{
  lastRoundResult=hist; activeRoundId=null;clearInterval(tickTimer);
  $('roundView').classList.add('hidden');$('waitingView').classList.add('hidden');$('resultView').classList.remove('hidden');
  $('resultLogo').textContent=hist.logoName;
  const mine=hist.results.find(r=>r.playerId===me.id);
  $('targetSwatch').style.background=hist.targetColor;
  $('mySwatch').style.background=mine?.color || '#777';
  $('myResult').textContent=mine?.color?`${mine.proximity.toFixed(1)} % de proximité · ${ms(mine.elapsedMs)}`:'Pas de réponse sur cette manche.';
  $('podium').innerHTML=hist.results.slice(0,3).map((r,i)=>`<div class="${i===0?'first':i===1?'second':'third'}"><div>${['🥇','🥈','🥉'][i]}</div><div>${esc(r.name)}</div><div>${r.proximity.toFixed(1)}%</div><div class="tiny">${ms(r.elapsedMs)}</div></div>`).join('');
  setTimeout(()=>{ if(!state?.activeRound){lastRoundResult=null;renderedRoundId=null;roundRenderer=null;hasPickedColor=false;$('resultView').classList.add('hidden');$('waitingView').classList.remove('hidden');}},7000);
});

if(me.id && me.name && $('code').value){
  socket.emit('join',{name:me.name,playerId:me.id,roomCode:$('code').value},res=>{if(res.ok)enterGame();});
}
