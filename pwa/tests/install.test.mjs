import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/pwa.js', import.meta.url), 'utf8');
const SESSION_KEY = 'peragym-installed-session-v1';

class Target {
  listeners = new Map();
  addEventListener(type, callback, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({callback, once: Boolean(options && typeof options === 'object' && options.once)});
  }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback)); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const item of [...this.listeners.get(event.type) || []]) {
      item.callback.call(this, event);
      if (item.once) this.removeEventListener(event.type, item.callback);
    }
    return true;
  }
}
class Element extends Target {
  children = [];
  attributes = new Map();
  hidden = false;
  disabled = false;
  open = false;
  textContent = '';
  className = '';
  constructor(tagName = 'div') {
    super(); this.tagName = tagName.toUpperCase();
    const classes = new Set();
    this.classList = {add: (...items) => items.forEach(item => classes.add(item)), remove: (...items) => items.forEach(item => classes.delete(item)), contains: item => classes.has(item)};
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.removed = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({type: 'close'}); }
  matches(selector) {
    const attribute = /^\[([^\]]+)\]$/.exec(selector);
    if (attribute) return this.hasAttribute(attribute[1]);
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelector(selector) { return descendants(this).find(node => node.matches(selector)) || null; }
  querySelectorAll(selector) { return descendants(this).filter(node => node.matches(selector)); }
}
function descendants(root) { return root.children.flatMap(child => [child, ...descendants(child)]); }
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function installHarness({query = '', displayMode = 'browser', installed = false, appVisible = false} = {}) {
  const window = new Target(), document = new Target(), media = new Map();
  const app = new Element(), header = new Element('button'), help = new Element('button');
  app.id = 'app'; app.hidden = !appVisible;
  header.setAttribute('data-install', ''); help.setAttribute('data-install', ''); help.setAttribute('data-install-help', '');
  for (const button of [header, help]) { const label = new Element('span'); label.setAttribute('data-install-label', ''); button.append(label); }
  app.append(header, help);
  document.body = new Element('body'); document.head = new Element('head'); document.body.append(app);
  const css = new Element('link'); css.href = '/pwa.css?v=3.2.0'; document.head.append(css);
  const all = () => [...descendants(document.head), ...descendants(document.body)];
  document.readyState = 'complete';
  document.createElement = name => new Element(name);
  document.getElementById = id => all().find(node => node.id === id) || null;
  document.querySelectorAll = selector => all().filter(node => node.matches(selector));
  document.querySelector = selector => selector === 'link[href^="/pwa.css"]' ? css : document.querySelectorAll(selector)[0] || null;
  const storage = new Map(installed ? [[SESSION_KEY, '1']] : []);
  const sessionStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key)};
  const location = new URL('https://peragym.test/app/' + query);
  location.assign = url => { location.href = new URL(url, location).href; };
  location.reload = () => {};
  const history = {state: null, replaceState(state, _unused, url) { this.state = state; location.href = new URL(url, location).href; }};
  const navigator = {userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile', platform: 'Linux', maxTouchPoints: 1, clipboard: {async writeText() {}}};
  const matchMedia = query => {
    if (!media.has(query)) { const result = new Target(); result.matches = query === `(display-mode: ${displayMode})`; media.set(query, result); }
    return media.get(query);
  };
  let nextTimer = 0;
  const timers = new Map();
  const setTimeout = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
  const clearTimeout = id => timers.delete(id);
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  class MutationObserver { observe() {} disconnect() {} }
  Object.assign(window, {navigator, location, history, matchMedia, isSecureContext: true, __peragymBootManaged: true});
  vm.runInNewContext(source, {window, document, location, history, navigator, sessionStorage, URL, URLSearchParams, CustomEvent, MutationObserver, setTimeout, clearTimeout, console}, {filename: 'pwa.js'});
  return {
    app, header, help, storage,
    guides: () => all().filter(node => node.tagName === 'DIALOG' && node.open && !node.removed),
    event(type) { window.dispatchEvent({type}); },
    visible() { app.hidden = false; window.dispatchEvent({type: 'peragym:app-visible'}); },
    beforeInstall(event) { window.dispatchEvent(event); },
    click(element) {
      if (element.disabled) return;
      const event = {type: 'click', target: element, preventDefault() {}};
      element.dispatchEvent(event);
      document.dispatchEvent(event);
    }
  };
}

