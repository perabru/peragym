import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {webcrypto, createHash} from 'node:crypto';
import {createSpotifyAccount} from './spotify-account.js';

const CLIENT = 'a'.repeat(32);
const ORIGIN = 'https://perabru.github.io';
const REDIRECT = `${ORIGIN}/peragym/docs/app/`;
const PENDING = 'peragym.spotify.pkce.v1';
const PLAYLIST = '1234567890abcdefghijkl';
const NEXT_PLAYLIST = 'abcdefghijkl1234567890';
const TOKEN = {access_token:'token-one', refresh_token:'refresh-one', token_type:'Bearer', expires_in:3600};
const PROFILE = {account_id:'stable-account', id:'legacy-id', display_name:'Bruno', external_urls:{spotify:'https://open.spotify.com/user/legacy-id'}, images:[{url:'https://i.scdn.co/image/profile'}]};

class MemoryStorage {
  values = new Map();
  get length(){return this.values.size;}
  key(i){return [...this.values.keys()][i] ?? null;}
  getItem(k){return this.values.has(k) ? this.values.get(k) : null;}
  setItem(k,v){this.values.set(String(k),String(v));}
  removeItem(k){this.values.delete(String(k));}
  clear(){this.values.clear();}
}

function json(body, status=200, headers={}) {
  return new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json',...headers}});
}

function setup(t, options={}) {
  const originals = Object.fromEntries(['window','fetch','crypto','localStorage','indexedDB','location','history','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const oldNow=Date.now;
  let now=1_800_000_000_000, current=new URL(options.href || REDIRECT);
  const assigned=[], replaced=[], requests=[], changes=[],popups=[],listeners=new Map();
  const storage=new MemoryStorage();
  const location={
    get href(){return current.href;}, set href(value){current=new URL(value,current);},
    get origin(){return current.origin;}, get pathname(){return current.pathname;},
    get search(){return current.search;}, get hash(){return current.hash;},
    assign(value){assigned.push(String(value));current=new URL(value,current);},
    toString(){return current.href;}
  };
  const history={state:{view:'musica'},replaceState(state,title,url){replaced.push({state,title,url:String(url)});location.href=new URL(url,current).href;}};
  const window={location,history,sessionStorage:storage,crypto:webcrypto,
    addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
    removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
    open(url,name,features){
      if(options.blockPopup)return null;
      const popup={closed:false,name,features,navigations:[url],messages:[],sessionStorage:new MemoryStorage(),
        close(){this.closed=true;},postMessage(data,origin){this.messages.push({data,origin});}};
      popup.location={replace(value){popup.navigations.push(String(value));}};popups.push(popup);return popup;
    }};
  let responder=options.fetch || (()=>{throw new Error('Unexpected network request');});
  Object.defineProperty(globalThis,'window',{configurable:true,value:window,writable:true});
  Object.defineProperty(globalThis,'location',{configurable:true,value:location,writable:true});
  Object.defineProperty(globalThis,'history',{configurable:true,value:history,writable:true});
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage,writable:true});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('OAuth must not read localStorage');}});
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,get(){throw new Error('OAuth must not read IndexedDB');}});
  Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:async (url,init={})=>{
    const call={url:String(url),init,headers:new Headers(init.headers),body:init.body?.toString() || ''};
    requests.push(call);return responder(call);
  }});
  Date.now=()=>now;
  t.after(()=>{
    Date.now=oldNow;
    for(const [key,descriptor] of Object.entries(originals)){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
    }
  });
  const account=createSpotifyAccount({clientId:options.clientId ?? CLIENT,redirectUri:options.redirectUri ?? REDIRECT,onChange:state=>changes.push(structuredClone(state))});
  t.after(()=>account.disconnect());
  return {account,storage,location,history,assigned,replaced,requests,changes,popups,listeners,
    message(event){for(const listener of [...(listeners.get('message')||[])])listener(event);},
    advance:ms=>{now+=ms;},respond:fn=>{responder=fn;},now:()=>now};
}

async function begin(env) {
  await env.account.connect();
  assert.equal(env.assigned.length,1);
  const auth=new URL(env.assigned[0]);
  const pending=JSON.parse(env.storage.getItem(PENDING));
  assert.ok(pending);
  env.location.href=REDIRECT;
  return {auth,pending};
}

function setCallback(env,state,extra='') {
  env.location.href=`${REDIRECT}?code=one-use-code&state=${encodeURIComponent(state)}&keep=1${extra}#musica`;
}

async function login(env, token=TOKEN) {
  const {pending}=await begin(env);
  env.respond(call=>{
    if(call.url==='https://accounts.spotify.com/api/token')return json(token);
    if(call.url==='https://api.spotify.com/v1/me')return json(PROFILE);
    throw new Error(`Unexpected request: ${call.url}`);
  });
  setCallback(env,pending.state);
  const result=await env.account.completeRedirect();
  assert.equal(result.handled,true);assert.equal(result.connected,true);
  return pending;
}

test('missing or invalid public Client ID never pretends that an account is connected',async t=>{
  const env=setup(t,{clientId:''});
  assert.equal(env.account.getState().configured,false);
  assert.equal(env.account.getState().connected,false);
  await assert.rejects(()=>env.account.connect(),Error);
  assert.equal(env.assigned.length,0);assert.equal(env.storage.length,0);assert.equal(env.requests.length,0);
  const invalid=createSpotifyAccount({clientId:'not-a-client-secret',redirectUri:REDIRECT});
  assert.equal(invalid.getState().configured,false);
});

test('redirect URI is restricted to the current HTTPS app route without query, fragment or credentials',async t=>{
  const env=setup(t);
  for(const redirectUri of [
    'https://evil.example/peragym/app/',`${ORIGIN}/elsewhere/`,`${REDIRECT}?next=evil`,`${REDIRECT}#hash`,
    'http://perabru.github.io/peragym/docs/app/','https://user:password@perabru.github.io/peragym/docs/app/','https://@perabru.github.io/peragym/docs/app/'
  ]){
    const account=createSpotifyAccount({clientId:CLIENT,redirectUri});
    assert.equal(account.getState().configured,false,redirectUri);
    await assert.rejects(()=>account.connect(),Error);
  }
  assert.equal(env.requests.length,0);
});

