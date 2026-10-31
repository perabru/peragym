'use strict';
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

/* Browser preview only. Installed Android always uses the SQLite bridge. */
function browserStore() {
  const key = 'peragym-preview-v1';
  const read = () => JSON.parse(localStorage.getItem(key) || '{"workouts":[],"sessions":[],"theme":"light","nextId":1}');
  const write = d => localStorage.setItem(key, JSON.stringify(d));
  return {
    load: () => JSON.stringify(read()),
    saveWorkout: raw => {
      const w = JSON.parse(raw), d = read();
      if (!w.name.trim() || !w.exercises.length) return JSON.stringify({ok:false,error:'Preencha o nome e adicione exercícios.'});
      if (!w.id) w.id = d.nextId++;
      w.exercises.forEach(e => {if(!e.id)e.id = d.nextId++;});
      const index = d.workouts.findIndex(x => x.id === w.id);
      if(index < 0) d.workouts.push(w); else d.workouts[index] = w;
      write(d);return JSON.stringify({ok:true,id:w.id});
    },
    deleteWorkout: id => {const d=read(); d.workouts=d.workouts.filter(x=>x.id!==id);d.sessions.forEach(s=>{if(s.workoutId===id)s.workoutId=null;});write(d);return '{"ok":true}';},
    updateWeight: (id, weight) => {const d=read();d.workouts.forEach(w=>w.exercises.forEach(e=>{if(e.id===id)e.weight=weight;}));write(d);return '{"ok":true}';},
    finishWorkout: raw => {const v=JSON.parse(raw),d=read(),w=d.workouts.find(x=>x.id===v.workoutId);if(!w)return '{"ok":false,"error":"Ficha não encontrada."}';d.sessions.unshift({id:d.nextId++,workoutId:w.id,workoutName:w.name,completedAt:Date.now(),duration:v.duration,volume:0});write(d);return '{"ok":true}';},
    setTheme: theme => {const d=read();d.theme=theme;write(d);return '{"ok":true}';}
  };
}
const native = window.PeraGymNative || browserStore();
let data = {workouts:[],sessions:[],theme:'light'};
let page = 'inicio', selectedId = null, editingId = 0, active = null, restUntil = 0;
let timerHandle, toastHandle, restHandle, draftInitial = '';
const formatKg = n => Number(n).toLocaleString('pt-BR',{maximumFractionDigits:2});
const timeText = seconds => `${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
const workout = id => data.workouts.find(w=>w.id===Number(id));

function call(method, ...args) {
  const result = JSON.parse(native[method](...args));
  if(result.ok===false) throw new Error(result.error || 'Não foi possível salvar. Tente novamente.');
  return result;
}
function refresh() {
  data = call('load');
  if(!Array.isArray(data.workouts)||!Array.isArray(data.sessions)) throw new Error('Não foi possível abrir suas fichas.');
  // Never trust row ordering from the storage adapter for historical display.
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
function setTheme(theme, persist = true) {
  if(persist) {try{call('setTheme',theme);}catch(e){notify(e.message);return;}}
  data.theme=theme;document.body.classList.toggle('dark',theme==='dark');
  $('#theme-toggle').setAttribute('aria-checked',String(theme==='dark'));
  $('#theme-toggle').setAttribute('aria-label',theme==='dark'?'Ativar tema claro':'Ativar tema escuro');
  $('meta[name="theme-color"]').content=theme==='dark'?'#211c26':'#fff8f1';
}
function nav(to) {
  page=to;selectedId=null;render();window.scrollTo(0,0);
}
function render() {
  clearInterval(timerHandle);
  $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.page===page);if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#main').innerHTML=selectedId?detailView():page==='fichas'?listView():page==='historico'?historyView():homeView();
  bindPage();
  if(active){updateSessionTimer();timerHandle=setInterval(updateSessionTimer,1000);}
}
function intro(eyebrow,title,subtitle,button='') {
  return `<div class="page-intro"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p class="subtext">${subtitle}</p></div>${button}</div>`;
}
function statsView(){return `<div class="stats"><div class="stat">${icon('gym','stat-icon')}<strong>${data.workouts.length.toString().padStart(2,'0')}</strong><span>fichas de treino</span></div><div class="stat">${icon('check','stat-icon')}<strong>${data.sessions.length.toString().padStart(2,'0')}</strong><span>treinos concluídos</span></div><div class="stat">${icon('clock','stat-icon')}<strong>${Math.round(data.sessions.reduce((s,v)=>s+v.duration,0)/60)}</strong><span>minutos treinados</span></div></div>`;}
function weekView(){
  const now=new Date(),monday=new Date(now);monday.setDate(now.getDate()-((now.getDay()+6)%7));
  return `<div class="week" aria-label="Treinos concluídos nesta semana">${['SEG','TER','QUA','QUI','SEX','SÁB','DOM'].map((day,i)=>{
    const date=new Date(monday);date.setDate(monday.getDate()+i);const key=date.toDateString();
    const done=data.sessions.some(s=>new Date(s.completedAt).toDateString()===key),today=now.toDateString()===key;
    return `<div class="day ${done?'done':''} ${today?'today':''}" aria-label="${day}, ${date.getDate()}${today?', hoje':''}${done?', treino concluído':''}"><span>${day}</span><b>${done?'✓':date.getDate()}</b><i></i></div>`;
  }).join('')}</div>`;
}
function emptyView(history=false){return `<div class="empty"><div class="empty-symbol">${icon(history?'history':'gym')}</div><h3>${history?'Seu progresso começa aqui':'Seu próximo treino começa aqui'}</h3><p>${history?'Conclua um treino para acompanhar sua constância e o tempo dedicado a você.':'Crie sua primeira ficha com os exercícios e as cargas que fazem parte da sua rotina.'}</p><button class="button primary" data-action="${history?'go-fichas':'create'}">${history?'Ver minhas fichas':'Criar minha primeira ficha'} ${icon('arrow')}</button>${history?'':'<button class="text-button" data-action="template">Ou começar com uma ficha em branco guiada</button>'}</div>`;}
function card(w,index){return `<article class="workout-card"><div class="workout-card-top"><div class="workout-letter">${String.fromCharCode(65+(index%26))}</div><div class="workout-info"><h3>${escapeHtml(w.name)}</h3><p class="workout-focus">${escapeHtml(w.focus||'Seu treino, seu ritmo')}</p></div><button class="icon-button" data-action="edit" data-id="${w.id}" aria-label="Editar ${escapeHtml(w.name)}">${icon('edit')}</button></div><div class="card-meta"><span>${icon('gym')}${w.exercises.length} exercício${w.exercises.length!==1?'s':''}</span>${w.days?`<span>${icon('calendar')}${escapeHtml(w.days)}</span>`:''}</div><div class="card-bottom"><button class="text-button" data-action="open" data-id="${w.id}">Ver ficha ${icon('arrow')}</button><button class="button primary" data-action="start" data-id="${w.id}">${active&&active.id===w.id?'Continuar treino':'Começar treino'}</button></div></article>`;}
function homeView(){
  const date=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  return intro(date.toLocaleUpperCase('pt-BR'),'Um passo mais forte.','Sua evolução, um treino de cada vez.')+`<div class="home-columns"><div class="home-left"><section class="hero"><span class="eyebrow">FOCO NO SEU MOVIMENTO</span><h2>Pequenos passos.<br>Grandes conquistas.</h2><p class="hero-copy">Encontre seu ritmo.<br>A constância faz a diferença.</p><div class="sun"></div><div class="hill"></div><div class="hill second"></div>${icon('gym','hero-dumbbell')}<div class="hero-bottom"><span><i class="status-dot"></i> Seu treino sempre com você</span><span>100% offline</span></div></section><div class="section-heading"><h3>Sua semana</h3><span class="small-label">Um dia de cada vez</span></div>${weekView()}</div><div class="home-right">${statsView()}<div class="section-heading"><h2>Minhas fichas</h2><button class="text-button" data-action="go-fichas">Ver todas ${data.workouts.length?'('+data.workouts.length+')':''}</button></div><div class="workout-list">${data.workouts.length?data.workouts.slice(0,2).map(card).join(''):emptyView()}</div>${data.workouts.length?'<button class="button secondary full" data-action="create">+ Criar nova ficha</button>':''}</div></div><p class="footer-note">Feito para acompanhar o seu ritmo. PeraGym.</p>`;
}
function listView(){return intro('SUA ROTINA EM MOVIMENTO','Minhas fichas','Organize, ajuste e encontre seu ritmo.','<button class="button primary add-top" data-action="create" aria-label="Criar nova ficha">+ Nova</button>')+(data.workouts.length?`<label class="search">${icon('search')}<input id="search" type="search" placeholder="Buscar ficha ou grupo muscular" aria-label="Buscar ficha ou grupo muscular"></label><div id="workout-results" class="workout-list all">${data.workouts.map(card).join('')}</div>`:emptyView());}
function detailView(){
  const w=workout(selectedId);if(!w){selectedId=null;return listView();}
  const running=active&&active.id===w.id;
  return `<div class="detail-layout"><div class="page-title-row"><button class="icon-button" data-action="back" aria-label="Voltar">${icon('back')}</button><span class="eyebrow">SUA FICHA DE TREINO</span></div><section class="detail-hero"><span class="eyebrow">${escapeHtml(w.days||'SEU TREINO, SEU RITMO')}</span><h1>${escapeHtml(w.name)}</h1><p class="subtext">${escapeHtml(w.focus||'Pronto para o seu próximo passo?')}</p></section>${running?'<div class="session-bar"><div><span>TREINO EM ANDAMENTO</span><strong id="session-time">00:00</strong></div><button data-action="finish">Concluir treino ✓</button></div>':`<div class="detail-actions"><button class="button primary" data-action="start" data-id="${w.id}">Começar treino ${icon('arrow')}</button><button class="button secondary" data-action="edit" data-id="${w.id}" aria-label="Editar ficha">${icon('edit')}</button><button class="icon-button" data-action="delete" data-id="${w.id}" aria-label="Excluir ficha">${icon('trash')}</button></div>`}<div class="section-heading"><h3>${w.exercises.length} exercício${w.exercises.length===1?'':'s'}</h3><span class="small-label">Carga em kg</span></div>${w.exercises.map((e,i)=>`<article class="exercise-card"><div class="exercise-heading"><span class="exercise-index">${(i+1).toString().padStart(2,'0')}</span><h3>${escapeHtml(e.name)}</h3></div><div class="exercise-prescription"><span>${e.sets} séries</span><span>${escapeHtml(e.reps)} repetições</span><span>${e.rest}s de descanso</span></div><div class="weight-control"><span class="small-label">Carga atual</span><div class="weight-stepper"><button data-action="weight-minus" data-id="${e.id}" aria-label="Diminuir carga de ${escapeHtml(e.name)} em 1 kg" ${Number(e.weight)<=0?'disabled':''}>−</button><button class="weight-value" data-action="weight-edit" data-id="${e.id}" aria-label="Editar carga de ${escapeHtml(e.name)}">${formatKg(e.weight)} <small>kg</small></button><button data-action="weight-plus" data-id="${e.id}" aria-label="Aumentar carga de ${escapeHtml(e.name)} em 1 kg" ${Number(e.weight)>=2000?'disabled':''}>+</button></div></div>${e.notes?`<p class="exercise-note">${escapeHtml(e.notes)}</p>`:''}${running?`<button class="done-exercise ${active.done.includes(e.id)?'checked':''}" data-action="check-exercise" data-id="${e.id}" aria-pressed="${active.done.includes(e.id)}">${icon('check')}${active.done.includes(e.id)?'Exercício concluído':'Marcar exercício como concluído'}</button>${e.rest?`<button class="rest-button" data-action="rest" data-seconds="${e.rest}">${icon('clock')} Iniciar descanso de ${e.rest}s</button>`:''}`:''}</article>`).join('')}${w.notes?`<div class="note-box"><strong>Suas observações</strong><br>${escapeHtml(w.notes)}</div>`:''}<p class="footer-note">Toque na carga para editar. Os ajustes são salvos automaticamente.</p></div>`;
}
function historyView(){return intro('CADA TREINO CONTA','Seu progresso','Um registro da sua constância.')+statsView()+(data.sessions.length?`<div class="section-heading"><h2>Treinos concluídos</h2><span class="small-label">Mais recentes</span></div>${data.sessions.map(s=>`<article class="history-item"><span class="history-tick">✓</span><div class="history-info"><h3>${escapeHtml(s.workoutName)}</h3><p>${new Date(s.completedAt).toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'})} · ${new Date(s.completedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</p></div><div class="history-duration">${Math.floor(s.duration/60)} min<small>${s.duration%60} s</small></div></article>`).join('')}`:emptyView(true));}

function bindPage(){
  $$('[data-action]',$('#main')).forEach(b=>b.addEventListener('click',()=>handle(b.dataset.action,b.dataset)));
  const search=$('#search');if(search)search.addEventListener('input',()=>{
    const q=search.value.trim().toLocaleLowerCase('pt-BR');
    const matches=data.workouts.filter(w=>(w.name+' '+w.focus).toLocaleLowerCase('pt-BR').includes(q));
    $('#workout-results').innerHTML=matches.length?matches.map(w=>card(w,data.workouts.indexOf(w))).join(''):'<p class="small-label">Nenhuma ficha encontrada. Tente outro nome.</p>';
    $$('[data-action]',$('#workout-results')).forEach(b=>b.addEventListener('click',()=>handle(b.dataset.action,b.dataset)));
  });
}
async function handle(action,ds={}){
  try{
    if(action==='create')return openEditor();
    if(action==='template')return openEditor({name:'Treino A',focus:'',days:'',notes:'',exercises:[{name:'',sets:3,reps:'10',weight:0,rest:60,notes:''}]});
    if(action==='go-fichas')return nav('fichas');
    if(action==='open'){selectedId=Number(ds.id);render();window.scrollTo(0,0);return;}
    if(action==='back'){selectedId=null;render();return;}
    if(action==='edit')return openEditor(workout(ds.id));
    if(action==='delete'){
      const w=workout(ds.id);if(await ask('Excluir esta ficha?',`A ficha “${w.name}” e seus exercícios serão excluídos. O histórico de treinos concluídos será mantido.`,'Excluir ficha')){
        call('deleteWorkout',w.id);if(active&&active.id===w.id)clearActive();refresh();selectedId=null;render();notify('Ficha excluída.');
      }return;
    }
    if(action.startsWith('weight-')){
      const w=workout(selectedId),e=w.exercises.find(x=>x.id===Number(ds.id));
      if(action==='weight-edit')return editWeight(e);
      const weight=Math.min(2000,Math.max(0,Math.round((Number(e.weight)+(action==='weight-plus'?1:-1))*100)/100));
      call('updateWeight',e.id,weight);refresh();render();notify(`Carga salva: ${formatKg(weight)} kg`);return;
    }
    if(action==='start'){
      const w=workout(ds.id);if(!w.exercises.length){notify('Adicione um exercício para começar.');return;}
      if(active&&active.id!==w.id){if(!await ask('Começar outro treino?','O treino em andamento será encerrado sem entrar no histórico.','Começar outro'))return;clearActive();}
      if(!active){active={id:w.id,startedAt:Date.now(),done:[]};persistActive();}
      selectedId=w.id;render();window.scrollTo(0,0);return;
    }
    if(action==='check-exercise'){
      const id=Number(ds.id);active.done=active.done.includes(id)?active.done.filter(x=>x!==id):[...active.done,id];persistActive();render();return;
    }
    if(action==='finish'){
      const w=workout(active.id),incomplete=active.done.length<w.exercises.length;
      if(incomplete&&!await ask('Concluir este treino?','Alguns exercícios ainda não foram marcados como concluídos. Deseja registrar o treino mesmo assim?','Concluir treino'))return;
      call('finishWorkout',JSON.stringify({workoutId:active.id,duration:Math.max(0,Math.floor((Date.now()-active.startedAt)/1000))}));
      clearActive();refresh();selectedId=null;page='historico';render();window.scrollTo(0,0);notify('Mais um passo! Treino registrado.');return;
    }
    if(action==='rest'){restUntil=Date.now()+Number(ds.seconds)*1000;startRest();return;}
  }catch(e){notify(e.message);}
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
  editingId=w&&w.id||0;$('#editor-title').textContent=editingId?'Editar ficha de treino':'Nova ficha de treino';
  const form=$('#workout-form');form.reset();['name','focus','days','notes'].forEach(k=>form.elements[k].value=w&&w[k]||'');
  $('#exercise-fields').innerHTML='';(w&&w.exercises.length?w.exercises:[{}]).forEach(addExerciseField);updateExerciseLabels();
  draftInitial=JSON.stringify(readDraft());$('#editor').showModal();$('.form-content').scrollTop=0;
}
function addExerciseField(e={}){
  const el=document.createElement('section');el.className='exercise-field';el.dataset.id=e.id||0;
  el.innerHTML=`<div class="field-heading"><b>Exercício</b><button type="button" class="icon-button remove-exercise" aria-label="Remover exercício">${icon('trash')}</button></div><label>Nome do exercício<input class="ex-name" value="${escapeHtml(e.name||'')}" placeholder="Ex.: Supino reto" required maxlength="100"></label><div class="form-grid"><label>Séries<input class="ex-sets" type="number" min="1" max="100" step="1" inputmode="numeric" required value="${e.sets??3}"></label><label>Repetições<input class="ex-reps" required maxlength="30" placeholder="Ex.: 8–12" value="${escapeHtml(e.reps??'10')}"></label><label>Carga (kg)<input class="ex-weight" type="text" inputmode="decimal" required maxlength="10" value="${formatKg(e.weight??0).replace(/\./g,'')}"></label><label>Descanso (s)<input class="ex-rest" type="number" min="0" max="3600" step="1" inputmode="numeric" required value="${e.rest??60}"></label></div><label>Observação do exercício<input class="ex-notes" maxlength="500" placeholder="Ex.: Ajuste de banco" value="${escapeHtml(e.notes||'')}"></label>`;
  $('.remove-exercise',el).onclick=()=>{el.remove();updateExerciseLabels();};$('#exercise-fields').append(el);updateExerciseLabels();
}
function updateExerciseLabels(){const fields=$$('.exercise-field');fields.forEach((el,i)=>{$('b',el).textContent=`Exercício ${(i+1).toString().padStart(2,'0')}`;$('.remove-exercise',el).setAttribute('aria-label',`Remover exercício ${i+1}`);});$('#exercise-count').textContent=`${fields.length} na ficha`;}
function readDraft(){
  const f=$('#workout-form');return {id:editingId,name:f.elements.name.value.trim(),focus:f.elements.focus.value.trim(),days:f.elements.days.value.trim(),notes:f.elements.notes.value.trim(),exercises:$$('.exercise-field').map(el=>({id:Number(el.dataset.id),name:$('.ex-name',el).value.trim(),sets:Number($('.ex-sets',el).value),reps:$('.ex-reps',el).value.trim(),weight:$('.ex-weight',el).value.trim(),rest:Number($('.ex-rest',el).value),notes:$('.ex-notes',el).value.trim()}))};
}
function parseWeight(raw){
  const text=String(raw).trim();if(!/^\d+(?:[.,]\d{1,2})?$/.test(text))throw new Error('Informe uma carga válida, como 12,5 kg, com até duas casas decimais.');
  const n=Number(text.replace(',','.'));if(!Number.isFinite(n)||n<0||n>2000)throw new Error('A carga deve ficar entre 0 e 2.000 kg.');return n;
}
async function closeEditor(){if(JSON.stringify(readDraft())!==draftInitial&&!await ask('Descartar alterações?','As alterações desta ficha ainda não foram salvas.','Descartar'))return;$('#editor').close();}
function saveEditor(event){
  event.preventDefault();try{
    const w=readDraft();if(!w.name)throw new Error('Dê um nome para sua ficha.');if(!w.exercises.length)throw new Error('Adicione pelo menos um exercício.');
    w.exercises.forEach(e=>{if(!e.name||!e.reps)throw new Error('Preencha o nome e as repetições dos exercícios.');e.weight=parseWeight(e.weight);if(!Number.isInteger(e.sets)||e.sets<1||e.sets>100)throw new Error('Use de 1 a 100 séries.');if(!Number.isInteger(e.rest)||e.rest<0||e.rest>3600)throw new Error('Use um descanso de 0 a 3.600 segundos.');});
    const result=call('saveWorkout',JSON.stringify(w));refresh();$('#editor').close();selectedId=Number(result.id);page='fichas';render();window.scrollTo(0,0);notify(editingId?'Ficha atualizada.':'Ficha criada. Seu próximo passo está pronto!');
  }catch(e){notify(e.message);}
}
function editWeight(e){
  const dialog=document.createElement('dialog');dialog.className='weight-dialog';dialog.innerHTML=`<form class="confirm-content"><h2>Qual é a nova carga?</h2><p>${escapeHtml(e.name)}</p><label class="small-label">Carga em quilos<input id="quick-weight" type="text" inputmode="decimal" required maxlength="10" value="${formatKg(e.weight).replace(/\./g,'')}" aria-label="Nova carga em quilos"></label><p class="form-hint">De 0 a 2.000 kg. Ex.: 12,5</p><div class="confirm-actions"><button type="button" class="button secondary">Cancelar</button><button type="submit" class="button primary">Salvar carga</button></div></form>`;
  document.body.append(dialog);const cleanup=()=>{dialog.close();dialog.remove();};$('.secondary',dialog).onclick=cleanup;dialog.oncancel=ev=>{ev.preventDefault();cleanup();};$('form',dialog).onsubmit=ev=>{ev.preventDefault();try{const weight=parseWeight($('#quick-weight',dialog).value);call('updateWeight',e.id,weight);refresh();cleanup();render();notify('Carga atualizada.');}catch(err){notify(err.message);}};dialog.showModal();$('#quick-weight',dialog).select();
}
function persistActive(){try{sessionStorage.setItem('peragym-active',JSON.stringify(active));}catch(e){/* SQLite still persists all completed data. */}}
function clearActive(){active=null;restUntil=0;clearInterval(timerHandle);clearInterval(restHandle);$('.rest-pill')?.remove();try{sessionStorage.removeItem('peragym-active');}catch(e){}}
function updateSessionTimer(){if($('#session-time')&&active)$('#session-time').textContent=timeText(Math.floor((Date.now()-active.startedAt)/1000));}
function startRest(){
  $('.rest-pill')?.remove();clearInterval(restHandle);const el=document.createElement('div');el.className='rest-pill';el.setAttribute('role','timer');el.setAttribute('aria-label','Tempo de descanso');el.innerHTML='<span>Respire.<br>Seu descanso</span><strong></strong><button aria-label="Encerrar descanso">×</button>';document.body.append(el);$('button',el).onclick=()=>{clearInterval(restHandle);el.remove();restUntil=0;};
  const tick=()=>{const seconds=Math.max(0,Math.ceil((restUntil-Date.now())/1000));$('strong',el).textContent=timeText(seconds);if(seconds===0){clearInterval(restHandle);el.remove();notify('Descanso concluído. Pronto para a próxima série?');}};tick();restHandle=setInterval(tick,500);
}
window.peraBack=()=>{
  const open=$$('dialog[open]');if(open.length){const top=open[open.length-1];top.dispatchEvent(new Event('cancel',{cancelable:true}));return true;}
  if(selectedId){selectedId=null;render();return true;}if(page!=='inicio'){nav('inicio');return true;}
  return false;
};
$('#theme-toggle').onclick=()=>setTheme(data.theme==='dark'?'light':'dark');
$$('.nav-item').forEach(b=>b.onclick=()=>nav(b.dataset.page));$('.brand').onclick=e=>{e.preventDefault();nav('inicio');};
$('#add-exercise').onclick=()=>{if($$('.exercise-field').length>=100){notify('Use até 100 exercícios por ficha.');return;}addExerciseField();$$('.exercise-field').at(-1).scrollIntoView({block:'start',behavior:'smooth'});};
$('#workout-form').onsubmit=saveEditor;$('#close-editor').onclick=closeEditor;$('#cancel-editor').onclick=closeEditor;$('#editor').oncancel=e=>{e.preventDefault();closeEditor();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$$('dialog[open]').length&&selectedId){selectedId=null;render();}});
async function init(){
  try{
    refresh();setTheme(data.theme,false);
    try{const saved=JSON.parse(sessionStorage.getItem('peragym-active'));if(saved&&workout(saved.id)&&Number.isFinite(saved.startedAt)&&Array.isArray(saved.done)){active=saved;selectedId=saved.id;}}catch(e){}
    render();
  }catch(e){$('#main').innerHTML='<div class="error-panel"><h2>Vamos tentar de novo?</h2><p>Não foi possível abrir suas fichas. Feche e reabra o PeraGym para tentar novamente.</p></div>';}
  await new Promise(resolve=>setTimeout(resolve,650));$('#app').hidden=false;$('#loading').classList.add('fade');setTimeout(()=>$('#loading').remove(),300);
}
init();
