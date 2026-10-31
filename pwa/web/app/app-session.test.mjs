import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {parseMusicLink} from './music-links.js';

const APP_URL=new URL('./app.js',import.meta.url);
const clone=value=>structuredClone(value);
const workout={id:'workout-a',name:'Treino A',focus:'Superiores',days:'Segunda',notes:'',exercises:[{id:'exercise-a',name:'Supino',sets:3,reps:'10',weight:12.5,rest:60,notes:''}]};
const anotherWorkout={...workout,id:'workout-b',name:'Treino B',exercises:[{...workout.exercises[0],id:'exercise-b',name:'Remada'}]};
const sessionA={id:'history-a',workoutId:workout.id,workoutName:workout.name,completedAt:1_800_000_000_000,duration:60,volume:375};
const sessionB={...sessionA,id:'history-b',workoutName:'Treino B',workoutId:anotherWorkout.id,completedAt:1_800_000_010_000};
const initialData=()=>({workouts:clone([workout,anotherWorkout]),sessions:clone([sessionA,sessionB]),loadHistory:[],bodyWeights:[],musicLinks:[],theme:'light',activeSession:null});
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};

/** Execute the production handle/detailView with mocked boundaries, not copied logic. */
async function harness(t,{activeSession=null,confirm=true}={}){
 let now=1_800_000_100_000,model=initialData(),renderCount=0,pendingRecovery=false,authRenderCount=0;
 model.activeSession=clone(activeSession);
 const calls=[],notices=[],confirmations=[],playerCalls=[],loadingCalls=[],loadingOperations=[],editorEvents=[],deferred=new Map(),timers=new Map(),elements=new Map();
 let nextTimer=0;
 function element(selector){
  if(elements.has(selector))return elements.get(selector);
  const classes=new Set(),attributes=new Map();
  const item={selector,hidden:false,disabled:false,textContent:'',innerHTML:'',dataset:{},value:'',id:selector.startsWith('#')?selector.slice(1):'',isConnected:true,
   classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),toggle(value,force){const on=force??!classes.has(value);if(on)classes.add(value);else classes.delete(value);return on;},contains:value=>classes.has(value)},
   setAttribute:(name,value)=>attributes.set(name,String(value)),getAttribute:name=>attributes.get(name)??null,removeAttribute:name=>attributes.delete(name),
   addEventListener(){},removeEventListener(){},focus(){},scrollIntoView(){},select(){},click(){},reset(){},close(){item.open=false;},showModal(){item.open=true;},remove(){item.isConnected=false;},replaceChildren(){item.innerHTML='';},append(){},prepend(){},
   querySelector:child=>element(`${selector} ${child}`),querySelectorAll:()=>[],elements:{name:{value:''},focus:{value:''},days:{value:''},notes:{value:''}}};
  elements.set(selector,item);return item;
 }
 const document={querySelector:element,querySelectorAll:selector=>selector==='.nav-item'?['inicio','fichas','historico','musica'].map(page=>{const item=element(`[nav=${page}]`);item.dataset.page=page;return item;}):[],addEventListener(){},body:element('body'),head:element('head'),activeElement:null,createElement:tag=>element(`[created-${tag}-${elements.size}]`)};
 let authState={unlocked:true,profileId:'profile-a',profile:{id:'profile-a',name:'Bruno',username:'bruno'},generation:1};
 const localAccount={getState:()=>clone(authState),lock(){authState={...authState,unlocked:false,generation:authState.generation+1};}};
 async function commit(name,args,apply){
  const copy=clone(args);calls.push({name,args:copy});
  const queue=deferred.get(name),pending=queue?.shift();if(pending)await pending.promise;
  return apply(copy);
 }
 const store={
  load:()=>commit('load',[],()=>clone(model)),
  setSetting:(key,value)=>commit('setSetting',[key,value],args=>{model[args[0]]=clone(args[1]);return {ok:true};}),
  finishWorkout:input=>commit('finishWorkout',[input],([row])=>{model.sessions.push({...row,id:'history-new',workoutName:model.workouts.find(w=>w.id===row.workoutId)?.name,completedAt:now});model.activeSession=null;return {ok:true,id:'history-new'};}),
  saveWorkout:input=>commit('saveWorkout',[input],([row])=>{const index=model.workouts.findIndex(w=>w.id===row.id);if(index<0)model.workouts.push(row);else model.workouts[index]=row;if(model.activeSession?.id===row.id)model.activeSession.done=model.activeSession.done.filter(id=>row.exercises.some(e=>e.id===id));return {id:row.id};}),
  deleteWorkout:id=>commit('deleteWorkout',[id],([target])=>{model.workouts=model.workouts.filter(w=>w.id!==target);if(model.activeSession?.id===target)model.activeSession=null;return {ok:true};}),
  deleteSession:id=>commit('deleteSession',[id],([target])=>{model.sessions=model.sessions.filter(row=>row.id!==target);return {ok:true};}),
  inspectLegacy:async()=>({hasData:false})
 };
 const context={console,URL,URLSearchParams,structuredClone,Date:class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},
  document,location:new URL('https://perabru.github.io/peragym/docs/app/'),navigator:{onLine:true},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},localAccount,store,
  createOperationLoading:()=>({run:(message,task)=>{loadingCalls.push(message);return task();},start:message=>{loadingCalls.push(message);const operation={message,updates:[],releases:0};loadingOperations.push(operation);const release=()=>{operation.releases++;};release.update=value=>{operation.updates.push(value);};return release;},clear(){},track:(_message,promise)=>promise}),
  readMusicConnectionConfig:()=>({spotifyClientId:'',googleClientId:''}),saveMusicConnectionConfig(){},clearMusicConnectionConfig(){},
  createLocalBiometric:()=>({}),createLocalDeviceSession:()=>({clear:()=>commit('clearDeviceSession',[],()=>undefined)}),createLocalAuthUI:()=>({hasPendingRecovery:()=>pendingRecovery,render(){authRenderCount++;},settingsMarkup:()=>'',bindSettings(){},reset:async()=>{},initialize:async()=>{}}),
  createMusicPlayer:()=>({close(){playerCalls.push({name:'close'});},load:async value=>{playerCalls.push({name:'load',value:clone(value)});},loadQueue:async(items,options)=>{playerCalls.push({name:'loadQueue',items:clone(items),options:clone(options)});return {index:options.index,length:items.length};},getQueueState:()=>null,openAccount:(provider,profile)=>{playerCalls.push({name:'openAccount',provider,profile:clone(profile)});},setMessage:message=>{playerCalls.push({name:'setMessage',message});}}),createYouTubeAccount:()=>({}),createSpotifyAccount:()=>({}),parseMusicLink,renderChart:()=>'',filterRange:points=>points,summarize:()=>({count:0,last:null}),
  setInterval:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  __showEditor:value=>{editorEvents.push({workout:clone(value),active:clone(vmContext.__appTest.getState().active),saved:clone(model.activeSession)});element('#editor').open=true;},
  __render:()=>{renderCount++;},__notify:message=>notices.push(String(message)),__ask:(...args)=>{confirmations.push(args);return Promise.resolve(typeof confirm==='function'?confirm(...args):confirm);}};
 context.window={addEventListener(){},dispatchEvent(){},scrollTo(){}};
 let source=await readFile(APP_URL,'utf8');
 // Only import bindings are replaced; all production action and rendering bodies execute unchanged.
 for(const match of source.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?$/gm)){
  if(!/workout-session\.js(?:\?|$)/.test(match[2]))continue;
  const module=await import(new URL(match[2].split('?')[0],APP_URL).href);
  for(const binding of match[1].split(',')){
   const [exported,local=exported]=binding.trim().split(/\s+as\s+/);
   context[local]=(value,at=now)=>module[exported](value,at);
  }
 }
 source=source.replace(/^import\s+[^;]+;\s*$/gm,'').replaceAll('import.meta.url',JSON.stringify(APP_URL.href)).replace(/\ninit\(\);?\s*$/,'\n');
 source+='\nconst productionRender=render;render=globalThis.__render;notify=globalThis.__notify;ask=globalThis.__ask;if(typeof showWorkoutEditor==="function")showWorkoutEditor=globalThis.__showEditor;globalThis.__appTest={nav,hasLocalAccess,productionRender,handle,card,detailView,historyView,openEditor,saveEditor,prepareYouTube,rememberMusic,loadMusicPlaylist,loadSpotifyTracks,loadYouTubeTracks,playMusicQueue,musicTrackResults,musicLibraryResults,musicView,setDraft(value){readDraft=()=>structuredClone(value);},activateMusic,lockApp,setAccounts(spotify,youtube){spotifyAccount=spotify;youtubeAccount=youtube;},setState(value){if("active"in value)active=structuredClone(value.active);if(value.data)data=structuredClone(value.data);if("selectedId"in value)selectedId=value.selectedId;if(value.page)page=value.page;if("musicTrackPage"in value)musicTrackPage=value.musicTrackPage;if("musicTrackSearch"in value)musicTrackSearch=value.musicTrackSearch;if("musicPlaylistSearch"in value)musicPlaylistSearch=value.musicPlaylistSearch;},getState(){return structuredClone({active,data,selectedId,page,handling,restUntil,spotifyPlaylists,youtubePlaylists,spotifyTracks,youtubeTracks,selectedMusicPlaylist,musicTrackPage,musicTrackSearch,musicPlaylistSearch,musicPlaylistFailure});},updateSessionTimer};';
 const vmContext=vm.createContext(context);vm.runInContext(source,vmContext,{filename:'production-app.js'});
 const app=vmContext.__appTest;app.setState({active:activeSession,data:model,selectedId:activeSession?.id??workout.id,page:'fichas'});
 return {app,store,calls,notices,confirmations,playerCalls,loadingCalls,loadingOperations,editorEvents,elements,setRecoveryPending:value=>{pendingRecovery=value;},authRenders:()=>authRenderCount,accountState:()=>clone(authState),setAccountState:value=>{authState={...authState,...clone(value)};},model:()=>clone(model),renders:()=>renderCount,now:()=>now,advance:ms=>{now+=ms;},
  deferNext(name){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const queue=deferred.get(name)||[];queue.push({promise});deferred.set(name,queue);return {resolve,reject};},
  sync(){app.setState({data:model});},element};
}

