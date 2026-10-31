/** Google Identity Services token model + read-only YouTube Data API.
 * Tokens remain in this instance's memory. This module never signs in silently.
 * https://developers.google.com/identity/oauth2/web/guides/use-token-model
 * https://developers.google.com/identity/oauth2/web/reference/js-reference
 */
const GIS_URL = 'https://accounts.google.com/gsi/client';
const API_BASE = 'https://www.googleapis.com/youtube/v3/';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const REQUEST_TIMEOUT = 12000;
const POPUP_TIMEOUT = 120000;
const MAX_ITEMS = 100;
const MAX_PAGES = 10;
const CLIENT_ID = /^[A-Za-z0-9_-]{6,200}\.apps\.googleusercontent\.com$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{8,150}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_+/=-]{1,2048}$/;
const fail = message => Object.assign(new Error(message), {name:'YouTubeAccountError'});
const cancelled = () => Object.assign(fail('A conexão com o YouTube foi encerrada.'), {code:'YOUTUBE_CANCELLED'});
const cleanText = (value, max=300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0,max) : '';
const validToken = value => typeof value === 'string' && value.length>0 && value.length<=16384 && !/[\s\u0000-\u001f\u007f]/.test(value);
function imageURL(value) {
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\u007f<>\\]/.test(value))return undefined;
  try {
    const url=new URL(value),host=url.hostname;
    if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port
      &&['ytimg.com','ggpht.com','googleusercontent.com'].some(domain=>host===domain||host.endsWith('.'+domain)))return url.href;
  } catch { /* An unavailable thumbnail does not prevent listing the item. */ }
  return undefined;
}
function thumbnail(snippet) {
  const thumbnails=snippet?.thumbnails;
  return imageURL(thumbnails?.medium?.url||thumbnails?.default?.url||thumbnails?.high?.url);
}
function configured(clientId,browser) {
  if(typeof clientId!=='string'||!CLIENT_ID.test(clientId))throw fail('A vinculação YouTube ainda não foi ativada. O responsável pelo PeraGym precisa informar o Client ID público do Google.');
  let url;try{url=new URL(browser.location.href);}catch{throw fail('Abra o PeraGym em um endereço HTTPS para conectar ao YouTube.');}
  const local=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!local)throw fail('Abra o PeraGym em um endereço HTTPS para conectar ao YouTube.');
  return clientId;
}

