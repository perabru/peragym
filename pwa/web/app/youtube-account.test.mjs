import test from 'node:test';
import assert from 'node:assert/strict';
import {createYouTubeAccount} from './youtube-account.js';

const CLIENT='123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
const SCOPE='https://www.googleapis.com/auth/youtube.readonly';
const TOKEN={access_token:'youtube-token-only-in-ram',token_type:'Bearer',expires_in:3600,scope:SCOPE};
const CHANNEL='UCabcdefghijklmnopqrstuv';
const PLAYLIST='PLabcdefghijklmnopqrstuv';
const VIDEO='M7lc1UVf-VE';
const PROFILE={items:[{id:CHANNEL,snippet:{title:'Bruno — canal real',thumbnails:{default:{url:'https://yt3.ggpht.com/profile'}}}}]};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function setup(t,options={}){
 const keys=['window','document','fetch','google','localStorage','sessionStorage','indexedDB'];
 const descriptors=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const oldNow=Date.now,oldSetTimeout=globalThis.setTimeout;
 let now=1_800_000_000_000,responder=options.fetch||(()=>json(PROFILE));
 const clients=[],calls=[],changes=[],scripts=[],revokes=[];
 const sdk={
  initTokenClient(config){
   const client={config,requests:[],requestAccessToken(overrides){client.requests.push(overrides);options.request?.(client,overrides);}};
   clients.push(client);return client;
  },
  hasGrantedAllScopes(response,scope){return String(response.scope||'').split(/\s+/).includes(scope);},
  revoke(token,callback){revokes.push(token);if(options.revoke)options.revoke(token,callback);else callback?.({successful:true});}
 };
 const browser={location:new URL(options.href||'https://perabru.github.io/peragym/docs/app/'),google:options.sdk===false?undefined:{accounts:{oauth2:sdk}}};
 const document={head:{append(script){scripts.push(script);options.append?.(script);}},createElement(tag){return {tagName:tag.toUpperCase(),remove(){this.removed=true;}};}};
 Object.defineProperty(globalThis,'window',{configurable:true,writable:true,value:browser});
 Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:document});
 Object.defineProperty(globalThis,'google',{configurable:true,writable:true,value:browser.google});
 for(const key of ['localStorage','sessionStorage','indexedDB']){
  const deny=()=>{throw new Error(`YouTube account must not touch ${key}`);};
  Object.defineProperty(globalThis,key,{configurable:true,get:deny});
  Object.defineProperty(browser,key,{configurable:true,get:deny});
 }
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:async(url,init={})=>{
  const call={url:String(url),init,headers:new Headers(init.headers)};calls.push(call);return responder(call);
 }});
 Date.now=()=>now;
 if(options.fastTimeout)globalThis.setTimeout=(fn,ms,...args)=>oldSetTimeout(fn,ms===12000?5:ms,...args);
 const account=createYouTubeAccount({clientId:options.clientId??CLIENT,onChange:value=>changes.push(structuredClone(value))});
 t.after(async()=>{
  // Explicit cleanup must cancel timers and asynchronous callbacks before restoring globals.
  try{await account.disconnect();}catch{}
  Date.now=oldNow;globalThis.setTimeout=oldSetTimeout;
  for(const[key,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 });
 return {account,browser,sdk,clients,calls,changes,scripts,revokes,respond:fn=>{responder=fn;},advance:ms=>{now+=ms;},installSdk(){browser.google={accounts:{oauth2:sdk}};globalThis.google=browser.google;}};
}
async function login(env,token=TOKEN){
 await env.account.prepare();
 const pending=env.account.connect();
 assert.equal(env.clients.at(-1).requests.length,1);
 env.clients.at(-1).config.callback(token);
 const result=await pending;
 assert.equal(env.account.getState().connected,true);
 return result;
}

test('missing Google Client ID performs no network and never invents a connected profile',async t=>{
 const env=setup(t,{clientId:''});
 assert.equal(env.account.getState().configured,false);assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);
 const prepared=await env.account.prepare();assert.equal(prepared.configured,false);assert.equal(prepared.ready,false);await assert.rejects(()=>env.account.connect(),Error);
 assert.equal(env.scripts.length,0);assert.equal(env.calls.length,0);assert.equal(env.clients.length,0);
});

