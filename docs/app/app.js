import {createOperationLoading} from './operation-loading.js?v=3.5.0';
import {createSession,normalizeSession,elapsedSeconds,pauseSession,resumeSession,restartSession} from './workout-session.js?v=3.5.0';
import * as store from './db.js?v=3.5.0';
import {parseMusicLink} from './music-links.js?v=3.5.0';
import {localAccount} from './local-account.js?v=3.5.0';
import {createLocalBiometric} from './local-biometric.js?v=3.5.0';
import {createLocalAuthUI} from './local-auth-ui.js?v=3.5.0';
import {createYouTubeAccount} from './youtube-account.js?v=3.5.0';
import {createSpotifyAccount} from './spotify-account.js?v=3.5.0';
import {createMusicPlayer} from './music-player.js?v=3.5.0';
import {renderChart,filterRange,summarize} from './charts.js?v=3.5.0';
'use strict';
const cassette = () => '<img src="/peragym/docs/assets/cassette.svg" class="cassette-icon" alt="" aria-hidden="true">';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${({
  gym:'<path d="m6 6 12 12M3 8l5-5m8 18 5-5M1 6l5-5m12 22 5-5M5 12l7-7m0 14 7-7"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',
  check:'<path d="m5 12 5 5L20 7"/>',
  edit:'<path d="m15 4 5 5M3 21l5-1L21 7l-5-5L3 15Zm0 0 5-1-5-5"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back:'<path d="m14 5-7 7 7 7"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.4 7M3 4v7h7m2-4v6l4 2"/>',
  leaf:'<path d="M20 3C8 2 1 10 5 17s17 3 15-14ZM4 21 15 10"/>'
})[name] || ''}</svg>`;

const operationLoading=createOperationLoading();
const loadingMessages={load:'Abrindo seus registros…',saveWorkout:'Salvando ficha…',deleteWorkout:'Excluindo ficha…',deleteSession:'Excluindo treino do histórico…',updateWeight:'Salvando carga…',finishWorkout:'Registrando treino…',setSetting:'Salvando no aparelho…',saveBodyWeight:'Salvando peso…',deleteBodyWeight:'Excluindo registro…',exportBackup:'Preparando backup…',importBackup:'Importando backup…',migrateLegacy:'Copiando seus treinos…'};
const db=Object.fromEntries(Object.entries(store).map(([name,value])=>[name,loadingMessages[name]?(...args)=>operationLoading.run(loadingMessages[name],()=>value(...args)):value]));
let authBusyRelease=null;
function authBusy(message){authBusyRelease?.();authBusyRelease=message?operationLoading.start(message):null;}
let data = {workouts:[],sessions:[],loadHistory:[],bodyWeights:[],musicLinks:[],theme:'light'};
const musicPlayer = createMusicPlayer($('#music-deck'),{account:()=>spotifyAccount});
let page = 'inicio', selectedId = null, editingId = 0, active = null, restUntil = 0;
let timerHandle, toastHandle, restHandle, draftInitial = '';
let chartExerciseId='', chartRange='90', submitting=false, handling=false;
let spotifyAccount=null, youtubeAccount=null, musicConfigLoaded=false, spotifyPlaylists=[], youtubePlaylists=[], youtubeTracks=[], musicBusy=false, youtubeBusy=false, playlistRequest=0, youtubeRequest=0, musicGeneration=0;
let legacyStatus=null, youtubePreparing=false;
const localBiometric=createLocalBiometric({account:localAccount});
const authUI=createLocalAuthUI({mount:$('#main'),account:localAccount,biometric:localBiometric,onUnlock:unlockApp,onLock:lockApp,onBusy:authBusy,onRefresh:async()=>{await refresh();render();}});
let returningFromSpotify=new URLSearchParams(location.search).has('state') && (new URLSearchParams(location.search).has('code')||new URLSearchParams(location.search).has('error'));
if(returningFromSpotify)page='musica';
const formatKg = n => Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const timeText = seconds => `${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
const workout = id => data.workouts.find(w=>w.id===id);

async function call(method, ...args) {
  if(method==='load')return db.load();
  if(method==='saveWorkout')return db.saveWorkout(JSON.parse(args[0]));
  if(method==='deleteWorkout')return db.deleteWorkout(args[0]);
  if(method==='updateWeight')return db.updateWeight(args[0],args[1]);
  if(method==='finishWorkout')return db.finishWorkout(JSON.parse(args[0]));
  if(method==='setTheme')return db.setSetting('theme',args[0]);
  throw new Error('Operação indisponível.');
}
async function refresh() {
  data = await call('load');
  if(!Array.isArray(data.workouts)||!Array.isArray(data.sessions)) throw new Error('Não foi possível abrir suas fichas.');
  data.sessions.sort((a,b)=>b.completedAt-a.completedAt);
}
function notify(message) {
  // Dialogs are in the browser top layer; keep validation messages in that layer.
  const dialogs = $$('dialog[open]'), currentDialog = dialogs[dialogs.length - 1];
  if (currentDialog) {
    let inline = $('.dialog-message', currentDialog);
    if (!inline) {
      inline = document.createElement('p'); inline.className = 'dialog-message';
      inline.setAttribute('role', 'alert');
      const content = $('.form-content', currentDialog) || $('.confirm-content', currentDialog) || currentDialog;
      content.prepend(inline);
    }
    inline.textContent = message; inline.scrollIntoView({block:'nearest'});
  }
  $('#toast').textContent=message;$('#toast').classList.add('visible');
  clearTimeout(toastHandle);toastHandle=setTimeout(()=>$('#toast').classList.remove('visible'),3400);
}
async function setTheme(theme, persist = true) {
  if(persist) {try{await call('setTheme',theme);}catch(e){notify(e.message);return;}}
  data.theme=theme;document.body.classList.toggle('dark',theme==='dark');
  $('#theme-toggle').setAttribute('aria-checked',String(theme==='dark'));
  $('#theme-toggle').setAttribute('aria-label',theme==='dark'?'Ativar tema claro':'Ativar tema escuro');
  $('meta[name="theme-color"]').content=theme==='dark'?'#100b26':'#fff0f6';
}
function nav(to) {
  if(!localAccount.getState().unlocked)return;
  page=to;selectedId=null;render();window.scrollTo(0,0);
}
function render() {
  clearInterval(timerHandle);
  document.body.classList.toggle('app-locked',!localAccount.getState().unlocked);
  $('#settings-open').disabled=!localAccount.getState().unlocked;
  if(!localAccount.getState().unlocked){authUI.render();return;}
  $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.page===page);if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const view=selectedId?detailView():page==='fichas'?listView():page==='historico'?historyView():page==='evolucao'?evolutionView():page==='ajustes'?settingsView():page==='musica'?musicView():homeView();
  $('#main').innerHTML=(active&&selectedId!==active.id?ongoingView():'')+view;
  bindPage();
  if(active){updateSessionTimer();if(active.pausedAt===null)timerHandle=setInterval(updateSessionTimer,1000);}
}
function intro(eyebrow,title,subtitle,button='') {
  return `<div class="page-intro"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p class="subtext">${subtitle}</p></div>${button}</div>`;
}
function statsView(){return `<div class="stats"><div class="stat">${icon('gym','stat-icon')}<strong>${data.workouts.length.toString().padStart(2,'0')}</strong><span>Fichas</span></div><div class="stat">${icon('check','stat-icon')}<strong>${data.sessions.length.toString().padStart(2,'0')}</strong><span>Concluídos</span></div><div class="stat">${icon('clock','stat-icon')}<strong>${Math.round(data.sessions.reduce((s,v)=>s+v.duration,0)/60)}</strong><span>Minutos</span></div></div>`;}
function weekView(){
  const now=new Date(),monday=new Date(now);monday.setDate(now.getDate()-((now.getDay()+6)%7));
  return `<div class="week" aria-label="Treinos concluídos nesta semana">${['SEG','TER','QUA','QUI','SEX','SÁB','DOM'].map((day,i)=>{
    const date=new Date(monday);date.setDate(monday.getDate()+i);const key=date.toDateString();
    const done=data.sessions.some(s=>new Date(s.completedAt).toDateString()===key),today=now.toDateString()===key;
    return `<div class="day ${done?'done':''} ${today?'today':''}" aria-label="${day}, ${date.getDate()}${today?', hoje':''}${done?', treino concluído':''}"><span>${day}</span><b>${done?'✓':date.getDate()}</b><i></i></div>`;
  }).join('')}</div>`;
}
function emptyView(history=false){return `<div class="empty"><div class="empty-symbol">${icon(history?'history':'gym')}</div><h3>${history?'Nenhum treino concluído':'Nenhuma ficha criada'}</h3><p>${history?'Os treinos concluídos aparecerão aqui.':'Adicione os exercícios, séries e cargas.'}</p><button class="button primary" data-action="${history?'go-fichas':'create'}">${history?'Ver minhas fichas':'Criar ficha'} ${icon('arrow')}</button>${history?'':'<button class="text-button" data-action="template">Usar modelo em branco</button>'}</div>`;}
function card(w,index){return `<article class="workout-card"><div class="workout-card-top"><div class="workout-letter">${String.fromCharCode(65+(index%26))}</div><div class="workout-info"><h3>${escapeHtml(w.name)}</h3><p class="workout-focus">${escapeHtml(w.focus||'Ficha de treino')}</p></div><button class="icon-button" data-action="edit" data-id="${w.id}" aria-label="Editar ${escapeHtml(w.name)}">${icon('edit')}</button></div><div class="card-meta"><span>${icon('gym')}${w.exercises.length} exercício${w.exercises.length!==1?'s':''}</span>${w.days?`<span>${icon('calendar')}${escapeHtml(w.days)}</span>`:''}</div><div class="card-bottom"><button class="text-button" data-action="open" data-id="${w.id}">Ver ficha ${icon('arrow')}</button><button class="button primary" data-action="start" data-id="${w.id}">${active&&active.id===w.id?(active.pausedAt!==null?'Retomar treino':'Continuar treino'):'Começar treino'}</button></div></article>`;}
function homeView(){
  const date=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  return intro(date,'Treinos','',data.workouts.length?'<button class="button primary" data-action="create">+ Nova ficha</button>':'')+
    `<div class="home-simple">${statsView()}<section><div class="section-heading"><h2>Minhas fichas</h2>${data.workouts.length?'<button class="text-button" data-action="go-fichas">Ver todas</button>':''}</div><div class="workout-list">${data.workouts.length?data.workouts.slice(0,3).map(card).join(''):emptyView()}</div></section><div class="home-utilities"><section class="week-summary"><h3>Esta semana</h3>${weekView()}</section><button class="music-shortcut" data-action="go-music"><span aria-hidden="true">♫</span><div><strong>Música</strong><small>Abrir player</small></div>${icon('arrow')}</button></div></div>`;
}
function listView(){return intro('TREINOS','Minhas fichas','Exercícios, séries e cargas.','<button class="button primary add-top" data-action="create" aria-label="Criar nova ficha">+ Nova</button>')+(data.workouts.length?`<label class="search">${icon('search')}<input id="search" type="search" placeholder="Buscar ficha ou grupo muscular" aria-label="Buscar ficha ou grupo muscular"></label><div id="workout-results" class="workout-list all">${data.workouts.map(card).join('')}</div>`:emptyView());}
function ongoingView(){
  return `<aside class="ongoing-workout" aria-label="Treino em andamento"><div><span class="eyebrow">${active.pausedAt!==null?'TREINO PAUSADO':'EM ANDAMENTO'}</span><strong>${escapeHtml(workout(active.id)?.name||'Seu treino')} · <span id="session-time">${timeText(elapsedSeconds(active))}</span></strong></div><button class="button secondary" data-action="session-open">Abrir treino ${icon('arrow')}</button></aside>`;
}
function sessionControls(){
  const paused=active.pausedAt!==null;
  return `<section class="session-bar ${paused?'session-paused':''}" aria-label="Controles do treino"><div class="session-summary"><div><span>${paused?'TREINO PAUSADO':'TREINO EM ANDAMENTO'}</span><strong id="session-time" aria-label="Tempo de treino">${timeText(elapsedSeconds(active))}</strong></div><span class="session-progress">${active.done.length} / ${workout(active.id)?.exercises.length||0} exercícios</span></div><div class="session-buttons"><button class="button secondary" data-action="${paused?'session-resume':'session-pause'}">${paused?'▶ Continuar treino':'Ⅱ Pausar treino'}</button><button class="button primary" data-action="finish">Concluir treino ${cassette()}</button><button class="button secondary" data-action="session-restart">↻ Reiniciar</button><button class="button secondary session-cancel" data-action="session-cancel">Cancelar treino</button></div></section>`;
}
function detailView(){
  const w=workout(selectedId);if(!w){selectedId=null;return listView();}
  const running=active&&active.id===w.id;
  return `<div class="detail-layout"><div class="page-title-row"><button class="icon-button" data-action="back" aria-label="Voltar">${icon('back')}</button><span class="eyebrow">SUA FICHA DE TREINO</span></div><section class="detail-hero"><span class="eyebrow">${escapeHtml(w.days||'FICHA DE TREINO')}</span><h1>${escapeHtml(w.name)}</h1><p class="subtext">${escapeHtml(w.focus||'Exercícios da ficha')}</p></section>${running?sessionControls():`<div class="detail-actions"><button class="button primary" data-action="start" data-id="${w.id}">Começar treino ${icon('arrow')}</button><button class="button secondary" data-action="edit" data-id="${w.id}" aria-label="Editar ficha">${icon('edit')}</button><button class="icon-button" data-action="delete" data-id="${w.id}" aria-label="Excluir ficha">${icon('trash')}</button></div>`}<div class="section-heading"><h3>${w.exercises.length} exercício${w.exercises.length===1?'':'s'}</h3><span class="small-label">Carga em kg</span></div>${w.exercises.map((e,i)=>`<article class="exercise-card"><div class="exercise-heading"><span class="exercise-index">${(i+1).toString().padStart(2,'0')}</span><h3>${escapeHtml(e.name)}</h3></div><div class="exercise-prescription"><span>${e.sets} séries</span><span>${escapeHtml(e.reps)} repetições</span><span>${e.rest}s de descanso</span></div><div class="weight-control"><span class="small-label">Carga atual</span><div class="weight-stepper"><button data-action="weight-minus" data-id="${e.id}" aria-label="Diminuir carga de ${escapeHtml(e.name)} em 1 kg" ${Number(e.weight)<=0?'disabled':''}>−</button><button class="weight-value" data-action="weight-edit" data-id="${e.id}" aria-label="Editar carga de ${escapeHtml(e.name)}">${formatKg(e.weight)} <small>kg</small></button><button data-action="weight-plus" data-id="${e.id}" aria-label="Aumentar carga de ${escapeHtml(e.name)} em 1 kg" ${Number(e.weight)>=2000?'disabled':''}>+</button></div></div>${e.notes?`<p class="exercise-note">${escapeHtml(e.notes)}</p>`:''}${running?`<button class="done-exercise ${active.done.includes(e.id)?'checked':''}" data-action="check-exercise" data-id="${e.id}" aria-pressed="${active.done.includes(e.id)}" ${active.pausedAt!==null?'disabled':''}>${icon('check')}${active.done.includes(e.id)?'Exercício concluído':'Marcar exercício como concluído'}</button>${e.rest?`<button class="rest-button" data-action="rest" data-seconds="${e.rest}" ${active.pausedAt!==null?'disabled':''}>${icon('clock')} Iniciar descanso de ${e.rest}s</button>`:''}`:''}</article>`).join('')}${w.notes?`<div class="note-box"><strong>Suas observações</strong><br>${escapeHtml(w.notes)}</div>`:''}<p class="footer-note">Toque na carga para editar. Cada ajuste é salvo no aparelho.</p></div>`;
}
function historyView(){return intro('TREINOS CONCLUÍDOS','Histórico','Datas e duração dos treinos.')+statsView()+(data.sessions.length?`<div class="section-heading"><h2>Treinos concluídos</h2><span class="small-label">Mais recentes</span></div>${data.sessions.map(s=>`<article class="history-item"><span class="history-tick">✓</span><div class="history-info"><h3>${escapeHtml(s.workoutName)}</h3><p>${new Date(s.completedAt).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'})} · ${new Date(s.completedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</p></div><div class="history-duration">${Math.floor(s.duration/60)} min<small>${s.duration%60} s</small></div><button class="text-button history-remove" data-action="history-delete" data-id="${s.id}" aria-label="Excluir treino ${escapeHtml(s.workoutName)} de ${new Date(s.completedAt).toLocaleDateString('pt-BR')}">${icon('trash')} Excluir</button></article>`).join('')}`:emptyView(true));}

function signedKg(value){return `${value>0?'+':''}${formatKg(value)} kg`;}
function seriesSummary(points,label){
  const s=summarize(points);
  return `<div class="chart-metrics"><div><span>${label}</span><strong>${s.last===null?'—':formatKg(s.last)}<small>${s.last===null?'':'kg'}</small></strong></div><div><span>Variação no período</span><strong class="chart-change">${s.count>1?signedKg(s.change):'—'}</strong><small>${s.count>1&&s.percent!==null?`${s.percent>0?'+':''}${s.percent.toLocaleString('pt-BR',{maximumFractionDigits:1})}% entre os registros`:'Registre novos valores para comparar'}</small></div></div>`;
}
function evolutionView(){
  const entries=new Map();
  data.loadHistory.forEach(h=>entries.set(h.exerciseId,{id:h.exerciseId,name:h.name,workoutName:h.workoutName}));
  data.workouts.forEach(w=>w.exercises.forEach(e=>{if(entries.has(e.id))entries.set(e.id,{id:e.id,name:e.name,workoutName:w.name});}));
  const exercises=[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
  if(!entries.has(chartExerciseId))chartExerciseId=exercises[0]?.id||'';
  const loadPoints=filterRange(data.loadHistory.filter(h=>h.exerciseId===chartExerciseId),chartRange);
  const weightPoints=filterRange(data.bodyWeights,chartRange);
  return intro('REGISTROS','Evolução','Histórico de cargas e peso corporal.')+
    `<div class="evolution-toolbar"><span class="local-badge"><i class="status-dot"></i> Dados só neste aparelho</span><label>Período<select id="chart-range" aria-label="Período dos gráficos"><option value="30" ${chartRange==='30'?'selected':''}>Últimos 30 dias</option><option value="90" ${chartRange==='90'?'selected':''}>Últimos 90 dias</option><option value="all" ${chartRange==='all'?'selected':''}>Todo o período</option></select></label></div>
    <div class="evolution-grid"><section class="chart-card"><div class="chart-heading"><div><span class="eyebrow">CARGAS / KG</span><h2>Evolução de cargas</h2></div><span class="chart-symbol">${icon('gym')}</span></div>
    <label class="chart-select-label">Exercício<select id="chart-exercise" ${exercises.length?'':'disabled'} aria-label="Exercício do gráfico de cargas">${exercises.length?exercises.map(e=>`<option value="${e.id}" ${e.id===chartExerciseId?'selected':''}>${escapeHtml(e.name)} · ${escapeHtml(e.workoutName)}</option>`).join(''):'<option>Nenhum exercício registrado</option>'}</select></label>
    ${seriesSummary(loadPoints,'Última carga registrada')}${renderChart(loadPoints,{id:'loads',title:'Evolução da carga do exercício',unit:'kg',color:'coral'})}
    <p class="chart-explanation">Cada ponto registra uma carga salva na ficha.</p>
    <details class="chart-data"><summary>Ver registros de carga (${loadPoints.length})</summary>${loadPoints.length?`<div class="data-table-wrap"><table><caption>Cargas registradas no período selecionado</caption><thead><tr><th>Data</th><th>Carga</th></tr></thead><tbody>${loadPoints.slice().reverse().map(p=>`<tr><td>${new Date(p.at).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}</td><td>${formatKg(p.value)} kg</td></tr>`).join('')}</tbody></table></div>`:'<p class="small-label">Nenhum registro neste período.</p>'}</details></section>
    <section class="chart-card weight-chart-card"><div class="chart-heading"><div><span class="eyebrow">PESO / KG</span><h2>Peso corporal</h2></div><span class="chart-symbol weight-symbol">${icon('leaf')}</span></div>
    <p class="chart-explanation weight-intro">Registre o peso e compare por período.</p>
    ${seriesSummary(weightPoints,'Último peso registrado')}${renderChart(weightPoints,{id:'body',title:'Evolução do peso corporal',unit:'kg',color:'wine'})}
    <button class="button primary full" data-action="body-add">+ Registrar meu peso</button>
    <details class="chart-data"><summary>Ver e editar registros (${data.bodyWeights.length})</summary>${data.bodyWeights.length?`<div class="body-records">${data.bodyWeights.slice().reverse().map(w=>`<article class="body-record"><div><strong>${formatKg(w.value)} <small>kg</small></strong><span>${new Date(w.at).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}</span>${w.notes?`<p>${escapeHtml(w.notes)}</p>`:''}</div><div><button class="icon-button" data-action="body-edit" data-id="${w.id}" aria-label="Editar peso de ${formatKg(w.value)} kg">${icon('edit')}</button><button class="icon-button" data-action="body-delete" data-id="${w.id}" aria-label="Excluir peso de ${formatKg(w.value)} kg">${icon('trash')}</button></div></article>`).join('')}</div>`:'<p class="small-label">Seu primeiro registro aparecerá aqui.</p>'}</details></section></div>
    <p class="footer-note">Exporte os registros em Ajustes → Salvar backup.</p>`;
}
function settingsView(){
  return intro('PERAGYM','Ajustes','Instalação e backup dos dados.')+
    `<div class="settings-grid">${authUI.settingsMarkup()}${legacyStatus?.hasData&&!data.legacyImport?'<section class="setting-card"><span class="eyebrow">DADOS ANTERIORES</span><h2>Trazer meus treinos</h2><p>Há registros da versão sem login neste navegador. Você pode copiá-los para este perfil vazio.</p><button class="button secondary" data-action="legacy-import">Copiar treinos anteriores</button><p class="form-hint">A cópia antiga continuará sem senha.</p></section>':''}<section class="setting-card"><span class="eyebrow">INSTALAÇÃO</span><h2>PeraGym na tela inicial</h2><p>Instale no Android ou no iPhone e abra o seu treino como um aplicativo.</p><button class="button primary" data-install data-install-help>Instalar aplicativo ${icon('arrow')}</button><p class="form-hint">No iPhone: abra no Safari, toque em Compartilhar e escolha Adicionar à Tela de Início.</p></section>
    <section class="setting-card"><span class="eyebrow">ARMAZENAMENTO</span><h2>Backup local</h2><p>As fichas, cargas e registros de peso ficam no banco deste navegador. Exporte um backup para guardar ou transferir para outro aparelho.</p><div class="backup-actions"><button class="button primary" data-action="backup-export">Salvar backup ${cassette()}</button><button class="button secondary" data-action="backup-import">Importar backup</button></div><input id="import-file" type="file" accept="application/json,.json" hidden><p class="form-hint">Apagar os dados do navegador ou desinstalar pode remover o banco local. O arquivo de backup contém seus dados pessoais: guarde-o em um lugar privado.</p></section></div><p class="footer-note">PeraGym · Vice Training</p>`;
}

function musicView(){
  const links=(data.musicLinks||[]).map(url=>{try{return parseMusicLink(url);}catch(_){return null;}}).filter(Boolean);
  const spotify=spotifyAccount?.getState()||{configured:false,connected:false};
  const youtube=youtubeAccount?.getState()||{configured:false,connected:false,ready:false};
  const spotifyConnect=spotify.connected?`<div class="account-connected"><i class="status-dot"></i><strong>${escapeHtml(spotify.profile?.displayName||'Conta Spotify')}</strong><button class="text-button" data-action="spotify-disconnect">Sair</button></div><button class="button secondary full" data-action="spotify-library" ${musicBusy?'disabled':''}>${musicBusy?'Carregando...':'Minhas playlists'}</button>`:spotify.configured?`<button class="button spotify-connect full" data-action="spotify-connect">Conectar Spotify</button><p class="form-hint">Login oficial. Reprodução completa exige Premium.</p>`:`<button class="button secondary full" disabled>Conectar Spotify</button><p class="form-hint">Conexão de contas aguardando ativação. Para ouvir agora, cole um link acima.</p>`;
  const youtubeConnect=youtube.connected?`<div class="account-connected"><i class="status-dot"></i><strong>${escapeHtml(youtube.profile?.displayName||'Conta YouTube')}</strong><button class="text-button" data-action="youtube-disconnect">Sair</button></div><button class="button secondary full" data-action="youtube-library" ${youtubeBusy?'disabled':''}>${youtubeBusy?'Carregando...':'Minhas playlists'}</button>`:youtube.configured?`<button class="button secondary full" data-action="${youtube.ready?'youtube-connect':'youtube-prepare'}" ${!youtube.ready&&!youtube.error?'disabled':''}>${youtube.ready?'Conectar com Google':youtube.error?'Preparar login Google':'Preparando login...'}</button><p class="form-hint">Autorize a leitura das playlists do YouTube.</p>`:`<button class="button secondary full" disabled>Conectar com Google</button><p class="form-hint">Conexão Google aguardando ativação. Para ouvir agora, cole um link acima.</p>`;
  return intro('','Música','Escolha a conta ou cole um link.')+
    `<div class="music-simple"><section class="setting-card music-input-card"><form id="music-form"><label>Link da música ou playlist<input id="music-link" type="url" inputmode="url" required maxlength="2048" placeholder="YouTube Music ou Spotify" autocomplete="off" spellcheck="false"></label><button type="submit" class="button primary full">Abrir no player ▶</button></form><p class="form-hint">Música exige internet.</p></section>
    <div class="music-accounts"><section class="account-card"><h2>Spotify</h2>${musicConfigLoaded?spotifyConnect:'<p class="form-hint">Carregando conexão...</p>'}${spotify.error&&spotify.configured?`<p class="form-hint" role="status">${escapeHtml(spotify.error)}</p>`:''}</section><section class="account-card"><h2>YouTube / Music</h2>${musicConfigLoaded?youtubeConnect:'<p class="form-hint">Carregando conexão...</p>'}${youtube.error&&youtube.configured?`<p class="form-hint" role="status">${escapeHtml(youtube.error)}</p>`:''}</section></div>
    ${spotifyPlaylists.length?`<section class="setting-card"><h2>Playlists do Spotify</h2><ul class="music-link-list">${spotifyPlaylists.map((item,i)=>`<li><strong>${escapeHtml(item.name)}</strong><button class="button secondary" data-action="spotify-playlist" data-index="${i}">Ouvir ▶</button></li>`).join('')}</ul></section>`:''}
    ${youtubePlaylists.length?`<section class="setting-card"><h2>Playlists do YouTube</h2><ul class="music-link-list">${youtubePlaylists.map((item,i)=>`<li><strong>${escapeHtml(item.name)}</strong><button class="button secondary" data-action="youtube-playlist" data-index="${i}" ${youtubeBusy?'disabled':''}>Ver músicas</button></li>`).join('')}</ul></section>`:''}
    ${youtubeTracks.length?`<section class="setting-card"><h2>Músicas da playlist</h2><ul class="music-link-list">${youtubeTracks.map((item,i)=>`<li><strong>${escapeHtml(item.name||item.title)}</strong><button class="button secondary" data-action="youtube-track" data-index="${i}">Ouvir ▶</button></li>`).join('')}</ul></section>`:''}
    <section class="music-recents"><h2>Recentes</h2>${links.length?`<ul class="music-link-list">${links.map((item,i)=>`<li><div><strong>${escapeHtml(item.label)}</strong></div><div class="music-link-actions"><button class="button secondary" data-action="music-play" data-index="${i}" aria-label="Carregar ${escapeHtml(item.label)}">▶ Ouvir</button><button class="icon-button" data-action="music-remove" data-index="${i}" aria-label="Remover ${escapeHtml(item.label)} dos recentes">${icon('trash')}</button></div></li>`).join('')}</ul>`:'<p class="form-hint">Seus últimos oito links.</p>'}</section><details class="music-privacy"><summary>Contas e reprodução</summary><p>O login abre no serviço oficial. O PeraGym não recebe sua senha Google ou Spotify. As autorizações ficam apenas nesta sessão. O YouTube retorna as playlists disponíveis na sua API, sem acesso completo à biblioteca do YouTube Music. Vídeos privados ou bloqueados podem não tocar no player. O player do YouTube permanece visível; a música pausa ao ocultar o app ou abrir um formulário.</p><p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">Termos YouTube</a> · <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Privacidade Google</a> · <a href="https://www.spotify.com/legal/end-user-agreement/" target="_blank" rel="noopener">Termos Spotify</a> · <a href="https://www.spotify.com/legal/privacy-policy/" target="_blank" rel="noopener">Privacidade Spotify</a></p></details></div>`;
}
async function playMusic(raw){
  const item=parseMusicLink(raw);
  if(!navigator.onLine)throw new Error('Conecte-se à internet para ouvir música.');
  const urls=[item.url,...(data.musicLinks||[]).filter(url=>url!==item.url)].slice(0,8);
  data.musicLinks=urls;
  void musicPlayer.load(item).catch(error=>notify(error.message));
  try{await db.setSetting('musicLinks',urls);}catch(_){notify('Não foi possível salvar o link nos recentes.');}
  if(page==='musica')render();
}
function musicAccountChanged(){
  if(!spotifyAccount?.getState().connected){playlistRequest++;spotifyPlaylists=[];musicBusy=false;}
  if(page==='musica' && localAccount.getState().unlocked)render();
}
async function prepareYouTube(){
  if(youtubePreparing||!youtubeAccount?.getState().configured||youtubeAccount.getState().ready)return;
  youtubePreparing=true;try{await youtubeAccount.prepare();}catch(error){if(page==='musica'&&localAccount.getState().unlocked)notify(error.message);}finally{youtubePreparing=false;}
}
function youtubeAccountChanged(){
  if(!youtubeAccount?.getState().connected){youtubeRequest++;youtubePlaylists=[];youtubeTracks=[];youtubeBusy=false;}
  if(page==='musica'&&localAccount.getState().unlocked)render();
}
async function initializeMusic(){
  const generation=++musicGeneration;let clientId='',googleClientId='';
  try{
    const response=await fetch(new URL('../music-config.json',import.meta.url),{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(8000)});
    if(response.ok){const config=await response.json();if(typeof config.spotifyClientId==='string' && /^[a-fA-F0-9]{32}$/.test(config.spotifyClientId))clientId=config.spotifyClientId;if(typeof config.googleClientId==='string')googleClientId=config.googleClientId;}
  }catch(_){ /* Local training remains available without music services. */ }
  if(generation!==musicGeneration||!localAccount.getState().unlocked)return;
  spotifyAccount=createSpotifyAccount({clientId,redirectUri:new URL('./',import.meta.url).href,onChange:musicAccountChanged});
  youtubeAccount=createYouTubeAccount({clientId:googleClientId,onChange:youtubeAccountChanged});
  musicConfigLoaded=true;
  if(returningFromSpotify){
    let owner=null;try{owner=sessionStorage.getItem('peragym:spotify-profile');}catch(_){}
    if(owner&&owner!==localAccount.getState().profile.id){notify('Entre no perfil que iniciou a conexão com o Spotify.');}
    else{
      page='musica';selectedId=null;render();
      try{const result=await spotifyAccount.completeRedirect();if(generation!==musicGeneration)return;try{sessionStorage.removeItem('peragym:spotify-profile');}catch(_){}if(result.error)notify(result.error);else if(result.connected){notify('Spotify conectado.');void activateMusic('spotify');}returningFromSpotify=false;}catch(error){notify(error.message);}
    }
  }
  if(page==='musica'&&localAccount.getState().unlocked){render();void prepareYouTube();}
}
async function activateMusic(provider){
  const account=provider==='spotify'?spotifyAccount:youtubeAccount;
  const session=localAccount.getState();
  if(!session.unlocked||!account?.getState().connected)return;
  const current=()=>localAccount.getState().unlocked&&localAccount.getState().generation===session.generation&&(provider==='spotify'?spotifyAccount:youtubeAccount)===account&&account.getState().connected;
  page='musica';selectedId=null;render();musicPlayer.openAccount(provider,account.getState().profile);window.scrollTo(0,0);
  if(provider==='spotify')await loadSpotifyPlaylists();else await loadYouTubePlaylists();
  if(!current())return;
  const recent=(data.musicLinks||[]).find(url=>{try{return parseMusicLink(url).provider===provider;}catch(_){return false;}});
  if(recent){await playMusic(recent);return;}
  const playlists=provider==='spotify'?spotifyPlaylists:youtubePlaylists;
  if(playlists.length){
    if(provider==='spotify'||playlists[0].privacyStatus!=='private'){await playMusic(playlists[0].url);return;}
    await loadYouTubeTracks(0);if(!current())return;
    const track=youtubeTracks.find(item=>item.privacyStatus!=='private');if(track){await playMusic(track.url);return;}
  }
  musicPlayer.setMessage('Conta conectada. Cole um link ou escolha uma música para ouvir.');
}
async function loadSpotifyPlaylists(){
  if(musicBusy||!spotifyAccount?.getState().connected)return;
  musicBusy=true;const request=++playlistRequest;render();
  try{const rows=await operationLoading.run('Carregando playlists do Spotify…',()=>spotifyAccount.getPlaylists());if(request===playlistRequest){spotifyPlaylists=rows;if(!rows.length)notify('Nenhuma playlist disponível nesta conta.');}}catch(error){if(request===playlistRequest&&page==='musica')notify(error.message);}finally{if(request===playlistRequest){musicBusy=false;if(page==='musica')render();}}
}
async function loadYouTubePlaylists(){
  if(youtubeBusy||!youtubeAccount?.getState().connected)return;
  youtubeBusy=true;const request=++youtubeRequest;render();
  try{const rows=await operationLoading.run('Carregando playlists do YouTube…',()=>youtubeAccount.getPlaylists());if(request===youtubeRequest){youtubePlaylists=rows;youtubeTracks=[];if(!rows.length)notify('Nenhuma playlist disponível pela API do YouTube.');}}catch(error){if(request===youtubeRequest)notify(error.message);}finally{if(request===youtubeRequest){youtubeBusy=false;if(page==='musica')render();}}
}
async function loadYouTubeTracks(index){
  const item=youtubePlaylists[index];if(!item||youtubeBusy)return;
  youtubeBusy=true;const request=++youtubeRequest;render();
  try{const rows=await operationLoading.run('Carregando músicas…',()=>youtubeAccount.getPlaylistTracks(item.id));if(request===youtubeRequest){youtubeTracks=rows;if(!rows.length)notify('Esta playlist não tem vídeos disponíveis para o player.');}}catch(error){if(request===youtubeRequest)notify(error.message);}finally{if(request===youtubeRequest){youtubeBusy=false;if(page==='musica')render();}}
}

function localDateTime(at=Date.now()){
  const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function openBodyEditor(row=null){
  const dialog=document.createElement('dialog');dialog.className='body-editor';
  dialog.innerHTML=`<form class="confirm-content"><span class="eyebrow">SEU REGISTRO PESSOAL</span><h2>${row?'Editar peso corporal':'Registrar peso corporal'}</h2><div class="body-form-fields"><label>Peso em quilos<input name="bodyWeight" type="text" inputmode="decimal" required maxlength="8" value="${row?formatKg(row.value).replace(/\./g,''):''}" placeholder="Ex.: 72,5"></label><label>Data e horário<input name="recordedAt" type="datetime-local" required value="${localDateTime(row?.at)}" max="${localDateTime()}"></label><label>Observação (opcional)<textarea name="weightNotes" maxlength="500" rows="2" placeholder="Algo que você queira lembrar">${escapeHtml(row?.notes||'')}</textarea></label></div><p class="form-hint">A data e o peso informados aparecerão no seu gráfico.</p><div class="confirm-actions"><button type="button" class="button secondary">Cancelar</button><button type="submit" class="button primary">Salvar peso ${cassette()}</button></div></form>`;
  document.body.append(dialog);const cleanup=()=>{dialog.close();dialog.remove();};$('.secondary',dialog).onclick=cleanup;dialog.oncancel=e=>{e.preventDefault();cleanup();};
  $('form',dialog).onsubmit=async event=>{
    event.preventDefault();const button=$('[type=submit]',dialog);if(button.disabled)return;button.disabled=true;
    try{const f=$('form',dialog);await db.saveBodyWeight({id:row?.id,value:f.elements.bodyWeight.value,at:new Date(f.elements.recordedAt.value).getTime(),notes:f.elements.weightNotes.value});await refresh();cleanup();render();notify('Peso corporal salvo no aparelho.');}catch(e){notify(e.message);button.disabled=false;}
  };dialog.showModal();
}
async function exportBackup(){
  try{const backup=await db.exportBackup(),blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`PeraGym-backup-${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);notify('Backup gerado. Guarde o arquivo com segurança.');}catch(e){notify(e.message);}
}
async function importBackup(event){
  const file=event.target.files[0];event.target.value='';if(!file)return;
  try{if(file.size>15*1024*1024)throw new Error('Use um backup de até 15 MB.');const raw=JSON.parse(await file.text());db.validateBackup(raw);if(!await ask('Substituir os dados locais?','Importar este backup substituirá as fichas e registros deste perfil. Exporte os dados atuais antes, se precisar.','Importar backup'))return;await db.importBackup(raw);await clearActive();await refresh();await setTheme(data.theme,false);render();notify('Backup importado.');}catch(e){notify(e instanceof SyntaxError?'Este arquivo não contém um backup JSON válido.':e.message);}
}

function bindPage(){
  authUI.bindSettings();
  if(page==='musica'&&youtubeAccount?.getState().configured&&!youtubeAccount.getState().ready&&!youtubeAccount.getState().error)void prepareYouTube();
  if($('#music-form'))$('#music-form').onsubmit=async event=>{event.preventDefault();try{await playMusic($('#music-link').value);}catch(error){notify(error.message);}};
  $$('[data-action]',$('#main')).forEach(b=>b.addEventListener('click',()=>handle(b.dataset.action,b.dataset)));
  if($('#chart-exercise'))$('#chart-exercise').onchange=e=>{chartExerciseId=e.target.value;render();};
  if($('#chart-range'))$('#chart-range').onchange=e=>{chartRange=e.target.value;render();};
  if($('#import-file'))$('#import-file').onchange=importBackup;
  const search=$('#search');if(search)search.addEventListener('input',()=>{
    const q=search.value.trim().toLocaleLowerCase('pt-BR');
    const matches=data.workouts.filter(w=>(w.name+' '+w.focus).toLocaleLowerCase('pt-BR').includes(q));
    $('#workout-results').innerHTML=matches.length?matches.map(w=>card(w,data.workouts.indexOf(w))).join(''):'<p class="small-label">Nenhuma ficha encontrada. Tente outro nome.</p>';
    $$('[data-action]',$('#workout-results')).forEach(b=>b.addEventListener('click',()=>handle(b.dataset.action,b.dataset)));
  });
}
async function handle(action,ds={}){
  if(!localAccount.getState().unlocked)return;
  if(action==='spotify-library'){void loadSpotifyPlaylists();return;}
  if(handling)return;
  handling=true;
  try{
    if(action==='legacy-import'){if(await ask('Copiar treinos anteriores?','Os registros da versão sem login serão copiados para este perfil. Ele precisa estar vazio. A cópia original, sem senha, será preservada.','Copiar treinos')){await db.migrateLegacy();await refresh();render();notify('Treinos copiados para o seu perfil.');}return;}
    if(action==='history-delete'){
      const record=data.sessions.find(item=>item.id===ds.id);if(!record)return;
      if(await ask('Excluir treino do histórico?',`${record.workoutName} · ${new Date(record.completedAt).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}. A ficha e as cargas serão mantidas.`,'Excluir treino')){await db.deleteSession(record.id);await refresh();render();notify('Treino removido do histórico.');}return;
    }
    if(action==='session-open'){if(active){selectedId=active.id;render();window.scrollTo(0,0);}return;}
    if(action==='session-pause'){if(!active||active.pausedAt!==null)return;await persistActive(pauseSession(active));resetRest();render();notify('Treino pausado.');return;}
    if(action==='session-resume'){if(!active||active.pausedAt===null)return;await persistActive(resumeSession(active));render();notify('Treino retomado.');return;}
    if(action==='session-restart'){
      if(!active)return;
      if(await ask('Reiniciar este treino?','O tempo será zerado e os exercícios serão desmarcados. A ficha e as cargas serão mantidas.','Reiniciar treino')){await persistActive(restartSession(active));resetRest();render();notify('Treino reiniciado.');}return;
    }
    if(action==='session-cancel'){
      if(!active)return;
      if(await ask('Cancelar este treino?','O treino em andamento será descartado. A ficha e as cargas serão mantidas.','Cancelar treino')){await clearActive();selectedId=null;page='inicio';render();window.scrollTo(0,0);notify('Treino cancelado.');}return;
    }
    if(action==='go-music')return nav('musica');
    if(action==='spotify-connect'){try{sessionStorage.setItem('peragym:spotify-profile',localAccount.getState().profile.id);}catch(_){}const result=await operationLoading.run('Conectando ao Spotify…',()=>spotifyAccount.connectPopup());if(result?.connected){try{sessionStorage.removeItem('peragym:spotify-profile');}catch(_){}await activateMusic('spotify');}else if(result?.error)notify(result.error);return;}
    if(action==='youtube-prepare')return await prepareYouTube();
    if(action==='youtube-connect'){const result=await operationLoading.run('Conectando ao YouTube…',()=>youtubeAccount.connect());if(result.connected)await activateMusic('youtube');return;}
    if(action==='youtube-library')return await loadYouTubePlaylists();
    if(action==='youtube-playlist')return await loadYouTubeTracks(Number(ds.index));
    if(action==='youtube-track')return await playMusic(youtubeTracks[Number(ds.index)].url);
    if(action==='youtube-disconnect'){musicPlayer.close();youtubeAccount.disconnect();youtubePlaylists=[];youtubeTracks=[];render();return;}
    if(action==='spotify-library')return await loadSpotifyPlaylists();
    if(action==='spotify-playlist')return await playMusic(spotifyPlaylists[Number(ds.index)].url);
    if(action==='spotify-disconnect'){musicPlayer.close();spotifyAccount.disconnect();spotifyPlaylists=[];render();return;}
    if(action==='music-play')return await playMusic(data.musicLinks[Number(ds.index)]);
    if(action==='music-remove'){const urls=data.musicLinks.filter((_,i)=>i!==Number(ds.index));await db.setSetting('musicLinks',urls);data.musicLinks=urls;render();return;}
    if(action==='body-add')return openBodyEditor();
    if(action==='body-edit')return openBodyEditor(data.bodyWeights.find(w=>w.id===ds.id));
    if(action==='body-delete'){if(await ask('Excluir este registro?','Este peso será removido do gráfico.','Excluir registro')){await db.deleteBodyWeight(ds.id);await refresh();render();notify('Registro removido.');}return;}
    if(action==='backup-export')return exportBackup();
    if(action==='backup-import')return $('#import-file').click();
    if(action==='settings')return nav('ajustes');
    if(action==='create')return openEditor();
    if(action==='template')return openEditor({name:'Treino A',focus:'',days:'',notes:'',exercises:[{name:'',sets:3,reps:'10',weight:0,rest:60,notes:''}]});
    if(action==='go-fichas')return nav('fichas');
    if(action==='open'){selectedId=ds.id;render();window.scrollTo(0,0);return;}
    if(action==='back'){selectedId=null;render();return;}
    if(action==='edit')return openEditor(workout(ds.id));
    if(action==='delete'){
      const w=workout(ds.id);if(await ask('Excluir esta ficha?',`A ficha “${w.name}” e seus exercícios serão excluídos. O histórico de treinos concluídos será mantido.`,'Excluir ficha')){
        await call('deleteWorkout',w.id);if(active&&active.id===w.id)clearActiveMemory();await refresh();selectedId=null;render();notify('Ficha excluída.');
      }return;
    }
    if(action.startsWith('weight-')){
      const w=workout(selectedId),e=w.exercises.find(x=>x.id===ds.id);
      if(action==='weight-edit')return editWeight(e);
      const weight=Math.min(2000,Math.max(0,Math.round((Number(e.weight)+(action==='weight-plus'?1:-1))*100)/100));
      await call('updateWeight',e.id,weight);await refresh();render();notify(`Carga salva: ${formatKg(weight)} kg`);return;
    }
    if(action==='start'){
      const w=workout(ds.id);if(!w.exercises.length){notify('Adicione um exercício para começar.');return;}
      if(active&&active.id!==w.id&&!await ask('Começar outro treino?','O treino em andamento será encerrado sem entrar no histórico.','Começar outro'))return;
      if(!active||active.id!==w.id){await persistActive(createSession(w.id));resetRest();}
      else if(active.pausedAt!==null)await persistActive(resumeSession(active));
      selectedId=w.id;render();window.scrollTo(0,0);return;
    }
    if(action==='check-exercise'){
      if(!active||active.pausedAt!==null)return;
      const id=ds.id;if(!workout(active.id)?.exercises.some(e=>e.id===id))return;
      await persistActive({...active,done:active.done.includes(id)?active.done.filter(x=>x!==id):[...active.done,id]});render();return;
    }
    if(action==='finish'){
      if(!active)return;
      const w=workout(active.id),incomplete=active.done.length<w.exercises.length;
      if(incomplete&&!await ask('Concluir este treino?','Alguns exercícios ainda não foram marcados como concluídos. Deseja registrar o treino mesmo assim?','Concluir treino'))return;
      await call('finishWorkout',JSON.stringify({workoutId:active.id,duration:elapsedSeconds(active)}));
      clearActiveMemory();await refresh();selectedId=null;page='historico';render();window.scrollTo(0,0);notify('Treino registrado.');return;
    }
    if(action==='rest'){if(!active||active.pausedAt!==null)return;restUntil=Date.now()+Number(ds.seconds)*1000;startRest();return;}
  }catch(e){notify(e.message);}finally{handling=false;}
}

function ask(title,message,yes='Confirmar'){
  return new Promise(resolve=>{
    const dialog=$('#confirm');$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;$('#confirm-yes').textContent=yes;
    let done=false;
    const close=result=>{if(done)return;done=true;dialog.close();$('#confirm-yes').onclick=null;$('#confirm-no').onclick=null;dialog.oncancel=null;resolve(result);};
    $('#confirm-yes').onclick=()=>close(true);$('#confirm-no').onclick=()=>close(false);dialog.oncancel=e=>{e.preventDefault();close(false);};dialog.showModal();
  });
}
function openEditor(w=null){
  if(active){notify('Conclua o treino em andamento antes de editar suas fichas.');return;}
  $$('.dialog-message',$('#editor')).forEach(el=>el.remove());
  editingId=w&&w.id||'';$('#editor-title').textContent=editingId?'Editar ficha de treino':'Nova ficha de treino';
  const form=$('#workout-form');form.reset();['name','focus','days','notes'].forEach(k=>form.elements[k].value=w&&w[k]||'');
  $('#exercise-fields').innerHTML='';(w&&w.exercises.length?w.exercises:[{}]).forEach(addExerciseField);updateExerciseLabels();
  draftInitial=JSON.stringify(readDraft());$('#editor').showModal();$('.form-content').scrollTop=0;
}
function addExerciseField(e={}){
  const el=document.createElement('section');el.className='exercise-field';el.dataset.id=e.id||'';
  el.innerHTML=`<div class="field-heading"><b>Exercício</b><button type="button" class="icon-button remove-exercise" aria-label="Remover exercício">${icon('trash')}</button></div><label>Nome do exercício<input class="ex-name" value="${escapeHtml(e.name||'')}" placeholder="Ex.: Supino reto" required maxlength="100"></label><div class="form-grid"><label>Séries<input class="ex-sets" type="number" min="1" max="100" step="1" inputmode="numeric" required value="${e.sets??3}"></label><label>Repetições<input class="ex-reps" required maxlength="30" placeholder="Ex.: 8–12" value="${escapeHtml(e.reps??'10')}"></label><label>Carga (kg)<input class="ex-weight" type="text" inputmode="decimal" required maxlength="10" value="${formatKg(e.weight??0).replace(/\./g,'')}"></label><label>Descanso (s)<input class="ex-rest" type="number" min="0" max="3600" step="1" inputmode="numeric" required value="${e.rest??60}"></label></div><label>Observação do exercício<input class="ex-notes" maxlength="500" placeholder="Ex.: Ajuste de banco" value="${escapeHtml(e.notes||'')}"></label>`;
  $('.remove-exercise',el).onclick=()=>{el.remove();updateExerciseLabels();};$('#exercise-fields').append(el);updateExerciseLabels();
}
function updateExerciseLabels(){const fields=$$('.exercise-field');fields.forEach((el,i)=>{$('b',el).textContent=`Exercício ${(i+1).toString().padStart(2,'0')}`;$('.remove-exercise',el).setAttribute('aria-label',`Remover exercício ${i+1}`);});$('#exercise-count').textContent=`${fields.length} na ficha`;}
function readDraft(){
  const f=$('#workout-form');return {id:editingId,name:f.elements.name.value.trim(),focus:f.elements.focus.value.trim(),days:f.elements.days.value.trim(),notes:f.elements.notes.value.trim(),exercises:$$('.exercise-field').map(el=>({id:el.dataset.id,name:$('.ex-name',el).value.trim(),sets:Number($('.ex-sets',el).value),reps:$('.ex-reps',el).value.trim(),weight:$('.ex-weight',el).value.trim(),rest:Number($('.ex-rest',el).value),notes:$('.ex-notes',el).value.trim()}))};
}
function parseWeight(raw){
  const text=String(raw).trim();if(!/^\d+(?:[.,]\d{1,2})?$/.test(text))throw new Error('Informe uma carga válida, como 12,5 kg, com até duas casas decimais.');
  const n=Number(text.replace(',','.'));if(!Number.isFinite(n)||n<0||n>2000)throw new Error('A carga deve ficar entre 0 e 2.000 kg.');return n;
}
async function closeEditor(){if(JSON.stringify(readDraft())!==draftInitial&&!await ask('Descartar alterações?','As alterações desta ficha ainda não foram salvas.','Descartar'))return;$('#editor').close();}
async function saveEditor(event){
  event.preventDefault();if(submitting)return;submitting=true;try{
    const w=readDraft();if(!w.name)throw new Error('Dê um nome para sua ficha.');if(!w.exercises.length)throw new Error('Adicione pelo menos um exercício.');
    w.exercises.forEach(e=>{if(!e.name||!e.reps)throw new Error('Preencha o nome e as repetições dos exercícios.');e.weight=parseWeight(e.weight);if(!Number.isInteger(e.sets)||e.sets<1||e.sets>100)throw new Error('Use de 1 a 100 séries.');if(!Number.isInteger(e.rest)||e.rest<0||e.rest>3600)throw new Error('Use um descanso de 0 a 3.600 segundos.');});
    const result=await call('saveWorkout',JSON.stringify(w));await refresh();$('#editor').close();selectedId=result.id;page='fichas';render();window.scrollTo(0,0);notify(editingId?'Ficha atualizada.':'Ficha criada.');
  }catch(e){notify(e.message);}finally{submitting=false;}
}
function editWeight(e){
  const dialog=document.createElement('dialog');dialog.className='weight-dialog';dialog.innerHTML=`<form class="confirm-content"><h2>Qual é a nova carga?</h2><p>${escapeHtml(e.name)}</p><label class="small-label">Carga em quilos<input id="quick-weight" type="text" inputmode="decimal" required maxlength="10" value="${formatKg(e.weight).replace(/\./g,'')}" aria-label="Nova carga em quilos"></label><p class="form-hint">De 0 a 2.000 kg. Ex.: 12,5</p><div class="confirm-actions"><button type="button" class="button secondary">Cancelar</button><button type="submit" class="button primary">Salvar carga ${cassette()}</button></div></form>`;
  document.body.append(dialog);const cleanup=()=>{dialog.close();dialog.remove();};$('.secondary',dialog).onclick=cleanup;dialog.oncancel=ev=>{ev.preventDefault();cleanup();};$('form',dialog).onsubmit=async ev=>{ev.preventDefault();try{const weight=parseWeight($('#quick-weight',dialog).value);await call('updateWeight',e.id,weight);await refresh();cleanup();render();notify('Carga atualizada.');}catch(err){notify(err.message);}};dialog.showModal();$('#quick-weight',dialog).select();
}
async function persistActive(next=active){
  await db.setSetting('activeSession',next);
  active=next?structuredClone(next):null;data.activeSession=active?structuredClone(active):null;
}
function resetRest(){restUntil=0;clearInterval(restHandle);$('.rest-pill')?.remove();}
function clearActiveMemory(){active=null;data.activeSession=null;clearInterval(timerHandle);resetRest();}
async function clearActive(){await persistActive(null);clearActiveMemory();}
function updateSessionTimer(){if($('#session-time')&&active)$('#session-time').textContent=timeText(elapsedSeconds(active));}

function startRest(){
  $('.rest-pill')?.remove();clearInterval(restHandle);const el=document.createElement('div');el.className='rest-pill';el.setAttribute('role','timer');el.setAttribute('aria-label','Tempo de descanso');el.innerHTML='<span>Descanso</span><strong></strong><button aria-label="Encerrar descanso">×</button>';document.body.append(el);$('button',el).onclick=()=>{clearInterval(restHandle);el.remove();restUntil=0;};
  const tick=()=>{const seconds=Math.max(0,Math.ceil((restUntil-Date.now())/1000));$('strong',el).textContent=timeText(seconds);if(seconds===0){clearInterval(restHandle);el.remove();notify('Descanso concluído.');}};tick();restHandle=setInterval(tick,500);
}
window.peraBack=()=>{
  const open=$$('dialog[open]');if(open.length){const top=open[open.length-1];top.dispatchEvent(new Event('cancel',{cancelable:true}));return true;}
  if(selectedId){selectedId=null;render();return true;}if(page!=='inicio'){nav('inicio');return true;}
  return false;
};
$('#settings-open').onclick=()=>nav('ajustes');
$('#theme-toggle').onclick=()=>setTheme(data.theme==='dark'?'light':'dark',localAccount.getState().unlocked);
$$('.nav-item').forEach(b=>b.onclick=()=>nav(b.dataset.page));$('.brand').onclick=e=>{e.preventDefault();nav('inicio');};
$('#add-exercise').onclick=()=>{if($$('.exercise-field').length>=100){notify('Use até 100 exercícios por ficha.');return;}addExerciseField();$$('.exercise-field').at(-1).scrollIntoView({block:'start',behavior:'smooth'});};
$('#workout-form').onsubmit=saveEditor;$('#close-editor').onclick=closeEditor;$('#cancel-editor').onclick=closeEditor;$('#editor').oncancel=e=>{e.preventDefault();closeEditor();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$$('dialog[open]').length&&selectedId){selectedId=null;render();}});
async function unlockApp(){
  await refresh();await setTheme(data.theme,false);
  page=returningFromSpotify?'musica':'inicio';selectedId=null;active=null;
  const saved=normalizeSession(data.activeSession);
  if(saved&&workout(saved.id)){active={...saved,done:saved.done.filter(id=>workout(saved.id).exercises.some(e=>e.id===id))};if(!returningFromSpotify)selectedId=saved.id;}
  try{legacyStatus=await db.inspectLegacy();}catch(_){legacyStatus=null;}
  render();$('#main').focus();
  void initializeMusic();
}
async function lockApp(){
  operationLoading.clear();authBusyRelease=null;
  musicGeneration++;playlistRequest++;youtubeRequest++;
  musicPlayer.close();spotifyAccount?.disconnect();youtubeAccount?.disconnect({revoke:false});
  spotifyAccount=null;youtubeAccount=null;spotifyPlaylists=[];youtubePlaylists=[];youtubeTracks=[];musicBusy=false;youtubeBusy=false;musicConfigLoaded=false;
  localAccount.lock();
  $$('dialog').forEach(dialog=>{dialog.close();if(!['editor','confirm'].includes(dialog.id))dialog.remove();});
  $('#workout-form').reset();$('#exercise-fields').replaceChildren();$('#toast').textContent='';$('#toast').classList.remove('visible');
  $('#confirm-title').textContent='';$('#confirm-message').textContent='';editingId=0;draftInitial='';
  active=null;selectedId=null;page='inicio';youtubePreparing=false;
  clearInterval(timerHandle);clearInterval(restHandle);$('.rest-pill')?.remove();
  data={workouts:[],sessions:[],loadHistory:[],bodyWeights:[],musicLinks:[],theme:data.theme};
  render();await authUI.reset();render();$('#main').focus();
}
async function init(){
  if(window.__peragymSpotifyReturn)return;
  try{
    await authUI.initialize();render();
    window.dispatchEvent(new Event('peragym:app-ready'));
    if(!window.__peragymBootManaged){$('#app').hidden=false;$('#loading')?.remove();}
  }catch(error){
    console.error('PeraGym startup:',error.message);
    window.dispatchEvent(new CustomEvent('peragym:app-error',{detail:{message:'Não foi possível abrir o acesso local. Use um navegador atualizado em HTTPS.'}}));
    if(!window.__peragymBootManaged){$('#app').hidden=false;$('#loading')?.remove();$('#main').innerHTML='<div class="error-panel"><h2>Não foi possível abrir o acesso local</h2><p>Use um navegador atualizado em HTTPS. Seus dados não foram apagados.</p></div>';}
  }
}
init();