export function createYouTubeAccount({clientId='',onChange}={}) {
  const browser=globalThis.window||globalThis;
  let configurationError,config;
  try{config=configured(clientId,browser);}catch(error){configurationError=error.message;}
  let sdk,prepared=false,preparing=null,generation=0,accessToken=null,expiresAt=0,profile=null,lastError=configurationError;
  let expiryTimer,connection=null,blockedUntil=0;
  const requests=new Set();
  const check=run=>{if(run!==generation)throw cancelled();};
  function getState() {
    const connected=Boolean(profile&&accessToken&&expiresAt>Date.now());
    return {configured:Boolean(config),ready:Boolean(config&&prepared),connected,
      ...(connected?{profile:{...profile}}:{}),...(lastError?{error:lastError}:{})};
  }
  function notify(){try{onChange?.(getState());}catch{/* Consumers do not control credential cleanup. */}}
  function forget(){clearTimeout(expiryTimer);accessToken=null;expiresAt=0;profile=null;}
  function abortRequests(){for(const request of requests)request.cancel();requests.clear();}
  function setError(error,run=generation){
    if(run!==generation||error?.code==='YOUTUBE_CANCELLED')return;
    lastError=error?.name==='YouTubeAccountError'?error.message:'Não foi possível conversar com o YouTube. Verifique sua conexão e tente novamente.';notify();
  }
  function finishConnection(operation,error) {
    if(connection!==operation||operation.settled)return;
    operation.settled=true;clearTimeout(operation.timer);connection=null;
    if(error){forget();abortRequests();setError(error,operation.run);operation.reject(error);}
    else{lastError=null;notify();operation.resolve(getState());}
  }
  function expire(run) {
    if(run!==generation)return;
    generation++;forget();abortRequests();
    if(connection){const pending=connection;connection=null;pending.settled=true;clearTimeout(pending.timer);pending.reject(fail('Sua autorização YouTube expirou. Toque em Conectar YouTube para autorizar novamente.'));}
    lastError='Sua autorização YouTube expirou. Toque em Conectar YouTube para autorizar novamente.';notify();
  }

  // Preparation can happen before the button is enabled; it never requests consent.
  function prepare() {
    if(!config)return Promise.resolve(getState());
    const available=browser.google?.accounts?.oauth2;
    if(typeof available?.initTokenClient==='function'){sdk=available;prepared=true;lastError=null;notify();return Promise.resolve(getState());}
    if(preparing)return preparing.promise;
    if(!globalThis.document?.head)return Promise.reject(fail('O serviço de conexão Google precisa de um navegador atualizado.'));
    const script=document.createElement('script');script.src=GIS_URL;script.async=true;script.defer=true;
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const task={promise};preparing=task;let settled=false;
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);script.onload=null;script.onerror=null;
      if(preparing===task)preparing=null;
      if(error){script.remove();prepared=false;setError(error);reject(error);return;}
      sdk=browser.google.accounts.oauth2;prepared=true;lastError=null;notify();resolve(getState());
    };
    script.onload=()=>finish(typeof browser.google?.accounts?.oauth2?.initTokenClient==='function'?null:fail('O serviço Google não ficou disponível. Tente novamente.'));
    script.onerror=()=>finish(fail('Não foi possível carregar a conexão Google. Verifique sua internet e tente novamente.'));
    const timer=setTimeout(()=>finish(fail('A conexão Google demorou para carregar. Tente novamente.')),REQUEST_TIMEOUT);
    try{document.head.append(script);}catch{finish(fail('O navegador não permitiu carregar a conexão Google.'));}
    return promise;
  }

  async function request(resource,parameters,run) {
    check(run);
    if(!accessToken||expiresAt<=Date.now()){forget();lastError='Conecte sua conta YouTube para continuar.';notify();throw fail(lastError);}
    if(Date.now()<blockedUntil)throw fail(`O YouTube pediu uma pausa. Tente novamente em ${Math.max(1,Math.ceil((blockedUntil-Date.now())/1000))} segundos.`);
    if(!['channels','playlists','playlistItems'].includes(resource))throw fail('Consulta YouTube indisponível.');
    const url=new URL(resource,API_BASE);Object.entries(parameters).forEach(([key,value])=>url.searchParams.set(key,String(value)));
    const controller=new AbortController();let timeout,cancel;
    const interrupted=new Promise((_,reject)=>{
      cancel=()=>{controller.abort();reject(cancelled());};
      timeout=setTimeout(()=>{controller.abort();reject(fail('O YouTube demorou para responder. Verifique sua conexão e tente novamente.'));},REQUEST_TIMEOUT);
    });
    const pending={cancel};requests.add(pending);
    try{
      const network=(async()=>{
        let response;try{response=await globalThis.fetch(url.href,{method:'GET',headers:{Authorization:`Bearer ${accessToken}`,Accept:'application/json'},credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});}
        catch{check(run);throw fail('Não foi possível acessar o YouTube. Verifique sua internet e tente novamente.');}
        check(run);let body;try{body=await response.json();}catch{body=null;}check(run);
        if(!response.ok){
          if(response.status===401){forget();lastError='A autorização YouTube expirou ou foi revogada. Conecte novamente.';notify();throw fail(lastError);}
          if(response.status===403)throw fail('O YouTube não autorizou esta consulta. Confira a API habilitada, as permissões e a cota do projeto Google.');
          if(response.status===404)throw fail('Esta playlist não está disponível para a conta conectada.');
          if(response.status===429){const value=Number(response.headers?.get?.('Retry-After'));blockedUntil=Date.now()+(Number.isFinite(value)&&value>0?Math.min(value,3600):5)*1000;throw fail('O YouTube recebeu muitos pedidos. Aguarde um pouco e tente novamente.');}
          throw fail('O YouTube não conseguiu concluir a consulta. Tente novamente.');
        }
        if(!body||typeof body!=='object'||Array.isArray(body)||!Array.isArray(body.items))throw fail('O YouTube retornou uma lista inválida. Tente novamente.');
        return body;
      })();
      const body=await Promise.race([network,interrupted]);check(run);return body;
    } finally {clearTimeout(timeout);requests.delete(pending);}
  }
  async function acceptToken(response,operation) {
    if(connection!==operation||operation.settled||operation.run!==generation||operation.received)return;
    operation.received=true;
    try{
      if(response?.error)throw fail(response.error==='access_denied'?'Você cancelou a autorização YouTube.':'O Google não concluiu a autorização YouTube. Tente novamente.');
      const seconds=Number(response?.expires_in);
      if(!validToken(response?.access_token)||String(response.token_type).toLowerCase()!=='bearer'||!Number.isFinite(seconds)||seconds<=0||seconds>86400)throw fail('O Google não retornou uma autorização válida. Tente conectar novamente.');
      const granted=typeof sdk?.hasGrantedAllScopes==='function'?sdk.hasGrantedAllScopes(response,SCOPE):typeof response.scope==='string'&&response.scope.split(/\s+/).includes(SCOPE);
      if(!granted)throw fail('Autorize a leitura dos dados do YouTube para carregar suas playlists.');
      check(operation.run);accessToken=response.access_token;expiresAt=Date.now()+seconds*1000;
      clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>expire(operation.run),seconds*1000);
      const channels=await request('channels',{part:'snippet',mine:'true',maxResults:50},operation.run);check(operation.run);
      const channel=channels.items.find(item=>CHANNEL_ID.test(item?.id||''));
      if(!channel)throw fail('O YouTube não retornou um canal para esta conta. Não foi possível confirmar a conexão.');
      profile={id:channel.id,channelId:channel.id,displayName:cleanText(channel.snippet?.title,120)||'Canal YouTube',url:`https://www.youtube.com/channel/${channel.id}`};
      const image=thumbnail(channel.snippet);if(image)profile.image=image;
      finishConnection(operation);
    } catch(error){finishConnection(operation,error?.name==='YouTubeAccountError'?error:fail('Não foi possível confirmar sua conta YouTube. Tente novamente.'));}
  }

  // Intentionally not async: requestAccessToken runs on the original button gesture.
  function connect() {
    if(!config){lastError=configurationError;notify();return Promise.reject(fail(lastError));}
    if(!prepared||typeof sdk?.initTokenClient!=='function'){lastError='Aguarde a preparação da conexão Google e toque em Conectar YouTube novamente.';notify();return Promise.reject(fail(lastError));}
    if(connection)return connection.promise;
    generation++;forget();abortRequests();lastError=null;const run=generation;
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const operation={run,promise,resolve,reject,settled:false,received:false};connection=operation;
    operation.timer=setTimeout(()=>finishConnection(operation,fail('A janela de autorização demorou para responder. Toque em Conectar YouTube para tentar novamente.')),POPUP_TIMEOUT);
    try{
      const client=sdk.initTokenClient({client_id:config,scope:SCOPE,include_granted_scopes:false,
        callback:response=>{void acceptToken(response,operation);},
        error_callback:error=>finishConnection(operation,fail(error?.type==='popup_closed'?'Você fechou a autorização YouTube.':error?.type==='popup_failed_to_open'?'O navegador bloqueou a janela Google. Permita popups e tente novamente.':'Não foi possível abrir a autorização Google. Tente novamente.'))});
      if(typeof client?.requestAccessToken!=='function')throw fail('O Google não preparou a autorização. Tente novamente.');
      client.requestAccessToken({prompt:'select_account'});notify();
    }catch(error){finishConnection(operation,error?.name==='YouTubeAccountError'?error:fail('Não foi possível abrir a autorização Google. Tente novamente.'));}
    return promise;
  }
  function disconnect({revoke=true}={}) {
    const token=accessToken;generation++;forget();abortRequests();blockedUntil=0;
    if(connection){const pending=connection;connection=null;pending.settled=true;clearTimeout(pending.timer);pending.reject(cancelled());}
    lastError=configurationError;notify();
    if(!revoke||!token||typeof sdk?.revoke!=='function')return Promise.resolve({revoked:false});
    return new Promise(resolve=>{
      let finished=false;const finish=response=>{if(finished)return;finished=true;clearTimeout(timer);resolve(response);};
      const timer=setTimeout(()=>finish({revoked:false}),REQUEST_TIMEOUT);
      try{sdk.revoke(token,response=>finish({revoked:response?.successful===true||response?.error==='invalid_token'}));}
      catch{finish({revoked:false});}
    });
  }
  async function list(resource,parameters,mapItem) {
    const run=generation,rows=[],visited=new Set();let token;
    try{
      for(let page=0;page<MAX_PAGES;page++){
        const body=await request(resource,{...parameters,maxResults:50,...(token?{pageToken:token}:{})},run);
        for(const raw of body.items.slice(0,50)){const item=mapItem(raw);if(item)rows.push(item);if(rows.length===MAX_ITEMS)return rows;}
        if(body.nextPageToken===undefined||body.nextPageToken===null||body.nextPageToken==='')return rows;
        if(typeof body.nextPageToken!=='string'||!PAGE_TOKEN.test(body.nextPageToken)||visited.has(body.nextPageToken))throw fail('O YouTube retornou uma paginação inválida. Tente novamente.');
        token=body.nextPageToken;visited.add(token);
      }
      return rows;
    }catch(error){setError(error,run);throw error;}
  }
  function getPlaylists() {
    const ids=new Set();
    return list('playlists',{part:'snippet,contentDetails,status',mine:'true'},item=>{
      if(!PLAYLIST_ID.test(item?.id||'')||ids.has(item.id))return null;ids.add(item.id);
      const row={id:item.id,listId:item.id,provider:'youtube',kind:'playlist',name:cleanText(item.snippet?.title)||'Playlist YouTube',url:`https://www.youtube.com/playlist?list=${item.id}`};
      const count=item.contentDetails?.itemCount;if(Number.isInteger(count)&&count>=0)row.itemCount=count;
      const privacy=item.status?.privacyStatus;if(['public','unlisted','private'].includes(privacy))row.privacyStatus=privacy;
      const image=thumbnail(item.snippet);if(image)row.image=image;return row;
    });
  }
  function getPlaylistTracks(id) {
    if(typeof id!=='string'||!PLAYLIST_ID.test(id))return Promise.reject(fail('Escolha uma playlist válida do YouTube.'));
    return list('playlistItems',{part:'snippet,contentDetails,status',playlistId:id},item=>{
      const videoId=item?.contentDetails?.videoId||item?.snippet?.resourceId?.videoId;
      if(!VIDEO_ID.test(videoId||''))return null;
      const title=cleanText(item.snippet?.title)||'Vídeo YouTube';
      const row={id:videoId,videoId,provider:'youtube',kind:'video',name:title,title,url:`https://www.youtube.com/watch?v=${videoId}`};
      const channel=cleanText(item.snippet?.videoOwnerChannelTitle,160);if(channel)row.channel=channel;
      const image=thumbnail(item.snippet);if(image)row.image=image;
      const privacy=item.status?.privacyStatus;if(['public','unlisted','private'].includes(privacy))row.privacyStatus=privacy;
      return row;
    });
  }
  return {getState,prepare,connect,disconnect,getPlaylists,getPlaylistTracks};
}