test('preparing GIS never opens a popup and the click path requests a token synchronously',async t=>{
 let insideClick=false;
 const env=setup(t,{request(){assert.equal(insideClick,true,'Popup token request must run before leaving the click stack');}});
 assert.equal(env.account.getState().connected,false);
 await env.account.prepare();assert.equal(env.account.getState().ready,true);assert.equal(env.clients.length,0);
 insideClick=true;const pending=env.account.connect();insideClick=false;
 const client=env.clients.at(-1);
 assert.equal(client.requests.length,1);assert.equal(client.config.client_id,CLIENT);assert.equal(client.config.scope,SCOPE);assert.equal(client.config.include_granted_scopes,false);
 assert.equal(client.config.client_secret,undefined);assert.equal(client.requests[0].prompt,'select_account');
 assert.equal(env.account.getState().connected,false,'A popup alone is not a verified account');
 client.config.callback(TOKEN);await pending;
 const state=env.account.getState();assert.equal(state.connected,true);assert.equal(state.profile.id,CHANNEL);assert.equal(state.profile.channelId,CHANNEL);assert.equal(state.profile.displayName,'Bruno — canal real');
 assert.equal(state.profile.url,`https://www.youtube.com/channel/${CHANNEL}`);
 const call=env.calls[0],url=new URL(call.url);
 assert.equal(url.origin,'https://www.googleapis.com');assert.equal(url.pathname,'/youtube/v3/channels');assert.equal(url.searchParams.get('mine'),'true');assert.equal(url.searchParams.get('part'),'snippet');
 assert.equal(call.headers.get('authorization'),`Bearer ${TOKEN.access_token}`);assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');assert.equal(call.init.cache,'no-store');
 assert.equal(url.searchParams.has('access_token'),false);
});

test('dynamic GIS preparation exposes ready only after the official script is available',async t=>{
 const env=setup(t,{sdk:false});
 const prepared=env.account.prepare();await flush();
 assert.equal(env.scripts.length,1);assert.equal(env.scripts[0].src,'https://accounts.google.com/gsi/client');assert.equal(env.account.getState().ready,false);
 assert.equal(env.clients.length,0);env.installSdk();env.scripts[0].onload();await prepared;
 assert.equal(env.account.getState().ready,true);assert.equal(env.account.getState().connected,false);
});

test('blocked GIS scripts fail with a recoverable disconnected state',async t=>{
 const env=setup(t,{sdk:false});const prepared=env.account.prepare();await flush();env.scripts[0].onerror();
 await assert.rejects(()=>prepared,Error);assert.equal(env.account.getState().ready,false);assert.equal(env.account.getState().connected,false);assert.ok(env.account.getState().error);
});

test('denied scope, popup cancellation and absent YouTube channel do not create fake login',async t=>{
 const env=setup(t);await env.account.prepare();
 let pending=env.account.connect();env.clients.at(-1).config.callback({error:'access_denied'});await assert.rejects(()=>pending,Error);
 assert.equal(env.calls.length,0);assert.equal(env.account.getState().connected,false);
 pending=env.account.connect();env.clients.at(-1).config.callback({...TOKEN,scope:'openid'});await assert.rejects(()=>pending,Error);assert.equal(env.calls.length,0);
 pending=env.account.connect();env.clients.at(-1).config.error_callback({type:'popup_closed'});await assert.rejects(()=>pending,Error);assert.equal(env.calls.length,0);
 env.respond(()=>json({items:[]}));pending=env.account.connect();env.clients.at(-1).config.callback(TOKEN);await assert.rejects(()=>pending,Error);
 assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);assert.equal(env.revokes.length,0,'Failures must not revoke consent implicitly');
});

