/** Browser-only Spotify Authorization Code + PKCE. Tokens never leave this closure. */
const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const API_ORIGIN = 'https://api.spotify.com';
const PENDING_KEY = 'peragym.spotify.pkce.v1';
const PENDING_TTL = 10 * 60 * 1000;
const TOKEN_MARGIN = 30 * 1000;
const REQUEST_TIMEOUT = 12 * 1000;
const SCOPES = ['streaming','user-read-private','user-read-email','playlist-read-private','playlist-read-collaborative','user-modify-playback-state'];
const CLIENT_ID = /^[a-fA-F0-9]{32}$/;
const ID = /^[A-Za-z0-9]{22}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const UNSAFE_URL = /[\u0000-\u001f\u007f<>\\]/;
const hasUserInfo = raw => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw);

function problem(message, name = 'SpotifyAccountError') {
  const error = new Error(message); error.name = name; return error;
}
function base64url(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function sameState(a,b) {
  if(typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length)return false;
  let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);
  return difference===0;
}
function text(raw,max=160) {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max) : '';
}
function spotifyImage(raw) {
  if(typeof raw !== 'string' || raw.length>2048 || UNSAFE_URL.test(raw))return undefined;
  try{
    const url=new URL(raw),h=url.hostname;
  if(url.protocol==='https:'&&!url.username&&!url.password&&!hasUserInfo(raw)&&!url.port
      &&(h==='scdn.co'||h.endsWith('.scdn.co')||h==='spotifycdn.com'||h.endsWith('.spotifycdn.com')))return url.href;
  }catch{}
  return undefined;
}
function profileFrom(raw) {
  if(!raw || typeof raw !== 'object' || Array.isArray(raw))throw problem('O Spotify não retornou um perfil válido. Conecte novamente.');
  const accountId=text(raw.account_id,200),id=text(raw.id,200);
  if(!accountId&&!id)throw problem('O Spotify não retornou um perfil válido. Conecte novamente.');
  const profile={accountId:accountId||id,id:id||accountId,displayName:text(raw.display_name,120)||'Conta Spotify'};
  // account_id is the stable account identifier; email/product are not required.
  if(id)profile.url=`https://open.spotify.com/user/${encodeURIComponent(id)}`;
  const image=spotifyImage(raw.images?.[0]?.url);if(image)profile.image=image;
  return profile;
}
function validateConfiguration(clientId,redirectUri,browser) {
  if(typeof clientId !== 'string'||!CLIENT_ID.test(clientId))throw problem('A conexão Spotify ainda não foi configurada. O responsável pelo PeraGym precisa informar o Client ID público do aplicativo.');
  if(typeof redirectUri !== 'string'||redirectUri.length>2048||UNSAFE_URL.test(redirectUri))throw problem('O endereço de retorno do Spotify não foi configurado corretamente.');
  const current=new URL(browser.location.href),redirect=new URL(redirectUri);
  const appPath=current.pathname.endsWith('/index.html')?current.pathname.slice(0,-10):current.pathname;
  if(current.protocol!=='https:'||redirect.protocol!=='https:'||redirect.origin!==current.origin
    ||redirect.username||redirect.password||hasUserInfo(redirectUri)||redirect.search||redirect.hash
    ||!appPath.endsWith('/')||redirect.pathname!==appPath)throw problem('O retorno do Spotify deve usar o endereço HTTPS deste aplicativo, sem outros caminhos, parâmetros ou fragmentos.');
  return {clientId,redirectUri:redirect.href,origin:current.origin,path:appPath};
}