const activeAt=(now,extra={})=>({id:workout.id,startedAt:now,done:[],pausedAt:null,pausedMs:0,...extra});

test('cancel confirmation leaves the running workout and persisted state unchanged',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']});const env=await harness(t,{activeSession:active,confirm:false});
 await env.app.handle('session-cancel');
 assert.equal(env.confirmations.length,1);assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);
 assert.equal(env.calls.filter(c=>c.name==='setSetting'||c.name==='finishWorkout').length,0);
});

test('pause and resume persist their transitions and completion excludes all paused time',async t=>{
 const env=await harness(t);await env.app.handle('start',{id:workout.id});
 env.advance(15000);await env.app.handle('session-pause');
 assert.equal(env.app.getState().active.pausedAt,env.now());assert.deepEqual(env.app.getState().active,env.model().activeSession);
 env.advance(70000);env.app.updateSessionTimer();assert.equal(env.element('#session-time').textContent,'00:15');
 await env.app.handle('session-resume');assert.equal(env.app.getState().active.pausedAt,null);assert.equal(env.app.getState().active.pausedMs,70000);
 env.advance(10000);await env.app.handle('check-exercise',{id:'exercise-a'});await env.app.handle('finish');
 const finish=env.calls.find(c=>c.name==='finishWorkout');assert.ok(finish,'Completion must be persisted');assert.equal(finish.args[0].duration,25);
 assert.equal(env.app.getState().active,null);assert.equal(env.app.getState().page,'historico');
});

