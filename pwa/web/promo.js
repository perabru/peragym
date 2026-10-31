'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const THEME_KEY = 'peragym-promo-theme-v1';
  const PIX_KEY = 'bruno.pera@unifesp.br';
  let donation = null, loading = null, toastHandle = null;

  function setTheme(dark, persist = true) {
    document.body.classList.toggle('dark', dark);
    $('#theme-toggle').setAttribute('aria-checked', String(dark));
    $('#theme-toggle').setAttribute('aria-label', dark ? 'Ativar tema claro' : 'Ativar tema escuro');
    $('meta[name="theme-color"]').content = dark ? '#211c26' : '#fff8f1';
    if (persist) try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (_) {}
  }
  try {
    const theme = localStorage.getItem(THEME_KEY);
    setTheme(theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches, false);
  } catch (_) { setTheme(false, false); }
  $('#theme-toggle').addEventListener('click', () => setTheme(!document.body.classList.contains('dark')));
  $('#year').textContent = new Date().getFullYear();

  function announce(text) {
    const modal = $('#donation-dialog');
    if (modal.open) {
      $('#donation-message').textContent = text;
      $('#donation-message').hidden = false;
      return;
    }
    $('#toast').textContent = text;
    $('#toast').classList.add('visible');
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
  }

  function showDonation(value) {
    const payload = typeof value.pixPayload === 'string' ? value.pixPayload : '';
    $('#pix-key').textContent = PIX_KEY;
    $('#pix-payload').value = payload;
    $('#pix-payload-label').hidden = !payload;
    $('#copy-pix').hidden = !payload;
    const qr = $('#qr-container');
    qr.replaceChildren();
    if (typeof value.qrDataUrl === 'string' && /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value.qrDataUrl)) {
      const image = new Image();
      image.src = value.qrDataUrl;
      image.alt = 'QR Code Pix para doação opcional de R$ 1,99 ao PeraGym';
      qr.append(image);
    } else {
      const text = document.createElement('p');
      text.textContent = payload ? 'Use o código Pix abaixo se quiser apoiar.' : 'Se quiser apoiar, copie a chave Pix abaixo.';
      qr.append(text);
    }
    // Navigation is intentionally independent of any donation status or amount.
    $('#install-free').href = '/app/?instalar=1';
    $('#open-free-app').href = '/app/';
  }

  async function loadDonation() {
    if (donation) { showDonation(donation); return; }
    if (loading) return loading;
    loading = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/donation', {credentials:'same-origin', cache:'no-store', headers:{Accept:'application/json'}, signal:controller.signal});
        if (!response.ok) throw new Error('Pix indisponível');
        const value = await response.json();
        if (value.optional !== true || value.amountCents !== 199 || value.pixKey !== PIX_KEY) throw new Error('Dados do Pix inválidos');
        donation = value;
        showDonation(value);
      } catch (_) {
        // A Pix service outage must never prevent free installation.
        showDonation({pixKey:PIX_KEY});
        announce('Os dados completos do Pix não carregaram. Você pode copiar a chave se quiser doar ou continuar gratuitamente.');
      } finally { clearTimeout(timeout); loading = null; }
    })();
    return loading;
  }

  function offerDonation() {
    $('#donation-message').hidden = true;
    const dialog = $('#donation-dialog');
    if (!dialog.open) dialog.showModal();
    loadDonation();
  }
  $$('[data-install-free], [data-donation]').forEach(button => button.addEventListener('click', offerDonation));
  $('#close-donation').addEventListener('click', () => $('#donation-dialog').close());

  async function copy(text, success) {
    try { await navigator.clipboard.writeText(text); announce(success); }
    catch (_) { announce('Não foi possível copiar automaticamente. Selecione e copie o texto exibido. A instalação gratuita continua disponível.'); }
  }
  $('#copy-pix').addEventListener('click', () => copy($('#pix-payload').value, 'Código Pix copiado. A doação é opcional; você já pode continuar gratuitamente.'));
  $('#copy-key').addEventListener('click', () => copy(PIX_KEY, 'Chave Pix copiada. Doar é opcional e não altera o acesso gratuito ao aplicativo.'));
})();
