import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://peragym.example';
const assets={
  '/index.html':{body:'<h1>PeraGym grátis</h1>',type:'text/html; charset=utf-8'},
  '/app/index.html':{body:'<h1>Seu treino gratuito</h1>',type:'text/html; charset=utf-8'},
  '/app/style.css':{body:'body { color: #974859 }',type:'text/css; charset=utf-8'},
  '/app/app.js':{body:'const freeApplication = true;',type:'application/javascript; charset=utf-8'},
  '/app/db.js':{body:'const deviceLocalDatabase = true;',type:'application/javascript; charset=utf-8'},
  '/app/charts.js':{body:'const localCharts = true;',type:'application/javascript; charset=utf-8'},
  '/sw.js':{body:'self.addEventListener("fetch", () => {});',type:'application/javascript; charset=utf-8'},
  '/manifest.webmanifest':{body:'{"start_url":"/app/"}',type:'application/manifest+json'},
  '/icons/icon-192.png':{body:'UEc=',encoding:'base64',type:'image/png'},
};
let temporaryDirectory,worker,workerModule;

before(async()=>{
  temporaryDirectory=await mkdtemp(join(tmpdir(),'peragym-free-tests-'));
  const output=join(temporaryDirectory,'worker.mjs');
  await build({entryPoints:[join(root,'server/worker.js')],outfile:output,bundle:true,format:'esm',platform:'neutral',define:{__PERAGYM_ASSETS__:JSON.stringify(assets)},logLevel:'silent'});
  workerModule=await import(pathToFileURL(output).href);
  worker=workerModule.default;
});
after(async()=>{if(temporaryDirectory)await rm(temporaryDirectory,{recursive:true,force:true});});

function harness(){
  let databaseCalls=0;
  const neverUseDatabase=new Proxy({}, {get(){databaseCalls++;throw new Error('The free application must never query the former purchase database.');}});
  const env={DB:neverUseDatabase,ADMIN_EMAIL:'former-owner@example.com'};
  const request=async(path,{method='GET',body,headers={}}={})=>{
    const requestHeaders=new Headers(headers);
    if(body!==undefined){requestHeaders.set('Content-Type','application/json');requestHeaders.set('Origin',origin);}
    const response=await worker.fetch(new Request(origin+path,{method,headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body)}),env,{});
    assert.equal(databaseCalls,0,'No free-app or donation request may read or write the old purchase database.');
    assert.equal(response.headers.get('Set-Cookie'),null,'The free app must not issue a purchase/license cookie.');
    return response;
  };
  return {request};
}

const oldIdentity={
  'oai-authenticated-user-id':'former-owner-id',
  'oai-authenticated-user-email':'former-owner@example.com',
  Cookie:'__Host-peragym_session=previous-license-cookie',
  Authorization:`Bearer ${'A'.repeat(43)}`,
};

test('configuration advertises free access and an optional fixed donation without database setup',async()=>{
  const h=harness(),response=await h.request('/api/config');
  assert.equal(response.status,200);
  const value=await response.json();
  assert.equal(value.freeAccess,true);assert.equal(value.priceCents,0);assert.equal(value.salesEnabled,false);
  assert.equal(value.donationAmountCents,199);assert.equal(value.paymentMode,'donation');assert.equal(value.currency,'BRL');
  assert.equal(value.pixKey,'bruno.pera@unifesp.br');assert.equal(value.appUrl,'/app/');assert.equal(value.downloadUrl,'/download');
});

test('session is free for an anonymous visitor and never requires a license or owner identity',async()=>{
  const h=harness();
  for(const headers of [{},oldIdentity]){
    const response=await h.request('/api/session',{headers});assert.equal(response.status,200);
    const session=await response.json();assert.equal(session.licensed,true);assert.equal(session.freeAccess,true);assert.equal(session.owner,false);
  }
  const response=await worker.fetch(new Request(origin+'/api/session'),{},{});
  assert.equal(response.status,200,'The Worker also works when no DB binding or owner setting exists.');
  assert.equal((await response.json()).freeAccess,true);
});

test('donation returns a valid R$1.99 Pix and leaves app access independent of contribution',async()=>{
  const h=harness(),response=await h.request('/api/donation?amountCents=999999&paid=true');
  assert.equal(response.status,200);
  const donation=await response.json();
  assert.equal(donation.amountCents,199);assert.equal(donation.optional,true);assert.equal(donation.currency,'BRL');
  assert.equal(donation.pixKey,'bruno.pera@unifesp.br');assert.equal(donation.appUrl,'/app/');assert.equal(donation.downloadUrl,'/download');
  assert.ok(donation.pixPayload.includes('54041.99'),'Pix payload carries precisely R$1.99.');
  assert.ok(donation.pixPayload.includes('PERAGYMAPOIO'),'The optional contribution uses the donation identifier.');
  assert.ok(donation.pixPayload.includes('bruno.pera@unifesp.br'));
  assert.equal(donation.pixPayload.slice(-4),workerModule.crc16(donation.pixPayload.slice(0,-4)));
  assert.ok(donation.qrDataUrl.startsWith('data:image/svg+xml;base64,'));
  const svg=Buffer.from(donation.qrDataUrl.split(',')[1],'base64').toString('utf8');assert.ok(svg.includes('<svg'));
  assert.equal('accessToken' in donation,false);assert.equal('orderId' in donation,false);assert.equal('claimUrl' in donation,false);
  const app=await h.request('/app/');assert.equal(app.status,200,'Viewing the app does not wait for a donation receipt.');
});

