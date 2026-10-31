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

const authorizedAsset = body => new Response(body,{headers:{'X-PeraGym-Protected':'1','Content-Type':'text/javascript'}});

test('manifest has real install icons, protected start URL, and platform-compatible scope', async () => {
  const manifest = JSON.parse(await readFile(new URL('../web/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(manifest.start_url,'/app/');
  assert.equal(manifest.id,'/app/');
  assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.lang,'pt-BR');
  assert(manifest.icons.some(icon=>icon.sizes==='192x192'&&icon.purpose==='any'));
  assert(manifest.icons.some(icon=>icon.sizes==='512x512'&&icon.purpose==='maskable'));
  for(const icon of manifest.icons){
    const bytes=await readFile(new URL(`../web${icon.src}`,import.meta.url));
    assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    const [width,height]=icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16),width);assert.equal(bytes.readUInt32BE(20),height);
  }
});

test('a browser message cannot unlock a download without a licensed server session', async () => {
  const downloads=[];
  const h=harness(async url=>{
    if(new URL(url).pathname==='/api/session')return Response.json({licensed:false});
    downloads.push(url);return authorizedAsset('sensitive app');
  });
  await h.prepare();
  assert.equal(downloads.length,0);
  assert.equal(h.messages.at(-1).type,'PERAGYM_LICENSE_REQUIRED');
  assert.equal([...h.cacheData.keys()].filter(name=>name.endsWith('-app')).length,0);
});

test('licensed shell is prepared, and then opens offline without calling the server', async () => {
  let online=true;
  const h=harness(async url=>{
    if(!online)throw new Error('offline');
    return new URL(url).pathname==='/api/session'?Response.json({licensed:true}):authorizedAsset(new URL(url).pathname);
  });
  await h.prepare();
  assert.equal(h.messages.at(-1).type,'PERAGYM_OFFLINE_READY');
  online=false;
  assert.equal(await (await h.fetch('/app/','navigate')).text(),'/app/index.html');
  assert.equal(await (await h.fetch('/app/db.js')).text(),'/app/db.js');
});

test('ordinary 200 pages and redirects never become a paid shell', async () => {
  const h=harness(async url=>new URL(url).pathname==='/api/session'?Response.json({licensed:true}):new Response('marketing or sign-in'));
  await h.prepare();
  assert.equal(h.messages.some(item=>item.type==='PERAGYM_OFFLINE_READY'),false);
  for(const data of h.cacheData.values())assert.equal(data.size,0);
});

test('online auth failure clears shell cache, not the user database', async () => {
  let revoked=false;
  const h=harness(async url=>{
    if(new URL(url).pathname==='/api/session')return Response.json({licensed:true});
    return revoked?new Response('purchase required',{status:403}):authorizedAsset('paid');
  });
  await h.prepare();
  assert([...h.cacheData.keys()].some(name=>name.endsWith('-app')));
  revoked=true;
  assert.equal((await h.fetch('/app/','navigate')).status,403);
  assert.equal([...h.cacheData.keys()].filter(name=>name.endsWith('-app')).length,0);
  assert.equal(h.messages.at(-1).type,'PERAGYM_LICENSE_REQUIRED');
  assert.equal(workerSource.includes('indexedDB.deleteDatabase'),false);
});

test('session 401 also removes an existing offline shell', async () => {
  let revoked=false;
  const h=harness(async url=>{
    if(new URL(url).pathname==='/api/session')return revoked?new Response('',{status:401}):Response.json({licensed:true});
    return authorizedAsset('paid');
  });
  await h.prepare();revoked=true;await h.prepare();
  assert.equal([...h.cacheData.keys()].filter(name=>name.endsWith('-app')).length,0);
});

test('payment APIs, administration and sign-in are never intercepted or cached', async () => {
  const h=harness(async()=>{throw new Error('unexpected worker fetch');});
  for(const path of ['/api/orders','/api/session','/admin','/admin/orders','/signin-with-chatgpt','/callback'])assert.equal(await h.fetch(path),undefined);
  assert.equal(await h.fetch('/app/app.js','same-origin','POST'),undefined);
  assert.equal(h.cacheData.size,0);
});