test('restart confirms, preserves the selected workout, and resets elapsed time and checklist',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a'],pausedAt:1_800_000_030_000,pausedMs:5000});const env=await harness(t,{activeSession:active});
 await env.app.handle('session-restart');const next=env.app.getState().active;
 assert.equal(env.confirmations.length,1);assert.equal(next.id,workout.id);assert.equal(next.startedAt,env.now());assert.deepEqual(next.done,[]);assert.equal(next.pausedMs,0);assert.equal(next.pausedAt,null);
 assert.deepEqual(next,env.model().activeSession);assert.equal(env.calls.some(c=>c.name==='finishWorkout'),false);
});

test('accepted cancellation clears the active session without adding any history row',async t=>{
 const active=activeAt(1_800_000_000_000);const env=await harness(t,{activeSession:active});const history=env.model().sessions;
 await env.app.handle('session-cancel');assert.equal(env.confirmations.length,1);assert.equal(env.app.getState().active,null);assert.equal(env.model().activeSession,null);
 assert.deepEqual(env.model().sessions,history);assert.equal(env.calls.some(c=>c.name==='finishWorkout'),false);
});

test('deleting history confirms and removes only the selected session then reloads data',async t=>{
 const active=activeAt(1_800_000_000_000);const env=await harness(t,{activeSession:active});
 await env.app.handle('history-delete',{id:sessionA.id});
 assert.equal(env.confirmations.length,1);assert.deepEqual(env.calls.find(c=>c.name==='deleteSession')?.args,[sessionA.id]);assert.ok(env.calls.some(c=>c.name==='load'));
 assert.deepEqual(env.app.getState().data.sessions.map(row=>row.id),[sessionB.id]);assert.deepEqual(env.model().activeSession,active);assert.deepEqual(env.app.getState().active,active);
 assert.ok(env.renders()>0);assert.equal(env.app.historyView().includes(sessionA.workoutName),false);assert.ok(env.app.historyView().includes(sessionB.workoutName));
});

test('failed session transition keeps RAM and persisted state unchanged until storage succeeds',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']});const env=await harness(t,{activeSession:active});const pending=env.deferNext('setSetting');
 const action=env.app.handle('session-pause');await flush();
 assert.deepEqual(env.app.getState().active,active,'RAM must still describe the durable session while a save is pending');assert.deepEqual(env.model().activeSession,active);
 pending.reject(new Error('Falha simulada ao salvar'));await action;
 assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);assert.equal(env.app.getState().handling,false);assert.ok(env.notices.some(m=>m.includes('Falha simulada')));
});

test('failed cancellation does not discard the in-memory workout',async t=>{
 const active=activeAt(1_800_000_000_000);const env=await harness(t,{activeSession:active});const pending=env.deferNext('setSetting');
 const action=env.app.handle('session-cancel');await flush();assert.deepEqual(env.app.getState().active,active);
 pending.reject(new Error('Falha ao cancelar'));await action;assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);
});

test('paused details expose resume and disable exercise/rest actions until continuing',async t=>{
 const active=activeAt(1_800_000_000_000,{pausedAt:1_800_000_050_000});const env=await harness(t,{activeSession:active});
 const html=env.app.detailView();assert.ok(html.includes('data-action="session-resume"'));assert.equal(html.includes('data-action="session-pause"'),false);assert.ok(html.includes('TREINO PAUSADO'));
 assert.match(html,/data-action="check-exercise"[^>]*disabled/);assert.match(html,/data-action="rest"[^>]*disabled/);
 await env.app.handle('check-exercise',{id:'exercise-a'});await env.app.handle('rest',{seconds:'60'});
 assert.deepEqual(env.app.getState().active,active);assert.equal(env.app.getState().restUntil,0);assert.equal(env.calls.length,0);
});

test('completing while paused excludes the pause and performs no second active-session write',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a'],pausedAt:1_800_000_030_000,pausedMs:5000});const env=await harness(t,{activeSession:active});
 env.advance(600000);await env.app.handle('finish');
 assert.equal(env.calls.find(c=>c.name==='finishWorkout').args[0].duration,25);assert.equal(env.calls.some(c=>c.name==='setSetting'),false);assert.equal(env.app.getState().active,null);
});