test('all application files are available without payment, login, cookies or a server database',async()=>{
  const h=harness();
  for(const path of ['/app/','/app/index.html','/app/style.css','/app/app.js','/app/db.js','/app/charts.js']){
    const response=await h.request(path);
    assert.equal(response.status,200,path);assert.equal(response.headers.get('X-PeraGym-App'),'1',path);
    assert.equal(response.headers.get('X-PeraGym-Protected'),null,path);
    assert.equal(response.headers.get('Location'),null,path);
  }
  const oldCookie=await h.request('/app/app.js',{headers:oldIdentity});assert.equal(oldCookie.status,200);
  assert.match(await oldCookie.text(),/freeApplication/);
});

test('download leads directly to app installation and never to a checkout page',async()=>{
  const h=harness(),response=await h.request('/download');
  assert.equal(response.status,303);
  assert.equal(response.headers.get('Location'),'/app/?instalar=1');
  const destination=await h.request(response.headers.get('Location'));assert.equal(destination.status,200);
});

test('old order and claim endpoints are retired and cannot create records or unlock flows',async()=>{
  const h=harness();
  const routes=[
    ['/api/orders','POST'],
    ['/api/orders/PGABCDEF0123456789ABCD','GET'],
    ['/api/orders/PGABCDEF0123456789ABCD/claim','POST'],
  ];
  for(const [path,method] of routes){
    const response=await h.request(path,{method,headers:oldIdentity,body:method==='POST'?{name:'Legacy buyer',email:'legacy@example.com',paid:true}:undefined});
    assert.equal(response.status,410,path);const result=await response.json();
    assert.equal(result.appUrl,'/app/',path);assert.ok(result.error,path);
    assert.equal('accessToken' in result,false,path);assert.equal('claimUrl' in result,false,path);
  }
});

test('legacy bank approval and admin APIs are retired even with a former owner identity',async()=>{
  const h=harness();
  for(const path of ['/api/admin/state','/api/admin/config','/api/admin/orders/PGABCDEF0123456789ABCD/approve']){
    const method=path.endsWith('/state')?'GET':'POST';
    const response=await h.request(path,{method,headers:oldIdentity,body:method==='POST'?{confirmedInBank:true,bankReference:'OLD-REFERENCE',priceCents:199,salesEnabled:true}:undefined});
    assert.equal(response.status,410,path);assert.equal((await response.json()).appUrl,'/app/',path);
  }
  for(const path of ['/admin','/admin/']){
    const response=await h.request(path,{headers:oldIdentity});assert.equal(response.status,303,path);assert.equal(response.headers.get('Location'),'/',path);
  }
});

test('read-only free and donation APIs reject state-changing methods',async()=>{
  const h=harness();
  for(const path of ['/api/config','/api/donation','/api/session']){
    for(const method of ['POST','PATCH','DELETE']){
      const response=await h.request(path,{method,body:{priceCents:100,amountCents:100,status:'paid'}});
      assert.equal(response.status,405,`${method} ${path}`);
    }
  }
});

test('HEAD keeps the same free routes and headers while returning no body',async()=>{
  const h=harness();
  for(const path of ['/api/config','/api/donation','/api/session','/app/','/app/app.js','/']){
    const response=await h.request(path,{method:'HEAD'});assert.equal(response.status,200,path);assert.equal(await response.text(),'',path);
  }
});

test('unknown paths remain unavailable and security headers are retained',async()=>{
  const h=harness();
  assert.equal((await h.request('/app/not-a-real-file.js')).status,404);
  assert.equal((await h.request('/api/not-a-real-route')).status,404);
  const response=await h.request('/');assert.equal(response.status,200);
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  const policy=response.headers.get('Content-Security-Policy');assert.ok(policy.includes("script-src 'self'"));assert.ok(policy.includes("object-src 'none'"));assert.equal(policy.includes("'unsafe-inline'"),false);
  const sw=await h.request('/sw.js');assert.equal(sw.headers.get('Service-Worker-Allowed'),'/');assert.equal(sw.headers.get('Cache-Control'),'no-cache');
});

test('Pix CRC still matches the Banco Central reference vector',()=>{
  const reference='00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
  assert.equal(workerModule.crc16(reference),'1D3D');
});
