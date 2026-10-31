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

  if (!document.querySelector('link[href="/pwa.css"]')) {
    const styles = document.createElement('link');
    styles.rel = 'stylesheet';styles.href = '/pwa.css';document.head.append(styles);
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
    const title = document.createElement('h2');title.id = 'pwa-guide-title';title.textContent = ios ? 'PeraGym no seu iPhone' : android ? 'PeraGym no seu Android' : 'PeraGym sempre por perto';
    const intro = document.createElement('p');intro.textContent = iosOtherBrowser ? 'Abra este endereço no Safari para adicionar o PeraGym à sua Tela de Início.' : ios ? 'No Safari, são três passos. Não é necessário baixar pela App Store.' : 'Instale pelo navegador para abrir o aplicativo direto da sua tela inicial.';
    const list = document.createElement('ol');
    const steps = ios ? ['Abra o menu Compartilhar do Safari (quadrado com uma seta para cima).','Toque em “Adicionar à Tela de Início”. Se necessário, role a lista de ações.','Confirme o nome PeraGym e toque em “Adicionar”.'] : android ? ['Abra o menu ⋮ do Chrome neste endereço.','Toque em “Instalar aplicativo” ou “Adicionar à tela inicial”.','Confirme em “Instalar” e abra pelo ícone PeraGym.'] : ['Abra este endereço no Chrome ou Edge.','Use o ícone de instalação na barra de endereço ou o menu do navegador.','Confirme a instalação e abra o PeraGym pelo novo ícone.'];
    steps.forEach(text => {const item=document.createElement('li');item.textContent=text;list.append(item);});
    const note = document.createElement('p');note.className='pwa-guide-note';note.setAttribute('role','status');note.textContent='Na primeira abertura, mantenha a internet conectada para preparar o uso offline. Seus treinos e medidas ficam neste aparelho.';
    const recovery = document.createElement('p');recovery.className='pwa-guide-note';recovery.textContent=ios ? 'Guarde o arquivo de acesso do seu pedido. No iPhone, o aplicativo instalado pode solicitar a recuperação da compra. Comece seus registros pelo ícone instalado e faça um backup antes de trocar de navegador ou aparelho.' : 'Guarde o arquivo de acesso do seu pedido e faça um backup local antes de trocar de navegador ou aparelho.';
    const actions=document.createElement('div');actions.className='pwa-guide-actions';
    if (iosOtherBrowser) {
      const copy=document.createElement('button');copy.type='button';copy.className='pwa-guide-secondary';copy.textContent='Copiar endereço';copy.addEventListener('click', async()=>{try{await navigator.clipboard.writeText(new URL('/app/',location.origin).href);note.textContent='Endereço copiado. Abra o Safari e cole na barra de endereço.';}catch(_){note.textContent=`Abra o Safari e acesse ${new URL('/app/',location.origin).href}`;}});actions.append(copy);
    }
    const close=document.createElement('button');close.type='button';close.className='pwa-guide-primary';close.textContent='Entendi';close.addEventListener('click',()=>guide.close());actions.append(close);
    guide.append(title,intro,list,note,recovery,actions);guide.addEventListener('close',()=>{guide?.remove();guide=undefined;});document.body.append(guide);guide.showModal();
  }

  async function install() {
    if (!inApp) {location.assign('/app/');return;}
    if (standalone()) {announce('O PeraGym já está aberto como aplicativo.');return;}
    if (installPrompt) {
      const prompt=installPrompt;installPrompt=undefined;
      try {await prompt.prompt();const choice=await prompt.userChoice;if(choice.outcome==='accepted')announce('Confirme a instalação no seu aparelho.');}catch(_){openGuide();}
      return;
    }
    openGuide();
  }

  function offerUpdate(worker) {
    if (!inApp || updateShown || !worker) return;
    updateShown=true;
    const banner=document.createElement('aside');banner.className='pwa-update';banner.setAttribute('aria-label','Atualização do aplicativo');
    const text=document.createElement('p');text.textContent='Uma nova versão do PeraGym está pronta. Salve a ficha em edição antes de atualizar.';
    const actions=document.createElement('div');
    const later=document.createElement('button');later.type='button';later.className='pwa-guide-secondary';later.textContent='Depois';later.addEventListener('click',()=>banner.remove());
    const update=document.createElement('button');update.type='button';update.className='pwa-guide-primary';update.textContent='Atualizar agora';update.addEventListener('click',()=>{reloadAfterUpdate=true;worker.postMessage({type:'PERAGYM_SKIP_WAITING'});banner.remove();});
    actions.append(later,update);banner.append(text,actions);document.body.append(banner);
  }

  function prepareOffline() {
    if (!inApp || !registration?.active) return;
    registration.active.postMessage({type:'PERAGYM_PREPARE_OFFLINE'});
  }

  window.addEventListener('beforeinstallprompt', event=>{event.preventDefault();installPrompt=event;updateButtons();});
  window.addEventListener('appinstalled',()=>{installPrompt=undefined;updateButtons();announce('PeraGym instalado. Bom treino!');});
  window.addEventListener('peragym:install',install);
  document.addEventListener('click',event=>{const button=event.target.closest?.('[data-install]');if(button){event.preventDefault();install();}});
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change',updateButtons);
  const observer=new MutationObserver(updateButtons);

  async function boot() {
    updateButtons();observer.observe(document.body,{childList:true,subtree:true});
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
      await navigator.serviceWorker.ready;
      prepareOffline();
      if(registration.waiting)offerUpdate(registration.waiting);
      registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)offerUpdate(worker);});});
      window.addEventListener('online',()=>{prepareOffline();registration.update().catch(()=>{});});
      navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloadAfterUpdate){reloadAfterUpdate=false;location.reload();}else prepareOffline();});
      navigator.serviceWorker.addEventListener('message',event=>{
        if(event.data?.type==='PERAGYM_OFFLINE_READY'){
          document.querySelectorAll('[data-offline-status]').forEach(item=>{item.textContent='Pronto para usar offline';});
          window.dispatchEvent(new CustomEvent('peragym:offline-ready'));
        }
        if(event.data?.type==='PERAGYM_LICENSE_REQUIRED'&&inApp&&navigator.onLine){announce('Conecte seu acesso de compra para continuar. Seus dados locais foram mantidos.');window.dispatchEvent(new CustomEvent('peragym:license-required'));}
      });
    } catch (_) {
      // The online app still works; install instructions remain available.
      window.dispatchEvent(new CustomEvent('peragym:offline-unavailable'));
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
