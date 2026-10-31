/** Official Spotify SDK transport. Tokens are requested when needed and never persisted here.
 * Reference: https://developer.spotify.com/documentation/web-playback-sdk/reference
 * Reference: https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
 */
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const API_URL = 'https://api.spotify.com/v1/me/player/play';
const TIMEOUT_MS = 12000;
const EMPTY_STATE = {paused:true, position:0, duration:0, title:'', artist:'', image:'', canSeek:false, ready:false};
const cancelled = () => Object.assign(new Error('A conexão com o Spotify foi encerrada.'), {code:'SPOTIFY_CANCELLED'});
const errorMessage = {
  authentication_error:'Sua sessão do Spotify não foi aceita. Conecte sua conta novamente.',
  account_error:'A reprodução no aplicativo exige uma conta Spotify Premium autorizada para este aplicativo.',
  initialization_error:'Este navegador não oferece a reprodução protegida necessária para o Spotify. Use um navegador atualizado.',
  playback_error:'O Spotify não conseguiu reproduzir esta música. Tente outra faixa ou tente novamente.',
  autoplay_failed:'O navegador bloqueou o áudio. Toque em reproduzir novamente para autorizar.',
  not_ready:'O player do Spotify perdeu a conexão. Verifique sua internet e conecte novamente.'
};

function playbackBody(media) {
  if (!media || media.provider !== 'spotify' || !['track','playlist','album'].includes(media.kind)
      || typeof media.id !== 'string' || !/^[A-Za-z0-9]{22}$/.test(media.id)
      || media.uri !== `spotify:${media.kind}:${media.id}`) {
    throw new Error('Escolha uma faixa, playlist ou álbum válido do Spotify.');
  }
  return media.kind === 'track' ? {uris:[media.uri]} : {context_uri:media.uri};
}

function apiError(response) {
  if (response.status === 401) return new Error('Sua sessão do Spotify expirou. Conecte sua conta novamente.');
  if (response.status === 403) return new Error('O Spotify não autorizou a reprodução. Verifique sua conta Premium e a permissão deste aplicativo.');
  if (response.status === 404) return new Error('O dispositivo do Spotify não está disponível. Conecte o player novamente.');
  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.('Retry-After'));
    return new Error(Number.isFinite(seconds) && seconds > 0 && seconds <= 86400
      ? `O Spotify recebeu muitos pedidos. Aguarde ${Math.ceil(seconds)} segundos e tente novamente.`
      : 'O Spotify recebeu muitos pedidos. Aguarde um pouco e tente novamente.');
  }
  return new Error('O Spotify não conseguiu iniciar a reprodução. Tente novamente.');
}