test('connect generates S256 PKCE with crypto entropy and stores only a short-lived pending transaction',async t=>{
  const env=setup(t),{auth,pending}=await begin(env);
  assert.equal(auth.origin,'https://accounts.spotify.com');assert.equal(auth.pathname,'/authorize');
  assert.equal(auth.searchParams.get('response_type'),'code');assert.equal(auth.searchParams.get('client_id'),CLIENT);
  assert.equal(auth.searchParams.get('redirect_uri'),REDIRECT);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  assert.match(pending.verifier,/^[A-Za-z0-9._~-]{43,128}$/);assert.match(pending.state,/^[A-Za-z0-9_-]{32,}$/);
  assert.equal(auth.searchParams.get('code_challenge'),createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.equal(auth.searchParams.get('state'),pending.state);assert.notEqual(pending.verifier,pending.state);
  assert.equal(pending.clientId,CLIENT);assert.equal(pending.redirectUri,REDIRECT);assert.equal(pending.origin,ORIGIN);
  assert.equal(pending.expiresAt-pending.createdAt,600_000);assert.equal(pending.createdAt,env.now());
  const scopes=new Set(auth.searchParams.get('scope').split(' '));
  for(const scope of ['streaming','user-read-private','user-read-email','playlist-read-private','playlist-read-collaborative','user-modify-playback-state'])assert.ok(scopes.has(scope),scope);
  assert.equal(scopes.has('playlist-modify-private'),false);assert.equal(scopes.has('playlist-modify-public'),false);
  assert.equal(scopes.has('user-read-playback-state'),false);assert.equal(env.requests.length,0);
  assert.equal(env.storage.length,1);assert.equal(env.storage.key(0),PENDING);
  assert.equal(/access_token|refresh_token|client_secret/i.test(env.storage.getItem(PENDING)),false);
});

test('callback consumes state and cleans only OAuth parameters before token exchange awaits',async t=>{
  const env=setup(t),{pending}=await begin(env);
  let release;
  env.respond(call=>{
    if(call.url==='https://accounts.spotify.com/api/token')return new Promise(resolve=>{release=()=>resolve(json(TOKEN));});
    if(call.url==='https://api.spotify.com/v1/me')return json(PROFILE);
    throw new Error('Unexpected request');
  });
  setCallback(env,pending.state);
  const completion=env.account.completeRedirect();
  const clean=new URL(env.location.href);
  assert.equal(clean.searchParams.has('code'),false);assert.equal(clean.searchParams.has('state'),false);assert.equal(clean.searchParams.has('error'),false);
  assert.equal(clean.searchParams.get('keep'),'1');assert.equal(clean.hash,'#musica');
  assert.equal(env.storage.getItem(PENDING),null);
  for(let i=0;i<5 && !release;i++)await Promise.resolve();
  assert.equal(typeof release,'function');release();
  const result=await completion;assert.equal(result.connected,true);
  assert.equal(env.account.getState().profile.accountId,'stable-account');assert.equal(env.account.getState().profile.displayName,'Bruno');
  assert.equal('product' in env.account.getState().profile,false);assert.equal('email' in env.account.getState().profile,false);
  const exchange=env.requests[0],payload=new URLSearchParams(exchange.body);
  assert.equal(exchange.init.method,'POST');assert.equal(exchange.headers.get('authorization'),null);
  assert.ok(exchange.headers.get('content-type').startsWith('application/x-www-form-urlencoded'));
  assert.equal(payload.get('grant_type'),'authorization_code');assert.equal(payload.get('code'),'one-use-code');
  assert.equal(payload.get('client_id'),CLIENT);assert.equal(payload.get('redirect_uri'),REDIRECT);assert.equal(payload.get('code_verifier'),pending.verifier);
  assert.equal(payload.has('client_secret'),false);
});

test('state mismatch, expiration, replay and wrong callback origin cannot exchange a code',async t=>{
  const env=setup(t),{pending}=await begin(env);
  setCallback(env,'wrong-state');
  const mismatch=await env.account.completeRedirect();assert.equal(mismatch.handled,true);assert.equal(mismatch.connected,false);assert.ok(mismatch.error);
  assert.equal(env.storage.getItem(PENDING),null);assert.equal(env.requests.length,0);
  env.storage.setItem(PENDING,JSON.stringify(pending));setCallback(env,pending.state);env.advance(600_001);
  const expired=await env.account.completeRedirect();assert.equal(expired.connected,false);assert.ok(expired.error);assert.equal(env.requests.length,0);
  setCallback(env,pending.state);const replay=await env.account.completeRedirect();assert.ok(replay.error);assert.equal(env.requests.length,0);
  const fresh={...pending,createdAt:env.now(),expiresAt:env.now()+600_000};env.storage.setItem(PENDING,JSON.stringify(fresh));
  env.location.href=`https://evil.example/peragym/app/?code=x&state=${pending.state}`;
  const foreign=await env.account.completeRedirect();assert.equal(foreign.connected,false);assert.ok(foreign.error);assert.equal(env.requests.length,0);
});

test('access denial cleans parameters and ends the pending transaction without remote calls',async t=>{
  const env=setup(t),{pending}=await begin(env);
  env.location.href=`${REDIRECT}?error=access_denied&state=${pending.state}&keep=yes#musica`;
  const result=await env.account.completeRedirect();assert.equal(result.handled,true);assert.equal(result.connected,false);assert.ok(result.error);
  assert.equal(env.storage.length,0);assert.equal(env.requests.length,0);assert.equal(new URL(env.location.href).searchParams.get('keep'),'yes');
  const idle=await env.account.completeRedirect();assert.equal(idle.handled,false);
});

test('failed token exchange stays disconnected and consumes the single-use authorization state',async t=>{
  const env=setup(t),{pending}=await begin(env);
  env.respond(()=>json({error:'invalid_grant',error_description:'authorization code expired'},400));
  setCallback(env,pending.state);
  const result=await env.account.completeRedirect();
  assert.equal(result.handled,true);assert.equal(result.connected,false);assert.ok(result.error);
  assert.equal(env.account.getState().connected,false);assert.equal(env.storage.length,0);
  assert.equal(env.requests.length,1);assert.equal(env.requests[0].url,'https://accounts.spotify.com/api/token');
  await assert.rejects(()=>env.account.getAccessToken(),Error);
});

test('tokens stay in RAM, are excluded from public state and are cleared on disconnect or reload',async t=>{
  const env=setup(t);await login(env);
  assert.equal(await env.account.getAccessToken(),'token-one');assert.equal(env.storage.length,0);
  assert.equal(/token-one|refresh-one|access_token|refresh_token/.test(JSON.stringify(env.changes)),false);
  const second=createSpotifyAccount({clientId:CLIENT,redirectUri:REDIRECT});
  assert.equal(second.getState().connected,false);await assert.rejects(()=>second.getAccessToken(),Error);
  env.account.disconnect();assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);
  await assert.rejects(()=>env.account.getAccessToken(),Error);
});

