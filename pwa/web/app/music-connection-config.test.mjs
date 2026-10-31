import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readMusicConnectionConfig,
  saveMusicConnectionConfig,
  clearMusicConnectionConfig,
  validateMusicConnectionConfig
} from './music-connection-config.js';

const SPOTIFY = 'ABCDEF0123456789ABCDEF0123456789';
const GOOGLE = '1234567890-Client_Test.apps.googleusercontent.com';
const EMPTY = {spotifyClientId:'', googleClientId:''};
const KEY = id => 'peragym.music.config.v1.' + id;

function setup(t, replacement) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  const storage = replacement ?? {
    getItem:key => values.get(key) ?? null,
    setItem:(key, value) => { values.set(String(key), String(value)); },
    removeItem:key => { values.delete(key); }
  };
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:storage});
  t.after(() => {
    if(previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  return {values, storage};
}

test('validates only public IDs, trims input and preserves case-sensitive Google identifiers', () => {
  assert.deepEqual(validateMusicConnectionConfig({spotifyClientId:'  ' + SPOTIFY + '  ', googleClientId:' ' + GOOGLE + ' '}), {
    spotifyClientId:SPOTIFY.toLowerCase(), googleClientId:GOOGLE
  });
  assert.deepEqual(validateMusicConnectionConfig({}), EMPTY);
  assert.deepEqual(validateMusicConnectionConfig({spotifyClientId:' ', googleClientId:''}), EMPTY);
  assert.deepEqual(validateMusicConnectionConfig(Object.assign(Object.create(null), {googleClientId:GOOGLE})), {...EMPTY, googleClientId:GOOGLE});
});

test('rejects credentials, unknown keys, inherited objects and accessor properties without evaluating them', () => {
  for(const field of ['password', 'token', 'accessToken', 'clientSecret', 'redirectUri', '__proto__']) {
    const value = Object.create(null); value[field] = 'do-not-store';
    assert.throws(() => validateMusicConnectionConfig(value), {name:'MusicConnectionConfigError'});
  }
  for(const value of [null, [], '', 1, true, Object.create({spotifyClientId:SPOTIFY})]) {
    assert.throws(() => validateMusicConnectionConfig(value));
  }
  let read = false;
  const accessor = {get spotifyClientId() { read = true; return SPOTIFY; }};
  assert.throws(() => validateMusicConnectionConfig(accessor));
  assert.equal(read, false);
  assert.throws(() => validateMusicConnectionConfig({[Symbol('token')]:'no'}));
});

test('rejects malformed, deceptive and oversized client IDs', () => {
  for(const spotifyClientId of [undefined, null, 32, 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 'https://accounts.spotify.com/', ' '.repeat(65)]) {
    assert.throws(() => validateMusicConnectionConfig({spotifyClientId}));
  }
  for(const googleClientId of [undefined, null, 1, 'short.apps.googleusercontent.com', '123456.apps.googleusercontent.com.evil.example',
    'https://' + GOOGLE, 'a'.repeat(201) + '.apps.googleusercontent.com', 'a'.repeat(257), GOOGLE + '\u0000']) {
    assert.throws(() => validateMusicConnectionConfig({googleClientId}));
  }
});

test('saves durably under a profile-specific key and keeps profile configurations isolated', t => {
  const {values} = setup(t);
  assert.deepEqual(readMusicConnectionConfig('profile-A'), EMPTY);
  const saved = saveMusicConnectionConfig('profile-A', {spotifyClientId:SPOTIFY, googleClientId:GOOGLE});
  assert.deepEqual(saved, {spotifyClientId:SPOTIFY.toLowerCase(), googleClientId:GOOGLE});
  assert.deepEqual(JSON.parse(values.get(KEY('profile-A'))), saved);
  saveMusicConnectionConfig('profile-B', {googleClientId:'654321-other.apps.googleusercontent.com'});
  assert.equal(readMusicConnectionConfig('profile-B').spotifyClientId, '');
  assert.equal(readMusicConnectionConfig('profile-A').googleClientId, GOOGLE);
  saved.googleClientId = 'changed only in the caller';
  assert.equal(readMusicConnectionConfig('profile-A').googleClientId, GOOGLE);
});

test('invalid data and profile IDs cannot overwrite another saved configuration', t => {
  const {values} = setup(t);
  saveMusicConnectionConfig('valid-profile', {spotifyClientId:SPOTIFY});
  const before = new Map(values);
  assert.throws(() => saveMusicConnectionConfig('valid-profile', {spotifyClientId:'invalid'}));
  for(const profileId of ['', null, 1, '../valid-profile', 'profile.with.dots', 'a'.repeat(81), 'profile\u0000']) {
    assert.throws(() => readMusicConnectionConfig(profileId));
    assert.throws(() => saveMusicConnectionConfig(profileId, EMPTY));
    assert.throws(() => clearMusicConnectionConfig(profileId));
  }
  assert.deepEqual(values, before);
});

test('corrupt, oversized or credential-bearing storage reads safely as an empty configuration', t => {
  const {values} = setup(t);
  for(const raw of ['not json', 'null', '[]', '"text"', '{"spotifyClientId":10}', '{"token":"must-not-return"}', 'x'.repeat(1025)]) {
    values.set(KEY('profile'), raw);
    assert.deepEqual(readMusicConnectionConfig('profile'), EMPTY);
  }
});

test('unavailable storage fails closed for writes while reads remain usable', t => {
  setup(t, {getItem() { throw new Error('storage unavailable'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blocked'); }});
  assert.deepEqual(readMusicConnectionConfig('profile'), EMPTY);
  assert.throws(() => saveMusicConnectionConfig('profile', EMPTY), {name:'MusicConnectionConfigError'});
  assert.throws(() => clearMusicConnectionConfig('profile'), {name:'MusicConnectionConfigError'});
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, get() { throw new Error('SecurityError'); }});
  assert.deepEqual(readMusicConnectionConfig('profile'), EMPTY);
  assert.throws(() => saveMusicConnectionConfig('profile', EMPTY));
  assert.throws(() => clearMusicConnectionConfig('profile'));
});

test('silent storage failures cannot be reported as a successful save or removal', t => {
  setup(t, {getItem() { return null; }, setItem() {}, removeItem() {}});
  assert.throws(() => saveMusicConnectionConfig('profile', {spotifyClientId:SPOTIFY}));
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{getItem() { return '{}'; }, removeItem() {}}});
  assert.throws(() => clearMusicConnectionConfig('profile'));
});

test('clearing one profile removes only its public IDs and leaves unrelated storage untouched', t => {
  const {values} = setup(t);
  saveMusicConnectionConfig('A', {spotifyClientId:SPOTIFY});
  saveMusicConnectionConfig('B', {googleClientId:GOOGLE});
  values.set('other-app', 'untouched');
  assert.deepEqual(clearMusicConnectionConfig('A'), EMPTY);
  assert.equal(values.has(KEY('A')), false);
  assert.deepEqual(readMusicConnectionConfig('A'), EMPTY);
  assert.equal(readMusicConnectionConfig('B').googleClientId, GOOGLE);
  assert.equal(values.get('other-app'), 'untouched');
});
