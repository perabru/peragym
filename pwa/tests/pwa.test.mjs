import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const workerSource = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
const origin = 'https://peragym.test';

function harness(network) {
  const handlers = new Map();
  const cacheData = new Map();
  const messages = [];
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
  const client = {url: `${origin}/app/`, postMessage: value => messages.push(value)};
  const scope = {
    location: {origin},
    clients: {async matchAll() {return [client];}, async claim() {}},
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: () => {}
  };
  const context = vm.createContext({self:scope,caches:cacheApi,URL,Response,Request,Set,Promise,fetch:(input,init)=>network(address(input),init),console});
  vm.runInContext(workerSource, context);
  return {
    cacheData, cacheApi, messages,
    async prepare() {
      let wait;
      handlers.get('message')({data:{type:'PERAGYM_PREPARE_OFFLINE'},source:client,waitUntil:promise=>{wait=promise;}});
      await wait;
    },
    async fetch(path,mode='same-origin',method='GET') {
      let response;
      handlers.get('fetch')({request:{url:new URL(path,origin).href,method,mode},respondWith:promise=>{response=promise;}});
      return response ? await response : undefined;
    }
  };
}

function appAsset(path, {marker = true, legacy = false} = {}) {
  const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html';
  const headers = {'Content-Type': `${type}; charset=utf-8`};
  if(marker) headers['X-PeraGym-App']='1';
  if(legacy) headers['X-PeraGym-Protected']='1';
  return new Response(path,{headers});
}

async function seedOldShell(harness) {
  const cache = await harness.cacheApi.open('peragym-2.0.0-app');
  for (const path of ['/app/index.html','/app/style.css','/app/app.js','/app/db.js','/app/charts.js']) await cache.put(`${origin}${path}`,appAsset(path,{marker:false,legacy:true}));
}

test('manifest retains install icons, free app start URL and compatible scope', async () => {
  const manifest = JSON.parse(await readFile(new URL('../web/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(manifest.start_url,'/app/');assert.equal(manifest.id,'/app/');assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');assert.equal(manifest.lang,'pt-BR');
  assert(manifest.icons.some(icon=>icon.sizes==='192x192'&&icon.purpose==='any'));
  assert(manifest.icons.some(icon=>icon.sizes==='512x512'&&icon.purpose==='maskable'));
  for(const icon of manifest.icons){
    const bytes=await readFile(new URL(`../web${icon.src}`,import.meta.url));
    assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    const [width,height]=icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16),width);assert.equal(bytes.readUInt32BE(20),height);
  }
});

test('free offline preparation downloads the public app without calling account or payment APIs', async () => {
  const downloads=[];
  const h=harness(async url=>{
    const path=new URL(url).pathname;downloads.push(path);
    if(path.startsWith('/api/'))throw new Error('No account or donation service is available');
    return appAsset(path);
  });
  await h.prepare();
  assert.equal(h.messages.at(-1).type,'PERAGYM_OFFLINE_READY');
  assert.deepEqual(downloads.sort(),['/app/app.js','/app/charts.js','/app/db.js','/app/index.html','/app/style.css']);
});

test('complete app opens offline with no session, cookie or donation requirement', async () => {
  let online=true;
  const h=harness(async url=>{
    if(!online)throw new Error('offline');
    return appAsset(new URL(url).pathname);
  });
  await h.prepare();online=false;
  assert.equal(await (await h.fetch('/app/','navigate')).text(),'/app/index.html');
  assert.equal(await (await h.fetch('/app/db.js')).text(),'/app/db.js');
});

test('finite app assets also cache with valid MIME when a deployment omits the optional app marker', async () => {
  const h=harness(async url=>appAsset(new URL(url).pathname,{marker:false}));
  await h.prepare();
  assert.equal(h.messages.at(-1).type,'PERAGYM_OFFLINE_READY');
});

test('wrong MIME and redirected pages never become a complete application shell', async () => {
  const h=harness(async()=>new Response('an HTML error cannot be used as a JavaScript file',{headers:{'Content-Type':'text/html'}}));
  await h.prepare();
  assert.equal(h.messages.some(item=>item.type==='PERAGYM_OFFLINE_READY'),false);
  assert.equal(h.cacheData.size,0);
  const redirected=harness(async url=>{
    const response=appAsset(new URL(url).pathname);
    Object.defineProperty(response,'redirected',{value:true});
    return response;
  });
  await redirected.prepare();assert.equal(redirected.cacheData.size,0);
});

test('migration preserves an older working offline shell until the complete free replacement is available', async () => {
  let online=false;
  const h=harness(async url=>{
    if(!online)throw new Error('temporarily offline');
    return appAsset(new URL(url).pathname);
  });
  await seedOldShell(h);await h.prepare();
  assert(h.cacheData.has('peragym-2.0.0-app'));
  assert.equal(await (await h.fetch('/app/','navigate')).text(),'/app/index.html');
  online=true;await h.prepare();
  assert(h.cacheData.has('peragym-2.1.0-app'));assert.equal(h.cacheData.has('peragym-2.0.0-app'),false);
  assert.equal(h.messages.at(-1).type,'PERAGYM_OFFLINE_READY');
});

test('transient asset failures preserve the offline app and never touch the local database', async () => {
  let failed=false;
  const h=harness(async url=>failed?new Response('temporarily unavailable',{status:503}):appAsset(new URL(url).pathname));
  await h.prepare();failed=true;await h.prepare();
  assert.equal((await h.fetch('/app/','navigate')).status,200);
  assert(h.cacheData.has('peragym-2.1.0-app'));
  assert.equal(workerSource.includes('indexedDB.deleteDatabase'),false);
});

test('donation APIs, session failures, admin, sign-in and unknown URLs are never intercepted or cached', async () => {
  const h=harness(async url=>appAsset(new URL(url).pathname));
  await h.prepare();const names=[...h.cacheData.keys()];
  for(const path of ['/api/donation','/api/session','/api/orders','/admin','/admin/orders','/signin-with-chatgpt','/callback','/app/unknown.js','https://external.example/app/'])assert.equal(await h.fetch(path),undefined);
  assert.equal(await h.fetch('/app/app.js','same-origin','POST'),undefined);
  assert.deepEqual([...h.cacheData.keys()],names);
});

test('installation guidance is independent of orders and explains local storage on iOS', async () => {
  const script=await readFile(new URL('../web/pwa.js',import.meta.url),'utf8');
  assert.equal(script.includes('PERAGYM_LICENSE_REQUIRED'),false);
  assert.equal(script.includes('arquivo de acesso do seu pedido'),false);
  assert(script.includes('Safari e o aplicativo podem manter bancos locais separados'));
});