test('playlist reads normalize records and validate pagination before sending any bearer token',async t=>{
  const env=setup(t);await login(env);
  env.respond(call=>{
    const url=new URL(call.url);
    assert.equal(url.origin,'https://api.spotify.com');assert.equal(url.pathname,'/v1/me/playlists');
    assert.equal(call.headers.get('authorization'),'Bearer token-one');assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');
    if(url.searchParams.has('offset'))return json({items:[{id:NEXT_PLAYLIST,name:'Segunda',uri:`spotify:playlist:${NEXT_PLAYLIST}`}],next:null});
    return json({items:[{id:PLAYLIST,name:'Meu treino',uri:`spotify:playlist:${PLAYLIST}`,external_urls:{spotify:`https://open.spotify.com/playlist/${PLAYLIST}`},images:[{url:'https://i.scdn.co/image/cover'}]}],next:'https://api.spotify.com/v1/me/playlists?offset=50&limit=50'});
  });
  const playlists=await env.account.getPlaylists();assert.equal(playlists.length,2);
  assert.equal(playlists[0].id,PLAYLIST);assert.equal(playlists[0].name,'Meu treino');assert.equal(playlists[0].uri,`spotify:playlist:${PLAYLIST}`);
  assert.equal(playlists[0].url,`https://open.spotify.com/playlist/${PLAYLIST}`);assert.equal(playlists[0].image,'https://i.scdn.co/image/cover');
  const before=env.requests.length;
  env.respond(()=>json({items:[],next:'https://api.spotify.com.evil.example/v1/me/playlists?offset=50'}));
  await assert.rejects(()=>env.account.getPlaylists(),Error);
  assert.equal(env.requests.length,before+1);assert.equal(env.requests.some(r=>new URL(r.url).hostname.endsWith('evil.example')),false);
});

test('expiring tokens refresh once in RAM, rotate the refresh token and never add secrets or cookies',async t=>{
  const env=setup(t);await login(env);env.advance(3_580_000);
  let refreshCalls=0;
  env.respond(call=>{
    assert.equal(call.url,'https://accounts.spotify.com/api/token');
    const body=new URLSearchParams(call.body);assert.equal(body.get('grant_type'),'refresh_token');
    assert.equal(body.get('client_id'),CLIENT);assert.equal(body.get('refresh_token'),refreshCalls?'refresh-two':'refresh-one');
    assert.equal(body.has('client_secret'),false);assert.equal(call.headers.get('authorization'),null);
    assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');
    refreshCalls++;return json({access_token:`token-${refreshCalls+1}`,refresh_token:'refresh-two',token_type:'Bearer',expires_in:3600});
  });
  const [a,b]=await Promise.all([env.account.getAccessToken(),env.account.getAccessToken()]);
  assert.equal(a,'token-2');assert.equal(b,'token-2');assert.equal(refreshCalls,1);assert.equal(env.storage.length,0);
  env.advance(3_580_000);assert.equal(await env.account.getAccessToken(),'token-3');assert.equal(refreshCalls,2);
});

test('refresh revocation clears tokens and requires reconnect instead of retrying invalid_grant',async t=>{
  const env=setup(t);await login(env);env.advance(3_580_000);env.respond(()=>json({error:'invalid_grant',error_description:'revoked'},400));
  await assert.rejects(()=>env.account.getAccessToken(),Error);assert.equal(env.account.getState().connected,false);
  const count=env.requests.length;await assert.rejects(()=>env.account.getAccessToken(),Error);assert.equal(env.requests.length,count);
  assert.equal(env.storage.length,0);assert.ok(env.account.getState().error);
});

test('API 401 revokes the local connection; 403 reports permissions; 429 respects Retry-After without a retry loop',async t=>{
  const env=setup(t);await login(env);env.respond(()=>json({error:{status:403,message:'denied'}},403));
  await assert.rejects(()=>env.account.getPlaylists(),Error);assert.equal(env.account.getState().connected,true);
  env.respond(()=>json({error:{status:429,message:'rate limit'}},429,{'retry-after':'7'}));
  await assert.rejects(()=>env.account.getPlaylists(),Error);const count=env.requests.length;
  await assert.rejects(()=>env.account.getPlaylists(),Error);assert.equal(env.requests.length,count);
  env.advance(8_000);env.respond(()=>json({error:{status:401,message:'revoked'}},401));
  await assert.rejects(()=>env.account.getPlaylists(),Error);assert.equal(env.account.getState().connected,false);
});

test('disconnect during pending code exchange cannot resurrect tokens or a connected profile',async t=>{
  const env=setup(t),{pending}=await begin(env);
  let release;
  env.respond(call=>{
    if(call.url==='https://accounts.spotify.com/api/token')return new Promise(resolve=>{release=()=>resolve(json(TOKEN));});
    if(call.url==='https://api.spotify.com/v1/me')return json(PROFILE);
    throw new Error('Unexpected request');
  });
  setCallback(env,pending.state);const completion=env.account.completeRedirect();
  for(let i=0;i<5 && !release;i++)await Promise.resolve();
  assert.equal(typeof release,'function');env.account.disconnect();release();
  const result=await completion;assert.equal(result.connected,false);assert.equal(env.account.getState().connected,false);
  assert.equal(env.account.getState().profile,undefined);await assert.rejects(()=>env.account.getAccessToken(),Error);
  assert.equal(env.storage.length,0);
});

