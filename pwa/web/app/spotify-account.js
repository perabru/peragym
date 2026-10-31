/** Browser-only Spotify Authorization Code + PKCE. Tokens never leave this closure. */
const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const API_ORIGIN = 'https://api.spotify.com';
const PENDING_KEY = 'peragym.spotify.pkce.v1';
const PENDING_TTL = 10 * 60 * 1000;
const TOKEN_MARGIN = 30 * 1000;
const REQUEST_TIMEOUT = 12 * 1000;
const POPUP_CALLBACK = 'peragym:spotify:callback';
const POPUP_ACK = 'peragym:spotify:ack';
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
  let generation=0,refreshing=null,completing=null,blockedUntil=0,popupAttempt=null;
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
  function stopPopupListeners(attempt) {
    clearTimeout(attempt.deadline);clearInterval(attempt.poll);
    browser.removeEventListener?.('message',attempt.listener);
  }
  function finishPopup(attempt,result) {
    if(!attempt||attempt.settled)return;
    attempt.settled=true;stopPopupListeners(attempt);
    if(popupAttempt===attempt)popupAttempt=null;
    if(pendingRead()?.state===attempt.state)pendingRemove();
    try{attempt.window.close();}catch{}
    attempt.resolve({...result,mode:'popup'});
  }
  function cancelPopup(message='A conexão Spotify foi encerrada.') {
    if(popupAttempt)finishPopup(popupAttempt,{handled:true,connected:false,error:message});
  }
  function disconnect() {
    generation++;cancelPopup();abortRequests();forgetTokens();pendingRemove();refreshing=null;completing=null;lastError=configurationError;blockedUntil=0;notify();
  }
  function validatePending(pending,returned,current) {
    const now=Date.now();
    if(!config||!pending||typeof pending!=='object'||!STATE.test(pending.state)||!VERIFIER.test(pending.verifier)
      ||!STATE.test(returned)||!sameState(pending.state,returned)
      ||pending.clientId!==config.clientId||pending.redirectUri!==config.redirectUri||pending.origin!==config.origin
      ||current.protocol!=='https:'||current.origin!==config.origin||current.pathname!==config.path||current.username||current.password
      ||!Number.isFinite(pending.createdAt)||!Number.isFinite(pending.expiresAt)
      ||pending.createdAt>now||pending.expiresAt!==pending.createdAt+PENDING_TTL||now>=pending.expiresAt) {
      throw problem('Esta autorização Spotify expirou ou não corresponde a esta aba. Toque em Conectar Spotify e tente novamente.');
    }
  }
  function checkCooldown() {
    if(Date.now()<blockedUntil)throw problem(`O Spotify pediu uma pausa. Tente novamente em ${Math.max(1,Math.ceil((blockedUntil-Date.now())/1000))} segundos.`);
  }
  async function requestJSON(url,init,run,{tokenRequest=false,playlistItems=false}={}) {
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
      if(response.status===403)throw problem(playlistItems?'O Spotify não autorizou os itens desta playlist. A API permite apenas playlists que você possui ou nas quais colabora; confira também as permissões da conta.':'O Spotify não autorizou este acesso. Confira as permissões e se esta conta está liberada no aplicativo Spotify.');
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
  async function apiGet(url,run,options={}) {
    const token=await getAccessToken();assertCurrent(run);
    return requestJSON(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}},run,options);
  }
  function beginConnection() {
    const run=++generation;cancelPopup('Uma nova conexão Spotify foi iniciada.');abortRequests();forgetTokens();
    refreshing=null;completing=null;pendingRemove();lastError=null;notify();return run;
  }
  function freshPKCE() {
    const crypto=browser.crypto||globalThis.crypto;
    if(!crypto?.getRandomValues||!crypto?.subtle)throw problem('Este navegador não oferece a conexão segura necessária. Use um navegador atualizado em HTTPS.');
    return {crypto,verifier:base64url(crypto.getRandomValues(new Uint8Array(64))),state:base64url(crypto.getRandomValues(new Uint8Array(32)))};
  }
  async function prepareAuthorization(run,{crypto,verifier,state}) {
    const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    assertCurrent(run);
    const createdAt=Date.now(),pending={clientId:config.clientId,redirectUri:config.redirectUri,origin:config.origin,state,verifier,createdAt,expiresAt:createdAt+PENDING_TTL};
    const serialized=JSON.stringify(pending);
    try{
      browser.sessionStorage.setItem(PENDING_KEY,serialized);
      if(browser.sessionStorage.getItem(PENDING_KEY)!==serialized)throw new Error('storage');
    }catch{pendingRemove();throw problem('O navegador precisa permitir dados temporários nesta aba para conectar ao Spotify.');}
    const url=new URL(AUTHORIZE);
    for(const [key,value]of Object.entries({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,scope:SCOPES.join(' '),state,code_challenge_method:'S256',code_challenge:challenge}))url.searchParams.set(key,value);
    assertCurrent(run);return {url,pending,serialized};
  }
  async function connect() {
    if(!config){lastError=configurationError;notify();throw problem(lastError);}
    const run=beginConnection();
    try{const {url}=await prepareAuthorization(run,freshPKCE());assertCurrent(run);browser.location.assign(url.href);}
    catch(error){if(run===generation)pendingRemove();errorState(error,run);throw error;}
  }
  // Call directly from a click: open the window before the first asynchronous PKCE digest.
  function connectPopup() {
    if(!config){lastError=configurationError;notify();return Promise.reject(problem(lastError));}
    const run=beginConnection();let fields,popup;
    try{
      fields=freshPKCE();
      try{popup=browser.open?.('about:blank',`peragym-spotify-auth-${fields.state}`,'popup=yes,width=520,height=760');}catch{}
    }catch(error){errorState(error,run);return Promise.reject(error);}
    if(!popup||popup.closed||typeof browser.addEventListener!=='function'||typeof browser.removeEventListener!=='function') {
      try{popup?.close();}catch{}
      return (async()=>{
        try {
          const {url}=await prepareAuthorization(run,fields);assertCurrent(run);
          const warning='O navegador bloqueou a janela do Spotify. A conexão abrirá nesta aba; ao voltar, seu perfil local pode pedir a senha novamente.';
          lastError=warning;notify();browser.location.assign(url.href);
          return {handled:false,connected:false,mode:'redirect',redirected:true,warning};
        }catch(error){if(run===generation)pendingRemove();errorState(error,run);throw error;}
      })();
    }
    return new Promise(resolve=>{
      const attempt={window:popup,state:fields.state,run,resolve,settled:false,accepted:false,listener:null,deadline:null,poll:null};
      popupAttempt=attempt;
      const failAttempt=message=>{
        if(popupAttempt!==attempt||attempt.settled)return;
        if(run===generation){lastError=message;notify();}
        finishPopup(attempt,{handled:true,connected:false,error:message});
      };
      attempt.listener=event=>{
        if(attempt.settled||attempt.accepted||popupAttempt!==attempt||run!==generation
          ||event.origin!==config.origin||event.source!==popup||!event.data||event.data.type!==POPUP_CALLBACK
          ||typeof event.data.callbackUrl!=='string'||event.data.callbackUrl.length>8192||UNSAFE_URL.test(event.data.callbackUrl)
          ||hasUserInfo(event.data.callbackUrl))return;
        let callback;
        try {
          callback=new URL(event.data.callbackUrl);
          const states=callback.searchParams.getAll('state');
          if(states.length!==1||!sameState(states[0],attempt.state))return;
          validatePending(pendingRead(),states[0],callback);
        }catch{return;}
        attempt.accepted=true;stopPopupListeners(attempt);
        // Acknowledge only the exact popup and origin, never broadcast or send tokens/verifiers.
        try{popup.postMessage({type:POPUP_ACK,state:attempt.state},config.origin);}catch{}
        const completion=completeRedirect({callbackUrl:callback.href});
        completion.then(result=>finishPopup(attempt,result),error=>{
          errorState(error);finishPopup(attempt,{handled:true,connected:false,error:lastError});
        });
      };
      browser.addEventListener('message',attempt.listener);
      attempt.deadline=setTimeout(()=>failAttempt('A autorização Spotify expirou. Toque em Conectar Spotify e tente novamente.'),PENDING_TTL);
      attempt.poll=setInterval(()=>{
        if(attempt.accepted||attempt.settled)return;
        try{if(popup.closed)failAttempt('A janela do Spotify foi fechada. Conecte novamente quando quiser.');}catch{}
      },500);
      prepareAuthorization(run,fields).then(({url,serialized})=>{
        if(attempt.settled||popupAttempt!==attempt)return;
        assertCurrent(run);
        // A same-origin temporary copy lets the callback continue in its own tab if opener/ACK is lost.
        // No access/refresh token or unlocked local profile is copied.
        try{popup.sessionStorage.setItem(PENDING_KEY,serialized);}catch{}
        if(popup.closed){failAttempt('A janela do Spotify foi fechada. Conecte novamente quando quiser.');return;}
        popup.location.replace(url.href);
      }).catch(error=>{
        errorState(error,run);finishPopup(attempt,{handled:true,connected:false,error:run===generation?lastError:'A conexão Spotify foi encerrada.'});
      });
    });
  }
  function completeRedirect({callbackUrl}={}) {
    if(completing)return completing;
    let current;
    if(callbackUrl!==undefined&&(typeof callbackUrl!=='string'||callbackUrl.length>8192||UNSAFE_URL.test(callbackUrl)||hasUserInfo(callbackUrl))) {
      return Promise.resolve({handled:true,connected:false,error:'O retorno do Spotify é inválido. Conecte novamente.'});
    }
    try{current=new URL(callbackUrl===undefined?browser.location.href:callbackUrl);}catch{return Promise.resolve({handled:false,connected:getState().connected});}
    if(!['code','state','error'].some(key=>current.searchParams.has(key)))return Promise.resolve({handled:false,connected:getState().connected});
    const codes=current.searchParams.getAll('code'),states=current.searchParams.getAll('state'),errors=current.searchParams.getAll('error');
    const pending=pendingRead();pendingRemove();
    // Remove only OAuth parameters, synchronously, before any fetch or other await.
    if(callbackUrl===undefined) {
      const clean=new URL(current);
      for(const key of ['code','state','error'])clean.searchParams.delete(key);
      try{browser.history.replaceState(browser.history.state??null,'',clean.pathname+clean.search+clean.hash);}
      catch{forgetTokens();lastError='Não foi possível limpar o retorno do Spotify. Feche esta aba e conecte novamente.';notify();return Promise.resolve({handled:true,connected:false,error:lastError});}
    }
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
  function paginationError() {return problem('O Spotify retornou uma paginação inválida ou repetida. Tente carregar a lista novamente.');}
  function pageURL(raw,pathname,{playlistItems=false}={}) {
    if(typeof raw!=='string'||raw.length>4096||UNSAFE_URL.test(raw)||hasUserInfo(raw))throw paginationError();
    let url;try{url=new URL(raw);}catch{throw paginationError();}
    if(url.origin!==API_ORIGIN||url.username||url.password||url.pathname!==pathname||url.hash)throw paginationError();
    const allowed=playlistItems?['limit','offset','market','additional_types']:['limit','offset'];
    for(const key of url.searchParams.keys()){
      const values=url.searchParams.getAll(key),value=values[0];
      if(!allowed.includes(key)||values.length!==1)throw paginationError();
      if(key==='limit'||key==='offset'){
        const n=Number(value);
        if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)
          ||(key==='limit'&&(n<1||n>50))
          ||(key==='offset'&&(n<0||n>Number.MAX_SAFE_INTEGER-50||(!playlistItems&&n>100000))))throw paginationError();
        url.searchParams.set(key,String(n));
      }else if(key==='market'){
        if(!/^[A-Z]{2}$/.test(value))throw paginationError();
      }else{
        const types=value.split(',');
        if(!types.length||new Set(types).size!==types.length||types.some(type=>!['track','episode'].includes(type)))throw paginationError();
      }
    }
    // Ask for both supported item types on every page, even if a next URL
    // omits additional_types; a default of tracks alone would lose episodes.
    if(playlistItems)url.searchParams.set('additional_types','track,episode');
    if(url.searchParams.get('offset')==='0')url.searchParams.delete('offset');
    url.searchParams.sort();
    return url;
  }
  function pageDetails(page,url) {
    if(!Array.isArray(page.items)||page.items.length>Number(url.searchParams.get('limit')||50))throw problem('O Spotify não retornou uma página válida de itens. Tente novamente.');
    const offset=Number(url.searchParams.get('offset'));
    if(page.offset!==undefined&&(!Number.isSafeInteger(page.offset)||page.offset!==offset))throw paginationError();
    if(page.next!==null&&page.next!==undefined&&(typeof page.next!=='string'||!page.next))throw paginationError();
    return {offset,total:Number.isSafeInteger(page.total)&&page.total>=0?page.total:undefined};
  }
  function progress(onProgress,loaded,total,pages,run) {
    if(typeof onProgress==='function'){
      try{const pending=onProgress({loaded,...(total===undefined?{}:{total}),pages});if(pending&&typeof pending.catch==='function')pending.catch(()=>{});}catch{}
    }
    // A callback can log out or switch profiles synchronously. Do not publish
    // stale rows or start another authenticated request after that happens.
    assertCurrent(run);
  }
  function playlistRow(item) {
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.id!=='string'||!ID.test(item.id))return null;
    const row={id:item.id,provider:'spotify',kind:'playlist',name:text(item.name,300).trim()||'Playlist Spotify',uri:`spotify:playlist:${item.id}`,url:`https://open.spotify.com/playlist/${item.id}`};
    const image=spotifyImage(item.images?.[0]?.url);if(image)row.image=image;
    const summary=Object.hasOwn(item,'items')?item.items:item.tracks;
    if(Number.isSafeInteger(summary?.total)&&summary.total>=0)row.count=summary.total;
    const owner=item.owner;
    if(owner&&typeof owner==='object'&&!Array.isArray(owner)){
      const id=text(owner.id,200).trim(),name=text(owner.display_name,160).trim()||id;
      if(id||name)row.owner={...(id?{id}:{}),...(name?{name}:{})};
    }
    return row;
  }
  function playlistItemRow(wrapper,position) {
    const container=wrapper&&typeof wrapper==='object'&&!Array.isArray(wrapper)?wrapper:null;
    // The 2026 endpoint calls this item. The deprecated track field remains
    // documented, but must never override an explicit null/current item.
    const raw=container?(Object.hasOwn(container,'item')?container.item:container.track):null;
    const item=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:null;
    const kind=item?.type==='episode'?'episode':'track';
    const local=container?.is_local===true||item?.is_local===true||(typeof item?.uri==='string'&&item.uri.startsWith('spotify:local:'));
    const valid=!!item&&['track','episode'].includes(item.type)&&typeof item.id==='string'&&ID.test(item.id)&&!local;
    const name=text(item?.name,300).trim()||(local?'Arquivo local indisponível':valid?(kind==='episode'?'Episódio Spotify':'Faixa Spotify'):'Item indisponível');
    const row={id:valid?item.id:'',provider:'spotify',kind,name,title:name,
      url:valid?`https://open.spotify.com/${kind}/${item.id}`:'',uri:valid?`spotify:${kind}:${item.id}`:'',position};
    if(!valid||item.is_playable===false||(item.restrictions&&typeof item.restrictions==='object'&&typeof item.restrictions.reason==='string'&&item.restrictions.reason))row.unavailable=true;
    let artists=[];
    if(kind==='track'&&Array.isArray(item?.artists))artists=item.artists.map(artist=>text(artist?.name,160).trim()).filter(Boolean);
    else if(kind==='episode'){
      const show=text(item?.show?.name,160).trim()||text(item?.show?.publisher,160).trim();
      if(show)artists=[show];
    }
    if(artists.length)row.artists=artists;
    if(Number.isSafeInteger(item?.duration_ms)&&item.duration_ms>=0)row.durationMs=item.duration_ms;
    return row;
  }
  async function collectPages(pathname,{onProgress,playlistItems=false}={}) {
    if(onProgress!==undefined&&typeof onProgress!=='function')throw problem('O observador de carregamento da lista é inválido.');
    const run=generation;
    try{
      const results=[],ids=new Set(),visited=new Set();let next=`${API_ORIGIN}${pathname}?limit=50`,pages=0;
      while(next){
        assertCurrent(run);
        const url=pageURL(next,pathname,{playlistItems}),address=url.href;
        if(visited.has(address))throw paginationError();
        visited.add(address);
        const page=await apiGet(address,run,{playlistItems});assertCurrent(run);
        const {offset,total}=pageDetails(page,url),end=offset+page.items.length;
        if(!Number.isSafeInteger(end))throw paginationError();
        let following=null;
        if(page.next){
          following=pageURL(page.next,pathname,{playlistItems});
          const nextOffset=Number(following.searchParams.get('offset'));
          if(!page.items.length||nextOffset<=offset||nextOffset<end||visited.has(following.href))throw paginationError();
        }
        page.items.forEach((item,index)=>{
          if(playlistItems)results.push(playlistItemRow(item,offset+index));
          else{
            const row=playlistRow(item);
            if(row&&!ids.has(row.id)){results.push(row);ids.add(row.id);}
          }
        });
        pages++;progress(onProgress,results.length,total,pages,run);next=following?.href||null;
      }
      assertCurrent(run);lastError=null;notify();return results;
    }catch(error){errorState(error,run);throw error;}
  }
  function getPlaylists({onProgress}={}) {return collectPages('/v1/me/playlists',{onProgress});}
  async function getPlaylistTracks(id,{onProgress}={}) {
    if(typeof id!=='string'||!ID.test(id))throw problem('Escolha uma playlist Spotify válida.');
    return collectPages(`/v1/playlists/${id}/items`,{onProgress,playlistItems:true});
  }

  // Remove stale in-progress authorizations without retaining any credentials.
  const pending=pendingRead();
  if(pending&&(!Number.isFinite(pending.expiresAt)||Date.now()>=pending.expiresAt))pendingRemove();
  return {getState,connect,connectPopup,completeRedirect,disconnect,getPlaylists,getPlaylistTracks,getAccessToken};
}