test('tokens remain in closure RAM and neither public state nor a fresh module instance contains credentials',async t=>{
 const env=setup(t);await login(env);
 assert.equal(JSON.stringify(env.changes).includes(TOKEN.access_token),false);assert.equal(JSON.stringify(env.account.getState()).includes(TOKEN.access_token),false);
 const reloaded=createYouTubeAccount({clientId:CLIENT});assert.equal(reloaded.getState().connected,false);assert.equal(reloaded.getState().profile,undefined);
 await env.account.disconnect();assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);assert.deepEqual(env.revokes,[TOKEN.access_token]);
});

test('owned playlists paginate through the fixed Google API and normalize safe canonical URLs',async t=>{
 const env=setup(t);await login(env);
 env.respond(call=>{
  const url=new URL(call.url);assert.equal(url.origin,'https://www.googleapis.com');assert.equal(url.pathname,'/youtube/v3/playlists');assert.equal(url.searchParams.get('mine'),'true');assert.equal(url.searchParams.get('maxResults'),'50');
  assert.equal(call.headers.get('authorization'),`Bearer ${TOKEN.access_token}`);assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');
  return url.searchParams.get('pageToken')==='NEXT'
   ?json({items:[{id:'PLsecondabcdefghijklmn',snippet:{title:'Segunda'},contentDetails:{itemCount:5}}]})
   :json({items:[{id:PLAYLIST,snippet:{title:'Treino <forte>',thumbnails:{default:{url:'https://i.ytimg.com/playlist.jpg'}}},contentDetails:{itemCount:3},status:{privacyStatus:'public'}},{id:'javascript:evil',snippet:{title:'Unsafe'}}],nextPageToken:'NEXT'});
 });
 const rows=await env.account.getPlaylists();assert.equal(rows.length,2);assert.equal(rows[0].id,PLAYLIST);assert.equal(rows[0].listId,PLAYLIST);assert.equal(rows[0].provider,'youtube');assert.equal(rows[0].kind,'playlist');assert.equal(rows[0].name,'Treino <forte>');
 const url=new URL(rows[0].url);assert.ok(['www.youtube.com','music.youtube.com'].includes(url.hostname));assert.equal(url.pathname,'/playlist');assert.equal(url.searchParams.get('list'),PLAYLIST);assert.equal(rows[0].itemCount,3);
 assert.equal(env.calls.length,3);
});

test('playlist tracks use validated video identifiers and never fetch URLs supplied by API metadata',async t=>{
 const env=setup(t);await login(env);
 env.respond(call=>{
  const url=new URL(call.url);assert.equal(url.pathname,'/youtube/v3/playlistItems');assert.equal(url.searchParams.get('playlistId'),PLAYLIST);assert.equal(url.searchParams.get('maxResults'),'50');
  return json({items:[{id:'item-one',contentDetails:{videoId:VIDEO},snippet:{title:'Faixa real',videoOwnerChannelTitle:'Canal real',resourceId:{videoId:VIDEO},thumbnails:{default:{url:'https://i.ytimg.com/vi/M7lc1UVf-VE/default.jpg'}}}},{contentDetails:{videoId:'invalid<script>'},snippet:{title:'Unsafe'}}]});
 });
 const rows=await env.account.getPlaylistTracks(PLAYLIST);assert.equal(rows.length,1);assert.equal(rows[0].id,VIDEO);assert.equal(rows[0].videoId,VIDEO);assert.equal(rows[0].provider,'youtube');assert.equal(rows[0].kind,'video');assert.equal(rows[0].name,'Faixa real');
 const url=new URL(rows[0].url);assert.equal(url.origin,'https://www.youtube.com');assert.equal(url.pathname,'/watch');assert.equal(url.searchParams.get('v'),VIDEO);
 const count=env.calls.length;await assert.rejects(()=>env.account.getPlaylistTracks('https://evil.example/steal'),Error);assert.equal(env.calls.length,count);
});