function fakeRequestDeadline(t) {
  const previousSet=globalThis.setTimeout,previousClear=globalThis.clearTimeout;
  const timers=new Map();let sequence=0;
  globalThis.setTimeout=(callback,delay)=>{const id=++sequence;timers.set(id,{callback,delay});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  t.after(()=>{globalThis.setTimeout=previousSet;globalThis.clearTimeout=previousClear;});
  return {timers,fire(){for(const timer of [...timers.values()])timer.callback();}};
}

test('a stalled Spotify fetch aborts after 12 seconds without holding the caller indefinitely',async t=>{
  const env=setup(t);await login(env);const deadline=fakeRequestDeadline(t);let signal;
  env.respond(call=>{signal=call.init.signal;return new Promise(()=>{});});
  const reading=env.account.getPlaylists();
  for(let i=0;i<8&&!signal;i++)await Promise.resolve();
  assert.ok(signal);assert.equal(signal.aborted,false);assert.equal(deadline.timers.size,1);
  assert.equal([...deadline.timers.values()][0].delay,12_000);
  deadline.fire();
  await assert.rejects(()=>reading,/demorou para responder/);
  assert.equal(signal.aborted,true);assert.equal(deadline.timers.size,0);
  assert.equal(env.account.getState().connected,true);
});

test('the same 12-second deadline covers an indefinitely stalled JSON response body',async t=>{
  const env=setup(t);await login(env);const deadline=fakeRequestDeadline(t);let bodyStarted=false,signal;
  env.respond(call=>{signal=call.init.signal;return {ok:true,status:200,json(){bodyStarted=true;return new Promise(()=>{});}};});
  const reading=env.account.getPlaylists();
  for(let i=0;i<12&&!bodyStarted;i++)await Promise.resolve();
  assert.equal(bodyStarted,true);deadline.fire();
  await assert.rejects(()=>reading,/demorou para responder/);
  assert.equal(signal.aborted,true);assert.equal(deadline.timers.size,0);
});

test('disconnect aborts a pending playlist request immediately even when fetch ignores AbortSignal',async t=>{
  const env=setup(t);await login(env);let signal;
  env.respond(call=>{signal=call.init.signal;return new Promise(()=>{});});
  const reading=env.account.getPlaylists();
  for(let i=0;i<8&&!signal;i++)await Promise.resolve();
  assert.ok(signal);env.account.disconnect();
  await assert.rejects(()=>reading,/encerrada/);
  assert.equal(signal.aborted,true);assert.equal(env.account.getState().connected,false);
  assert.equal(env.account.getState().profile,undefined);
});

async function waitFor(predicate) {
  const deadline=performance.now()+3000;
  while(!predicate()&&performance.now()<deadline)await delay(2);
  assert.ok(predicate(),'Expected asynchronous PKCE preparation to complete');
}
async function beginPopup(env) {
  const completion=env.account.connectPopup();
  assert.equal(env.popups.length,1,'Popup must open synchronously in the click call stack');
  const popup=env.popups[0];assert.equal(popup.navigations[0],'about:blank');
  await waitFor(()=>popup.navigations.length===2);
  const auth=new URL(popup.navigations[1]),pending=JSON.parse(env.storage.getItem(PENDING));
  return {completion,popup,auth,pending};
}
function successfulExchange(env) {
  env.respond(call=>{
    if(call.url==='https://accounts.spotify.com/api/token')return json(TOKEN);
    if(call.url==='https://api.spotify.com/v1/me')return json(PROFILE);
    throw new Error(`Unexpected request: ${call.url}`);
  });
}

test('popup PKCE returns tokens to the original RAM session without navigating or rewriting its URL',async t=>{
  const env=setup(t,{href:`${REDIRECT}?view=music#musica`}),original=env.location.href;
  const {completion,popup,auth,pending}=await beginPopup(env);
  assert.equal(auth.origin,'https://accounts.spotify.com');assert.equal(auth.searchParams.get('redirect_uri'),REDIRECT);
  assert.equal(auth.searchParams.get('state'),pending.state);
  assert.deepEqual(JSON.parse(popup.sessionStorage.getItem(PENDING)),pending,'Temporary PKCE copy supports opener-loss fallback');
  successfulExchange(env);
  const callbackUrl=`${REDIRECT}?code=popup-code&state=${pending.state}`;
  env.message({origin:ORIGIN,source:popup,data:{type:'peragym:spotify:callback',callbackUrl}});
  assert.equal(env.storage.getItem(PENDING),null,'One-use pending state is consumed before token exchange awaits');
  assert.deepEqual(popup.messages,[{data:{type:'peragym:spotify:ack',state:pending.state},origin:ORIGIN}]);
  const result=await completion;assert.equal(result.connected,true);assert.equal(result.mode,'popup');
  assert.equal(env.account.getState().connected,true);assert.equal(await env.account.getAccessToken(),'token-one');
  assert.equal(env.location.href,original);assert.equal(env.assigned.length,0);assert.equal(env.replaced.length,0);
  assert.equal(popup.closed,true);assert.equal(env.listeners.get('message').size,0);
  const payload=new URLSearchParams(env.requests[0].body);
  assert.equal(payload.get('code'),'popup-code');assert.equal(payload.get('code_verifier'),pending.verifier);
  const requests=env.requests.length;
  env.message({origin:ORIGIN,source:popup,data:{type:'peragym:spotify:callback',callbackUrl}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(env.requests.length,requests);
  assert.equal(/token-one|refresh-one/.test(JSON.stringify(popup.messages)),false);
});

test('popup messages require the exact origin, popup reference, callback route and pending state',async t=>{
  const env=setup(t),{completion,popup,pending}=await beginPopup(env);
  const correct={origin:ORIGIN,source:popup,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=code&state=${pending.state}`}};
  for(const event of [
    {...correct,origin:'https://evil.example'}, {...correct,source:{}},
    {...correct,data:{type:'unrelated',callbackUrl:correct.data.callbackUrl}},
    {...correct,data:{type:'peragym:spotify:callback',callbackUrl:`https://evil.example/peragym/docs/app/?code=code&state=${pending.state}`}},
    {...correct,data:{type:'peragym:spotify:callback',callbackUrl:`${ORIGIN}/elsewhere/?code=code&state=${pending.state}`}},
    {...correct,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=code&state=${'b'.repeat(43)}`}},
    {...correct,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=code&state=${pending.state}&state=${pending.state}`}},
    {...correct,data:{type:'peragym:spotify:callback',callbackUrl:`https://@perabru.github.io/peragym/docs/app/?code=code&state=${pending.state}`}}
  ])env.message(event);
  assert.equal(env.requests.length,0);assert.ok(env.storage.getItem(PENDING));assert.equal(popup.messages.length,0);
  successfulExchange(env);env.message(correct);assert.equal((await completion).connected,true);
});

test('popup blocking uses the existing redirect flow with an explicit local-password warning',async t=>{
  const env=setup(t,{blockPopup:true});const result=await env.account.connectPopup();
  assert.equal(result.mode,'redirect');assert.equal(result.redirected,true);assert.equal(result.connected,false);
  assert.match(result.warning,/senha/);assert.match(env.account.getState().error,/bloqueou/);
  assert.equal(env.assigned.length,1);assert.equal(new URL(env.assigned[0]).origin,'https://accounts.spotify.com');
  assert.ok(env.storage.getItem(PENDING));assert.equal(env.requests.length,0);
});

test('an unconfigured account never opens an authorization window',async t=>{
  const env=setup(t,{clientId:''});await assert.rejects(()=>env.account.connectPopup(),/Client ID/);
  assert.equal(env.popups.length,0);assert.equal(env.storage.length,0);assert.equal(env.requests.length,0);
});

test('disconnect closes popup, removes listeners and ignores a late authorization callback',async t=>{
  const env=setup(t),{completion,popup,pending}=await beginPopup(env);
  env.account.disconnect();const result=await completion;
  assert.equal(result.connected,false);assert.match(result.error,/encerrada/);
  assert.equal(popup.closed,true);assert.equal(env.listeners.get('message').size,0);assert.equal(env.storage.length,0);
  env.message({origin:ORIGIN,source:popup,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=late&state=${pending.state}`}});
  assert.equal(env.requests.length,0);assert.equal(env.account.getState().connected,false);
});

test('disconnect during popup token exchange cannot restore a Spotify session',async t=>{
  const env=setup(t),{completion,popup,pending}=await beginPopup(env);let release;
  env.respond(call=>{
    if(call.url==='https://accounts.spotify.com/api/token')return new Promise(resolve=>{release=()=>resolve(json(TOKEN));});
    if(call.url==='https://api.spotify.com/v1/me')return json(PROFILE);
    throw new Error('Unexpected request');
  });
  env.message({origin:ORIGIN,source:popup,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=code&state=${pending.state}`}});
  await waitFor(()=>typeof release==='function');env.account.disconnect();release();
  assert.equal((await completion).connected,false);assert.equal(env.account.getState().connected,false);
  assert.equal(popup.closed,true);await assert.rejects(()=>env.account.getAccessToken());
});