export function createSpotifyAccount({clientId='',redirectUri='',onChange}={}) {
  const browser=globalThis.window||globalThis;
  let config=null,configurationError;
  try{config=validateConfiguration(clientId,redirectUri,browser);}catch(error){configurationError=error?.name==='SpotifyAccountError'?error.message:'O endereço de retorno do Spotify não foi configurado corretamente.';}
  let accessToken=null,refreshToken=null,expiresAt=0,profile=null,lastError=configurationError;
  let generation=0,refreshing=null,completing=null,blockedUntil=0;
  const pendingRequests=new Set();

  function getState() {
    const connected=Boolean(profile&&((accessToken&&expiresAt>Date.now())||refreshToken));
    return {configured:Boolean(config),connected,...(profile?{profile:{...profile}}:{}),...(lastError?{error:lastError}:{})};
  }
  function notify() {try{if(typeof onChange==='function')onChange(getState());}catch{/* A UI callback must not change OAuth results. */}}
  function errorState(error,run=generation) {
    if(run!==generation)return;
    lastError=error?.name==='SpotifyAccountError'?error.message:'Não foi possível conversar com o Spotify. Verifique a conexão e tente novamente.';notify();
  }
  function forgetTokens() {accessToken=null;refreshToken=null;expiresAt=0;profile=null;}
  function assertCurrent(run) {if(run!==generation)throw problem('A conexão Spotify foi encerrada.','SpotifyOperationCancelled');}
  function pendingRead() {
    try{
      const raw=browser.sessionStorage.getItem(PENDING_KEY);
      if(!raw)return null;
      if(raw.length>4096){pendingRemove();return null;}
      const parsed=JSON.parse(raw);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){pendingRemove();return null;}
      return parsed;
    }catch{pendingRemove();return null;}
  }
  function pendingRemove() {try{browser.sessionStorage.removeItem(PENDING_KEY);}catch{}}
  function abortRequests() {
    for(const pending of pendingRequests){pending.reason='disconnect';pending.controller.abort();}
  }
  function disconnect() {
    generation++;abortRequests();forgetTokens();pendingRemove();refreshing=null;lastError=configurationError;blockedUntil=0;notify();
  }
  function validatePending(pending,returned,current) {
    const now=Date.now();
    if(!config||!pending||typeof pending!=='object'||!STATE.test(pending.state)||!VERIFIER.test(pending.verifier)
      ||!STATE.test(returned)||!sameState(pending.state,returned)
      ||pending.clientId!==config.clientId||pending.redirectUri!==config.redirectUri||pending.origin!==config.origin
      ||current.protocol!=='https:'||current.origin!==config.origin||current.pathname!==config.path
      ||!Number.isFinite(pending.createdAt)||!Number.isFinite(pending.expiresAt)
      ||pending.createdAt>now||pending.expiresAt!==pending.createdAt+PENDING_TTL||now>=pending.expiresAt) {
      throw problem('Esta autorização Spotify expirou ou não corresponde a esta aba. Toque em Conectar Spotify e tente novamente.');
    }
  }
  function checkCooldown() {
    if(Date.now()<blockedUntil)throw problem(`O Spotify pediu uma pausa. Tente novamente em ${Math.max(1,Math.ceil((blockedUntil-Date.now())/1000))} segundos.`);
  }
  async function requestJSON(url,init,run,{tokenRequest=false}={}) {
    assertCurrent(run);checkCooldown();
    const pending={controller:new AbortController(),reason:null};
    pendingRequests.add(pending);
    let rejectAbort;
    const aborted=new Promise((resolve,reject)=>{rejectAbort=reject;});
    const onAbort=()=>rejectAbort(problem('A solicitação Spotify foi interrompida.','SpotifyRequestAborted'));
    pending.controller.signal.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>{pending.reason='timeout';pending.controller.abort();},REQUEST_TIMEOUT);
    let response,payload;
    try{
      // Race the complete response, including its body, so a stalled request
      // cannot hold the application's UI even if a fetch adapter ignores abort.
      ({response,payload}=await Promise.race([(async()=>{
        const response=await globalThis.fetch(url,{...init,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:pending.controller.signal});
        assertCurrent(run);
        let payload;
        try{payload=await response.json();}catch(error){if(pending.controller.signal.aborted)throw error;payload=null;}
        return {response,payload};
      })(),aborted]));
    }catch{
      assertCurrent(run);
      if(pending.reason==='timeout')throw problem('O Spotify demorou para responder. Verifique a conexão e tente novamente.');
      throw problem('Não foi possível conversar com o Spotify. Verifique a conexão e tente novamente.');
    }finally{
      clearTimeout(timer);pendingRequests.delete(pending);pending.controller.signal.removeEventListener('abort',onAbort);
    }
    assertCurrent(run);
    if(!response.ok){
      if(response.status===429){
        const raw=Number(response.headers?.get('retry-after'));
        const seconds=Number.isFinite(raw)&&raw>0?Math.min(3600,Math.ceil(raw)):5;
        blockedUntil=Date.now()+seconds*1000;
        throw problem(`O Spotify pediu uma pausa. Tente novamente em ${seconds} segundos.`);
      }
      if(response.status===401||(tokenRequest&&response.status===400&&payload?.error==='invalid_grant')){
        forgetTokens();throw problem('A autorização Spotify expirou ou foi revogada. Conecte sua conta novamente.');
      }
      if(response.status===403)throw problem('O Spotify não autorizou este acesso. Confira as permissões e se esta conta está liberada no aplicativo Spotify.');
      if(response.status===400)throw problem('O Spotify recusou a solicitação. Conecte novamente e confira o Client ID e o endereço de retorno.');
      throw problem('O Spotify está indisponível no momento. Tente novamente mais tarde.');
    }
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw problem('O Spotify retornou uma resposta inválida. Tente novamente.');
    return payload;
  }
  async function tokenRequest(parameters,run) {
    const payload=await requestJSON(TOKEN_ENDPOINT,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams(parameters)
    },run,{tokenRequest:true});
    const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&!/[\s\u0000-\u001f\u007f]/.test(value);
    const seconds=Number(payload.expires_in);
    if(!validToken(payload.access_token)||String(payload.token_type).toLowerCase()!=='bearer'
      ||!Number.isFinite(seconds)||seconds<=0||seconds>86400
      ||(payload.refresh_token!==undefined&&!validToken(payload.refresh_token)))throw problem('O Spotify não retornou uma sessão válida. Conecte novamente.');
    assertCurrent(run);
    accessToken=payload.access_token;expiresAt=Date.now()+seconds*1000;
    if(payload.refresh_token)refreshToken=payload.refresh_token;
    return accessToken;
  }
  async function getAccessToken() {
    const run=generation;
    if(!config)throw problem(configurationError);
    if(accessToken&&expiresAt-Date.now()>TOKEN_MARGIN)return accessToken;
    if(!refreshToken){forgetTokens();lastError='Conecte sua conta Spotify para continuar.';notify();throw problem(lastError);}
    if(refreshing)return refreshing;
    const renewal=(async()=>{
      try{
        const value=await tokenRequest({grant_type:'refresh_token',refresh_token:refreshToken,client_id:config.clientId},run);
        assertCurrent(run);lastError=null;notify();return value;
      }catch(error){errorState(error,run);throw error;}
    })();
    refreshing=renewal;
    try{return await renewal;}finally{if(refreshing===renewal)refreshing=null;}
  }
  async function apiGet(url,run) {
    const token=await getAccessToken();assertCurrent(run);
    return requestJSON(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}},run);
  }
  async function connect() {
    if(!config){lastError=configurationError;notify();throw problem(lastError);}
    const run=++generation;abortRequests();forgetTokens();refreshing=null;pendingRemove();lastError=null;notify();
    try{
      const crypto=browser.crypto||globalThis.crypto;
      if(!crypto?.getRandomValues||!crypto?.subtle)throw problem('Este navegador não oferece a conexão segura necessária. Use um navegador atualizado em HTTPS.');
      const verifier=base64url(crypto.getRandomValues(new Uint8Array(64)));
      const state=base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
      assertCurrent(run);
      const createdAt=Date.now(),pending={clientId:config.clientId,redirectUri:config.redirectUri,origin:config.origin,state,verifier,createdAt,expiresAt:createdAt+PENDING_TTL};
      try{
        browser.sessionStorage.setItem(PENDING_KEY,JSON.stringify(pending));
        if(browser.sessionStorage.getItem(PENDING_KEY)!==JSON.stringify(pending))throw new Error('storage');
      }catch{pendingRemove();throw problem('O navegador precisa permitir dados temporários nesta aba para conectar ao Spotify.');}
      const url=new URL(AUTHORIZE);
      for(const [key,value]of Object.entries({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,scope:SCOPES.join(' '),state,code_challenge_method:'S256',code_challenge:challenge}))url.searchParams.set(key,value);
      assertCurrent(run);browser.location.assign(url.href);
    }catch(error){if(run===generation)pendingRemove();errorState(error,run);throw error;}
  }
  function completeRedirect() {
    if(completing)return completing;
    let current;
    try{current=new URL(browser.location.href);}catch{return Promise.resolve({handled:false,connected:getState().connected});}
    if(!['code','state','error'].some(key=>current.searchParams.has(key)))return Promise.resolve({handled:false,connected:getState().connected});
    const codes=current.searchParams.getAll('code'),states=current.searchParams.getAll('state'),errors=current.searchParams.getAll('error');
    const pending=pendingRead();pendingRemove();
    // Remove only OAuth parameters, synchronously, before any fetch or other await.
    const clean=new URL(current);
    for(const key of ['code','state','error'])clean.searchParams.delete(key);
    try{browser.history.replaceState(browser.history.state??null,'',clean.pathname+clean.search+clean.hash);}
    catch{forgetTokens();lastError='Não foi possível limpar o retorno do Spotify. Feche esta aba e conecte novamente.';notify();return Promise.resolve({handled:true,connected:false,error:lastError});}
    const run=++generation;abortRequests();forgetTokens();refreshing=null;
    const completion=(async()=>{
      try{
        if(!config)throw problem(configurationError);
        if(states.length!==1||codes.length>1||errors.length>1||Boolean(codes.length)===Boolean(errors.length))throw problem('O retorno do Spotify é inválido. Conecte novamente.');
        validatePending(pending,states[0],current);
        if(errors.length)throw problem(errors[0]==='access_denied'?'Você cancelou a conexão com o Spotify.':'O Spotify não concluiu a autorização. Tente conectar novamente.');
        const code=codes[0];if(!code||code.length>4096||/[\u0000-\u001f\u007f<>]/.test(code))throw problem('O código de autorização Spotify é inválido. Conecte novamente.');
        await tokenRequest({grant_type:'authorization_code',code,redirect_uri:config.redirectUri,client_id:config.clientId,code_verifier:pending.verifier},run);
        const rawProfile=await apiGet(`${API_ORIGIN}/v1/me`,run);assertCurrent(run);
        profile=profileFrom(rawProfile);lastError=null;notify();return {handled:true,connected:true};
      }catch(error){
        if(run===generation){forgetTokens();errorState(error,run);}
        return {handled:true,connected:false,error:run===generation?lastError:'A conexão Spotify foi encerrada.'};
      }
    })();
    completing=completion;
    completion.then(()=>{if(completing===completion)completing=null;},()=>{if(completing===completion)completing=null;});
    return completion;
  }
  function playlistPageURL(raw) {
    let url;try{url=new URL(raw);}catch{throw problem('O Spotify retornou um endereço de playlists inválido.');}
    if(url.origin!==API_ORIGIN||url.username||url.password||hasUserInfo(raw)||UNSAFE_URL.test(raw)||url.pathname!=='/v1/me/playlists'||url.hash)throw problem('O Spotify retornou um endereço de playlists inválido.');
    for(const key of url.searchParams.keys()){
      const values=url.searchParams.getAll(key),n=Number(values[0]);
      if(!['limit','offset'].includes(key)||values.length!==1||!/^\d+$/.test(values[0])||!Number.isInteger(n)
        ||(key==='limit'&&(n<1||n>50))||(key==='offset'&&(n<0||n>100000)))throw problem('O Spotify retornou uma paginação de playlists inválida.');
    }
    return url.href;
  }
  async function getPlaylists() {
    const run=generation;
    try{
      const results=[],ids=new Set(),visited=new Set();let next=`${API_ORIGIN}/v1/me/playlists?limit=50`;
      while(next){
        const url=playlistPageURL(next);
        if(visited.has(url)||visited.size>=100)throw problem('Não foi possível concluir a lista de playlists. Tente novamente ou use o link de uma playlist.');
        visited.add(url);
        const page=await apiGet(url,run);assertCurrent(run);
        if(!Array.isArray(page.items))throw problem('O Spotify não retornou uma lista válida de playlists.');
        for(const item of page.items){
          if(!item||typeof item.id!=='string'||!ID.test(item.id)||ids.has(item.id))continue;
          const row={id:item.id,name:text(item.name,300)||'Playlist Spotify',uri:`spotify:playlist:${item.id}`,url:`https://open.spotify.com/playlist/${item.id}`};
          const image=spotifyImage(item.images?.[0]?.url);if(image)row.image=image;
          results.push(row);ids.add(item.id);
        }
        if(page.next!==null&&page.next!==undefined&&typeof page.next!=='string')throw problem('O Spotify retornou uma paginação de playlists inválida.');
        next=page.next?playlistPageURL(page.next):null;
      }
      lastError=null;notify();return results;
    }catch(error){errorState(error,run);throw error;}
  }

  // Remove stale in-progress authorizations without retaining any credentials.
  const pending=pendingRead();
  if(pending&&(!Number.isFinite(pending.expiresAt)||Date.now()>=pending.expiresAt))pendingRemove();
  return {getState,connect,completeRedirect,disconnect,getPlaylists,getAccessToken};
}
