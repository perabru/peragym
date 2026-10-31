'use strict';

(() => {
  const inApp = location.pathname === '/app' || location.pathname.startsWith('/app/');
  let installPrompt;
  let registration;
  let reloadAfterUpdate = false;
  let guide;
  let updateShown = false;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(navigator.userAgent);
  const iosOtherBrowser = ios && /CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);

  if (!document.querySelector('link[href^="/pwa.css"]')) {
    const styles = document.createElement('link');
    styles.rel = 'stylesheet';styles.href = '/pwa.css?v=3.2.0';document.head.append(styles);
  }

  function updateButtons() {
    document.querySelectorAll('[data-install]').forEach(button => {
      button.hidden = !inApp || standalone();
      if (!button.hidden) button.setAttribute('aria-label', 'Instalar o PeraGym neste aparelho');
    });
  }

  function announce(message) {
    let region = document.getElementById('pwa-announcement');
    if (!region) {
      region = document.createElement('div');region.id = 'pwa-announcement';region.className = 'pwa-announcement';region.setAttribute('role','status');region.setAttribute('aria-live','polite');document.body.append(region);
    }
    region.textContent = message;
    region.classList.add('is-visible');
    setTimeout(() => region.classList.remove('is-visible'), 5000);
  }

  function openGuide() {
    guide?.remove();
    guide = document.createElement('dialog');guide.className = 'pwa-guide';guide.setAttribute('aria-labelledby','pwa-guide-title');
    const tape = document.createElement('img');tape.className='pwa-guide-tape';tape.src='/assets/cassette.svg';tape.alt='';tape.width=100;tape.height=66;
    const kicker = document.createElement('span');kicker.className='pwa-guide-kicker';kicker.textContent='INSTALAR APLICATIVO';
    const title = document.createElement('h2');title.id = 'pwa-guide-title';title.textContent = ios ? 'Instalar no iPhone' : android ? 'Instalar no Android' : 'Instalar PeraGym';
    const intro = document.createElement('p');intro.textContent = iosOtherBrowser ? 'Abra este endereço no Safari para instalar o PeraGym.' : ios ? 'No Safari, siga os passos abaixo.' : 'Adicione o PeraGym à tela inicial pelo navegador.';
    const list = document.createElement('ol');
    const steps = ios ? ['No Safari, toque em Compartilhar (quadrado com seta para cima).','Toque em “Adicionar à Tela de Início”. Se necessário, role a lista de ações.','Confirme em “Adicionar”.'] : android ? ['No Chrome, abra o menu ⋮.','Toque em “Instalar aplicativo” ou “Adicionar à tela inicial”.','Confirme em “Instalar” e abra pelo ícone PeraGym.'] : ['Abra este endereço no Chrome ou Edge.','Use o ícone de instalação na barra de endereço ou o menu do navegador.','Confirme a instalação e abra o PeraGym pelo novo ícone.'];
    steps.forEach(text => {const item=document.createElement('li');item.textContent=text;list.append(item);});
    const note = document.createElement('p');note.className='pwa-guide-note';note.setAttribute('role','status');note.textContent='Conecte-se na primeira abertura para preparar o uso offline. Treinos e medidas ficam neste aparelho.';
    const storageNote = document.createElement('p');storageNote.className='pwa-guide-note';storageNote.textContent=ios ? 'Comece os registros pelo ícone instalado. O Safari e o aplicativo podem manter bancos locais separados. Faça um backup antes de trocar de navegador ou aparelho.' : 'O PeraGym é gratuito. Faça um backup antes de trocar de navegador ou aparelho.';
    const actions=document.createElement('div');actions.className='pwa-guide-actions';
    if (iosOtherBrowser) {
      const copy=document.createElement('button');copy.type='button';copy.className='pwa-guide-secondary';copy.textContent='Copiar endereço';copy.addEventListener('click', async()=>{try{await navigator.clipboard.writeText(new URL('/app/',location.origin).href);note.textContent='Endereço copiado. Abra o Safari e cole na barra de endereço.';}catch(_){note.textContent=`Abra o Safari e acesse ${new URL('/app/',location.origin).href}`;}});actions.append(copy);
    }
    const panel=guide;
    const close=document.createElement('button');close.type='button';close.className='pwa-guide-primary';close.textContent='Fechar';close.addEventListener('click',()=>panel.close());actions.append(close);
    guide.append(tape,kicker,title,intro,list,note,storageNote,actions);guide.addEventListener('close',()=>{panel.remove();if(guide===panel)guide=undefined;});document.body.append(guide);guide.showModal();
  }

  async function install() {
    if (!inApp) {location.assign('/app/');return;}
    if (standalone()) {announce('O PeraGym já está aberto como aplicativo.');return;}
    if (installPrompt) {
      const prompt=installPrompt;installPrompt=undefined;
      try {await prompt.prompt();const choice=await prompt.userChoice;if(choice.outcome==='accepted')announce('Confirme a instalação no aparelho.');}catch(_){openGuide();}
      return;
    }
    openGuide();
  }

  function offerUpdate(worker) {
    if (!inApp || updateShown || !worker) return;
    updateShown=true;
    const banner=document.createElement('aside');banner.className='pwa-update';banner.setAttribute('aria-label','Atualização do aplicativo');
    const tape=document.createElement('img');tape.className='pwa-update-tape';tape.src='/assets/cassette.svg';tape.alt='';tape.width=58;tape.height=39;
    const title=document.createElement('h3');title.textContent='Atualização disponível.';
    const text=document.createElement('p');text.textContent='Salve a ficha em edição antes de atualizar.';
    const actions=document.createElement('div');
    const later=document.createElement('button');later.type='button';later.className='pwa-guide-secondary';later.textContent='Depois';later.addEventListener('click',()=>banner.remove());
    const update=document.createElement('button');update.type='button';update.className='pwa-guide-primary';update.textContent='Atualizar agora';update.addEventListener('click',()=>{reloadAfterUpdate=true;worker.postMessage({type:'PERAGYM_SKIP_WAITING'});banner.remove();});
    actions.append(later,update);banner.append(tape,title,text,actions);document.body.append(banner);
  }

  function prepareOffline() {
    if (!inApp || !registration?.active) return;
    registration.active.postMessage({type:'PERAGYM_PREPARE_OFFLINE'});
  }

  window.addEventListener('beforeinstallprompt', event=>{event.preventDefault();installPrompt=event;updateButtons();});
  window.addEventListener('appinstalled',()=>{installPrompt=undefined;updateButtons();announce('PeraGym instalado.');});
  window.addEventListener('peragym:install',install);
  document.addEventListener('click',event=>{const button=event.target.closest?.('[data-install]');if(button){event.preventDefault();install();}});
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change',updateButtons);
  const observer=new MutationObserver(updateButtons);

  async function boot() {
    updateButtons();observer.observe(document.body,{childList:true,subtree:true});
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      registration=await navigator.serviceWorker.register('/sw.js?v=3.2.0',{scope:'/'});
      await navigator.serviceWorker.ready;
      prepareOffline();
      if(registration.waiting)offerUpdate(registration.waiting);
      registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)offerUpdate(worker);});});
      window.addEventListener('online',()=>{prepareOffline();registration.update().catch(()=>{});});
      navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloadAfterUpdate){reloadAfterUpdate=false;location.reload();}else prepareOffline();});
      navigator.serviceWorker.addEventListener('message',event=>{
        if(event.data?.type==='PERAGYM_OFFLINE_READY'){
          document.querySelectorAll('[data-offline-status]').forEach(item=>{item.textContent='Disponível offline';});
          window.dispatchEvent(new CustomEvent('peragym:offline-ready'));
        }
      });
    } catch (_) {
      // The online app still works; install instructions remain available.
      window.dispatchEvent(new CustomEvent('peragym:offline-unavailable'));
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
