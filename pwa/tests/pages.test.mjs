import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {buildPages, createDonation, normalizeBasePath, rewritePublicText} from '../scripts/build-pages.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const basePath = '/peragym/docs/';
const origin = 'https://perabru.github.io';
let temporaryRoot, projectRoot, outputDir;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'peragym-pages-tests-'));
  projectRoot = path.join(temporaryRoot, 'project', 'pwa');
  outputDir = path.join(temporaryRoot, 'project', 'docs');
  await mkdir(projectRoot, {recursive: true});
  await cp(path.join(sourceRoot, 'web'), path.join(projectRoot, 'web'), {recursive: true});
  await buildPages({projectRoot, basePath});
});
after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, {recursive: true, force: true});
});

const builtText = file => readFile(path.join(outputDir, file), 'utf8');
async function filesUnder(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) names.push(...await filesUnder(path.join(directory, entry.name), name + '/'));
    else names.push(name);
  }
  return names.sort();
}

function crc16(value) {
  let checksum = 0xffff;
  for (const byte of new TextEncoder().encode(value)) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) checksum = checksum & 0x8000 ? (checksum << 1 ^ 0x1021) & 0xffff : checksum << 1 & 0xffff;
  }
  return checksum.toString(16).toUpperCase().padStart(4, '0');
}

test('Pages base path remains inside the configured repository path', () => {
  assert.equal(normalizeBasePath('/peragym/docs'), basePath);
  assert.equal(normalizeBasePath(basePath), basePath);
  assert.equal(normalizeBasePath('/'), '/');
  for (const unsafe of ['https://external.example/', '//external.example/', '/one/../two/', '/peragym/?q=1', '/peragym/#app']) {
    assert.throws(() => normalizeBasePath(unsafe), unsafe);
  }
});

test('finite URL rewriting retains external players, provider origin checks and JavaScript regexes', async () => {
  const html = '<a href="/">Home</a><a href="#treinos">Treinos</a><img src="/assets/cassette.svg"><iframe src="https://www.youtube.com/embed/M7lc1UVf-VE"></iframe>';
  const rewrittenHtml = rewritePublicText(html, 'index.html', basePath);
  assert.ok(rewrittenHtml.includes(`href="${basePath}"`));
  assert.ok(rewrittenHtml.includes(`src="${basePath}assets/cassette.svg"`));
  assert.ok(rewrittenHtml.includes('href="#treinos"'));
  assert.ok(rewrittenHtml.includes('src="https://www.youtube.com/embed/M7lc1UVf-VE"'));
  const css = ".hero{background:url('/assets/night-drive.jpg')}";
  assert.equal(rewritePublicText(css, 'promo.css', basePath), `.hero{background:url('${basePath}assets/night-drive.jpg')}`);
  const js = String.raw`const ratio = total / count; const pattern = /\/app\/|https:\/\/example\.com/; const outside = 'https://example.com/app/'; const icon = '/assets/cassette.svg';`;
  const rewrittenJs = rewritePublicText(js, 'app/app.js', basePath);
  assert.ok(rewrittenJs.includes(String.raw`const pattern = /\/app\/|https:\/\/example\.com/;`));
  assert.ok(rewrittenJs.includes('const ratio = total / count;'));
  assert.ok(rewrittenJs.includes("const outside = 'https://example.com/app/';"));
  assert.ok(rewrittenJs.includes(`const icon = '${basePath}assets/cassette.svg';`));

  assert.equal(await builtText('app/spotify-account.js'),await readFile(path.join(sourceRoot,'web/app/spotify-account.js'),'utf8'));
  const moduleSource = await builtText('app/music-links.js');
  const music = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  const media = music.parseYouTubeLink('https://music.youtube.com/watch?v=M7lc1UVf-VE');
  const embed = new URL(music.makeEmbedUrl(media, origin));
  assert.equal(embed.origin, 'https://www.youtube.com');
  assert.equal(embed.pathname, '/embed/M7lc1UVf-VE');
  assert.equal(embed.searchParams.get('origin'), origin);
  assert.throws(() => music.makeEmbedUrl(media, `${origin}${basePath}`));
});