test('popup timeout clears pending state and closes the window without a token exchange',async t=>{
  const env=setup(t),deadline=fakeRequestDeadline(t),{completion,popup}=await beginPopup(env);
  assert.equal([...deadline.timers.values()].filter(timer=>timer.delay===600_000).length,1);
  deadline.fire();const result=await completion;
  assert.equal(result.connected,false);assert.match(result.error,/expirou/);
  assert.equal(popup.closed,true);assert.equal(env.storage.length,0);assert.equal(env.listeners.get('message').size,0);
  assert.equal(deadline.timers.size,0);assert.equal(env.requests.length,0);
});

test('completeRedirect accepts a validated callback URL without touching the main URL',async t=>{
  const env=setup(t),{pending}=await begin(env),original=env.location.href;
  successfulExchange(env);
  const result=await env.account.completeRedirect({callbackUrl:`${REDIRECT}?code=returned&state=${pending.state}`});
  assert.equal(result.connected,true);assert.equal(env.location.href,original);assert.equal(env.replaced.length,0);
});

test('a second connect cancels the previous popup and only the latest state can finish',async t=>{
  const env=setup(t),first=await beginPopup(env);
  const latestCompletion=env.account.connectPopup();assert.equal(env.popups.length,2);
  const latest=env.popups[1];await waitFor(()=>latest.navigations.length===2);
  const pending=JSON.parse(env.storage.getItem(PENDING));
  assert.equal((await first.completion).connected,false);assert.equal(first.popup.closed,true);
  env.message({origin:ORIGIN,source:first.popup,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=old&state=${first.pending.state}`}});
  assert.equal(env.requests.length,0);assert.equal(JSON.parse(env.storage.getItem(PENDING)).state,pending.state);
  successfulExchange(env);
  env.message({origin:ORIGIN,source:latest,data:{type:'peragym:spotify:callback',callbackUrl:`${REDIRECT}?code=new&state=${pending.state}`}});
  assert.equal((await latestCompletion).connected,true);
});

test('closing the popup releases its pending authorization without waiting ten minutes',async t=>{
  const previousSet=globalThis.setInterval,previousClear=globalThis.clearInterval;
  const intervals=new Map();let sequence=0;
  globalThis.setInterval=(callback,delay)=>{const id=++sequence;intervals.set(id,{callback,delay});return id;};
  globalThis.clearInterval=id=>intervals.delete(id);
  t.after(()=>{globalThis.setInterval=previousSet;globalThis.clearInterval=previousClear;});
  const env=setup(t),{completion,popup}=await beginPopup(env);
  assert.equal([...intervals.values()][0].delay,500);popup.closed=true;
  for(const interval of [...intervals.values()])interval.callback();
  const result=await completion;assert.equal(result.connected,false);assert.match(result.error,/fechada/);
  assert.equal(intervals.size,0);assert.equal(env.storage.length,0);assert.equal(env.listeners.get('message').size,0);
});

// Collection regression cases exercise the public reader contract against
// realistic API pages; OAuth continues to use the same isolated login helper.
const spotifyID = number => number.toString(36).padStart(22, '0');
const playlistItemsURL = (id, offset, extra = '') => `https://api.spotify.com/v1/playlists/${id}/items?limit=50&additional_types=track%2Cepisode&offset=${offset}${extra}`;
const playlistPage = (offset, items, next = null, total) => ({offset,limit:50,items,next,...(total === undefined ? {} : {total})});
const spotifyTrack = (id = spotifyID(1), name = 'Faixa de treino') => ({
  id,type:'track',name,uri:'javascript:untrusted',external_urls:{spotify:'https://untrusted.example/song'},
  artists:[{name:'Artista\u0000 seguro'}],duration_ms:180_000
});
const mediaItem = raw => ({item:raw});
function assertProgress(progress, loaded, pages, total) {
  assert.ok(progress.length > 0, 'A completed collection must report its loaded progress');
  const final = progress.at(-1);
  assert.equal(final.loaded, loaded);assert.equal(final.pages, pages);
  if(total === undefined)assert.equal('total' in final,false);else assert.equal(final.total,total);
  let priorLoaded=0,priorPages=0;
  for(const value of progress){
    assert.ok(Number.isSafeInteger(value.loaded)&&value.loaded>=priorLoaded);
    assert.ok(Number.isSafeInteger(value.pages)&&value.pages>=priorPages);
    assert.ok(Object.keys(value).every(key=>['loaded','total','pages'].includes(key)),'Progress exposes counts, never tokens or account records');
    if('total' in value)assert.ok(Number.isSafeInteger(value.total)&&value.total>=0);
    priorLoaded=value.loaded;priorPages=value.pages;
  }
}

test('all 101 playlist pages load without a page cap, with unique IDs and privacy-safe metadata',async t=>{
  const env=setup(t);await login(env);
  const progress=[],pages=101,pageSize=50,total=pages*pageSize;
  let pageRequests=0;
  env.respond(call=>{
    const url=new URL(call.url),offset=Number(url.searchParams.get('offset')||0);
    assert.equal(url.origin,'https://api.spotify.com');assert.equal(url.pathname,'/v1/me/playlists');
    assert.equal(url.searchParams.get('limit'),'50');assert.equal(call.headers.get('authorization'),'Bearer token-one');
    assert.equal(offset,pageRequests*pageSize);pageRequests++;
    const items=Array.from({length:pageSize},(_,index)=>{
      const value=offset===50&&index===0?49:offset+index;
      return {id:spotifyID(value),name:`Playlist ${value}\n`,uri:'javascript:wrong',external_urls:{spotify:'https://untrusted.example/list'},
        items:{total:12},owner:{id:'owner\u0000-id',display_name:'Bruno\n Pera',email:'private@example.com'}};
    });
    const next=pageRequests<pages?`https://api.spotify.com/v1/me/playlists?offset=${offset+pageSize}&limit=50`:null;
    return json(playlistPage(offset,items,next,total));
  });
  const rows=await env.account.getPlaylists({onProgress:value=>progress.push(structuredClone(value))});
  assert.equal(pageRequests,101);assert.equal(rows.length,total-1);assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
  assert.deepEqual(rows.slice(0,3).map(row=>row.id),[spotifyID(0),spotifyID(1),spotifyID(2)]);
  assert.equal(rows.at(-1).id,spotifyID(total-1));assert.equal(rows[49].id,spotifyID(49));assert.equal(rows[50].id,spotifyID(51));
  assert.equal(rows[0].name,'Playlist 0');assert.equal(rows[0].count,12);
  assert.deepEqual(rows[0].owner,{id:'owner-id',name:'Bruno Pera'});
  assert.equal(rows[0].uri,`spotify:playlist:${spotifyID(0)}`);assert.equal(rows[0].url,`https://open.spotify.com/playlist/${spotifyID(0)}`);
  assert.equal(JSON.stringify(rows).includes('private@example.com'),false);assert.equal(JSON.stringify(rows).includes('untrusted.example'),false);
  assertProgress(progress,total-1,pages,total);
});

test('playlist metadata and progress omit invalid totals instead of coercing API values',async t=>{
  const env=setup(t);await login(env);
  for(const invalid of ['12',-1,1.5,Number.MAX_SAFE_INTEGER+1,null,true]){
    const progress=[];
    env.respond(()=>json({items:[{id:PLAYLIST,name:'Minha ficha',items:{total:invalid},owner:{display_name:'Treino\u0001',email:'never@example.com'}}],total:invalid,next:null}));
    const rows=await env.account.getPlaylists({onProgress:value=>progress.push(structuredClone(value))});
    assert.equal(rows.length,1);assert.equal('count' in rows[0],false,String(invalid));
    assert.deepEqual(rows[0].owner,{name:'Treino'});assertProgress(progress,1,1);
    assert.equal(JSON.stringify(rows).includes('never@example.com'),false);
  }
});

test('all 12 playlist-item pages preserve more than 100 positions, duplicates and unavailable placeholders',async t=>{
  const env=setup(t);await login(env);
  const progress=[],pages=12,pageSize=50,total=pages*pageSize;
  let requests=0;
  const rawAt=position=>{
    if(position%53===0)return {item:null,track:spotifyTrack(spotifyID(9999),'Never use this fallback')};
    if(position%47===0)return mediaItem({...spotifyTrack(spotifyID(position)),is_local:true});
    const track=spotifyTrack(spotifyID(position%17),`Faixa ${position}\n`);
    return position%13===0?{track}:mediaItem(track);
  };
  env.respond(call=>{
    const url=new URL(call.url),offset=Number(url.searchParams.get('offset')||0);
    assert.equal(url.origin,'https://api.spotify.com');assert.equal(url.pathname,`/v1/playlists/${PLAYLIST}/items`);
    assert.equal(url.searchParams.get('limit'),'50');assert.equal(url.searchParams.get('additional_types'),'track,episode');
    assert.equal(call.headers.get('authorization'),'Bearer token-one');assert.equal(offset,requests*pageSize);requests++;
    const items=Array.from({length:pageSize},(_,index)=>rawAt(offset+index));
    return json(playlistPage(offset,items,requests<pages?playlistItemsURL(PLAYLIST,offset+pageSize):null,total));
  });
  const rows=await env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(structuredClone(value))});
  assert.equal(requests,12);assert.equal(rows.length,600);
  for(const [position,row]of rows.entries()){
    assert.equal(row.position,position);assert.equal(row.provider,'spotify');assert.equal(row.kind,'track');
    assert.equal(typeof row.name,'string');assert.equal(row.title,row.name);
    if(position%53===0||position%47===0){
      assert.equal(row.unavailable,true);assert.equal(row.id,'');assert.equal(row.url,'');assert.equal(row.uri,'');
    }else{
      const id=spotifyID(position%17);
      assert.equal(row.id,id);assert.equal(row.name,`Faixa ${position}`);assert.equal(row.url,`https://open.spotify.com/track/${id}`);
      assert.equal(row.uri,`spotify:track:${id}`);assert.deepEqual(row.artists,['Artista seguro']);assert.equal(row.durationMs,180_000);
    }
  }
  assert.equal(rows[1].id,rows[18].id,'Repeated tracks represent distinct playlist positions');
  assertProgress(progress,600,12,600);
});

test('current item records take precedence over legacy track records, including explicit null and malformed items',async t=>{
  const env=setup(t);await login(env);
  const first=spotifyID(301),second=spotifyID(302),episode=spotifyID(303),unplayable=spotifyID(304);
  const fallback=spotifyTrack(second,'Legacy fallback');
  const items=[
    {item:spotifyTrack(first,'Current\u0000 song'),track:fallback},
    {item:null,track:fallback},
    {item:{},track:fallback},
    {item:false,track:fallback},
    {track:fallback},
    mediaItem({id:episode,type:'episode',name:'Episode\n title',uri:'spotify:track:wrong',external_urls:{spotify:'javascript:bad'},show:{name:'Show\u0000 name',publisher:'Publisher\r'}}),
    mediaItem({...spotifyTrack(unplayable,'Unavailable\r song'),is_playable:false}),
    mediaItem({...spotifyTrack(spotifyID(305)),type:'audiobook'}),
    mediaItem({...spotifyTrack(spotifyID(306)),is_local:true}),
    {is_local:true,item:spotifyTrack(spotifyID(307))},
    mediaItem({...spotifyTrack(),id:'not-a-valid-spotify-id'}),
    null,
    {track:null}
  ];
  env.respond(()=>json(playlistPage(0,items,null,items.length)));
  const rows=await env.account.getPlaylistTracks(PLAYLIST);
  assert.equal(rows.length,items.length);assert.equal(rows[0].id,first);assert.equal(rows[0].name,'Current song');
  assert.equal(rows[4].id,second);assert.equal(rows[4].name,'Legacy fallback');
  assert.deepEqual(rows.map(row=>row.position),items.map((_,index)=>index));
  for(const position of [1,2,3,7,8,9,10,11,12]){
    const row=rows[position];assert.equal(row.kind,'track');assert.equal(row.unavailable,true);
    assert.equal(row.id,'');assert.equal(row.url,'');assert.equal(row.uri,'');
  }
  assert.equal(rows[5].kind,'episode');assert.equal(rows[5].id,episode);assert.equal(rows[5].name,'Episode title');assert.equal(rows[5].title,'Episode title');
  assert.equal(rows[5].url,`https://open.spotify.com/episode/${episode}`);assert.equal(rows[5].uri,`spotify:episode:${episode}`);
  if(rows[5].artists)assert.ok(rows[5].artists.every(value=>typeof value==='string'&&!/[\u0000-\u001f\u007f]/.test(value)));
  assert.equal(rows[6].id,unplayable);assert.equal(rows[6].unavailable,true);assert.equal(rows[6].uri,`spotify:track:${unplayable}`);
  assert.equal(rows[6].url,`https://open.spotify.com/track/${unplayable}`);
  assert.equal(JSON.stringify(rows).includes('javascript:'),false);assert.equal(JSON.stringify(rows).includes('untrusted.example'),false);
});

test('short API pages can advance by their server cursor while preserving original playlist positions',async t=>{
  const env=setup(t);await login(env);
  const progress=[];let page=0;
  env.respond(call=>{
    const url=new URL(call.url);
    if(page++===0)return json({items:[mediaItem(spotifyTrack())],next:playlistItemsURL(PLAYLIST,50,'&market=BR'),total:51});
    assert.equal(url.searchParams.get('offset'),'50');assert.equal(url.searchParams.get('market'),'BR');
    return json({offset:50,items:[mediaItem(spotifyTrack())],next:null,total:51});
  });
  const rows=await env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(structuredClone(value))});
  assert.deepEqual(rows.map(row=>row.position),[0,50]);assertProgress(progress,2,2,51);
});

