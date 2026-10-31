import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const bootSource = await readFile(new URL('../web/app/boot.js', import.meta.url), 'utf8');
const appUrl = 'https://perabru.github.io/peragym/docs/app/';

class EventTargetStub {
  listeners = new Map();
  addEventListener(type, listener, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({listener, once: Boolean(options && typeof options === 'object' && options.once)});
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.listener !== listener));
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const entry of [...this.listeners.get(event.type) || []]) {
      entry.listener.call(this, event);
      if (entry.once) this.removeEventListener(event.type, entry.listener);
    }
    return true;
  }
}

class ElementStub extends EventTargetStub {
  hidden = false;
  textContent = '';
  removed = false;
  style = {};
  attributes = new Map();
  focusCount = 0;
  constructor(id) {
    super();
    this.id = id;
    const tokens = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => tokens.add(value)),
      remove: (...values) => values.forEach(value => tokens.delete(value)),
      contains: value => tokens.has(value),
      toggle: (value, force) => {
        const active = force === undefined ? !tokens.has(value) : Boolean(force);
        if (active) tokens.add(value); else tokens.delete(value);
        return active;
      }
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focusCount++; }
  remove() { this.removed = true; }
  click() {
    const event = {type: 'click', target: this, preventDefault() {}};
    this.onclick?.(event);
    this.dispatchEvent(event);
  }
}

