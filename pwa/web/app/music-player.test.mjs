import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicPlayer} from './music-player.js';

class Element {
  constructor(){this.attrs={};this.children=[];this.hidden=false;this.disabled=false;this.dataset={};this.textContent='';this.value='';this.isConnected=true;this.classes=new Set();this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),toggle:(name,enabled)=>{const active=enabled??!this.classes.has(name);if(active)this.classes.add(name);else this.classes.delete(name);return active;},contains:name=>this.classes.has(name)};}
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];if(name==='src'||name==='href')delete this[name];}
  replaceChildren(...nodes){this.children.forEach(node=>{node.isConnected=false;});this.children=nodes;nodes.forEach(node=>{node.isConnected=true;});}
}
const selectors=['status','frame','source','controls','now','provider','toggle','position','duration','seek','previous','next','volume','close'];
const youtubeItem=i=>{const id=String(i).padStart(11,'a');return {provider:'youtube',kind:'video',videoId:id,id,url:`https://music.youtube.com/watch?v=${id}`,name:`Vídeo ${i}`};};
const spotifyItem=i=>{const id=i.toString(36).padStart(22,'A');return {provider:'spotify',kind:'track',id,uri:`spotify:track:${id}`,url:`https://open.spotify.com/track/${id}`,name:`Faixa ${i}`};};
const context=(()=>{const id='P'.repeat(22);return {provider:'spotify',kind:'playlist',id,uri:`spotify:playlist:${id}`,url:`https://open.spotify.com/playlist/${id}`};})();
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

