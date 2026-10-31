/** Normalize user-supplied YouTube links without fetching remote metadata. */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{8,150}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f<>\\]|%3[ce]/i;
const invalid = message => { throw new Error(message); };
const hasUserInfo = raw => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw.trim());

function singleParameter(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) invalid('O link possui parâmetros repetidos. Copie novamente o link de compartilhamento do YouTube.');
  return values[0] ?? null;
}

function checkedVideoId(value) {
  if (typeof value !== 'string' || !VIDEO_ID.test(value)) invalid('O link precisa conter um vídeo válido do YouTube, com identificador de 11 caracteres.');
  return value;
}

function checkedPlaylistId(value) {
  if (value === 'LM' || value === 'WL') invalid('Playlists pessoais de músicas curtidas (LM) e Assistir mais tarde (WL) não podem ser incorporadas. Use uma playlist pública ou um vídeo.');
  if (typeof value === 'string' && value.startsWith('RD')) invalid('Mixes automáticos do YouTube (RD...) não têm reprodução confiável no player. Use o link de um vídeo ou de uma playlist pública.');
  if (typeof value !== 'string' || !PLAYLIST_ID.test(value)) invalid('O link precisa conter uma playlist válida, com identificador de 8 a 150 caracteres.');
  return value;
}

function videoResult(value) {
  const videoId = checkedVideoId(value);
  return {kind:'video', videoId, listId:null, url:`https://music.youtube.com/watch?v=${videoId}`, label:`Música · ${videoId}`};
}

function playlistResult(value) {
  const listId = checkedPlaylistId(value);
  return {kind:'playlist', videoId:null, listId, url:`https://music.youtube.com/playlist?list=${listId}`, label:`Playlist · ${listId}`};
}

/**
 * Return a safe canonical record, or throw an Error with a user-facing message.
 * A watch link containing both v and list always becomes a single video.
 */
export function parseYouTubeLink(raw) {
  if (typeof raw !== 'string' || !raw.trim()) invalid('Cole um link de música ou playlist do YouTube.');
  if (raw.length > 2048) invalid('O link é muito longo. Use um link de compartilhamento do YouTube com até 2.048 caracteres.');
  if (UNSAFE_TEXT.test(raw)) invalid('Cole somente o endereço do YouTube, sem código HTML ou caracteres de controle.');

  let url;
  try { url = new URL(raw.trim()); } catch { invalid('O endereço não é um link válido do YouTube.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') invalid('Use um link HTTP ou HTTPS do YouTube.');
  if (url.username || url.password || hasUserInfo(raw)) invalid('O link do YouTube não pode conter usuário ou senha no endereço.');
  if (url.port && url.port !== '80' && url.port !== '443') invalid('O link do YouTube deve usar uma porta HTTP ou HTTPS padrão.');

  const host = url.hostname;
  if (!YOUTUBE_HOSTS.has(host) && host !== 'youtu.be') invalid('Use um link de youtube.com, music.youtube.com ou youtu.be.');
  const path = url.pathname.replace(/\/$/, '');

  if (host === 'youtu.be') {
    const match = /^\/([A-Za-z0-9_-]{11})$/.exec(path);
    if (!match) invalid('O link curto precisa apontar para um único vídeo válido do YouTube.');
    return videoResult(match[1]);
  }

  if (path === '/watch') {
    const videoId = singleParameter(url, 'v');
    if (videoId !== null) return videoResult(videoId);
    const listId = singleParameter(url, 'list');
    if (listId !== null) return playlistResult(listId);
    invalid('O link não contém um vídeo ou uma playlist. Copie o endereço de compartilhamento no YouTube.');
  }

  if (path === '/playlist' || path === '/embed/videoseries') return playlistResult(singleParameter(url, 'list'));

  const videoPath = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(path);
  if (videoPath) return videoResult(videoPath[1]);
  invalid('Este formato de link não é suportado. Use um vídeo, Shorts ou playlist do YouTube.');
}

function checkedOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048 || UNSAFE_TEXT.test(raw)) invalid('A origem do player precisa ser um endereço HTTP ou HTTPS válido.');
  let url;
  try { url = new URL(raw.trim()); } catch { invalid('A origem do player precisa ser um endereço HTTP ou HTTPS válido.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || hasUserInfo(raw) || !url.hostname
      || url.pathname !== '/' || url.search || url.hash) invalid('A origem do player deve conter apenas protocolo, domínio e, se necessário, porta.');
  return url.origin;
}

/** Build an iframe URL using validated IDs and URLSearchParams, never HTML. */
export function makeEmbedUrl(media, origin) {
  if (!media || typeof media !== 'object') invalid('Escolha uma música ou playlist válida para o player.');
  let url;
  if (media.kind === 'video') {
    url = new URL(`https://www.youtube.com/embed/${checkedVideoId(media.videoId)}`);
  } else if (media.kind === 'playlist') {
    url = new URL('https://www.youtube.com/embed/videoseries');
    url.searchParams.set('list', checkedPlaylistId(media.listId));
  } else invalid('Escolha uma música ou playlist válida para o player.');

  url.searchParams.set('enablejsapi', '1');
  url.searchParams.set('origin', checkedOrigin(origin));
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('autoplay', '0');
  url.searchParams.set('rel', '0');
  return url.toString();
}