function bootHarness({domReady = true} = {}) {
  let now = 0, nextTimer = 0, reloadCount = 0, visibleEvents = 0;
  const timers = new Map(), storageMutations = [];
  const window = new EventTargetStub(), document = new EventTargetStub();
  window.addEventListener('peragym:app-visible', () => visibleEvents++);
  class CustomEventStub {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const elements = Object.fromEntries(['loading', 'app', 'loading-status', 'loading-recovery', 'loading-error-message', 'loading-retry', 'loading-home'].map(id => [id, new ElementStub(id)]));
  elements.app.hidden = true;
  elements['loading-recovery'].hidden = true;
  elements['loading-status'].textContent = 'Carregando...';
  elements['loading-home'].href = '../';
  document.readyState = domReady ? 'complete' : 'loading';
  document.getElementById = id => document.readyState === 'loading' ? null : elements[id] && !elements[id].removed ? elements[id] : null;
  document.querySelector = selector => selector.startsWith('#') ? document.getElementById(selector.slice(1)) : null;
  document.documentElement = new ElementStub('html');
  document.body = new ElementStub('body');
  const storage = {
    getItem() { return null; },
    setItem(...args) { storageMutations.push(['setItem', ...args]); },
    removeItem(...args) { storageMutations.push(['removeItem', ...args]); },
    clear() { storageMutations.push(['clear']); }
  };
  const setTimeout = (callback, delay = 0, ...args) => {
    const id = ++nextTimer;
    timers.set(id, {at: now + Math.max(0, Number(delay) || 0), callback, args});
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  class FakeDate extends Date { static now() { return now; } }
  const location = {href: appUrl, origin: new URL(appUrl).origin, pathname: new URL(appUrl).pathname, reload() { reloadCount++; }};
  const performance = {now: () => now};
  Object.assign(window, {document, location, setTimeout, clearTimeout, performance, CustomEvent: CustomEventStub});
  const context = vm.createContext({
    window, document, location, setTimeout, clearTimeout, performance, Date: FakeDate,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    localStorage: storage, sessionStorage: storage,
    indexedDB: {deleteDatabase: (...args) => storageMutations.push(['deleteDatabase', ...args])},
    caches: {delete: (...args) => storageMutations.push(['deleteCache', ...args])},
    HTMLElement: ElementStub, Element: ElementStub, CustomEvent: CustomEventStub, URL, console
  });
  vm.runInContext(bootSource, context, {filename: 'boot.js'});
  return {
    elements, storageMutations,
    get reloadCount() { return reloadCount; },
    get visibleEvents() { return visibleEvents; },
    event(type, detail) { window.dispatchEvent({type, detail}); },
    resourceError(url) {
      const script = {tagName: 'SCRIPT', src: url, getAttribute: name => name === 'src' ? url : null};
      window.dispatchEvent({type: 'error', target: script});
    },
    scriptError(filename) { window.dispatchEvent({type: 'error', filename, message: 'Script failed', target: window}); },
    domReady() { document.readyState = 'interactive'; document.dispatchEvent({type: 'DOMContentLoaded'}); },
    advance(duration) {
      const until = now + duration;
      let executions = 0;
      while (true) {
        const pending = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!pending) break;
        if (++executions > 1000) throw new Error('Unexpected repeating boot timers');
        const [id, timer] = pending;
        now = timer.at;
        timers.delete(id);
        timer.callback(...timer.args);
      }
      now = until;
    }
  };
}

function assertLoading(harness) {
  assert.equal(harness.elements.app.hidden, true, 'An unfinished boot must not reveal an empty app');
  assert.equal(harness.elements.loading.removed, false);
  assert.equal(harness.elements.loading.hidden, false);
}
function assertRecovery(harness) {
  assertLoading(harness);
  assert.equal(harness.elements['loading-recovery'].hidden, false, 'The user must have a way to recover');
  assert.ok(harness.elements['loading-error-message'].textContent.trim(), 'Recovery needs a visible explanation');
}
function assertReady(harness) {
  assert.equal(harness.elements.app.hidden, false);
  assert.equal(harness.elements['loading-recovery'].hidden, true);
}

test('early app-ready waits for the minimum loading interval and cancels the boot timeout', () => {
  const h = bootHarness();
  h.advance(100);
  h.event('peragym:app-ready');
  h.advance(749);
  assertLoading(h);
  assert.equal(h.visibleEvents, 0, 'Install guidance must not open before loading finishes');
  h.advance(1);
  assertReady(h);
  assert.equal(h.visibleEvents, 1);
  h.advance(20000);
  assertReady(h);
  assert.equal(h.visibleEvents, 1, 'The app should be revealed only once');
  assert.equal(h.storageMutations.length, 0);
});

test('app-ready after the minimum interval reveals the rendered app immediately', () => {
  const h = bootHarness();
  h.advance(900);
  assertLoading(h);
  h.event('peragym:app-ready');
  h.advance(0);
  assertReady(h);
});

test('a twelve-second initialization timeout shows recovery without opening an empty application', () => {
  const h = bootHarness();
  h.advance(11999);
  assertLoading(h);
  assert.equal(h.elements['loading-recovery'].hidden, true);
  h.advance(1);
  assertRecovery(h);
});

test('recovery retry reloads the current page and never clears local records, storage or caches', () => {
  const h = bootHarness();
  h.advance(12000);
  assertRecovery(h);
  h.elements['loading-retry'].click();
  assert.equal(h.reloadCount, 1);
  assert.deepEqual(h.storageMutations, []);
});

test('a late successful initialization can leave timeout recovery and open the app', () => {
  const h = bootHarness();
  h.advance(13000);
  assertRecovery(h);
  h.event('peragym:app-ready');
  h.advance(1000);
  assertReady(h);
  assert.equal(h.reloadCount, 0);
});

test('an explicit app boot failure provides recovery and retains all stored data', () => {
  const h = bootHarness();
  h.event('peragym:app-error', {message: 'O banco local não abriu.'});
  assert.equal(h.elements['loading-error-message'].textContent,'O banco local não abriu.');
  assertRecovery(h);
  h.advance(20000);
  assertRecovery(h);
  assert.deepEqual(h.storageMutations, []);
});

test('failed local application modules are caught even before their JavaScript can dispatch an event', () => {
  for (const file of ['app.js', 'db.js', 'charts.js', 'music-links.js', 'music-player.js', 'local-account.js', 'local-auth-ui.js', 'local-biometric.js', 'youtube-account.js', 'spotify-account.js', 'spotify-playback.js', 'spotify-return.js', 'workout-session.js', 'operation-loading.js']) {
    const h = bootHarness();
    h.resourceError(new URL(`${file}?v=3.2.0`, appUrl).href);
    assertRecovery(h);
    assert.deepEqual(h.storageMutations, [], file);
  }
});

test('a YouTube player failure after successful boot never reopens loading recovery', () => {
  const h = bootHarness();
  h.event('peragym:app-ready');
  h.advance(1000);
  assertReady(h);
  h.resourceError('https://www.youtube.com/iframe_api');
  h.scriptError('https://s.ytimg.com/yts/jsbin/player.js');
  h.advance(20000);
  assertReady(h);
  assert.equal(h.reloadCount, 0);
});

test('a ready event received before DOMContentLoaded is retained until the loading elements exist', () => {
  const h = bootHarness({domReady: false});
  h.advance(100);
  h.event('peragym:app-ready');
  h.advance(1000);
  h.domReady();
  h.advance(850);
  assertReady(h);
  h.advance(20000);
  assertReady(h);
});

test('a local module resource failure before DOMContentLoaded is retained for recovery', () => {
  const h = bootHarness({domReady: false});
  h.resourceError(new URL('app.js?v=3.2.0', appUrl).href);
  h.domReady();
  h.advance(0);
  assertRecovery(h);
});


test('an unhandled module initialization rejection exposes recovery without clearing local data', () => {
  const h = bootHarness();
  h.event('unhandledrejection');
  assertRecovery(h);
  assert.deepEqual(h.storageMutations, []);
});
