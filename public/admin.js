const socket=io(), $=id=>document.getElementById(id);
let adminState=null,fileData=null,ticker=null,previewRenderer=null,editingLogoId=null,targetAreaRatio=0;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtMs=ms=>(ms/1000).toFixed(1)+' s';
const CATS={easy:{label:'Facile',emoji:'🟢',points:2},medium:{label:'Moyen',emoji:'🔵',points:5},hard:{label:'Difficile',emoji:'🟡',points:10},very_hard:{label:'Très difficile',emoji:'🔴',points:15},hc:{label:'Hors catégorie',emoji:'⚫',points:20}};

function status(id,msg,bad=false){const e=$(id);e.textContent=msg;e.className='status '+(bad?'error':'success')}
function qualNote(p){return !p.qualified&&p.totalRounds?` <span class="qual-note">⚠ ${p.playedRounds}/${p.totalRounds}</span>`:''}
function standingsHtml(type,title,rows,scoreFn){return `<div class="jersey ${type}"><h3>${title}</h3>${rows.slice(0,7).map((p,i)=>`<div class="rank-row ${!p.qualified&&type!=='polka'?'provisional':''}"><div class="rank-num">${i+1}</div><div class="rank-name">${esc(p.name)}${p.online?'<span class="online-dot"></span>':''}</div><div class="rank-score">${scoreFn(p)}</div></div>`).join('')||'<div class="tiny muted">Pas de scores.</div>'}</div>`}

function areaScore(r){if(r>.40)return 0;if(r>.15)return 1;if(r>.05)return 2;return 3}
function difficultyPreview(){
  const n={huge:0,known:1,lesser:2,niche:3}[$('notoriety').value]??1;
  const i={main:0,secondary:1,accent:2}[$('colorImportance').value]??1;
  const d={iconic:0,distinctive:1,generic:2}[$('colorDistinctiveness').value]??1;
  const score=Math.max(1,Math.min(10,1+n+areaScore(targetAreaRatio)+i+d));
  let auto='easy'; if(score>=9)auto='hc'; else if(score>=7)auto='very_hard'; else if(score>=5)auto='hard'; else if(score>=3)auto='medium';
  const mode=$('difficultyMode').value;
  const key=mode==='auto'?auto:mode;
  const c=CATS[key]||CATS.medium;
  const pct=(targetAreaRatio*100).toFixed(1);
  $('difficultyEstimate').innerHTML=`${c.emoji} <strong>${c.label}</strong> · <strong>${c.points} pts</strong> montagne · score estimé ${score}/10 · zone ciblée ${pct}%${mode==='auto'?'':' · catégorie forcée'}`;
  return {score,key};
}
function logoPayload(){
  return {
    name:$('logoName').value,
    targetColor:$('targetColor').value,
    colorTolerance:$('colorTolerance').value,
    logoImage:fileData,
    notoriety:$('notoriety').value,
    colorImportance:$('colorImportance').value,
    colorDistinctiveness:$('colorDistinctiveness').value,
    difficultyMode:$('difficultyMode').value,
    targetAreaRatio
  };
}