test('unsafe or overlapping playlist-item cursors are rejected before any second bearer-token request',async t=>{
  const env=setup(t);await login(env);
  const path=`/v1/playlists/${PLAYLIST}/items`;
  const invalid=[
    `https://api.spotify.com.evil.example${path}?limit=50&offset=1`,
    `http://api.spotify.com${path}?limit=50&offset=1`,
    `https://api.spotify.com.${path}?limit=50&offset=1`,
    `https://user:password@api.spotify.com${path}?limit=50&offset=1`,
    `https://@api.spotify.com${path}?limit=50&offset=1`,
    playlistItemsURL(NEXT_PLAYLIST,1),
    `https://api.spotify.com/v1/playlists/${PLAYLIST}/tracks?limit=50&offset=1`,
    `https://api.spotify.com/v1/me/playlists?limit=50&offset=1`,
    playlistItemsURL(PLAYLIST,1,'&access_token=token-one'),
    playlistItemsURL(PLAYLIST,1,'#access_token=token-one'),
    playlistItemsURL(PLAYLIST,1,'&fields=items'),
    `https://api.spotify.com${path}?limit=51&offset=1&additional_types=track%2Cepisode`,
    `https://api.spotify.com${path}?limit=0&offset=1&additional_types=track%2Cepisode`,
    `https://api.spotify.com${path}?limit=50&offset=-1&additional_types=track%2Cepisode`,
    `https://api.spotify.com${path}?limit=50&offset=1.5&additional_types=track%2Cepisode`,
    `https://api.spotify.com${path}?limit=50&offset=9007199254740992&additional_types=track%2Cepisode`,
    `https://api.spotify.com${path}?limit=50&offset=1&offset=1&additional_types=track%2Cepisode`,
    `https://api.spotify.com${path}?limit=50&offset=1&additional_types=artist`,
    playlistItemsURL(PLAYLIST,1,'&market=Brazil'),
    playlistItemsURL(PLAYLIST,0),
    `https://api.spotify.com${path}?offset=0&additional_types=track%2Cepisode&limit=50`
  ];
  for(const next of invalid){
    const before=env.requests.length;
    env.respond(()=>json(playlistPage(0,[mediaItem(spotifyTrack())],next,2)));
    await assert.rejects(()=>env.account.getPlaylistTracks(PLAYLIST),Error,next);
    assert.equal(env.requests.length,before+1,next);
    assert.equal(env.requests.at(-1).headers.get('authorization'),'Bearer token-one');
    assert.equal(new URL(env.requests.at(-1).url).origin,'https://api.spotify.com');
  }
});