test('declining history deletion preserves every record without issuing a write',async t=>{
 const env=await harness(t,{confirm:false});const before=env.model();await env.app.handle('history-delete',{id:sessionA.id});
 assert.equal(env.confirmations.length,1);assert.equal(env.calls.length,0);assert.deepEqual(env.model(),before);assert.deepEqual(env.app.getState().data.sessions,before.sessions);
});

test('failed history deletion leaves both the visible rows and persisted history unchanged',async t=>{
 const env=await harness(t),before=env.model().sessions,pending=env.deferNext('deleteSession');
 const action=env.app.handle('history-delete',{id:sessionA.id});await flush();assert.deepEqual(env.app.getState().data.sessions,before);
 pending.reject(new Error('Não foi possível excluir'));await action;assert.deepEqual(env.app.getState().data.sessions,before);assert.deepEqual(env.model().sessions,before);assert.ok(env.notices.includes('Não foi possível excluir'));
});

for(const [action,active] of [
 ['start',null],
 ['session-resume',activeAt(1_800_000_000_000,{pausedAt:1_800_000_030_000})],
 ['session-restart',activeAt(1_800_000_000_000,{done:['exercise-a']})],
 ['check-exercise',activeAt(1_800_000_000_000)]
])test(`failed ${action} persistence never commits a provisional RAM state`,async t=>{
 const env=await harness(t,{activeSession:active}),pending=env.deferNext('setSetting');
 const operation=env.app.handle(action,action==='start'?{id:workout.id}:{id:'exercise-a'});await flush();
 assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);
 pending.reject(new Error('Armazenamento indisponível'));await operation;
 assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);assert.equal(env.app.getState().handling,false);
});

test('failed completion retains the active checklist and does not invent a history entry',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']});const env=await harness(t,{activeSession:active}),before=env.model().sessions,pending=env.deferNext('finishWorkout');
 const action=env.app.handle('finish');await flush();assert.deepEqual(env.app.getState().active,active);
 pending.reject(new Error('Falha ao concluir treino'));await action;
 assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().sessions,before);assert.deepEqual(env.model().activeSession,active);assert.ok(env.notices.includes('Falha ao concluir treino'));
});

function fakeMusicAccount({provider='spotify',connected=true,rows=[],pending=null,connectResult}={}){
 let authorized=connected;
 return {getState:()=>({configured:true,ready:true,connected:authorized,profile:authorized?{id:`${provider}-account`,displayName:'Conta real autorizada'}:undefined}),
  getPlaylists:()=>pending?pending.promise:Promise.resolve(clone(rows)),
  connectPopup:()=>Promise.resolve(connectResult??{connected:authorized}),connect:()=>Promise.resolve(connectResult??{connected:authorized}),
  getPlaylistTracks:()=>Promise.resolve([]),disconnect(){authorized=false;return Promise.resolve({revoked:false});}};
}
function promiseControl(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

for(const provider of ['spotify','youtube'])test(`verified ${provider} account opens its page/player and loads playlists without autoplay`,async t=>{
 const env=await harness(t);
 const row=provider==='spotify'?{id:'37i9dQZF1DXcBWIGoYBM5M',name:'Treino',url:'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'}:{id:'PLabcdefghijklmnopqrstuv',name:'Treino',privacyStatus:'public',url:'https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuv'};
 const account=fakeMusicAccount({provider,rows:[row]});env.app.setAccounts(provider==='spotify'?account:null,provider==='youtube'?account:null);
 await env.app.activateMusic(provider);
 assert.equal(env.app.getState().page,'musica');assert.equal(env.app.getState().selectedId,null);
 assert.equal(env.playerCalls.find(c=>c.name==='openAccount')?.provider,provider);
 assert.equal(env.playerCalls.some(c=>c.name==='load'||c.name==='loadQueue'),false,'Connecting only opens the account/library; playback needs a selection');
 assert.equal(env.model().musicLinks.length,0);assert.ok(env.loadingCalls.some(label=>label.includes('playlists')));
});

test('a failed account authorization never opens a connected player or switches the workout screen',async t=>{
 const env=await harness(t),account=fakeMusicAccount({connected:false,connectResult:{connected:false,error:'Autorização cancelada'}});env.app.setAccounts(account,null);
 await env.app.handle('spotify-connect');
 assert.equal(env.playerCalls.some(c=>c.name==='openAccount'||c.name==='load'),false);assert.equal(env.app.getState().page,'fichas');assert.equal(env.app.getState().selectedId,workout.id);assert.ok(env.notices.includes('Autorização cancelada'));
});

test('locking the local profile during library loading cannot autoplay or expose late playlist data',async t=>{
 const env=await harness(t),pending=promiseControl(),account=fakeMusicAccount({pending});env.app.setAccounts(account,null);
 const activating=env.app.activateMusic('spotify');await flush();assert.equal(env.playerCalls.filter(c=>c.name==='openAccount').length,1);
 await env.app.lockApp();assert.equal(env.accountState().unlocked,false);
 pending.resolve([{id:'37i9dQZF1DXcBWIGoYBM5M',name:'Lista do perfil anterior',url:'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'}]);await activating;
 assert.equal(env.app.getState().page,'inicio');assert.deepEqual(env.app.getState().spotifyPlaylists,[]);assert.equal(env.playerCalls.some(c=>c.name==='load'),false);assert.equal(env.playerCalls.some(c=>c.name==='setMessage'),false);assert.deepEqual(env.app.getState().data.musicLinks,[]);
});

function visibleActionLabel(html,action){
 const match=html.match(new RegExp(`<button\\b(?=[^>]*data-action="${action}")[^>]*>([\\s\\S]*?)<\\/button>`));
 return match?match[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():null;
}

for(const [label,session] of [['idle',null],['running',activeAt(1_800_000_000_000)],['paused',activeAt(1_800_000_000_000,{pausedAt:1_800_000_030_000})]])test(`workout card and details show visible edit/delete labels while ${label}`,async t=>{
 const env=await harness(t,{activeSession:session});
 for(const html of [env.app.card(workout,0),env.app.detailView()]){
  assert.match(visibleActionLabel(html,'edit')||'',/Editar/);assert.match(visibleActionLabel(html,'delete')||'',/Excluir/);
 }
});

test('editing the running workout persists its pause before opening the editor and preserves completed exercises',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']}),env=await harness(t,{activeSession:active}),pending=env.deferNext('setSetting');
 const action=env.app.handle('edit',{id:workout.id});await flush();
 assert.equal(env.editorEvents.length,0,'The editor must not appear before the durable pause');assert.deepEqual(env.app.getState().active,active);
 pending.resolve();await action;assert.equal(env.editorEvents.length,1);
 const event=env.editorEvents[0];assert.equal(event.workout.id,workout.id);assert.equal(event.active.pausedAt,env.now());assert.deepEqual(event.active.done,['exercise-a']);assert.deepEqual(event.active,event.saved);
});

test('editing an already-paused workout preserves its timing/checklist without another pause write',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a'],pausedAt:1_800_000_030_000,pausedMs:9000}),env=await harness(t,{activeSession:active});
 await env.app.handle('edit',{id:workout.id});assert.equal(env.editorEvents.length,1);assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);assert.equal(env.calls.some(c=>c.name==='setSetting'),false);
});