function render(s){
  adminState=s;
  $('roomCode').textContent=s.roomCode;
  $('joinUrl').textContent=location.origin+'/?room='+s.roomCode;
  $('standings').innerHTML=
    standingsHtml('yellow','🟨 Jaune',s.standings.yellow,p=>p.yellowCount?`${p.yellowAvg.toFixed(1)}%${qualNote(p)}`:'—')+
    standingsHtml('green','🟩 Vert',s.standings.green,p=>p.yellowCount?`${fmtMs(p.greenAdjusted)}${qualNote(p)}`:'—')+
    standingsHtml('polka','🔴 Pois',s.standings.polka,p=>`${p.mountainPoints} pts`);

  $('logoCount').textContent=s.logos.length+' logo(s)';
  $('logoList').innerHTML=s.logos.map(l=>{
    const cat=CATS[l.difficultyCategory]||{emoji:'🏔️',label:l.difficultyLabel||'Moyen',points:l.difficultyPoints};
    return `<div class="logo-row"><img src="${l.logoImage}"><div class="logo-meta"><strong>${esc(l.name)}</strong><small><span class="color-dot" style="background:${l.targetColor}"></span>${l.targetColor} · tol. ${l.colorTolerance||42}<br>${cat.emoji} ${esc(cat.label)} · ${l.difficultyPoints} pts · score ${l.difficultyScore||'?'} / 10</small></div><div class="admin-actions"><button class="btn-soft" data-edit="${l.id}">✎</button><button class="btn-danger" data-del="${l.id}">×</button></div></div>`;
  }).join('')||'<div class="tiny muted">Ajoute ton premier logo.</div>';

  const sel=$('roundLogo'); const old=sel.value;
  sel.innerHTML=s.logos.map(l=>`<option value="${l.id}">${esc(l.name)} · ${(CATS[l.difficultyCategory]?.emoji||'🏔️')} ${l.difficultyPoints} pts</option>`).join('');
  if(s.logos.some(l=>l.id===old))sel.value=old;
  $('roundSeconds').value=s.settings.roundSeconds||20;

  $('playerCount').textContent=s.players.length+' joueur(s)';
  $('playerList').innerHTML=s.players.map(p=>`<div class="rank-row"><div>${p.online?'🟢':'⚪'}</div><div class="rank-name">${esc(p.name)}${!p.qualified&&p.totalRounds?` <span class="qual-note">provisoire ${p.playedRounds}/${p.totalRounds}</span>`:''}</div><div class="rank-score">${p.yellowCount?p.yellowAvg.toFixed(1)+'%':'—'}</div></div>`).join('')||'<div class="tiny muted">Aucun joueur connecté.</div>';

  $('history').innerHTML=s.roundHistory.slice(0,8).map(h=>`<div class="history-item"><strong>Étape ${h.roundNumber||'?'} · ${esc(h.logoName)}</strong> <span class="tiny muted">${h.difficultyEmoji||'🏔️'} ${esc(h.difficultyLabel||'')} · ${h.difficultyPoints} pts</span><div class="tiny">${h.results.slice(0,5).map((r,i)=>`${i+1}. ${esc(r.name)} ${r.proximity.toFixed(1)}%${r.mountainGain?` (+${r.mountainGain})`:''}`).join(' · ')}</div></div>`).join('')||'<div class="tiny muted">Aucune manche terminée.</div>';

  if(s.activeRound){
    $('roundPanel').classList.add('hidden'); $('activePanel').classList.remove('hidden');
    $('roundTitle').textContent=`Étape ${s.activeRound.roundNumber} · ${s.activeRound.logoName}`;
    $('activeLogo').src=s.activeRound.logoImage;
    $('activeDifficulty').textContent=`${s.activeRound.difficultyEmoji||'🏔️'} ${s.activeRound.difficultyLabel||''} · ${s.activeRound.difficultyPoints||0} pts montagne`;
    const n=s.activeRound.answerCount,total=Math.max(1,s.activeRound.participantCount||0);
    $('answerCount').textContent=n; $('participantCount').textContent=s.activeRound.participantCount||0; $('answerBar').style.width=Math.min(100,n/total*100)+'%';
    startTimer(s.activeRound);
  }else{
    $('roundPanel').classList.remove('hidden'); $('activePanel').classList.add('hidden'); $('roundTitle').textContent='Aucune manche'; $('roundTimer').textContent='—'; clearInterval(ticker);
  }
}

function startTimer(r){
  clearInterval(ticker);
  const d=()=>{
    const now=Date.now();
    if(now<r.startedAt){$('roundTimer').textContent='Départ '+Math.max(1,Math.ceil((r.startedAt-now)/1000));return;}
    $('roundTimer').textContent=(Math.max(0,r.endsAt-now)/1000).toFixed(1);
  };
  d(); ticker=setInterval(d,100);
}

async function rebuildPreview(){
  if(!fileData)return;
  try{
    if(!previewRenderer){previewRenderer=await LogoTone.create($('previewCanvas'),fileData,$('targetColor').value,$('colorTolerance').value)}
    else{previewRenderer.rebuildMask($('targetColor').value,$('colorTolerance').value);previewRenderer.render(null)}
    const stats=previewRenderer.maskStats?.(); targetAreaRatio=stats?.ratio||0; difficultyPreview(); $('previewWrap').classList.remove('hidden');
  }catch(e){status('logoStatus','Impossible de prévisualiser cette image.',true)}
}

function resetLogoForm(){
  editingLogoId=null; fileData=null; previewRenderer=null; targetAreaRatio=0;
  $('logoFormTitle').textContent='Ajouter un logo'; $('addLogo').textContent='Ajouter au parcours'; $('cancelEdit').classList.add('hidden');
  $('logoName').value=''; $('logoFile').value=''; $('targetColor').value='#F28C28'; $('colorTolerance').value='42'; $('toleranceValue').textContent='42';
  $('notoriety').value='known'; $('colorImportance').value='secondary'; $('colorDistinctiveness').value='distinctive'; $('difficultyMode').value='auto';
  $('previewWrap').classList.add('hidden'); $('logoStatus').classList.add('hidden'); difficultyPreview();
}

