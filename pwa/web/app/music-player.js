import {makeEmbedUrl} from './music-links.js?v=3.2.0';

let apiPromise;
function youtubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const previous = window.onYouTubeIframeAPIReady;
    const timeout = setTimeout(() => reject(new Error('API indisponível')), 15000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {clearTimeout(timeout); reject(new Error('API indisponível'));};
    document.head.append(script);
  }).catch(error => {apiPromise = undefined; throw error;});
  return apiPromise;
}

export function createMusicPlayer(mount) {
  const status = mount.querySelector('[data-music-status]');
  const host = mount.querySelector('[data-music-frame]');
  const source = mount.querySelector('[data-music-source]');
  let player, media, ready = false, generation = 0, stallTimer;
  const setStatus = message => {status.textContent = message;};
  const fits = () => window.innerHeight >= 220 && window.innerWidth >= (window.innerHeight <= 440 ? 306 : 240);
  const obscured = () => document.hidden || !!document.querySelector('dialog[open]');
  function destroyFrame() {
    generation++; clearTimeout(stallTimer);
    try {player?.destroy();} catch (_) { /* Removing the iframe stops playback too. */ }
    player = undefined; ready = false; host.replaceChildren();
  }
  function close() {
    destroyFrame(); media = undefined; mount.hidden = true;
    document.body.classList.remove('music-active');
  }
  function pause() {
    if (!media) return;
    if (ready) {
      try {player.pauseVideo(); setStatus('Pausado. Toque no play para continuar.');} catch (_) {close();}
    } else close();
  }
  async function load(next) {
    if (!fits()) throw new Error('Aumente a janela para exibir o player do YouTube.');
    if (!navigator.onLine) throw new Error('Conecte-se à internet para ouvir música.');
    destroyFrame(); media = next; mount.hidden = false;
    document.body.classList.add('music-active');
    source.href = next.url;
    setStatus('Toque no play do YouTube para ouvir.');
    const iframe = document.createElement('iframe');
    iframe.id = 'youtube-player'; iframe.title = 'Player oficial do YouTube';
    iframe.width = '360'; iframe.height = '203';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allow = 'autoplay; encrypted-media; fullscreen';
    iframe.allowFullscreen = true;
    iframe.src = makeEmbedUrl(next, location.origin);
    host.replaceChildren(iframe);
    const current = generation;
    try {
      const YT = await youtubeApi();
      if (current !== generation || !iframe.isConnected) return;
      if (obscured()) {close(); return;}
      player = new YT.Player(iframe, {events: {
        onReady: () => {
          if (current !== generation) return;
          ready = true;
          if (obscured()) pause();
        },
        onStateChange: event => {
          if (current !== generation) return;
          if (event.data === 1 && obscured()) {pause(); return;}
          clearTimeout(stallTimer);
          if(event.data === 3)stallTimer=setTimeout(()=>{if(current===generation)setStatus('O YouTube está demorando para carregar. Tente abrir pelo link abaixo.');},12000);
          const messages = {1:'Reproduzindo no YouTube.',2:'Pausado.',0:'Reprodução encerrada.',3:'Carregando música...'};
          if (messages[event.data]) setStatus(messages[event.data]);
        },
        onError: event => {
          if (current !== generation) return;
          clearTimeout(stallTimer);
          const messages = {2:'Link inválido. Cole outro link.',5:'O navegador não conseguiu reproduzir este vídeo.',100:'Música privada, removida ou indisponível.',101:'O autor permite ouvir apenas no YouTube.',150:'O autor permite ouvir apenas no YouTube.',153:'O YouTube não autorizou o player neste navegador.'};
          setStatus((messages[event.data] || 'O YouTube não conseguiu reproduzir este conteúdo.') + ' Use “Abrir no YouTube Music” abaixo.');
        },
        onAutoplayBlocked: () => {if(current === generation)setStatus('Toque no play do YouTube para ouvir.');}
      }});
    } catch (_) {
      // The iframe keeps its native controls if the optional control API fails.
      if (current === generation) setStatus('Use os controles do YouTube. Se não abrir, toque no link abaixo.');
    }
  }
  mount.querySelector('[data-music-close]').onclick = close;
  window.addEventListener('resize', () => {if(media && !fits())close();});
  document.addEventListener('visibilitychange', () => {if (document.hidden) pause();});
  let modalOpen = false;
  new MutationObserver(() => {
    const open = !!document.querySelector('dialog[open]');
    const justOpened = open && !modalOpen; modalOpen = open;
    if (justOpened) pause();
  }).observe(document.body, {subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  return {load, close};
}