test('editing another workout or creating a new one does not pause or alter the current workout',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']}),env=await harness(t,{activeSession:active});
 await env.app.handle('edit',{id:anotherWorkout.id});assert.equal(env.editorEvents[0].workout.id,anotherWorkout.id);assert.deepEqual(env.app.getState().active,active);
 await env.app.handle('create');assert.equal(env.editorEvents.length,2);assert.deepEqual(env.model().activeSession,active);assert.deepEqual(env.app.getState().active,active);assert.equal(env.calls.some(c=>c.name==='setSetting'),false);
});

test('a failed automatic pause keeps the editor closed and the original active session intact',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']}),env=await harness(t,{activeSession:active}),pending=env.deferNext('setSetting');
 const action=env.app.handle('edit',{id:workout.id});await flush();pending.reject(new Error('Não foi possível pausar'));await assert.doesNotReject(()=>action);
 assert.equal(env.editorEvents.length,0);assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);assert.ok(env.notices.includes('Não foi possível pausar'));assert.equal(env.app.getState().handling,false);
});

test('declining deletion leaves the current workout and its active session untouched',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']}),env=await harness(t,{activeSession:active,confirm:false}),before=env.model();
 await env.app.handle('delete',{id:workout.id});assert.equal(env.confirmations.length,1);assert.deepEqual(env.model(),before);assert.deepEqual(env.app.getState().active,active);assert.equal(env.calls.some(c=>c.name==='deleteWorkout'),false);
});

test('deleting the active workout clears RAM only after the database deletion commits',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']}),env=await harness(t,{activeSession:active}),pending=env.deferNext('deleteWorkout');const history=env.model().sessions;
 const action=env.app.handle('delete',{id:workout.id});await flush();assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model().activeSession,active);
 pending.resolve();await action;assert.equal(env.app.getState().active,null);assert.equal(env.model().activeSession,null);assert.deepEqual(env.app.getState().data.workouts.map(w=>w.id),[anotherWorkout.id]);assert.deepEqual(env.model().sessions,history);
});

test('a failed workout deletion preserves the workout, checklist and active time in RAM',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a']}),env=await harness(t,{activeSession:active}),pending=env.deferNext('deleteWorkout'),before=env.model();
 const action=env.app.handle('delete',{id:workout.id});await flush();pending.reject(new Error('Falha ao excluir ficha'));await action;
 assert.deepEqual(env.app.getState().active,active);assert.deepEqual(env.model(),before);assert.ok(env.notices.includes('Falha ao excluir ficha'));
});

test('saving an edited active workout reloads the database-reconciled checklist',async t=>{
 const active=activeAt(1_800_000_000_000,{done:['exercise-a'],pausedAt:1_800_000_030_000}),env=await harness(t,{activeSession:active});
 await env.app.handle('edit',{id:workout.id});
 env.app.setDraft({...clone(workout),exercises:[{...clone(workout.exercises[0]),id:'exercise-new',name:'Supino inclinado'}]});
 await env.app.saveEditor({preventDefault(){}});
 assert.equal(env.calls.some(c=>c.name==='saveWorkout'),true);assert.equal(env.calls.some(c=>c.name==='load'),true);
 assert.deepEqual(env.app.getState().active.done,[]);assert.deepEqual(env.app.getState().active,env.model().activeSession);assert.equal(env.app.getState().active.pausedAt,active.pausedAt);assert.equal(env.app.getState().active.startedAt,active.startedAt);
});

