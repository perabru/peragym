import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpotifyPlayback} from './spotify-playback.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const media = (kind='track', id='4uLU6hMCjMI75M1A2tKUQC') => ({provider:'spotify',kind,id,uri:`spotify:${kind}:${id}`,url:`https://open.spotify.com/${kind}/${id}`});

function environment(t, options={}) {
  const originals={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch};
  const h={instances:[],scripts:[],requests:[],states:[],errors:[],tokens:[],tokenRequests:0,ready:options.ready!==false,result:options.result??true,oauth:options.oauth!==false};
  class Player {
    constructor(config){this.config=config;this.listeners=new Map();this.calls=[];this.disconnects=0;h.instances.push(this);}
    addListener(event,callback){this.listeners.set(event,callback);return true;}
    removeListener(event,callback){if(this.listeners.get(event)===callback)this.listeners.delete(event);return true;}
    emit(event,payload){this.listeners.get(event)?.(payload);}
    connect(){this.calls.push(['connect']);if(h.oauth)this.config.getOAuthToken(token=>h.tokens.push(token));if(h.ready)queueMicrotask(()=>this.emit('ready',{device_id:'device /&id'}));return typeof h.result==='function'?h.result():Promise.resolve(h.result);}
    disconnect(){this.disconnects++;}
    activateElement(){this.calls.push(['activateElement']);return Promise.resolve();}
    togglePlay(){this.calls.push(['togglePlay']);return Promise.resolve();}
    nextTrack(){this.calls.push(['nextTrack']);return Promise.resolve();}
    previousTrack(){this.calls.push(['previousTrack']);return Promise.resolve();}
    seek(value){this.calls.push(['seek',value]);return Promise.resolve();}
    setVolume(value){this.calls.push(['setVolume',value]);return Promise.resolve();}
    pause(){this.calls.push(['pause']);return Promise.resolve();}
  }
  h.Player=Player;
  globalThis.window=options.loaded===false?{}:{Spotify:{Player}};
  globalThis.document={head:{append(script){h.scripts.push(script);}},createElement(tag){assert.equal(tag,'script');return {removed:false,remove(){this.removed=true;}};}};
  globalThis.fetch=async(url,request)=>{h.requests.push({url,request});return h.response||{ok:true,status:204,headers:{get:()=>null}};};
  h.account={getAccessToken:options.getAccessToken||(async()=>`access-${++h.tokenRequests}`)};
  h.engine=createSpotifyPlayback({account:h.account,onState:value=>h.states.push(value),onError:error=>h.errors.push(error)});
  t.after(()=>{
    h.engine.disconnect();
    for(const [key,value] of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  });
  return h;
}

function fakeTimeouts() {
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,timers=[];
  globalThis.setTimeout=(callback,delay,...args)=>{
    if(delay!==12000)return originalSet(callback,delay,...args);
    const timer={callback:()=>callback(...args),cancelled:false,spotifyTest:true};timers.push(timer);return timer;
  };
  globalThis.clearTimeout=timer=>{if(timer?.spotifyTest)timer.cancelled=true;else originalClear(timer);};
  return {timers,restore(){globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}};
}

test('creation is inert; explicit connect lazily loads the official SDK and preserves its global callback',async t=>{
  const h=environment(t,{loaded:false});let previousCalls=0;
  const previous=()=>previousCalls++;window.onSpotifyWebPlaybackSDKReady=previous;
  assert.equal(h.scripts.length,0);assert.equal(h.tokenRequests,0);assert.equal(h.requests.length,0);
  const connecting=h.engine.connect();
  assert.equal(h.scripts.length,1);assert.equal(h.scripts[0].src,'https://sdk.scdn.co/spotify-player.js');assert.equal(h.scripts[0].async,true);
  assert.equal(h.instances.length,0);
  window.Spotify={Player:h.Player};window.onSpotifyWebPlaybackSDKReady();
  assert.equal(await connecting,'device /&id');assert.equal(previousCalls,1);assert.equal(window.onSpotifyWebPlaybackSDKReady,previous);
  assert.equal(h.instances.length,1);assert.deepEqual(h.tokens,['access-1']);
  assert.equal(h.requests.length,0);assert.equal(h.engine.getState().paused,true);assert.equal(h.engine.getState().ready,true);
  const same=await h.engine.connect();assert.equal(same,'device /&id');assert.equal(h.instances.length,1);
});

test('SDK load failure and 12-second timeout clean script/global callback and permit another user attempt',async t=>{
  const h=environment(t,{loaded:false});const clock=fakeTimeouts();
  try {
    const first=h.engine.connect(),firstRejected=assert.rejects(first,/carregar/);
    h.scripts[0].onerror();await firstRejected;assert.equal(h.scripts[0].removed,true);assert.equal(window.onSpotifyWebPlaybackSDKReady,undefined);
    const second=h.engine.connect(),secondRejected=assert.rejects(second,/demorou/);
    const timer=clock.timers.findLast(timer=>!timer.cancelled);timer.callback();await secondRejected;
    assert.equal(h.scripts.length,2);assert.equal(h.scripts[1].removed,true);assert.equal(window.onSpotifyWebPlaybackSDKReady,undefined);
    assert.equal(h.engine.getState().ready,false);
  } finally {h.engine.disconnect();clock.restore();}
});

test('connect false rejects; a ready event cannot bypass a stalled connection timeout',async t=>{
  const h=environment(t,{result:false,ready:false});
  await assert.rejects(h.engine.connect(),/conectar/);assert.equal(h.engine.getState().ready,false);assert.ok(h.instances[0].disconnects);
  const clock=fakeTimeouts();h.result=()=>new Promise(()=>{});h.ready=true;
  try {
    const connecting=h.engine.connect(),rejected=assert.rejects(connecting,/demorou/);await tick();
    assert.equal(h.engine.getState().ready,true);
    clock.timers.find(timer=>!timer.cancelled).callback();await rejected;
    assert.equal(h.engine.getState().ready,false);assert.ok(h.instances[1].disconnects);
  } finally {h.engine.disconnect();clock.restore();}
});

test('play uses only the Spotify API, fresh bearer tokens and the proper track/context payload',async t=>{
  const h=environment(t);
  assert.deepEqual(await h.engine.play(media()),{ok:true,deviceId:'device /&id'});
  let request=h.requests.at(-1);
  assert.equal(request.url,'https://api.spotify.com/v1/me/player/play?device_id=device%20%2F%26id');
  assert.equal(request.request.method,'PUT');assert.equal(request.request.headers.Authorization,'Bearer access-2');
  assert.deepEqual(JSON.parse(request.request.body),{uris:[media().uri]});
  assert.equal(request.request.redirect,'error');assert.equal(request.request.credentials,'omit');assert.equal(request.request.cache,'no-store');
  assert.equal(h.engine.getState().paused,true,'HTTP success alone does not claim that audio is playing');
  await h.engine.play(media('playlist'));request=h.requests.at(-1);
  assert.deepEqual(JSON.parse(request.request.body),{context_uri:media('playlist').uri});assert.equal(request.request.headers.Authorization,'Bearer access-3');
  await h.engine.play(media('album'));assert.deepEqual(JSON.parse(h.requests.at(-1).request.body),{context_uri:media('album').uri});
  const callbacks=[];h.instances[0].config.getOAuthToken(token=>callbacks.push(token));await tick();
  assert.deepEqual(callbacks,['access-5']);
});

test('SDK events provide actual metadata and controls delegate without inventing playing states',async t=>{
  const h=environment(t);await h.engine.connect();const sdk=h.instances[0];
  sdk.emit('player_state_changed',{paused:false,position:1250,duration:200000,track_window:{current_track:{name:'Música',artists:[{name:'Artista A'},{name:'Artista B'}],album:{images:[{url:'https://i.scdn.co/image/test-cover'}]}}}});
  assert.deepEqual(h.engine.getState(),{paused:false,position:1250,duration:200000,title:'Música',artist:'Artista A, Artista B',image:'https://i.scdn.co/image/test-cover',uri:'',canSeek:true,canSkipNext:true,canSkipPrevious:true,ready:true});
  await h.engine.toggle();await h.engine.next();await h.engine.previous();await h.engine.seek(300000);await h.engine.setVolume(0.4);await h.engine.pause();
  assert.ok(sdk.calls.some(call=>call[0]==='togglePlay'));assert.ok(sdk.calls.some(call=>call[0]==='nextTrack'));assert.ok(sdk.calls.some(call=>call[0]==='previousTrack'));
  assert.ok(sdk.calls.some(call=>call[0]==='seek'&&call[1]===200000));assert.ok(sdk.calls.some(call=>call[0]==='setVolume'&&call[1]===0.4));assert.ok(sdk.calls.some(call=>call[0]==='pause'));
  assert.equal(h.engine.getState().paused,false,'SDK command completion does not fabricate the next state');
  for(const value of [-1,1.1,NaN,Infinity,'0.5'])await assert.rejects(h.engine.setVolume(value));
  for(const value of [-1,NaN,Infinity,'100'])await assert.rejects(h.engine.seek(value));
  sdk.emit('player_state_changed',null);assert.equal(h.engine.getState().paused,true);assert.equal(h.engine.getState().canSeek,false);
});

test('401, 403 and 429 reject play and expose readable safe messages without false playback',async t=>{
  const h=environment(t);await h.engine.connect();
  for(const [status,pattern] of [[401,/sessão.*expirou/],[403,/Premium/],[429,/17 segundos/]]) {
    h.response={ok:false,status,headers:{get:()=>status===429?'17':null},json:async()=>({error:{message:'untrusted access-secret'}})};
    await assert.rejects(h.engine.play(media()),pattern);
    assert.equal(h.engine.getState().paused,true);assert.equal(h.errors.at(-1).message.includes('access-secret'),false);
  }
});

test('a hung play request times out after 12 seconds, aborts and cannot fabricate later playback',async t=>{
  const h=environment(t);await h.engine.connect();const clock=fakeTimeouts(),response=deferred();
  globalThis.fetch=(url,request)=>{h.requests.push({url,request});return response.promise;};
  try {
    const playing=h.engine.play(media()),rejected=assert.rejects(playing,/demorou para responder/);await tick();
    assert.equal(h.requests.length,1);const timer=clock.timers.find(timer=>!timer.cancelled);assert.ok(timer);
    timer.callback();await rejected;
    assert.equal(h.requests[0].request.signal.aborted,true);assert.equal(timer.cancelled,true);
    assert.equal(h.engine.getState().paused,true);assert.match(h.errors.at(-1).message,/Verifique sua internet/);
    const stateCount=h.states.length;response.resolve({ok:true,status:204});await tick();assert.equal(h.states.length,stateCount);
    globalThis.fetch=async(url,request)=>{h.requests.push({url,request});return {ok:true,status:204};};
    await h.engine.play(media());assert.equal(clock.timers.at(-1).cancelled,true,'successful API calls also clear the timeout');
  } finally {h.engine.disconnect();clock.restore();}
});

test('authentication/account/not_ready errors stop the player; stale callbacks cannot update UI',async t=>{
  const h=environment(t);
  for(const [event,pattern] of [['authentication_error',/sessão/],['account_error',/Premium/],['not_ready',/conexão/]]) {
    await h.engine.connect();const sdk=h.instances.at(-1),stale=sdk.listeners.get('player_state_changed');
    sdk.emit(event,{device_id:'device /&id',message:'untrusted token-secret'});
    assert.match(h.errors.at(-1).message,pattern);assert.equal(h.errors.at(-1).message.includes('token-secret'),false);
    assert.equal(h.engine.getState().ready,false);assert.ok(sdk.disconnects);assert.equal(sdk.listeners.size,0);
    const count=h.states.length;stale({paused:false,position:500,duration:1000});assert.equal(h.states.length,count);
  }
});

test('playback and autoplay failures are visible and require another explicit play gesture',async t=>{
  const h=environment(t);await h.engine.connect();const sdk=h.instances[0];
  sdk.emit('player_state_changed',{paused:false,position:0,duration:1000});sdk.emit('playback_error',{message:'private raw error'});
  assert.equal(h.engine.getState().paused,true);assert.match(h.errors.at(-1).message,/não conseguiu reproduzir/);assert.equal(h.engine.getState().ready,true);
  sdk.emit('autoplay_failed');assert.match(h.errors.at(-1).message,/Toque em reproduzir/);assert.equal(h.requests.length,0);
});

test('disconnect cancels pending SDK load and queued SDK connection before they can resurrect',async t=>{
  const h=environment(t,{loaded:false});
  let pending=h.engine.connect(),rejected=assert.rejects(pending,{code:'SPOTIFY_CANCELLED'});
  const callback=window.onSpotifyWebPlaybackSDKReady;h.engine.disconnect();await rejected;
  assert.equal(h.scripts[0].removed,true);window.Spotify={Player:h.Player};callback();await tick();assert.equal(h.instances.length,0);
  pending=h.engine.connect();rejected=assert.rejects(pending,{code:'SPOTIFY_CANCELLED'});h.engine.disconnect();await rejected;
  assert.equal(h.instances.length,1);assert.equal(h.instances[0].calls.some(call=>call[0]==='connect'),false);
  assert.equal(h.engine.getState().ready,false);assert.equal(h.errors.length,0);
});

test('disconnect rejects late API completion and prevents stale token callbacks',async t=>{
  const token=deferred();const h=environment(t,{getAccessToken:()=>token.promise});
  await h.engine.connect();h.engine.disconnect();token.resolve('late-access');await tick();assert.deepEqual(h.tokens,[]);
  h.account.getAccessToken=async()=> 'current-access';await h.engine.connect();
  const response=deferred();globalThis.fetch=(url,request)=>{h.requests.push({url,request});return response.promise;};
  const playing=h.engine.play(media()),rejected=assert.rejects(playing,{code:'SPOTIFY_CANCELLED'});await tick();
  const request=h.requests.at(-1);assert.ok(request);h.engine.disconnect();assert.equal(request.request.signal.aborted,true);
  const count=h.states.length;response.resolve({ok:true,status:204});await rejected;assert.equal(h.states.length,count);assert.equal(h.errors.length,0);
});

test('competing play requests discard late authorization before sending an obsolete track',async t=>{
  const h=environment(t,{oauth:false});await h.engine.connect();const first=deferred(),second=deferred();let count=0;
  h.account.getAccessToken=()=>++count===1?first.promise:second.promise;
  const old=h.engine.play(media()),oldRejected=assert.rejects(old,{code:'SPOTIFY_CANCELLED'});await tick();
  const nextMedia=media('track','7ouMYWpwJ422jRcDASZB7P');const latest=h.engine.play(nextMedia);await tick();
  first.resolve('old-access');second.resolve('new-access');await oldRejected;await latest;
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].request.headers.Authorization,'Bearer new-access');
  assert.deepEqual(JSON.parse(h.requests[0].request.body),{uris:[nextMedia.uri]});
});