test('static output includes only public browser resources with byte-exact images and fonts', async () => {
  const files = await filesUnder(outputDir);
  for (const required of ['index.html', 'app/index.html', 'app/db.js', 'app/music-player.js', 'sw.js', 'manifest.webmanifest', 'donation.json', 'download/index.html', '.nojekyll']) assert.ok(files.includes(required), required);
  for (const file of files) {
    assert.equal(/(?:^|\/)(?:server|worker|db|drizzle|node_modules|api|\.openai)(?:\/|$)/.test(file), false, file);
    assert.equal(/\.test\.|\.map$/.test(file), false, file);
  }
  for (const file of ['assets/night-drive.jpg', 'assets/fonts/bungee.ttf', 'assets/fonts/yellowtail.ttf', 'icons/icon-512.png']) {
    assert.deepEqual(await readFile(path.join(outputDir, file)), await readFile(path.join(projectRoot, 'web', file)), file);
  }
  const promo = await builtText('promo.js');
  assert.ok(promo.includes(`${basePath}donation.json`));
  assert.equal(promo.includes("fetch('/api/donation'"), false);
  const index = await builtText('index.html');
  assert.match(index, /<meta\s+name=["']peragym-static["']\s+content=["']1["']/);
  assert.equal(/(?:src|href)=["']\/(?!peragym\/docs\/)/.test(index), false, 'Homepage must not escape the repository site');
  const redirect = await readFile(path.join(projectRoot, '..', 'index.html'), 'utf8');
  assert.ok(redirect.includes('./docs/'), 'The existing repository-root Pages source must lead to docs');
  assert.equal(await readFile(path.join(projectRoot, '..', '.nojekyll'), 'utf8'), '');
  assert.ok((await builtText('download/index.html')).includes(`${basePath}app/?instalar=1`));
});

test('generated manifest keeps install identity, scope and every icon within the Pages directory', async () => {
  const manifest = JSON.parse(await builtText('manifest.webmanifest'));
  assert.equal(manifest.id, `${basePath}app/`);
  assert.equal(manifest.start_url, `${basePath}app/`);
  assert.equal(manifest.scope, basePath);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'pt-BR');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const url = new URL(icon.src, origin);
    assert.ok(url.pathname.startsWith(basePath), icon.src);
    const bytes = await readFile(path.join(outputDir, url.pathname.slice(basePath.length)));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
  }
  const installation = await builtText('pwa.js');
  assert.ok(installation.includes(`${basePath}sw.js`));
  assert.ok(new RegExp(`scope:\\s*['\"]${basePath}['\"]`).test(installation));
});

test('optional Pix is generated at build time with a valid amount, CRC and QR, without API credentials', async () => {
  const donation = JSON.parse(await builtText('donation.json'));
  assert.deepEqual(donation, await createDonation(basePath));
  assert.equal(donation.optional, true);
  assert.equal(donation.amountCents, 199);
  assert.equal(donation.pixKey, 'bruno.pera@unifesp.br');
  assert.equal(donation.currency, 'BRL');
  assert.equal(donation.appUrl, `${basePath}app/`);
  assert.ok(donation.pixPayload.includes('54041.99'));
  assert.ok(donation.pixPayload.includes('PERAGYMAPOIO'));
  assert.equal(donation.pixPayload.slice(-4), crc16(donation.pixPayload.slice(0, -4)));
  assert.match(donation.qrDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(donation.qrDataUrl.split(',')[1], 'base64').toString('utf8'), /<svg/);
  for (const field of ['accessToken', 'orderId', 'claimUrl', 'secret', 'password']) assert.equal(field in donation, false);
});

function serviceWorkerHarness(source, network) {
  const handlers = new Map(), cacheData = new Map(), messages = [];
  const address = input => typeof input === 'string' ? new URL(input, origin).href : input.url;
  const cacheApi = {
    async keys() { return [...cacheData.keys()]; },
    async delete(name) { return cacheData.delete(name); },
    async open(name) {
      if (!cacheData.has(name)) cacheData.set(name, new Map());
      const data = cacheData.get(name);
      return {
        async match(request) { return data.get(address(request))?.clone(); },
        async put(request, response) { data.set(address(request), response.clone()); }
      };
    }
  };
  const client = {url: `${origin}${basePath}app/`, postMessage: message => messages.push(message)};
  const scope = {
    location: {origin, href: `${origin}${basePath}sw.js`},
    registration: {scope: `${origin}${basePath}`},
    clients: {async matchAll() { return [client]; }, async claim() {}},
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting() {}
  };
  vm.runInNewContext(source, {self: scope, caches: cacheApi, URL, Response, Request, Set, Promise, fetch: (input, init) => network(address(input), init), console});
  return {
    messages, cacheData, cacheApi,
    async install() {
      let promise;
      handlers.get('install')({waitUntil: value => { promise = value; }});
      await promise;
    },
    async prepare() {
      let promise;
      handlers.get('message')({source: client, data: {type: 'PERAGYM_PREPARE_OFFLINE'}, waitUntil: value => { promise = value; }});
      await promise;
    },
    async fetch(pathname, mode = 'same-origin') {
      let response;
      handlers.get('fetch')({request: {url: new URL(pathname, origin).href, method: 'GET', mode}, respondWith: value => { response = value; }});
      return response ? await response : undefined;
    }
  };
}

function responseForAsset(pathname) {
  const type = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.svg') ? 'image/svg+xml' : pathname.endsWith('.jpg') ? 'image/jpeg' : pathname.endsWith('.ttf') ? 'font/ttf' : pathname.endsWith('.png') ? 'image/png' : 'text/html';
  return new Response(pathname, {headers: {'Content-Type': type}});
}

test('rebased service worker prepares and opens offline using only Pages static assets', async () => {
  let online = true;
  const downloads = [];
  const h = serviceWorkerHarness(await builtText('sw.js'), async url => {
    if (!online) throw new Error('offline');
    const pathname = new URL(url).pathname;
    assert.ok(pathname.startsWith(basePath), pathname);
    assert.equal(pathname.includes('/api/'), false, pathname);
    downloads.push(pathname);
    await readFile(path.join(outputDir, pathname.slice(basePath.length) || 'index.html'));
    return responseForAsset(pathname);
  });
  await h.install();
  await h.prepare();
  assert.equal(h.messages.at(-1)?.type, 'PERAGYM_OFFLINE_READY');
  assert.ok(downloads.includes(`${basePath}app/music-links.js`));
  assert.ok(downloads.includes(`${basePath}assets/fonts/bungee.ttf`));
  for (const cache of h.cacheData.values()) for (const url of cache.keys()) assert.ok(url.startsWith(origin + basePath), url);
  online = false;
  assert.equal(await (await h.fetch(`${basePath}app/`, 'navigate')).text(), `${basePath}app/index.html`);
  assert.equal(await (await h.fetch(`${basePath}app/db.js`)).text(), `${basePath}app/db.js`);
  assert.equal(await h.fetch('/app/'), undefined);
  assert.equal(await h.fetch(`${basePath}api/session`), undefined);
  assert.equal(await h.fetch('https://www.youtube.com/iframe_api'), undefined);
});

test('offline preparation leaves caches belonging to another Pages app untouched', async () => {
  const h = serviceWorkerHarness(await builtText('sw.js'), async url => responseForAsset(new URL(url).pathname));
  const unrelated = await h.cacheApi.open('peragym-unrelated-1.0.0-app');
  const otherUrl = `${origin}/another-app/app/index.html`;
  await unrelated.put(otherUrl, responseForAsset('/another-app/app/index.html'));
  await h.prepare();
  assert.equal(h.messages.at(-1)?.type, 'PERAGYM_OFFLINE_READY');
  assert.ok(h.cacheData.has('peragym-unrelated-1.0.0-app'));
  assert.equal(await (await unrelated.match(otherUrl)).text(), '/another-app/app/index.html');
});

test('check mode detects changed or leftover output without silently rewriting it', async () => {
  await buildPages({projectRoot, basePath, check: true});
  const indexPath = path.join(outputDir, 'index.html');
  await writeFile(indexPath, '<h1>stale generated output</h1>\n');
  await assert.rejects(() => buildPages({projectRoot, basePath, check: true}));
  assert.equal(await readFile(indexPath, 'utf8'), '<h1>stale generated output</h1>\n');
  await buildPages({projectRoot, basePath});
  const obsoletePath = path.join(outputDir, 'obsolete-worker.js');
  await writeFile(obsoletePath, 'outdated generated code');
  await assert.rejects(() => buildPages({projectRoot, basePath, check: true}));
  await buildPages({projectRoot, basePath});
  assert.equal((await filesUnder(outputDir)).includes('obsolete-worker.js'), false);
  await buildPages({projectRoot, basePath, check: true});
});

test('static build rejects symlinks rather than publishing files outside the public web tree', async () => {
  const separate = path.join(temporaryRoot, 'symlink-project', 'pwa');
  await mkdir(separate, {recursive: true});
  await cp(path.join(sourceRoot, 'web'), path.join(separate, 'web'), {recursive: true});
  const privateFile = path.join(temporaryRoot, 'not-a-public-resource.txt');
  await writeFile(privateFile, 'must not be deployed');
  await symlink(privateFile, path.join(separate, 'web', 'private-link.txt'));
  await assert.rejects(() => buildPages({projectRoot: separate, basePath}), /symbolic|symlink|link/i);
});