test('owned playlists follow every cursor beyond 100 rows and 10 pages while reporting actual progress',async t=>{
 const env=setup(t);await login(env);let pages=0;const progress=[];
 env.respond(call=>{
  const page=pages++,url=new URL(call.url);assert.equal(url.searchParams.get('maxResults'),'50');
  assert.equal(url.searchParams.get('pageToken'),page?`PAGE${page}`:null);
  return json({items:Array.from({length:page===11?7:50},(_,i)=>({id:`PL${String(page*50+i).padStart(20,'0')}`,snippet:{title:`Playlist ${page*50+i}`}})),
   pageInfo:{totalResults:557},...(page<11?{nextPageToken:`PAGE${page+1}`}:{})});
 });
 const rows=await env.account.getPlaylists({onProgress:value=>progress.push(value)});
 assert.equal(rows.length,557);assert.equal(pages,12);assert.equal(progress.length,12);
 assert.deepEqual(progress[0],{loaded:50,total:557,pages:1});assert.deepEqual(progress.at(-1),{loaded:557,total:557,pages:12});
 assert.deepEqual(rows.map(row=>row.name),Array.from({length:557},(_,i)=>`Playlist ${i}`));
});

test('401 responses clear the local authorization without silently requesting another token',async t=>{
 const env=setup(t);await login(env);const requests=env.clients.reduce((sum,c)=>sum+c.requests.length,0);
 env.respond(()=>json({error:{code:401}},401));await assert.rejects(()=>env.account.getPlaylists(),Error);
 assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);assert.equal(env.clients.reduce((sum,c)=>sum+c.requests.length,0),requests);assert.equal(env.revokes.length,0);
});

test('disconnect cancels pending login and ignores a late token callback',async t=>{
 const env=setup(t);await env.account.prepare();const pending=env.account.connect(),client=env.clients.at(-1);
 const rejected=assert.rejects(()=>pending,Error);await env.account.disconnect();await rejected;client.config.callback(TOKEN);await flush();
 assert.equal(env.account.getState().connected,false);assert.equal(env.calls.length,0);assert.equal(env.revokes.length,0);
});

test('request deadlines cover a fetch that never settles',async t=>{
 const env=setup(t,{fastTimeout:true});await login(env);env.respond(()=>new Promise(()=>{}));
 await assert.rejects(()=>env.account.getPlaylists(),Error);assert.equal(env.calls.at(-1).init.signal.aborted,true);
});

test('request deadlines also cover a response body that never settles',async t=>{
 const env=setup(t,{fastTimeout:true});await login(env);env.respond(()=>({ok:true,status:200,json:()=>new Promise(()=>{})}));
 await assert.rejects(()=>env.account.getPlaylists(),Error);assert.equal(env.calls.at(-1).init.signal.aborted,true);
});

test('disconnect aborts library reads immediately even when the fetch ignores its signal',async t=>{
 const env=setup(t);await login(env);env.respond(()=>new Promise(()=>{}));
 const pending=env.account.getPlaylists();const rejected=assert.rejects(()=>pending,Error);await flush();
 assert.ok(env.calls.at(-1).init.signal);await env.account.disconnect();await rejected;assert.equal(env.calls.at(-1).init.signal.aborted,true);assert.equal(env.account.getState().connected,false);
});

test('expiry clears connected state and never silently renews a Google token',async t=>{
 const env=setup(t);await login(env);const count=env.clients.length;env.advance(3_600_001);
 assert.equal(env.account.getState().connected,false);await assert.rejects(()=>env.account.getPlaylists(),Error);assert.equal(env.clients.length,count);assert.equal(env.revokes.length,0);
});