test('missing workout identifiers cannot open an accidental new editor or trigger writes',async t=>{
 const env=await harness(t),before=env.model();
 for(const action of ['edit','delete'])for(const id of [undefined,'not-found'])await assert.doesNotReject(()=>env.app.handle(action,{id}));
 assert.equal(env.editorEvents.length,0);assert.deepEqual(env.model(),before);assert.equal(env.calls.some(c=>c.name==='deleteWorkout'||c.name==='setSetting'||c.name==='saveWorkout'),false);
});


test('pending recovery acknowledgement keeps app navigation and workout mutations locked',async t=>{
 const env=await harness(t);env.setRecoveryPending(true);
 assert.equal(env.accountState().unlocked,true);assert.equal(env.app.hasLocalAccess(),false);
 env.app.nav('historico');await env.app.handle('start',{id:workout.id});
 assert.equal(env.app.getState().page,'fichas');assert.equal(env.model().activeSession,null);assert.equal(env.calls.length,0);
 env.app.productionRender();assert.equal(env.element('body').classList.contains('app-locked'),true);
 assert.equal(env.element('#settings-open').disabled,true);assert.equal(env.authRenders(),1);
 env.setRecoveryPending(false);assert.equal(env.app.hasLocalAccess(),true);
 await env.app.handle('start',{id:workout.id});assert.equal(env.model().activeSession.id,workout.id);
});

const SPOTIFY_LIST={id:'37i9dQZF1DXcBWIGoYBM5M',name:'Playlist completa',provider:'spotify',kind:'playlist',url:'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'};
function trackRows(provider,count){
 return Array.from({length:count},(_,position)=>{
  const id=provider==='spotify'?'track'+String(position).padStart(17,'0'):'video'+String(position).padStart(6,'0');
  return {provider,kind:provider==='spotify'?'track':'video',id,...(provider==='youtube'?{videoId:id}:{}),name:`Faixa ${String(position+1).padStart(4,'0')}`,artists:[`Artista ${position}`],position,
   url:provider==='spotify'?`https://open.spotify.com/track/${id}`:`https://www.youtube.com/watch?v=${id}`,uri:provider==='spotify'?`spotify:track:${id}`:undefined};
 });
}
function completeLibrary(provider,{playlists=[],tracks=[],loadTracks}={}){
 let connected=true;const api=[];
 function progress(options,total){for(let loaded=50;loaded<total;loaded+=50)options?.onProgress?.({loaded,total,pages:Math.ceil(loaded/50)});options?.onProgress?.({loaded:total,total,pages:Math.max(1,Math.ceil(total/50))});}
 const account={api,getState:()=>({configured:true,ready:true,connected,profile:connected?{id:`${provider}-authorized`,displayName:'Conta confirmada pelo serviço'}:undefined}),
  getPlaylists:async options=>{api.push({method:'getPlaylists',options});progress(options,playlists.length);return clone(playlists);},
  getPlaylistTracks:async(id,options)=>{api.push({method:'getPlaylistTracks',id,options});if(loadTracks)return loadTracks(id,options);progress(options,tracks.length);return clone(tracks);},
  connectPopup:async()=>({connected}),connect:async()=>({connected}),disconnect(){connected=false;return Promise.resolve({revoked:false});}};
 return account;
}

test('all 125 YouTube playlists and all tracks are selectable in order without deduplicating repeated videos',async t=>{
 const env=await harness(t),rows=trackRows('youtube',125);rows[100]={...rows[1],position:100};
 const playlists=Array.from({length:125},(_,i)=>({id:'PL'+String(i).padStart(22,'0'),name:`Playlist ${i+1}`,provider:'youtube',kind:'playlist',url:'https://www.youtube.com/playlist?list=PL'+String(i).padStart(22,'0')}));
 const account=completeLibrary('youtube',{playlists,tracks:rows});env.app.setAccounts(null,account);await env.app.activateMusic('youtube');
 assert.equal(env.app.getState().youtubePlaylists.length,125);assert.ok(env.app.musicLibraryResults().includes('Playlist 125'));assert.equal(env.playerCalls.some(c=>c.name==='loadQueue'),false);
 env.app.setState({musicPlaylistSearch:'Playlist 125'});const results=env.app.musicLibraryResults();assert.ok(results.includes('data-index="124"'));assert.equal(results.includes('data-index="0"'),false);
 await env.app.loadYouTubeTracks(124);assert.equal(env.app.getState().youtubeTracks.length,125);await env.app.playMusicQueue();
 const queue=env.playerCalls.find(c=>c.name==='loadQueue');assert.equal(queue.items.length,125);assert.deepEqual(queue.items.map(row=>row.position),Array.from({length:125},(_,i)=>i));assert.equal(queue.items[1].url,queue.items[100].url);assert.equal(queue.options.context,undefined);
 assert.deepEqual(account.api.map(call=>call.method),['getPlaylists','getPlaylistTracks']);assert.equal(account.api[1].id,playlists[124].id);
 assert.ok(env.loadingOperations.some(op=>op.updates.some(message=>message.includes('125 de 125'))));assert.ok(env.loadingOperations.every(op=>op.releases===1));
});

