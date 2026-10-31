'use strict';

// Classic, pre-app callback bridge. No token exchange, profile data, password or verifier is messaged.
(() => {
  const CALLBACK='peragym:spotify:callback',ACK='peragym:spotify:ack';
  const PENDING='peragym.spotify.pkce.v1',BYPASS='peragym.spotify.return.once.v1';
  const STATE=/^[A-Za-z0-9_-]{43}$/;
  let callback;
  try{callback=new URL(window.location.href);}catch{return;}
  const states=callback.searchParams.getAll('state'),codes=callback.searchParams.getAll('code'),errors=callback.searchParams.getAll('error');
  if(callback.protocol!=='https:'||callback.username||callback.password||states.length!==1||!STATE.test(states[0])
    ||codes.length>1||errors.length>1||Boolean(codes.length)===Boolean(errors.length))return;
  const state=states[0];
  try{if(window.sessionStorage.getItem(BYPASS)===state){window.sessionStorage.removeItem(BYPASS);return;}}catch{}
  let opener;
  try{opener=window.opener;if(!opener||opener.closed||opener.location.origin!==callback.origin)return;}catch{return;}
  if(window.__peragymSpotifyReturn)return;
  window.__peragymSpotifyReturn=true;
  const callbackUrl=callback.href,clean=new URL(callback);
  for(const key of ['code','state','error'])clean.searchParams.delete(key);
  let mode='waiting',panel,title,description,button,deadline;
  try{window.history.replaceState(window.history.state??null,'',clean.pathname+clean.search+clean.hash);}
  catch{mode='fallback';}

  function continueHere() {
    let bypass=false,detached=false;
    try{window.sessionStorage.setItem(BYPASS,state);bypass=window.sessionStorage.getItem(BYPASS)===state;}catch{}
    try{window.opener=null;detached=!window.opener;}catch{}
    stop();window.__peragymSpotifyReturn=false;
    // The popup has its own temporary PKCE copy. Normal app startup can consume it once.
    // If both recovery mechanisms are blocked, open a clean app URL instead of creating a loop.
    window.location.replace(mode==='acknowledged'||(!bypass&&!detached)?clean.href:callbackUrl);
  }
  function update() {
    if(!title)return;
    if(mode==='waiting') {
      title.textContent='Voltando ao PeraGym…';
      description.textContent='A autorização será enviada à janela em que você iniciou a conexão.';
      button.hidden=true;
    }else if(mode==='acknowledged') {
      title.textContent='Autorização enviada';
      description.textContent='Volte à janela do PeraGym para abrir o player. Se continuar aqui, seu perfil local pode pedir a senha novamente.';
      button.textContent='Abrir PeraGym nesta janela';button.hidden=false;
    }else {
      title.textContent='Continue no PeraGym';
      description.textContent='O navegador não permitiu voltar automaticamente. Continue nesta janela; seu perfil local pode pedir a senha novamente.';
      button.textContent='Continuar nesta janela';button.hidden=false;
    }
  }
  function render() {
    if(panel||window.closed)return;
    panel=document.createElement('main');panel.setAttribute('aria-label','Retorno do Spotify');
    panel.style.cssText='max-width:440px;margin:12vh auto;padding:28px;border:1px solid #ff63b9;border-radius:22px;background:#191132;color:#fff3fc;font:16px/1.6 system-ui,sans-serif;box-shadow:0 16px 80px #0006';
    const brand=document.createElement('p');brand.textContent='PeraGym · Spotify';brand.style.cssText='color:#49e5f4;font-weight:700;letter-spacing:.04em';
    title=document.createElement('h1');title.style.cssText='font-size:24px;line-height:1.3';
    description=document.createElement('p');description.setAttribute('role','status');description.setAttribute('aria-live','polite');
    button=document.createElement('button');button.type='button';button.onclick=continueHere;
    button.style.cssText='width:100%;padding:13px 16px;border:0;border-radius:12px;background:#ff63b9;color:#100b26;font:700 16px system-ui;cursor:pointer';
    // Keep the app's nodes: modules may bind their DOM before init sees the callback flag.
    for(const child of [...document.body.children]) {
      if(!['SCRIPT','STYLE','LINK'].includes(child.tagName)){child.hidden=true;child.style.display='none';}
    }
    panel.append(brand,title,description,button);document.body.append(panel);
    document.body.style.cssText='margin:0;padding:20px;background:#100b26;min-height:100vh;box-sizing:border-box';
    update();window.dispatchEvent(new Event('peragym:app-ready'));
  }
  function stop() {clearTimeout(deadline);window.removeEventListener('message',onMessage);}
  function onMessage(event) {
    if(event.origin!==callback.origin||event.source!==opener||event.data?.type!==ACK||event.data.state!==state)return;
    stop();mode='acknowledged';
    try{window.sessionStorage.removeItem(PENDING);}catch{}
    update();
    try{window.close();}catch{}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render,{once:true});else render();
  if(mode==='waiting') {
    window.addEventListener('message',onMessage);
    deadline=setTimeout(()=>{stop();mode='fallback';update();},5000);
    try{opener.postMessage({type:CALLBACK,callbackUrl},callback.origin);}
    catch{stop();mode='fallback';update();}
  }
})();