test('local profile lock clears RAM and aborts reads without revoking Google consent',async t=>{
 const env=setup(t);await login(env);const oldClient=env.clients.at(-1);
 env.respond(()=>new Promise(()=>{}));
 const pending=env.account.getPlaylists(),rejected=assert.rejects(()=>pending,Error);await flush();
 const before=env.calls.length;
 assert.deepEqual(await env.account.disconnect({revoke:false}),{revoked:false});await rejected;
 assert.equal(env.calls.at(-1).init.signal.aborted,true);assert.equal(env.account.getState().connected,false);assert.equal(env.account.getState().profile,undefined);
 oldClient.config.callback(TOKEN);await flush();
 assert.equal(env.calls.length,before);assert.equal(env.account.getState().connected,false);assert.equal(env.revokes.length,0);
});

test('local lock ignores an outstanding Google popup callback without revoking consent',async t=>{
 const env=setup(t);await env.account.prepare();const pending=env.account.connect(),client=env.clients.at(-1);
 const rejected=assert.rejects(()=>pending,Error);await env.account.disconnect({revoke:false});await rejected;
 client.config.callback(TOKEN);await flush();
 assert.equal(env.account.getState().connected,false);assert.equal(env.calls.length,0);assert.equal(env.revokes.length,0);
});

test('all playlist pages retain ordered repeated videos and deduplicate only real item IDs repeated inside one page',async t=>{
 const env=setup(t);await login(env);let pages=0;const progress=[];
 env.respond(call=>{
  const page=pages++,url=new URL(call.url);assert.equal(url.searchParams.get('part'),'snippet,contentDetails,status');
  assert.equal(url.searchParams.get('pageToken'),page?`TRACKS${page}`:null);
  const items=Array.from({length:11},(_,i)=>{
   const position=page*11+i;
   return {id:page===1&&i===0?'item-0':`item-${position}`,contentDetails:{videoId:VIDEO},snippet:{position,title:`Faixa ${position}`}};
  });
  items.splice(5,0,structuredClone(items[0]));
  return json({items,pageInfo:{totalResults:132},...(page<11?{nextPageToken:`TRACKS${page+1}`}:{})});
 });
 const rows=await env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(value)});
 assert.equal(pages,12);assert.equal(rows.length,132);assert.ok(rows.every(row=>row.videoId===VIDEO&&row.id===VIDEO));
 assert.deepEqual(rows.map(row=>row.position),Array.from({length:132},(_,i)=>i));
 assert.deepEqual(rows.map(row=>row.name),Array.from({length:132},(_,i)=>`Faixa ${i}`));
 assert.equal(rows[0].playlistItemId,'item-0');assert.equal(rows[11].playlistItemId,'item-0','the same item ID on a later page is preserved');
 assert.deepEqual(progress.at(-1),{loaded:132,total:132,pages:12});assert.deepEqual(progress.map(row=>row.loaded),Array.from({length:12},(_,i)=>(i+1)*11));
});

test('missing playlist item IDs never collapse repeated videos and expose deterministic position fallbacks',async t=>{
 const env=setup(t);await login(env);
 env.respond(()=>json({items:[{contentDetails:{videoId:VIDEO},snippet:{title:'Primeira'}},{contentDetails:{videoId:VIDEO},snippet:{title:'Repetida'}},
  {id:'not/an/item/id',contentDetails:{videoId:VIDEO},snippet:{title:'Terceira'}}]}));
 const rows=await env.account.getPlaylistTracks(PLAYLIST);
 assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.position),[0,1,2]);assert.ok(rows.every(row=>row.playlistItemId===undefined));
});