function harness(t,{connected=true,play,onQueueChange}={}){
  const globals=['window','document','navigator','MutationObserver','location','localStorage','sessionStorage','indexedDB','fetch'];
  const saved=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const elements=new Map(selectors.map(name=>[`[data-music-${name}]`,new Element()]));
  for(const key of ['title','artist','image'])elements.set(`[data-track-${key}]`,new Element());
  const mount=new Element();mount.hidden=true;mount.querySelector=selector=>elements.get(selector)||null;
  const yt=[],engines=[],queueEvents=[],windowEvents=new Map(),documentEvents=new Map(),observers=[];
  let dialogOpen=false,storageTouches=0,networkCalls=0;
  class FakeYouTube {
    constructor(frame,{events}){this.frame=frame;this.events=events;this.playerState=2;this.destroyed=false;this.plays=0;this.pauses=0;yt.push(this);}
    destroy(){this.destroyed=true;}
    playVideo(){this.plays++;this.playerState=1;}
    pauseVideo(){this.pauses++;this.playerState=2;}
    getCurrentTime(){return 5;}
    getDuration(){return 60;}
    getPlayerState(){return this.playerState;}
    seekTo(){}
    setVolume(){}
    nextVideo(){this.nativeNext=(this.nativeNext||0)+1;}
    previousVideo(){this.nativePrevious=(this.nativePrevious||0)+1;}
    ready(){this.events.onReady();}
    emit(value){this.playerState=value;this.events.onStateChange({data:value});}
  }
  const document={hidden:false,activeElement:null,body:new Element(),head:new Element(),createElement:()=>new Element(),querySelector:()=>dialogOpen?new Element():null,addEventListener:(name,listener)=>documentEvents.set(name,listener)};
  document.head.append=()=>{};
  const window={innerHeight:900,innerWidth:1200,YT:{Player:FakeYouTube},addEventListener:(name,listener)=>windowEvents.set(name,listener)};
  const definitions={window,document,navigator:{onLine:true},location:{origin:'https://peragym.example'},MutationObserver:class {constructor(callback){observers.push(callback);}observe(){}},fetch:()=>{networkCalls++;throw new Error('Music queue tests must not contact a service.');}};
  for(const [name,value]of Object.entries(definitions))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  for(const name of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(globalThis,name,{configurable:true,get(){storageTouches++;throw new Error('Queue must remain in RAM, outside account or IndexedDB storage.');}});
  const account={getState:()=>({connected})};
  const factory=callbacks=>{
    const engine={callbacks,plays:[],disconnected:false,
      async play(item){this.plays.push({...item});if(play)return play(item,this);return {ok:true};},
      disconnect(){this.disconnected=true;},pause:async()=>{},toggle:async()=>{},seek:async()=>{},setVolume:async()=>{},async next(){this.nexts=(this.nexts||0)+1;},async previous(){this.previouses=(this.previouses||0)+1;},
      emit(state){callbacks.onState({ready:true,paused:true,position:0,duration:60000,canSkipNext:true,canSkipPrevious:true,...state});}
    };engines.push(engine);return engine;
  };
  const player=createMusicPlayer(mount,{account:()=>account,createSpotifyPlayback:factory,onQueueChange:value=>{queueEvents.push(value);onQueueChange?.(value);}});
  t.after(()=>{player.close();for(const [name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  return {player,mount,yt,engines,queueEvents,document,window,node:name=>elements.get(`[data-music-${name}]`),security:()=>({storageTouches,networkCalls}),setDialog(open){dialogOpen=open;observers.forEach(callback=>callback());}};
}

test('queue preserves order and repeated videos in RAM and exposes defensive snapshots',async t=>{
  const h=harness(t),a=youtubeItem(1),b=youtubeItem(2),items=[a,a,b];
  await h.player.loadQueue(items,{name:'Minha playlist'});
  const state=h.player.getQueueState();assert.equal(state.index,0);assert.equal(state.name,'Minha playlist');assert.equal(state.provider,'youtube');assert.equal(state.items.length,3);
  assert.equal(state.items[0].url,state.items[1].url);assert.notEqual(state.items[1].url,state.items[2].url);
  state.items[0].url='https://attacker.example';state.items.reverse();assert.equal(h.player.getQueueState().items[0].url,a.url);
  assert.equal(h.node('previous').disabled,true);assert.equal(h.node('next').disabled,false);assert.deepEqual(h.security(),{storageTouches:0,networkCalls:0});
});

test('next and previous select the queue position, including duplicate entries',async t=>{
  const h=harness(t),a=youtubeItem(1);
  await h.player.loadQueue([a,a,youtubeItem(2)]);const first=h.yt[0];first.ready();
  await h.player.next();assert.equal(h.player.getQueueState().index,1);assert.equal(first.destroyed,true);assert.equal(h.yt.length,2);
  await h.node('next').onclick();assert.equal(h.player.getQueueState().index,2);assert.equal(h.node('next').disabled,true);
  await h.player.next();assert.equal(h.player.getQueueState().index,2);assert.equal(h.yt.length,3);
  await h.node('previous').onclick();assert.equal(h.player.getQueueState().index,1);
  await h.player.previous();assert.equal(h.player.getQueueState().index,0);assert.equal(h.node('previous').disabled,true);
});

test('YouTube end advances exactly once and ignores old player events',async t=>{
  const h=harness(t);await h.player.loadQueue([youtubeItem(1),youtubeItem(2),youtubeItem(3)]);
  const first=h.yt[0];first.ready();first.emit(0);first.emit(0);await tick();
  assert.equal(h.player.getQueueState().index,1);assert.equal(h.yt.length,2);
  const second=h.yt[1];second.ready();assert.equal(second.plays,1,'Next frame attempts playback while visible.');
  first.events.onError({data:101});first.emit(0);first.events.onReady();assert.equal(h.player.getQueueState().index,1);assert.equal(h.yt.length,2);
  second.emit(0);await tick();assert.equal(h.player.getQueueState().index,2);
  const last=h.yt[2];last.ready();last.emit(0);last.emit(0);await tick();
  assert.equal(h.player.getQueueState().index,2);assert.equal(h.yt.length,3);assert.match(h.node('status').textContent,/Fila concluída/);
});

test('blocked YouTube item warns and enables manual next without automatic error loops',async t=>{
  const h=harness(t);await h.player.loadQueue([youtubeItem(1),youtubeItem(2)]);const first=h.yt[0];first.ready();
  first.events.onError({data:101});first.emit(0);first.emit(0);await tick();
  assert.equal(h.player.getQueueState().index,0);assert.equal(h.yt.length,1);assert.equal(h.node('next').disabled,false);assert.match(h.node('status').textContent,/próxima/);
  await h.player.next();assert.equal(h.player.getQueueState().index,1);assert.equal(h.yt.length,2);
});

test('end does not start a new video while a dialog obscures the service player',async t=>{
  const h=harness(t);await h.player.loadQueue([youtubeItem(1),youtubeItem(2)]);const first=h.yt[0];first.ready();h.setDialog(true);first.emit(0);await tick();
  assert.equal(h.player.getQueueState().index,0);assert.equal(h.yt.length,1);assert.ok(first.pauses>=1);assert.match(h.node('status').textContent,/Pausado/);
});

test('Spotify queue over 100 tracks uses one native context and original offsets, never URI batches',async t=>{
  const h=harness(t),items=Array.from({length:230},(_,index)=>({...spotifyItem(index),position:index*2}));
  await h.player.loadQueue(items,{index:120,name:'Playlist grande',context});
  assert.equal(h.engines.length,1);const engine=h.engines[0];
  assert.equal(engine.plays[0].kind,'playlist');assert.equal(engine.plays[0].uri,context.uri);assert.equal(engine.plays[0].offsetPosition,240);assert.equal('uris' in engine.plays[0],false);
  engine.emit({uri:items[120].uri});
  await h.player.next();assert.equal(h.engines.length,1);assert.equal(engine.disconnected,false);assert.equal(engine.nexts,1);assert.equal(engine.plays.length,1,'Native skips must not restart a guessed playlist offset.');
  engine.emit({uri:items[121].uri});assert.equal(h.player.getQueueState().index,121);
  await h.player.previous();assert.equal(h.engines.length,1);assert.equal(engine.previouses,1);assert.equal(engine.plays.length,1);
  engine.emit({uri:items[120].uri});assert.equal(h.player.getQueueState().index,120);
  assert.equal(h.player.getQueueState().items.length,230);assert.deepEqual(h.security(),{storageTouches:0,networkCalls:0});
});

test('Spotify native URI transitions synchronize repeated IDs without inventing same-URI progress',async t=>{
  const h=harness(t),a=spotifyItem(1),b=spotifyItem(2),c=spotifyItem(3);
  await h.player.loadQueue([a,b,a,c],{context});const engine=h.engines[0];
  engine.emit({uri:a.uri});assert.equal(h.player.getQueueState().index,0);
  engine.emit({uri:a.uri,position:0});assert.equal(h.player.getQueueState().index,0);assert.equal(h.player.getQueueState().positionKnown,false);
  engine.emit({uri:b.uri});assert.equal(h.player.getQueueState().index,1);assert.equal(h.player.getQueueState().positionKnown,true);
  engine.emit({uri:a.uri});assert.equal(h.player.getQueueState().index,2);assert.equal(h.player.getQueueState().positionKnown,false);
  engine.emit({uri:a.uri,position:0});assert.equal(h.player.getQueueState().index,2,'The SDK cannot distinguish repeated occurrences from URI alone.');
  engine.emit({uri:c.uri});assert.equal(h.player.getQueueState().index,3);
});

test('stale Spotify state does not undo an explicit selected row awaiting its URI',async t=>{
  const h=harness(t),items=[spotifyItem(1),spotifyItem(2)];await h.player.loadQueue(items,{index:1,context});const engine=h.engines[0];
  assert.equal(h.player.getQueueState().index,1);
  engine.emit({uri:items[0].uri,title:'Anterior'});assert.equal(h.player.getQueueState().index,1);
  engine.emit({uri:items[1].uri,title:'Atual'});assert.equal(h.player.getQueueState().index,1);
});

test('without Spotify context the queue sends only one selected track per request',async t=>{
  const h=harness(t),items=Array.from({length:150},(_,index)=>spotifyItem(index));
  await h.player.loadQueue(items,{index:101});assert.equal(h.engines[0].plays[0].uri,items[101].uri);assert.equal(h.engines[0].plays[0].kind,'track');
  await h.player.next();assert.equal(h.player.getQueueState().index,102);assert.equal(h.engines[1].plays[0].uri,items[102].uri);assert.equal('uris' in h.engines[1].plays[0],false);
});

test('mixed providers, nested playlists and invalid indices reject before changing the active queue',async t=>{
  const h=harness(t);await h.player.loadQueue([youtubeItem(1),youtubeItem(2)]);const initial=h.player.getQueueState();
  await assert.rejects(h.player.loadQueue([youtubeItem(1),spotifyItem(1)]),/apenas um serviço/);
  await assert.rejects(h.player.loadQueue([context]),/faixas individuais/);
  await assert.rejects(h.player.loadQueue([youtubeItem(1)],{index:2}),/posição válida/);
  await assert.rejects(h.player.loadQueue([]),/playlist/);
  await assert.rejects(h.player.loadQueue([youtubeItem(1)],{context}),/contexto/);
  const album={...context,kind:'album',uri:context.uri.replace(':playlist:',':album:'),url:context.url.replace('/playlist/','/album/')};
  await assert.rejects(h.player.loadQueue([spotifyItem(1)],{context:album}),/contexto/);
  assert.deepEqual(h.player.getQueueState(),initial);
});

test('direct load and close clear the queue and old callbacks cannot restore it',async t=>{
  const h=harness(t);await h.player.loadQueue([youtubeItem(1),youtubeItem(2)]);const old=h.yt[0];old.ready();
  await h.player.load(youtubeItem(3));assert.equal(h.player.getQueueState().items.length,0);assert.equal(h.player.getQueueState().index,-1);
  old.emit(0);assert.equal(h.player.getQueueState().items.length,0);
  const current=h.yt.at(-1);current.ready();h.player.close();assert.equal(h.mount.hidden,true);assert.equal(h.node('frame').children.length,0);
  current.emit(0);current.events.onReady();current.events.onError({data:100});assert.equal(h.mount.hidden,true);assert.equal(h.node('status').textContent,'');assert.equal(h.player.getQueueState().items.length,0);
});

test('a cancelled Spotify load cannot overwrite a later direct video or requeue after close',async t=>{
  const pending=deferred(),h=harness(t,{play:()=>pending.promise});
  const first=h.player.loadQueue([spotifyItem(1),spotifyItem(2)],{context});assert.equal(h.engines.length,1);const old=h.engines[0];
  await h.player.load(youtubeItem(1));const status=h.node('status').textContent;assert.equal(old.disconnected,true);
  pending.reject(new Error('Falha antiga'));await first;old.emit({uri:spotifyItem(2).uri,title:'Antiga'});
  assert.equal(h.node('status').textContent,status);assert.equal(h.player.getQueueState().items.length,0);assert.equal(h.engines.length,1);
  h.player.close();old.callbacks.onError(new Error('Resposta antiga'));assert.equal(h.node('status').textContent,'');assert.equal(h.mount.hidden,true);
});

test('queue snapshots never retain arbitrary account/token fields and observer failures are isolated',async t=>{
  const h=harness(t,{onQueueChange:()=>{throw new Error('Observer failed');}});
  const item={...youtubeItem(1),accessToken:'never-persist-token',account:{token:'another-secret'}};
  await h.player.loadQueue([item,item],{name:'<Minha fila>'});
  assert.equal(h.player.getQueueState().items.length,2);assert.equal(JSON.stringify(h.player.getQueueState()).includes('secret'),false);assert.equal(JSON.stringify(h.player.getQueueState()).includes('never-persist-token'),false);
  assert.deepEqual(h.security(),{storageTouches:0,networkCalls:0});
});


test('native Spotify skip after indistinguishable A,A keeps cursor and honors SDK skip flags',async t=>{
  const h=harness(t),a=spotifyItem(1),b=spotifyItem(2);
  await h.player.loadQueue([a,a,b],{context});const engine=h.engines[0];
  engine.emit({uri:a.uri});engine.emit({uri:a.uri,position:0});
  assert.equal(h.player.getQueueState().positionKnown,false);assert.match(h.node('status').textContent,/Playlist · 3 faixas/);
  await h.node('next').onclick();assert.equal(engine.nexts,1);assert.equal(engine.plays.length,1);
  engine.emit({uri:b.uri,canSkipNext:false,canSkipPrevious:true});
  assert.equal(h.player.getQueueState().index,2);assert.equal(h.player.getQueueState().positionKnown,true);assert.equal(h.node('next').disabled,true);
  await h.player.next();assert.equal(engine.nexts,1);
  await h.player.previous();assert.equal(engine.previouses,1);assert.equal(engine.plays.length,1);
  engine.emit({uri:a.uri,canSkipNext:true,canSkipPrevious:false});assert.equal(h.player.getQueueState().positionKnown,false);assert.equal(h.node('previous').disabled,true);
  await h.player.previous();assert.equal(engine.previouses,1);
});