test('all 600 Spotify rows retain their original composition/context while only available tracks enter the queue',async t=>{
 const env=await harness(t),rows=trackRows('spotify',600);rows[150]={...rows[3],position:150};
 for(const row of rows)if(row.position%17===0)row.unavailable=true;
 rows[13].kind='episode';rows[14].url='';
 const account=completeLibrary('spotify',{playlists:[SPOTIFY_LIST],tracks:rows});env.app.setAccounts(account,null);await env.app.activateMusic('spotify');await env.app.loadSpotifyTracks(0);
 assert.equal(env.app.getState().spotifyTracks.length,600);assert.equal(env.playerCalls.some(c=>c.name==='loadQueue'),false);
 await env.app.playMusicQueue(150);const queue=env.playerCalls.find(c=>c.name==='loadQueue'),positions=Array.from({length:600},(_,i)=>i).filter(i=>i%17!==0&&i!==13&&i!==14);
 assert.deepEqual(queue.items.map(row=>row.position),positions);assert.equal(queue.options.index,positions.indexOf(150));assert.equal(queue.items[queue.options.index].position,150);assert.equal(queue.items.filter(row=>row.url===rows[3].url).length,2);
 assert.deepEqual(queue.options.context,{provider:'spotify',kind:'playlist',id:SPOTIFY_LIST.id,uri:`spotify:playlist:${SPOTIFY_LIST.id}`,url:SPOTIFY_LIST.url});
 assert.deepEqual(account.api.map(call=>call.method),['getPlaylists','getPlaylistTracks']);assert.ok(env.loadingOperations.some(op=>op.updates.some(message=>message.includes('600 de 600'))));assert.ok(env.loadingOperations.every(op=>op.releases===1));
});

test('second-page track results include track 101 and search retains the original queue index',async t=>{
 const env=await harness(t),rows=trackRows('spotify',600);rows[544].artists=['Banda Única'];const account=completeLibrary('spotify',{playlists:[SPOTIFY_LIST],tracks:rows});
 env.app.setAccounts(account,null);await env.app.activateMusic('spotify');await env.app.loadSpotifyTracks(0);env.app.setState({musicTrackPage:1});
 const second=env.app.musicTrackResults();assert.ok(second.includes('Faixa 0101'));assert.ok(second.includes('data-index="100"'));assert.ok(second.includes('101–200 de 600'));assert.equal(second.includes('Faixa 0001'),false);
 env.app.setState({musicTrackSearch:'Única',musicTrackPage:4});const search=env.app.musicTrackResults();assert.ok(search.includes('Faixa 0545'));assert.ok(search.includes('data-index="544"'));assert.ok(search.includes('1–1 de 1'));assert.equal(env.app.getState().musicTrackPage,0);
});

for(const boundary of ['lock','disconnect'])test(`late playlist tracks after ${boundary} cannot expose rows, enqueue music or update progress`,async t=>{
 const env=await harness(t),pending=promiseControl();let report;
 const account=completeLibrary('spotify',{playlists:[SPOTIFY_LIST],loadTracks:(_id,options)=>{report=options.onProgress;report({loaded:50,total:600,pages:1});return pending.promise;}});
 env.app.setAccounts(account,null);await env.app.activateMusic('spotify');const loading=env.app.loadMusicPlaylist('spotify',SPOTIFY_LIST,{autoplay:true});await flush();const operation=env.loadingOperations.at(-1),before=operation.updates.length;
 if(boundary==='lock')await env.app.lockApp();else await env.app.handle('spotify-disconnect');
 report({loaded:600,total:600,pages:12});pending.resolve(trackRows('spotify',600));await loading;
 assert.equal(env.app.getState().selectedMusicPlaylist,null);assert.deepEqual(env.app.getState().spotifyTracks,[]);assert.equal(env.playerCalls.some(c=>c.name==='loadQueue'),false);assert.equal(operation.updates.length,before);assert.equal(operation.releases,1);
});

test('a late playlist error preserves the previous selection without starting playback',async t=>{
 const env=await harness(t),pending=promiseControl(),first={...SPOTIFY_LIST,name:'Anterior'},second={...SPOTIFY_LIST,id:'playlist00000000000001',name:'Nova',url:'https://open.spotify.com/playlist/playlist00000000000001'};
 const firstRows=trackRows('spotify',125);let count=0;
 const account=completeLibrary('spotify',{playlists:[first,second],loadTracks:()=>++count===1?Promise.resolve(firstRows):pending.promise});env.app.setAccounts(account,null);await env.app.activateMusic('spotify');await env.app.loadSpotifyTracks(0);
 const loading=env.app.loadSpotifyTracks(1);await flush();assert.equal(env.app.getState().selectedMusicPlaylist.name,'Anterior');pending.reject(new Error('A segunda página não carregou'));await loading;
 assert.equal(env.app.getState().selectedMusicPlaylist.name,'Anterior');assert.deepEqual(env.app.getState().spotifyTracks,firstRows);assert.equal(env.playerCalls.some(c=>c.name==='loadQueue'),false);assert.ok(env.notices.includes('A segunda página não carregou'));assert.ok(env.loadingOperations.every(op=>op.releases===1));
});