test('playlist-item pagination detects regressions and reordered loops after a valid page',async t=>{
  const env=setup(t);await login(env);let calls=0;
  const before=env.requests.length;
  env.respond(()=>{
    calls++;
    return calls===1?json(playlistPage(0,[mediaItem(spotifyTrack())],playlistItemsURL(PLAYLIST,1),3))
      :json(playlistPage(1,[mediaItem(spotifyTrack())],`https://api.spotify.com/v1/playlists/${PLAYLIST}/items?offset=1&additional_types=track%2Cepisode&limit=50`,3));
  });
  await assert.rejects(()=>env.account.getPlaylistTracks(PLAYLIST),Error);
  assert.equal(env.requests.length,before+2);assert.equal(calls,2);
});

test('playlist response-offset mismatch, overlapping pages and empty nonterminal pages abort the collection',async t=>{
  const env=setup(t);await login(env);
  for(const invalidOffset of [1,'0',-1,Number.MAX_SAFE_INTEGER+1]){
    const before=env.requests.length;
    env.respond(()=>json({offset:invalidOffset,items:[mediaItem(spotifyTrack())],next:null}));
    await assert.rejects(()=>env.account.getPlaylistTracks(PLAYLIST),Error,String(invalidOffset));
    assert.equal(env.requests.length,before+1);
  }
  let calls=0;
  env.respond(()=>++calls===1?json(playlistPage(0,[mediaItem(spotifyTrack()),mediaItem(spotifyTrack())],playlistItemsURL(PLAYLIST,1),3)):json({items:[],next:null}));
  await assert.rejects(()=>env.account.getPlaylistTracks(PLAYLIST),Error);assert.equal(calls,1,'The next cursor must not overlap positions already received');
  env.respond(()=>json(playlistPage(0,[],playlistItemsURL(PLAYLIST,50),50)));
  await assert.rejects(()=>env.account.getPlaylistTracks(PLAYLIST),Error);
});