test('corrupt and cyclic page tokens reject explicitly instead of returning a silently partial library',async t=>{
 const env=setup(t);await login(env);
 for(const token of [null,42,{},['TOKEN'],'bad token','https://evil.example/steal','x'.repeat(2049),'TOKEN\nNEXT']){
  env.respond(()=>json({items:[{id:PLAYLIST}],nextPageToken:token}));
  await assert.rejects(()=>env.account.getPlaylists(),/paginação inválida/);
 }
 for(const resource of ['playlists','playlistItems']){
  let page=0;const progress=[];
  env.respond(()=>json({items:[resource==='playlists'?{id:`PL${String(page).padStart(20,'0')}`}:{id:`item-${page}`,contentDetails:{videoId:VIDEO}}],nextPageToken:['A','B','A'][page++]}));
  const loading=resource==='playlists'?env.account.getPlaylists({onProgress:value=>progress.push(value)}):env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(value)});
  await assert.rejects(()=>loading,/paginação inválida/);assert.equal(page,3);assert.equal(progress.length,2);
 }
});

test('a response over the requested page size is rejected rather than truncated to fifty entries',async t=>{
 const env=setup(t);await login(env);
 env.respond(()=>json({items:Array.from({length:51},(_,i)=>({id:`PL${String(i).padStart(20,'0')}`}))}));
 await assert.rejects(()=>env.account.getPlaylists(),/página maior/);
});

test('disconnect cancels a later playlist page and suppresses progress after a late network response',async t=>{
 const env=setup(t);await login(env);let release;const waiting=new Promise(resolve=>{release=resolve;}),progress=[];
 env.respond(call=>new URL(call.url).searchParams.has('pageToken')?waiting:json({items:[{id:'item-0',contentDetails:{videoId:VIDEO}}],nextPageToken:'NEXT'}));
 const loading=env.account.getPlaylistTracks(PLAYLIST,{onProgress:value=>progress.push(value)}),rejected=assert.rejects(loading,error=>error.code==='YOUTUBE_CANCELLED');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(new URL(env.calls.at(-1).url).searchParams.get('pageToken'),'NEXT');
 await env.account.disconnect({revoke:false});await rejected;assert.equal(env.calls.at(-1).init.signal.aborted,true);
 const calls=env.calls.length;release(json({items:[{id:'item-1',contentDetails:{videoId:VIDEO}}],nextPageToken:'THIRD'}));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(progress.length,1);assert.equal(env.calls.length,calls);assert.equal(env.account.getState().connected,false);
});

test('a progress callback can cancel traversal immediately and callback failures never break valid pagination',async t=>{
 const env=setup(t);await login(env);let pages=0;
 env.respond(()=>json({items:[{id:`PL${String(pages++).padStart(20,'0')}`}],nextPageToken:'NEXT'}));
 await assert.rejects(()=>env.account.getPlaylists({onProgress:()=>{void env.account.disconnect({revoke:false});}}),error=>error.code==='YOUTUBE_CANCELLED');assert.equal(pages,1);
 env.respond(()=>json(PROFILE));await login(env);pages=0;
 env.respond(()=>json({items:[{id:`PL${String(pages++).padStart(20,'0')}`}],...(pages===1?{nextPageToken:'NEXT'}:{})}));
 assert.equal((await env.account.getPlaylists({onProgress:()=>{throw new Error('UI was unmounted');}})).length,2);
 const before=env.calls.length;await assert.rejects(()=>env.account.getPlaylists({onProgress:'not-a-function'}),/opções/);assert.equal(env.calls.length,before);
});

test('the overall library deadline fails explicitly after progress instead of reporting a partial result as complete',async t=>{
 const env=setup(t);await login(env);let pages=0;const progress=[];
 env.respond(()=>{env.advance(50000);return json({items:[{id:`PL${String(pages++).padStart(20,'0')}`}],nextPageToken:`NEXT${pages}`});});
 await assert.rejects(()=>env.account.getPlaylists({onProgress:value=>progress.push(value)}),/lista completa/);
 assert.equal(pages,3);assert.equal(progress.length,2);assert.deepEqual(progress.at(-1),{loaded:2,pages:2});
 assert.equal(env.account.getState().connected,true,'a library timeout does not silently revoke a valid authorization');
});
