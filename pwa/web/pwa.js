'use strict';

(() => {
  const inApp = location.pathname === '/app' || location.pathname.startsWith('/app/');
  const SESSION_KEY = 'peragym-installed-session-v1';
  let installPrompt, registration, guide;
  let reloadAfterUpdate = false, updateShown = false, installBusy = false, installedThisSession = false;
  let installRequested = new URLSearchParams(location.search).get('instalar') === '1';
  try { installedThisSession = sessionStorage.getItem(SESSION_KEY) === '1'; } catch (_) {}
  const standalone = () => ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some(mode => window.matchMedia(`(display-mode: ${mode})`).matches) || window.navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(navigator.userAgent);
  const iosOtherBrowser = ios && /CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);

  if (!document.querySelector('link[href^="/pwa.css"]')) {
    const styles = document.createElement('link');
    styles.rel = 'stylesheet'; styles.href = '/pwa.css?v=3.6.0'; document.head.append(styles);
  }

  function setInstalledSession(value) {
    installedThisSession = value;
    try { if (value) sessionStorage.setItem(SESSION_KEY, '1'); else sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  function updateButtons() {
    const installed = standalone() || installedThisSession;
    document.querySelectorAll('[data-install]').forEach(button => {
      const help = button.hasAttribute('data-install-help');
      button.hidden = !inApp || (!help && installed);
      button.disabled = installBusy && !help;
      button.setAttribute('aria-label', help && installed ? 'Ajuda de instalação do PeraGym' : 'Instalar o PeraGym neste aparelho');
      const label = button.querySelector('[data-install-label]');
      if (label) {
        const text = help && installed ? 'Ajuda de instalação' : help ? 'Instalar aplicativo' : 'Instalar';
        if (label.textContent !== text) label.textContent = text;
      }
    });
  }

  function announce(message) {
    let region = document.getElementById('pwa-announcement');
    if (!region) {
      region = document.createElement('div'); region.id = 'pwa-announcement'; region.className = 'pwa-announcement'; region.setAttribute('role', 'status'); region.setAttribute('aria-live', 'polite'); document.body.append(region);
    }
    region.textContent = message; region.classList.add('is-visible');
    setTimeout(() => region.classList.remove('is-visible'), 5000);
  }

  function refreshGuidePrompt() {
    const action = guide?.querySelector('[data-native-install]');
    if (action) action.hidden = !installPrompt || standalone() || installedThisSession || installBusy;
  }

  function openGuide() {
    guide?.remove();
    guide = document.createElement('dialog'); guide.className = 'pwa-guide'; guide.setAttribute('aria-labelledby', 'pwa-guide-title');
    const tape = document.createElement('img'); tape.className = 'pwa-guide-tape'; tape.src = '/assets/cassette.svg'; tape.alt = ''; tape.width = 100; tape.height = 66;
    const kicker = document.createElement('span'); kicker.className = 'pwa-guide-kicker'; kicker.textContent = 'INSTALAR APLICATIVO';
    const title = document.createElement('h2'); title.id = 'pwa-guide-title'; title.textContent = standalone() || installedThisSession ? 'Ajuda de instalação' : ios ? 'Instalar no iPhone' : android ? 'Instalar no Android' : 'Instalar PeraGym';
    const intro = document.createElement('p'); intro.textContent = standalone() ? 'O PeraGym já está aberto como aplicativo. Para instalar novamente, abra este endereço no navegador.' : installedThisSession ? 'A instalação foi confirmada nesta aba. Abra o PeraGym pelo ícone do aparelho. Se precisar reinstalar, siga os passos abaixo.' : iosOtherBrowser ? 'Use o menu Compartilhar ou abra este endereço no Safari.' : ios ? 'No Safari, siga os passos abaixo.' : 'Adicione o PeraGym à tela inicial pelo navegador.';
    const list = document.createElement('ol');
    const steps = ios ? ['No Safari, abra Compartilhar (ícone com seta para cima). Em algumas versões, ele fica no menu Mais.', 'Toque em “Adicionar à Tela de Início”. Se necessário, role a lista de ações.', 'Se aparecer “Abrir como App”, mantenha ativado e confirme em “Adicionar”.'] : android ? ['No Chrome, abra o menu ⋮.', 'Toque em “Instalar aplicativo” ou “Adicionar à tela inicial”.', 'Confirme em “Instalar” e abra pelo ícone PeraGym.'] : ['Abra este endereço no Chrome ou Edge.', 'Use o ícone de instalação na barra de endereço ou o menu do navegador.', 'Confirme a instalação e abra o PeraGym pelo novo ícone.'];
    steps.forEach(text => { const item = document.createElement('li'); item.textContent = text; list.append(item); });
    const note = document.createElement('p'); note.className = 'pwa-guide-note'; note.setAttribute('role', 'status'); note.textContent = 'Conecte-se na primeira abertura para preparar o uso offline. Seus dados ficam no aparelho.';
    const storageNote = document.createElement('p'); storageNote.className = 'pwa-guide-note'; storageNote.textContent = ios ? 'Comece os registros pelo ícone instalado. Safari e o aplicativo podem manter bancos locais separados. Faça backup antes de trocar de aparelho.' : 'Faça um backup antes de trocar de navegador ou aparelho.';
    const actions = document.createElement('div'); actions.className = 'pwa-guide-actions';
    if (iosOtherBrowser) {
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'pwa-guide-secondary'; copy.textContent = 'Copiar endereço';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(new URL('/app/', location.origin).href); note.textContent = 'Endereço copiado. Abra o Safari e cole na barra de endereço.'; }
        catch (_) { note.textContent = `Abra o Safari e acesse ${new URL('/app/', location.origin).href}`; }
      }); actions.append(copy);
    }
    const panel = guide;
    const native = document.createElement('button'); native.type = 'button'; native.className = 'pwa-guide-primary'; native.textContent = 'Instalar agora'; native.setAttribute('data-native-install', '');
    native.addEventListener('click', () => { panel.close(); install(); }); actions.append(native);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'pwa-guide-secondary'; close.textContent = 'Fechar'; close.addEventListener('click', () => panel.close()); actions.append(close);
    guide.append(tape, kicker, title, intro, list, note, storageNote, actions);
    guide.addEventListener('close', () => { panel.remove(); if (guide === panel) guide = undefined; });
    document.body.append(guide); refreshGuidePrompt(); guide.showModal();
  }

  function maybeAutoGuide() {
    if (!inApp || !installRequested) return;
    const app = document.getElementById('app');
    if (!app || app.hidden) return;
    installRequested = false;
    try { const url = new URL(location.href); url.searchParams.delete('instalar'); history.replaceState(history.state, '', url.href); } catch (_) {}
    if (!standalone() && !installedThisSession) openGuide();
  }

  async function install() {
    if (!inApp) { location.assign('/app/?instalar=1'); return; }
    if (standalone() || installedThisSession) { openGuide(); return; }
    if (installBusy) return;
    if (!installPrompt) { openGuide(); return; }
    const prompt = installPrompt; installPrompt = undefined; installBusy = true; updateButtons(); refreshGuidePrompt();
    try {
      // Only this click-driven path invokes the browser's native prompt. The
      // ?instalar=1 entry opens instructions without spending user activation.
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') announce('Instalação solicitada. Abra pelo ícone quando estiver pronta.');
      else openGuide();
    } catch (_) { openGuide(); }
    finally { installBusy = false; updateButtons(); refreshGuidePrompt(); }
  }

  function offerUpdate(worker) {
    if (!inApp || updateShown || !worker) return;
    updateShown = true;
    const banner = document.createElement('aside'); banner.className = 'pwa-update'; banner.setAttribute('aria-label', 'Atualização do aplicativo');
    const tape = document.createElement('img'); tape.className = 'pwa-update-tape'; tape.src = '/assets/cassette.svg'; tape.alt = ''; tape.width = 58; tape.height = 39;
    const title = document.createElement('h3'); title.textContent = 'Atualização disponível.';
    const text = document.createElement('p'); text.textContent = 'Salve a ficha em edição antes de atualizar.';
    const actions = document.createElement('div');
    const later = document.createElement('button'); later.type = 'button'; later.className = 'pwa-guide-secondary'; later.textContent = 'Depois'; later.addEventListener('click', () => banner.remove());
    const update = document.createElement('button'); update.type = 'button'; update.className = 'pwa-guide-primary'; update.textContent = 'Atualizar agora'; update.addEventListener('click', () => { reloadAfterUpdate = true; worker.postMessage({type: 'PERAGYM_SKIP_WAITING'}); banner.remove(); });
    actions.append(later, update); banner.append(tape, title, text, actions); document.body.append(banner);
  }

  function prepareOffline() {
    if (!inApp || !registration?.active) return;
    registration.active.postMessage({type: 'PERAGYM_PREPARE_OFFLINE'});
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event; setInstalledSession(false); updateButtons(); refreshGuidePrompt();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined; setInstalledSession(true); updateButtons(); refreshGuidePrompt(); announce('PeraGym instalado. Abra pelo ícone do aparelho.');
  });
  window.addEventListener('peragym:install', install);
  window.addEventListener('peragym:app-visible', maybeAutoGuide);
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-install]');
    if (button) { event.preventDefault(); if (button.hasAttribute('data-install-help') && (standalone() || installedThisSession)) openGuide(); else install(); }
  });
  const standaloneMedia = window.matchMedia('(display-mode: standalone)');
  if (standaloneMedia.addEventListener) standaloneMedia.addEventListener('change', updateButtons);
  else standaloneMedia.addListener?.(updateButtons);
  window.addEventListener('pageshow', updateButtons);
  const observer = new MutationObserver(updateButtons);

  async function boot() {
    updateButtons(); observer.observe(document.body, {childList: true, subtree: true}); maybeAutoGuide();
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    // Register listeners before asking the worker to prepare its cache. A fast
    // worker can answer before a later listener has been attached.
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'PERAGYM_OFFLINE_READY') {
        document.querySelectorAll('[data-offline-status]').forEach(item => { item.textContent = 'Disponível offline'; });
        window.dispatchEvent(new CustomEvent('peragym:offline-ready'));
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadAfterUpdate) { reloadAfterUpdate = false; location.reload(); } else prepareOffline();
    });
    window.addEventListener('online', () => { prepareOffline(); registration?.update().catch(() => {}); });
    try {
      registration = await navigator.serviceWorker.register('/sw.js?v=3.6.0', {scope: '/'});
      const readyTimeout = setTimeout(() => window.dispatchEvent(new CustomEvent('peragym:offline-unavailable')), 10000);
      navigator.serviceWorker.ready.then(active => {
        clearTimeout(readyTimeout); registration = active; prepareOffline();
        if (registration.waiting) offerUpdate(registration.waiting);
      }).catch(() => { clearTimeout(readyTimeout); window.dispatchEvent(new CustomEvent('peragym:offline-unavailable')); });
      if (registration.waiting) offerUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker); });
      });
    } catch (_) {
      window.dispatchEvent(new CustomEvent('peragym:offline-unavailable'));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true}); else boot();
})();