test('malformed item pages or a later 403 reject instead of returning partial tracks or falling back to tracks endpoint',async t=>{
  const env=setup(t);await login(env);
  for(const failure of [()=>json({offset:1,items:{not:'an array'},next:null}),()=>json({error:{status:403,message:'forbidden'}},403)]){
    let calls=0;
    const before=env.requests.length,progress=[];
    env.respond(call=>{
      assert.equal(new URL(call.url).pathname,`/v1/playlists/${PLAYLIST}/items`);
      return ++calls===1?json(playlistPage(0,[mediaItem(spotifyTrack())],playlistItemsURL(PLAYLIST,1),2)):failure();
    });
    await assert.rejects(()=>env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(structuredClone(value))}),Error);
    assert.equal(calls,2);assert.equal(env.requests.length,before+2);assert.equal(env.account.getState().connected,true);
    assert.ok(progress.every(value=>value.loaded<=1));
  }
  assert.equal(env.requests.some(call=>new URL(call.url).pathname.endsWith('/tracks')),false);
});

test('empty terminal item pages are valid and unsafe totals never appear in item progress',async t=>{
  const env=setup(t);await login(env);
  const emptyProgress=[];
  env.respond(()=>json({offset:0,items:[],next:null,total:0}));
  assert.deepEqual(await env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>emptyProgress.push(structuredClone(value))}),[]);
  assertProgress(emptyProgress,0,1,0);
  for(const total of ['1',-1,1.5,Number.MAX_SAFE_INTEGER+1,null,true]){
    const progress=[];
    env.respond(()=>json({items:[mediaItem(spotifyTrack())],next:null,total}));
    assert.equal((await env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(structuredClone(value))})).length,1);
    assertProgress(progress,1,1);
  }
});

test('playlist item readers validate the selected playlist ID before making any API request',async t=>{
  const env=setup(t);await login(env);const before=env.requests.length;
  for(const id of ['',null,{},'bad-id',PLAYLIST+'?',PLAYLIST+'/items'])await assert.rejects(()=>env.account.getPlaylistTracks(id),Error);
  assert.equal(env.requests.length,before);
});

for(const kind of ['playlists','items'])test(`disconnect inside terminal ${kind} progress cancels the generation instead of returning old account data`,async t=>{
  const env=setup(t);await login(env);const before=env.requests.length;
  env.respond(()=>json({items:kind==='playlists'?[{id:PLAYLIST,name:'Uma playlist'}]:[mediaItem(spotifyTrack())],next:null,total:1}));
  const options={onProgress(value){if(value.pages===1)env.account.disconnect();}};
  const reading=kind==='playlists'?env.account.getPlaylists(options):env.account.getPlaylistTracks(PLAYLIST,options);
  await assert.rejects(()=>reading,/encerrada/);
  assert.equal(env.requests.length,before+1);assert.equal(env.account.getState().connected,false);
});

test('disconnect aborts an in-flight playlist-item fetch even if the adapter ignores AbortSignal',async t=>{
  const env=setup(t);await login(env);let signal;
  env.respond(call=>{signal=call.init.signal;return new Promise(()=>{});});
  const reading=env.account.getPlaylistTracks(PLAYLIST);
  for(let index=0;index<8&&!signal;index++)await Promise.resolve();
  assert.ok(signal);env.account.disconnect();
  await assert.rejects(()=>reading,/encerrada/);assert.equal(signal.aborted,true);
  assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);
});

test('playlist collection cursors also reject same-page loops, foreign paths and token-bearing URLs before reuse',async t=>{
  const env=setup(t);await login(env);
  for(const next of [
    'https://api.spotify.com/v1/me/playlists?offset=0&limit=50',
    'https://api.spotify.com/v1/me/playlists?limit=50&offset=1&access_token=token-one',
    'https://api.spotify.com/v1/me/playlists?offset=1&limit=50#token-one',
    `https://api.spotify.com/v1/playlists/${PLAYLIST}/items?offset=1&limit=50`,
    'https://api.spotify.com/v1/me/playlists?offset=1&offset=1&limit=50'
  ]){
    const before=env.requests.length;
    env.respond(()=>json({offset:0,items:[{id:PLAYLIST,name:'Uma playlist'}],next}));
    await assert.rejects(()=>env.account.getPlaylists(),Error,next);
    assert.equal(env.requests.length,before+1,next);
  }
});

test('episode show metadata is exposed as safe artist text and invalid durations are omitted',async t=>{
  const env=setup(t);await login(env);
  env.respond(()=>json({items:[
    mediaItem({id:spotifyID(801),type:'episode',name:'Episódio\u0000',show:{name:'Show\n seguro',publisher:'Not chosen',email:'not-exposed@example.com'},duration_ms:75_000}),
    mediaItem({id:spotifyID(802),type:'episode',name:'Outro episódio',show:{name:'',publisher:'Podcast\r publisher'},duration_ms:-1}),
    mediaItem({...spotifyTrack(spotifyID(803)),duration_ms:'180000'}),
    mediaItem({...spotifyTrack(spotifyID(804)),duration_ms:Number.MAX_SAFE_INTEGER+1})
  ],next:null}));
  const rows=await env.account.getPlaylistTracks(PLAYLIST);
  assert.equal(rows[0].name,'Episódio');assert.equal(rows[0].durationMs,75_000);assert.deepEqual(rows[0].artists,['Show seguro']);
  assert.deepEqual(rows[1].artists,['Podcast publisher']);
  for(const row of rows.slice(1))assert.equal('durationMs' in row,false);
  assert.equal(JSON.stringify(rows).includes('not-exposed@example.com'),false);
});
