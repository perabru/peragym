'use strict';

// Independent of the module graph: a failed app import must not leave a spinner
// covering the recovery actions. No database or cache is changed here.
(() => {
  window.__peragymBootManaged = true;
  const started = Date.now();
  const MINIMUM_LOADING = 850;
  const STARTUP_TIMEOUT = 12000;
  let ready = false, failed = false, visible = false, mounted = false, domReady = document.readyState !== 'loading';
  let revealTimer, removalTimer, failureMessage='Tente novamente. Seus dados continuam salvos neste aparelho.';
  const find = id => document.getElementById(id);
  const timeout = setTimeout(() => fail(), STARTUP_TIMEOUT);

  function showFailure() {
    if (!domReady || visible) return;
    const loading = find('loading'), recovery = find('loading-recovery');
    if (loading) { loading.classList.add('loading-failed'); loading.setAttribute('aria-busy', 'false'); }
    const status = find('loading-status');
    if (status) status.textContent = 'Não foi possível abrir o PeraGym.';
    const message = find('loading-error-message');
    if (message) message.textContent = failureMessage;
    if (recovery) recovery.hidden = false;
  }

  function fail(event) {
    if(typeof event?.detail?.message==='string')failureMessage=event.detail.message.slice(0,220);
    if (ready || visible) return;
    failed = true;
    clearTimeout(timeout);
    clearTimeout(revealTimer);
    showFailure();
  }

  function reveal() {
    if (!domReady || !ready || visible) return;
    const remaining = MINIMUM_LOADING - (Date.now() - started);
    if (remaining > 0) { clearTimeout(revealTimer); revealTimer = setTimeout(reveal, remaining); return; }
    visible = true; failed = false;
    const app = find('app'), loading = find('loading'), recovery = find('loading-recovery');
    if (app) app.hidden = false;
    if (recovery) recovery.hidden = true;
    if (loading) {
      loading.classList.remove('loading-failed'); loading.classList.add('fade');
      loading.setAttribute('aria-busy', 'false');
      removalTimer = setTimeout(() => loading.remove(), 300);
    }
    window.dispatchEvent(new CustomEvent('peragym:app-visible'));
  }

  function mount() {
    if (mounted || !find('loading') || !find('app')) return;
    mounted = true; domReady = true;
    const retry = find('loading-retry');
    retry?.addEventListener('click', () => { clearTimeout(removalTimer); window.location.reload(); });
    if (ready) reveal(); else if (failed) showFailure();
  }

  window.addEventListener('peragym:app-ready', () => {
    ready = true; clearTimeout(timeout);
    if (!domReady && find('loading') && find('app')) mount();
    reveal();
  });
  window.addEventListener('peragym:app-error', fail);
  window.addEventListener('error', event => {
    if (ready || visible) return;
    const resource = event.target?.src || event.filename || '';
    if (/(?:^|\/)app\/(?:app|db|charts|music-links|music-player|local-account|local-auth-ui|local-biometric|youtube-account|spotify-account|spotify-playback)\.js(?:[?#]|$)/.test(resource)) fail();
  }, true);
  window.addEventListener('unhandledrejection', () => { if (!ready && !visible) fail(); });
  document.addEventListener('readystatechange', () => { if (document.readyState !== 'loading') mount(); });
  if (domReady) mount(); else document.addEventListener('DOMContentLoaded', mount, {once: true});
})();