test('official account connection remains click-synchronous and never requests a guest password',async t=>{
 const env=await harness(t);env.setAccountState({guest:true,profileId:'guest-local',profile:{id:'guest-local',name:'Visitante',username:'visitante'}});
 const account=completeLibrary('spotify',{playlists:[SPOTIFY_LIST]});let gesture=true,argumentsSeen;
 account.connectPopup=(...args)=>{assert.equal(gesture,true);argumentsSeen=args;return Promise.resolve({connected:true});};env.app.setAccounts(account,null);
 const connecting=env.app.handle('spotify-connect');gesture=false;await connecting;
 assert.deepEqual(argumentsSeen,[]);assert.equal(env.app.getState().page,'musica');assert.equal(env.playerCalls.some(c=>c.name==='loadQueue'),false);assert.equal(/type=["']password["']/.test(env.app.musicView()),false);assert.equal(account.api.filter(call=>call.method==='getPlaylists').length,1);
});

test('replacing a pending YouTube SDK preparation immediately prepares the new account and ignores the old completion',async t=>{
 const env=await harness(t),oldPending=promiseControl(),newPending=promiseControl();let oldCalls=0,newCalls=0,ready=false;
 const oldAccount={getState:()=>({configured:true,ready:false}),prepare(){oldCalls++;return oldPending.promise;}};
 const newAccount={getState:()=>({configured:true,ready}),prepare(){newCalls++;return newPending.promise;}};
 env.app.setState({page:'musica'});env.app.setAccounts(null,oldAccount);const oldPreparing=env.app.prepareYouTube();await env.app.prepareYouTube();assert.equal(oldCalls,1);
 env.app.setAccounts(null,newAccount);const newPreparing=env.app.prepareYouTube();assert.equal(newCalls,1);
 const renders=env.renders();oldPending.reject(new Error('Erro da configuração antiga'));await oldPreparing;
 assert.equal(env.renders(),renders);assert.equal(env.notices.length,0);await env.app.prepareYouTube();assert.equal(newCalls,1,'old finally cannot release the new account preparation guard');
 ready=true;newPending.resolve();await newPreparing;assert.equal(env.renders(),renders+1);await env.app.prepareYouTube();assert.equal(newCalls,1);
});

test('an API access error offers the official player only after explicit fallback activation',async t=>{
 const env=await harness(t),account=completeLibrary('spotify',{playlists:[SPOTIFY_LIST],loadTracks:()=>Promise.reject(new Error('Spotify 403: acesso à playlist negado.'))});
 env.app.setAccounts(account,null);await env.app.activateMusic('spotify');await env.app.loadSpotifyTracks(0);
 assert.equal(env.app.getState().selectedMusicPlaylist,null);assert.equal(env.playerCalls.some(c=>c.name==='load'||c.name==='loadQueue'),false);
 const view=env.app.musicView();assert.ok(view.includes('Spotify 403: acesso à playlist negado.'));assert.ok(view.includes('data-action="music-playlist-embed"'));assert.ok(view.includes('Abrir player oficial'));
 await env.app.handle('music-playlist-embed');const fallback=env.playerCalls.filter(c=>c.name==='load');assert.equal(fallback.length,1);assert.equal(fallback[0].value.url,SPOTIFY_LIST.url);assert.equal(env.playerCalls.some(c=>c.name==='loadQueue'),false);
 assert.equal(account.api.filter(c=>c.method==='getPlaylistTracks').length,1,'explicit fallback must not retry the failed API request');
});

for(const outcome of ['resolve','reject'])test(`a delayed recent-link write that ${outcome}s after a profile lock cannot update the next profile UI`,async t=>{
 const env=await harness(t),pending=env.deferNext('setSetting');const remembering=env.app.rememberMusic(SPOTIFY_LIST.url);await flush();await env.app.lockApp();
 env.setAccountState({unlocked:true,profileId:'profile-b',profile:{id:'profile-b',name:'Outra pessoa',username:'outra'},generation:env.accountState().generation+1});
 const next=env.app.getState().data;next.musicLinks=['https://www.youtube.com/watch?v=video000999'];env.app.setState({data:next});
 if(outcome==='resolve')pending.resolve();else pending.reject(new Error('Gravação do perfil anterior falhou'));await remembering;
 assert.deepEqual(env.app.getState().data.musicLinks,next.musicLinks);assert.equal(env.notices.includes('Não foi possível salvar o link nos recentes.'),false);
});


test('sign out waits for durable remembered-session removal before clearing the active profile',async t=>{
 const env=await harness(t),pending=env.deferNext('clearDeviceSession');
 const before=env.app.getState(),closing=env.app.lockApp();await flush();
 assert.equal(env.accountState().unlocked,true);assert.deepEqual(env.app.getState().data,before.data);assert.equal(env.playerCalls.length,0);
 pending.resolve();await closing;assert.equal(env.accountState().unlocked,false);assert.deepEqual(env.app.getState().data.workouts,[]);
});

test('failed remembered-session removal never claims sign out or clears the current workout data',async t=>{
 const env=await harness(t),pending=env.deferNext('clearDeviceSession'),before=env.app.getState();
 const closing=env.app.lockApp(),rejected=assert.rejects(closing,/storage failed/);pending.reject(new Error('storage failed'));await rejected;
 assert.equal(env.accountState().unlocked,true);assert.deepEqual(env.app.getState(),before);assert.equal(env.playerCalls.length,0);
});