function promptEvent(outcome = 'accepted', pendingPrompt) {
  let calls = 0, prevented = false;
  return {
    type: 'beforeinstallprompt',
    get calls() { return calls; },
    get prevented() { return prevented; },
    preventDefault() { prevented = true; },
    prompt() { calls++; return pendingPrompt || Promise.resolve(); },
    userChoice: Promise.resolve({outcome})
  };
}

test('install query opens instructions only after app visibility and never automatically spends the native prompt', async () => {
  const h = installHarness({query: '?instalar=1'}), prompt = promptEvent();
  h.beforeInstall(prompt);
  assert.equal(prompt.prevented, true);
  assert.equal(h.guides().length, 0);
  assert.equal(prompt.calls, 0);
  h.visible();
  await settle();
  assert.equal(h.guides().length, 1);
  assert.equal(prompt.calls, 0);
  h.event('peragym:app-visible');
  assert.equal(h.guides().length, 1, 'The same installation request must not create duplicate guides');
});

test('browser install button remains available without a native prompt and opens manual guidance', () => {
  const h = installHarness();
  assert.equal(h.header.hidden, false);
  h.click(h.header);
  assert.equal(h.guides().length, 1);
  assert.equal(h.guides()[0].querySelector('[data-native-install]').hidden, true);
  assert.equal(h.help.hidden, false);
});

test('confirmed installation hides the header CTA while preserving installation help and session state', () => {
  const h = installHarness();
  h.event('appinstalled');
  assert.equal(h.storage.get(SESSION_KEY), '1');
  assert.equal(h.header.hidden, true);
  assert.equal(h.help.hidden, false);
  h.click(h.help);
  assert.equal(h.guides().length, 1);
  assert.equal(h.guides()[0].querySelector('[data-native-install]').hidden, true);
  assert.equal(installHarness({installed: true}).header.hidden, true, 'Reloading the installed session must retain the confirmed state');
});

test('a new native install offer clears a stale installed-session flag and restores the browser CTA', () => {
  const h = installHarness({installed: true}), prompt = promptEvent();
  assert.equal(h.header.hidden, true);
  h.beforeInstall(prompt);
  assert.equal(prompt.prevented, true);
  assert.equal(h.storage.has(SESSION_KEY), false);
  assert.equal(h.header.hidden, false);
  assert.equal(prompt.calls, 0);
});

test('installed display modes hide the header CTA and keep manual installation help available', () => {
  for (const displayMode of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
    const h = installHarness({displayMode});
    assert.equal(h.header.hidden, true, displayMode);
    assert.equal(h.help.hidden, false, displayMode);
    h.click(h.help);
    assert.equal(h.guides().length, 1, displayMode);
  }
});

test('one explicit click consumes a native prompt once and acceptance alone does not claim installation', async () => {
  const h = installHarness(), prompt = promptEvent();
  h.beforeInstall(prompt);
  h.click(h.header);
  await settle();
  assert.equal(prompt.calls, 1);
  assert.equal(h.storage.has(SESSION_KEY), false, 'Only appinstalled can confirm installation');
  assert.equal(h.header.hidden, false);
  h.click(h.header);
  await settle();
  assert.equal(prompt.calls, 1);
  assert.equal(h.guides().length, 1, 'A consumed prompt must fall back to instructions on the next click');
});

test('a second request during a pending native prompt cannot trigger another prompt', async () => {
  let resolvePrompt;
  const pending = new Promise(resolve => { resolvePrompt = resolve; });
  const h = installHarness(), prompt = promptEvent('accepted', pending);
  h.beforeInstall(prompt);
  h.click(h.header);
  h.event('peragym:install');
  assert.equal(prompt.calls, 1);
  assert.equal(h.header.disabled, true);
  resolvePrompt();
  await settle();
  assert.equal(h.header.disabled, false);
  assert.equal(prompt.calls, 1);
});

test('dismissing the browser prompt leaves a manual installation path instead of a silent dead end', async () => {
  const h = installHarness(), prompt = promptEvent('dismissed');
  h.beforeInstall(prompt);
  h.click(h.header);
  await settle();
  assert.equal(prompt.calls, 1);
  assert.equal(h.guides().length, 1);
  assert.equal(h.header.hidden, false);
  assert.equal(h.header.disabled, false);
  assert.equal(h.storage.has(SESSION_KEY), false);
});


test('installation query also works when the app was already visible before the helper initialized', () => {
  const h = installHarness({query: '?instalar=1', appVisible: true});
  assert.equal(h.guides().length, 1);
  h.event('peragym:app-visible');
  assert.equal(h.guides().length, 1);
});
