/** Public OAuth application IDs only; no account credentials are stored here. */
const PREFIX = 'peragym.music.config.v1.';
const PROFILE_ID = /^[A-Za-z0-9-]{1,80}$/;
const SPOTIFY_ID = /^[a-fA-F0-9]{32}$/;
const GOOGLE_ID = /^[A-Za-z0-9_-]{6,200}\.apps\.googleusercontent\.com$/;
const MAX_STORED_LENGTH = 1024;
const emptyConfig = () => ({spotifyClientId:'', googleClientId:''});

function fail(message) {
  return Object.assign(new Error(message), {name:'MusicConnectionConfigError'});
}

function storageKey(profileId) {
  if(typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) {
    throw fail('Escolha um perfil local válido para configurar a música.');
  }
  return PREFIX + profileId;
}

export function validateMusicConnectionConfig(input) {
  if(!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw fail('Informe os Client IDs públicos do Spotify e do Google.');
  }
  if(Reflect.ownKeys(input).some(key => !['spotifyClientId', 'googleClientId'].includes(key))) {
    throw fail('Use somente Client IDs públicos. Senhas, tokens e Client Secrets não são aceitos.');
  }
  const result = emptyConfig();
  for(const [field, limit, pattern, label] of [
    ['spotifyClientId', 64, SPOTIFY_ID, 'Spotify'],
    ['googleClientId', 256, GOOGLE_ID, 'Google']
  ]) {
    if(!Object.hasOwn(input, field)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if(!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
        || descriptor.value.length > limit) {
      throw fail(`Informe um Client ID público válido do ${label}, ou deixe vazio.`);
    }
    const value = descriptor.value.trim();
    if(value && !pattern.test(value)) {
      throw fail(`Informe um Client ID público válido do ${label}, ou deixe vazio.`);
    }
    result[field] = field === 'spotifyClientId' ? value.toLowerCase() : value;
  }
  return result;
}

export function readMusicConnectionConfig(profileId) {
  const key = storageKey(profileId);
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if(typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) return emptyConfig();
    return validateMusicConnectionConfig(JSON.parse(raw));
  } catch {
    return emptyConfig();
  }
}

export function saveMusicConnectionConfig(profileId, input) {
  const key = storageKey(profileId), config = validateMusicConnectionConfig(input);
  try {
    const storage = globalThis.localStorage;
    if(!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') throw new Error();
    const serialized = JSON.stringify(config);
    storage.setItem(key, serialized);
    if(storage.getItem(key) !== serialized) throw new Error();
  } catch {
    throw fail('Não foi possível salvar os Client IDs neste navegador. Verifique o armazenamento e tente novamente.');
  }
  return {...config};
}

export function clearMusicConnectionConfig(profileId) {
  const key = storageKey(profileId);
  try {
    const storage = globalThis.localStorage;
    if(!storage || typeof storage.removeItem !== 'function' || typeof storage.getItem !== 'function') throw new Error();
    storage.removeItem(key);
    if(storage.getItem(key) !== null) throw new Error();
  } catch {
    throw fail('Não foi possível remover os Client IDs deste navegador. Tente novamente.');
  }
  return emptyConfig();
}