test('losing the SDK device invalidates playback still waiting for an account token',async t=>{
  const h=environment(t,{oauth:false});await h.engine.connect();const token=deferred();
  h.account.getAccessToken=()=>token.promise;
  const playing=h.engine.play(media()),rejected=assert.rejects(playing,{code:'SPOTIFY_CANCELLED'});await tick();
  h.instances[0].emit('not_ready',{device_id:'device /&id'});token.resolve('late-access');await rejected;
  assert.equal(h.requests.length,0);assert.equal(h.engine.getState().ready,false);assert.equal(h.errors.length,1);
});

test('invalid media never loads the SDK; missing/invalid account tokens never reach fetch',async t=>{
  const h=environment(t,{loaded:false});
  for(const value of [null,{...media(),provider:'youtube'},{...media(),uri:'spotify:track:wrong'},{...media(),id:'bad'}])await assert.rejects(h.engine.play(value),/válido/);
  assert.equal(h.scripts.length,0);assert.equal(h.tokenRequests,0);
  window.Spotify={Player:h.Player};h.account.getAccessToken=async()=> 'unsafe token\r\n';
  await assert.rejects(h.engine.play(media()),/sessão/);assert.equal(h.requests.length,0);
});


test('playlist offsets address the original position beyond 100 without sending a truncated URI array',async t=>{
 const h=environment(t);
 await h.engine.play({...media('playlist'),offsetPosition:257});
 assert.deepEqual(JSON.parse(h.requests.at(-1).request.body),{context_uri:media('playlist').uri,offset:{position:257}});
 const count=h.requests.length;
 for(const offsetPosition of [-1,1.5,NaN,Infinity,'2'])await assert.rejects(h.engine.play({...media('playlist'),offsetPosition}));
 await assert.rejects(h.engine.play({...media(),offsetPosition:1}));assert.equal(h.requests.length,count);
});

test('SDK exposes only a canonical current item URI for synchronizing the complete playlist',async t=>{
 const h=environment(t);await h.engine.connect();const sdk=h.instances[0];
 sdk.emit('player_state_changed',{paused:false,track_window:{current_track:{uri:media().uri}}});
 assert.equal(h.engine.getState().uri,media().uri);
 sdk.emit('player_state_changed',{paused:false,track_window:{current_track:{uri:'https://evil.invalid/token'}}});
 assert.equal(h.engine.getState().uri,'');
});