async function editLogo(id){
  const l=adminState?.logos.find(x=>x.id===id); if(!l)return;
  editingLogoId=id; fileData=l.logoImage; previewRenderer=null; targetAreaRatio=Number(l.targetAreaRatio)||0;
  $('logoFormTitle').textContent='Modifier '+l.name; $('addLogo').textContent='Enregistrer les modifications'; $('cancelEdit').classList.remove('hidden');
  $('logoName').value=l.name; $('targetColor').value=l.targetColor; $('colorTolerance').value=l.colorTolerance||42; $('toleranceValue').textContent=l.colorTolerance||42;
  $('notoriety').value=l.notoriety||'known'; $('colorImportance').value=l.colorImportance||'secondary'; $('colorDistinctiveness').value=l.colorDistinctiveness||'distinctive'; $('difficultyMode').value=l.difficultyMode||l.difficultyCategory||'auto';
  await rebuildPreview(); document.getElementById('logoEditorCard').scrollIntoView({behavior:'smooth',block:'start'});
}

$('loginBtn').onclick=()=>socket.emit('admin-login',{password:$('password').value},r=>{if(!r.ok)return status('loginStatus',r.error,true);$('loginCard').classList.add('hidden');$('adminApp').classList.remove('hidden');if(r.insecureDefault)alert('Sécurité : le mot de passe admin par défaut est "admin". Configure ADMIN_PASSWORD dans Railway.');render(r.state);difficultyPreview()});
socket.on('admin-state',render);
$('logoFile').onchange=()=>{const f=$('logoFile').files[0];if(!f)return;if(f.size>2_200_000)return status('logoStatus','Image trop lourde (vise moins de 2 Mo).',true);const rd=new FileReader();rd.onload=async()=>{fileData=rd.result;previewRenderer=null;await rebuildPreview()};rd.readAsDataURL(f)};
$('targetColor').addEventListener('input',rebuildPreview);
$('colorTolerance').addEventListener('input',()=>{$('toleranceValue').textContent=$('colorTolerance').value;rebuildPreview()});
['notoriety','colorImportance','colorDistinctiveness','difficultyMode'].forEach(id=>$(id).addEventListener('change',difficultyPreview));
$('previewCanvas').addEventListener('click',e=>{if(!previewRenderer)return;const sampled=previewRenderer.sampleAtEvent(e);if(!sampled)return;$('targetColor').value=sampled;previewRenderer.rebuildMask(sampled,$('colorTolerance').value);previewRenderer.render(null);const stats=previewRenderer.maskStats?.();targetAreaRatio=stats?.ratio||0;difficultyPreview();const pct=(targetAreaRatio*100).toFixed(1);status('logoStatus','Couleur cible sélectionnée : '+sampled+' · zone masquée : '+pct+' % du logo')});
$('addLogo').onclick=()=>{
  if(!fileData)return status('logoStatus','Choisis une image.',true);
  const payload=logoPayload();
  if(editingLogoId){payload.logoId=editingLogoId;socket.emit('admin-update-logo',payload,r=>{if(!r.ok)return status('logoStatus',r.error,true);status('logoStatus','Logo modifié !');setTimeout(resetLogoForm,500)})}
  else socket.emit('admin-add-logo',payload,r=>{if(!r.ok)return status('logoStatus',r.error,true);status('logoStatus','Logo ajouté !');setTimeout(resetLogoForm,500)});
};
$('cancelEdit').onclick=resetLogoForm;
$('logoList').onclick=e=>{const edit=e.target.closest('[data-edit]')?.dataset.edit;const del=e.target.closest('[data-del]')?.dataset.del;if(edit)return editLogo(edit);if(del&&confirm('Supprimer ce logo ?'))socket.emit('admin-delete-logo',{logoId:del},r=>{if(!r.ok)alert(r.error)})};
$('startRound').onclick=()=>{if(!$('roundLogo').value)return alert('Ajoute au moins un logo.');socket.emit('admin-start-round',{logoId:$('roundLogo').value,durationSeconds:$('roundSeconds').value},r=>{if(!r.ok)alert(r.error)})};
$('endRound').onclick=()=>socket.emit('admin-end-round',{},r=>{if(!r.ok)alert(r.error)});
$('roundSeconds').onchange=()=>socket.emit('admin-update-settings',{roundSeconds:$('roundSeconds').value},()=>{});
$('resetScores').onclick=()=>{if(confirm('Réinitialiser tous les classements ?'))socket.emit('admin-reset-scores',{},r=>{if(!r.ok)alert(r.error)})};
$('clearPlayers').onclick=()=>{if(confirm('Supprimer tous les joueurs et scores ?'))socket.emit('admin-clear-players',{},r=>{if(!r.ok)alert(r.error)})};
$('newCode').onclick=()=>{if(confirm('Changer le code de salle ? Les nouveaux joueurs devront utiliser le nouveau code.'))socket.emit('admin-new-room-code',{},()=>{})};
$('copyLink').onclick=async()=>{await navigator.clipboard.writeText(location.origin+'/?room='+adminState.roomCode);$('copyLink').textContent='Copié !';setTimeout(()=>$('copyLink').textContent='Copier le lien',1300)};