/** Creating a transport performs no SDK, authentication or network request. */
export function createSpotifyPlayback({account, onState = () => {}, onError = () => {}} = {}) {
  if (!account || typeof account.getAccessToken !== 'function') throw new Error('A conexão com a conta Spotify não está disponível.');
  let generation = 0, command = 0, player = null, deviceId = null, connection = null, sdkTask = null;
  let state = {...EMPTY_STATE};
  let readyWaiter = null;
  const listeners = new Map(), requests = new Set(), reported = new WeakSet();

  function publish(next, current = generation) {
    if (current !== generation) return;
    state = {...state, ...next};
    try { onState({...state}); } catch { /* UI callbacks do not control the SDK lifetime. */ }
  }
  function report(error, current = generation) {
    if (current !== generation || error.code === 'SPOTIFY_CANCELLED' || reported.has(error)) return error;
    reported.add(error);
    try { onError(error); } catch { /* Keep cleanup reliable even when the UI unmounts. */ }
    return error;
  }
  function check(current) { if (current !== generation) throw cancelled(); }
  function abortRequests() { requests.forEach(controller => controller.abort()); requests.clear(); }
  function destroyPlayer() {
    const old = player; player = null; deviceId = null;
    listeners.forEach((listener, event) => {try {old?.removeListener(event, listener);} catch { /* Already disconnected. */ }});
    listeners.clear();
    try {old?.disconnect();} catch { /* No local session remains after removing the instance. */ }
  }
  function failConnection(error, current) {
    if (current !== generation) return;
    command++; // Also invalidate a play that is still awaiting an account token.
    const pending = readyWaiter; readyWaiter = null;
    if (pending) {clearTimeout(pending.timer); pending.reject(error);}
    connection = null;
    destroyPlayer();
    abortRequests();
    publish({paused:true, ready:false, canSeek:false}, current);
    report(error, current);
  }

  function loadSdk() {
    if (globalThis.window?.Spotify?.Player) return Promise.resolve(window.Spotify);
    if (sdkTask) return sdkTask.promise;
    if (!globalThis.window || !globalThis.document?.head) return Promise.reject(new Error('O player Spotify precisa de um navegador atualizado.'));
    let resolve, reject;
    const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
    const script = document.createElement('script');
    const previous = window.onSpotifyWebPlaybackSDKReady;
    let settled = false, timer;
    const task = {promise, cancel:() => finish(cancelled())};
    const restore = () => {
      clearTimeout(timer); script.onerror = null; script.onload = null;
      if (window.onSpotifyWebPlaybackSDKReady === ready) {
        if (previous === undefined) delete window.onSpotifyWebPlaybackSDKReady;
        else window.onSpotifyWebPlaybackSDKReady = previous;
      }
      if (sdkTask === task) sdkTask = null;
    };
    const finish = error => {
      if (settled) return;
      settled = true; restore();
      if (error) {script.remove(); reject(error);} else resolve(window.Spotify);
    };
    const ready = () => {
      if (settled) return;
      try { if (typeof previous === 'function') previous(); } catch { /* Preserve an unrelated consumer without breaking ours. */ }
      finish(window.Spotify?.Player ? null : new Error('O player oficial do Spotify não ficou disponível. Tente novamente.'));
    };
    sdkTask = task;
    window.onSpotifyWebPlaybackSDKReady = ready;
    script.src = SDK_URL; script.async = true;
    script.onerror = () => finish(new Error('Não foi possível carregar o player oficial do Spotify. Verifique a internet e tente novamente.'));
    script.onload = () => {if (window.Spotify?.Player) ready();};
    timer = setTimeout(() => finish(new Error('O player oficial do Spotify demorou para carregar. Tente novamente.')), TIMEOUT_MS);
    try {document.head.append(script);} catch {finish(new Error('O navegador não permitiu carregar o player do Spotify.'));}
    return promise;
  }

  async function accessToken(current) {
    let token;
    try {token = await account.getAccessToken();} catch {check(current); throw new Error('Não foi possível autorizar o Spotify. Conecte sua conta novamente.');}
    check(current);
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token)) throw new Error('Sua sessão do Spotify não é válida. Conecte sua conta novamente.');
    return token;
  }
  function activate(current = generation) {
    if (!player || current !== generation || typeof player.activateElement !== 'function') return;
    try {
      // Invoke synchronously on the caller's click/gesture path whenever an instance exists.
      Promise.resolve(player.activateElement()).catch(() => {
        if (current === generation && player) report(new Error(errorMessage.autoplay_failed), current);
      });
    } catch {report(new Error(errorMessage.autoplay_failed), current);}
  }
  function updateFromSdk(raw, current) {
    if (!raw) {publish({...EMPTY_STATE, ready:!!deviceId}, current); return;}
    const track = raw.track_window?.current_track;
    const finite = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    let image = '';
    try {
      const candidate = new URL(track?.album?.images?.[0]?.url);
      if (candidate.protocol === 'https:' && !candidate.username && !candidate.password
          && (candidate.hostname === 'scdn.co' || candidate.hostname.endsWith('.scdn.co'))) image = candidate.href;
    } catch { /* Missing artwork is valid; the UI shows its fallback. */ }
    publish({paused:raw.paused !== false, position:finite(raw.position), duration:finite(raw.duration),
      title:typeof track?.name === 'string' ? track.name : '',
      artist:Array.isArray(track?.artists) ? track.artists.map(a => typeof a?.name === 'string' ? a.name : '').filter(Boolean).join(', ') : '',
      image, canSeek:!raw.disallows?.seeking, ready:!!deviceId}, current);
  }

  function connect() {
    activate();
    if (player && deviceId) return Promise.resolve(deviceId);
    if (connection) return connection.promise;
    const current = ++generation;
    const pending = {promise:null}; connection = pending;
    publish({...EMPTY_STATE}, current);
    const start = async () => {
      // Avoid an await before constructing/activating an already-loaded SDK on a gesture.
      const SDK = globalThis.window?.Spotify?.Player ? window.Spotify : await loadSdk();
      check(current);
      let instance;
      try { instance = new SDK.Player({name:'PeraGym', volume:0.75, enableMediaSession:true,
        getOAuthToken: callback => {
          accessToken(current).then(token => {
            if (current === generation && player === instance) callback(token);
          }).catch(error => {if (current === generation && player === instance) failConnection(error?.code === 'SPOTIFY_CANCELLED' ? error : new Error(errorMessage.authentication_error), current);});
        }}); } catch {throw new Error(errorMessage.initialization_error);}
      player = instance;
      const listen = (event, callback) => {
        const guarded = payload => {if (current === generation && player === instance) callback(payload);};
        listeners.set(event, guarded); instance.addListener(event, guarded);
      };
      let resolveReady;
      const ready = new Promise(resolve => {resolveReady = resolve;});
      const failed = new Promise((_, reject) => {
        const waiter = {resolve:resolveReady, reject, timer:null}; readyWaiter = waiter;
        waiter.timer = setTimeout(() => failConnection(new Error('A conexão com o Spotify demorou para responder. Tente novamente.'), current), TIMEOUT_MS);
      });
      // Errors while installing listeners are handled by the outer connection cleanup too.
      failed.catch(() => {});
      listen('ready', event => {
        if (!event || typeof event.device_id !== 'string' || !event.device_id) return failConnection(new Error('O Spotify não informou um dispositivo válido. Tente conectar novamente.'), current);
        deviceId = event.device_id;
        const waiter = readyWaiter;
        if (waiter) waiter.resolve(deviceId);
        publish({ready:true}, current);
      });
      listen('player_state_changed', raw => updateFromSdk(raw, current));
      ['authentication_error','account_error','initialization_error','not_ready'].forEach(event => listen(event, payload => {
        if (event === 'not_ready' && payload?.device_id && deviceId && payload.device_id !== deviceId) return;
        failConnection(new Error(errorMessage[event]), current);
      }));
      ['playback_error','autoplay_failed'].forEach(event => listen(event, () => {
        publish({paused:true}, current); report(new Error(errorMessage[event]), current);
      }));
      activate(current);
      const connected = Promise.resolve().then(() => {
        check(current);
        if (player !== instance) throw cancelled();
        return instance.connect();
      }).then(result => {
        if (result !== true) throw new Error('O Spotify não conseguiu conectar este player. Tente novamente.');
      }).catch(error => {
        if (error?.code === 'SPOTIFY_CANCELLED') throw error;
        throw new Error('O Spotify não conseguiu conectar este player. Tente novamente.');
      });
      const [, id] = await Promise.race([Promise.all([connected, ready]), failed]);
      check(current);
      if (player !== instance || !deviceId) throw cancelled();
      if (readyWaiter) {clearTimeout(readyWaiter.timer); readyWaiter = null;}
      return id;
    };
    pending.promise = start().catch(error => {
      const safe = error instanceof Error ? error : new Error('Não foi possível conectar o Spotify.');
      if (current === generation && safe.code !== 'SPOTIFY_CANCELLED') failConnection(safe, current);
      throw safe;
    }).finally(() => {if (connection === pending) connection = null;});
    return pending.promise;
  }

  async function play(media) {
    const body = playbackBody(media);
    const operation = ++command;
    abortRequests();
    const started = connect(), current = generation;
    let controller, requestTimer, timedOut = false;
    try {
      const id = await started;
      check(current);
      if (operation !== command) throw cancelled();
      const token = await accessToken(current);
      if (operation !== command) throw cancelled();
      controller = new AbortController(); requests.add(controller);
      let response;
      try {
        const timeout = new Promise((_, reject) => {
          requestTimer = setTimeout(() => {
            timedOut = true; controller.abort();
            reject(new Error('O Spotify demorou para responder. Verifique sua internet e tente novamente.'));
          }, TIMEOUT_MS);
        });
        response = await Promise.race([fetch(`${API_URL}?device_id=${encodeURIComponent(id)}`, {
          method:'PUT', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
          body:JSON.stringify(body), signal:controller.signal, redirect:'error', credentials:'omit', cache:'no-store'
        }), timeout]);
      } catch {
        check(current);
        if (operation !== command || (controller.signal.aborted && !timedOut)) throw cancelled();
        if (timedOut) throw new Error('O Spotify demorou para responder. Verifique sua internet e tente novamente.');
        throw new Error('Não foi possível acessar o Spotify. Verifique sua internet e tente novamente.');
      }
      check(current);
      if (operation !== command) throw cancelled();
      if (!response.ok) throw apiError(response);
      // HTTP success acknowledges the command; only SDK events can declare actual playback.
      return {ok:true, deviceId:id};
    } catch (error) {report(error, current); throw error;}
    finally {clearTimeout(requestTimer); if (controller) requests.delete(controller);}
  }

  async function run(method, args = [], activateAudio = false) {
    const current = generation, instance = player;
    if (!instance || !deviceId) throw new Error('Conecte o Spotify e escolha uma música para começar.');
    if (activateAudio) activate(current);
    try {
      await instance[method](...args);
      check(current);
      if (player !== instance) throw cancelled();
      return true;
    } catch (error) {
      check(current);
      const safe = error?.code === 'SPOTIFY_CANCELLED' ? error : new Error('O Spotify não conseguiu executar este controle. Tente novamente.');
      report(safe, current); throw safe;
    }
  }
  function disconnect() {
    generation++; command++;
    sdkTask?.cancel(); sdkTask = null;
    if (readyWaiter) {clearTimeout(readyWaiter.timer); readyWaiter.reject(cancelled()); readyWaiter = null;}
    connection = null; abortRequests(); destroyPlayer(); publish({...EMPTY_STATE});
  }

  return {
    connect, play, disconnect,
    getState:() => ({...state}),
    toggle:() => run('togglePlay', [], true),
    next:() => run('nextTrack'),
    previous:() => run('previousTrack'),
    pause:() => player && deviceId ? run('pause') : Promise.resolve(false),
    seek:ms => {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return Promise.reject(new Error('Escolha uma posição válida para a música.'));
      return run('seek', [Math.floor(state.duration > 0 ? Math.min(ms, state.duration) : ms)]);
    },
    setVolume:volume => {
      if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) return Promise.reject(new Error('Escolha um volume entre 0 e 100%.'));
      return run('setVolume', [volume]);
    }
  };
}
