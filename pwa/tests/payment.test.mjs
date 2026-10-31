import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://peragym.example';
const cookieName='__Host-peragym_session';
const assets={
  '/index.html':{body:'<h1>PeraGym promoção</h1>',type:'text/html; charset=utf-8'},
  '/app/index.html':{body:'<h1>PeraGym privado</h1>',type:'text/html; charset=utf-8'},
  '/app/style.css':{body:'body { color: #974859 }',type:'text/css; charset=utf-8'},
  '/app/app.js':{body:'const privateApplication = true;',type:'application/javascript; charset=utf-8'},
  '/admin/index.html':{body:'<h1>Administração</h1>',type:'text/html; charset=utf-8'},
  '/sw.js':{body:'self.addEventListener("fetch", () => {});',type:'application/javascript; charset=utf-8'},
};
let temporaryDirectory,worker,paymentModule,sqlMigrations;

/** D1's asynchronous result shape over Node's real SQLite engine. */
class LocalD1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys = ON');}
  prepare(sql){
    const database=this.sqlite;
    const statement=(parameters=[])=>({
      bind(...values){return statement(values);},
      async first(column){const row=database.prepare(sql).get(...parameters);return row?(column?row[column]:row):null;},
      async all(){return {success:true,results:database.prepare(sql).all(...parameters),meta:{changes:0}};},
      async run(){const result=database.prepare(sql).run(...parameters);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},
    });
    return statement();
  }
  close(){this.sqlite.close();}
}

before(async()=>{
  temporaryDirectory=await mkdtemp(join(tmpdir(),'peragym-payments-'));
  const output=join(temporaryDirectory,'worker.mjs');
  await build({entryPoints:[join(root,'server/worker.js')],outfile:output,bundle:true,format:'esm',platform:'neutral',define:{__PERAGYM_ASSETS__:JSON.stringify(assets)},logLevel:'silent'});
  paymentModule=await import(pathToFileURL(output).href);
  worker=paymentModule.default;
  const directory=join(root,'drizzle');
  sqlMigrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort().map(name=>readFile(join(directory,name),'utf8')));
  assert.ok(sqlMigrations.length,'Generated SQL migrations must be included in the project.');
});

after(async()=>{if(temporaryDirectory)await rm(temporaryDirectory,{recursive:true,force:true});});

function harness(){
  const DB=new LocalD1();
  for(const sql of sqlMigrations)DB.sqlite.exec(sql);
  const env={DB,ADMIN_EMAIL:'owner@example.com'};
  const request=async(path,{method='GET',body,headers={}}={})=>{
    const requestHeaders=new Headers(headers);
    if(body!==undefined){requestHeaders.set('Content-Type','application/json');if(!requestHeaders.has('Origin'))requestHeaders.set('Origin',origin);}
    const response=await worker.fetch(new Request(origin+path,{method,headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body)}),env,{});
    return response;
  };
  return {DB,env,request,close:()=>DB.close()};
}

const ownerHeaders={
  'oai-authenticated-user-id':'site-owner-123',
  'oai-authenticated-user-email':'owner@example.com',
  'oai-authenticated-user-full-name':'Responsável PeraGym',
};
const otherHeaders={
  'oai-authenticated-user-id':'site-other-456',
  'oai-authenticated-user-email':'other@example.com',
};
const auth=token=>({Authorization:`Bearer ${token}`});
const hashed=value=>createHash('sha256').update(value).digest('hex');

async function enableSales(h,priceCents=2990){
  const response=await h.request('/api/admin/config',{method:'POST',headers:ownerHeaders,body:{priceCents,salesEnabled:true}});
  assert.equal(response.status,200,await response.clone().text());
}

async function newOrder(h,overrides={}){
  const response=await h.request('/api/orders',{method:'POST',body:{name:'Pessoa Compradora',email:'buyer@example.com',...overrides}});
  assert.equal(response.status,201,await response.clone().text());
  return response.json();
}

async function approve(h,order,reference='E2E-EXTRATO-TESTE-001',headers=ownerHeaders){
  return h.request(`/api/admin/orders/${order.id}/approve`,{method:'POST',headers,body:{bankReference:reference,confirmedInBank:true}});
}

test('new installation has no invented price and refuses purchases while paused',async()=>{
  const h=harness();try{
    const configuration=await (await h.request('/api/config')).json();
    assert.equal(configuration.priceCents,null);
    assert.equal(configuration.salesEnabled,false);
    assert.equal(configuration.pixKey,'bruno.pera@unifesp.br');
    assert.equal(configuration.paymentMode,'manual');
    const order=await h.request('/api/orders',{method:'POST',body:{name:'Comprador',email:'buyer@example.com',priceCents:1}});
    assert.equal(order.status,409);
    assert.equal(h.DB.sqlite.prepare('SELECT COUNT(*) AS total FROM orders').get().total,0);
  }finally{h.close();}
});

test('owner bootstrap requires trusted identity and binds the stable user ID',async()=>{
  const h=harness();try{
    assert.equal((await h.request('/api/admin/state')).status,401);
    assert.equal((await h.request('/api/admin/state',{headers:otherHeaders})).status,403);
    assert.equal(h.DB.sqlite.prepare("SELECT value FROM settings WHERE key = 'admin_user_id'").get(),undefined);
    const first=await h.request('/api/admin/state',{headers:ownerHeaders});
    assert.equal(first.status,200);
    assert.equal(h.DB.sqlite.prepare("SELECT value FROM settings WHERE key = 'admin_user_id'").get().value,'site-owner-123');
    const changedEmail={...ownerHeaders,'oai-authenticated-user-email':'renamed@example.com'};
    assert.equal((await h.request('/api/admin/state',{headers:changedEmail})).status,200,'Stable identity remains the administrator after an email change.');
    const wrongIdSameEmail={...ownerHeaders,'oai-authenticated-user-id':'another-user'};
    assert.equal((await h.request('/api/admin/state',{headers:wrongIdSameEmail})).status,403,'An email match cannot replace the established owner.');
  }finally{h.close();}
});

test('the buyer cannot tamper with price, status or stored token and cannot enumerate orders',async()=>{
  const h=harness();try{
    await enableSales(h,2990);
    const order=await newOrder(h,{priceCents:1,status:'paid'});
    assert.equal(order.priceCents,2990);
    assert.equal(order.status,'pending');
    assert.match(order.accessToken,/^[A-Za-z0-9_-]{43}$/);
    assert.ok(order.qrDataUrl.startsWith('data:image/svg+xml;base64,'));
    assert.ok(order.pixPayload.includes('540529.90'));
    const stored=h.DB.sqlite.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    assert.equal(stored.price_cents,2990);
    assert.equal(stored.status,'pending');
    assert.notEqual(stored.token_hash,order.accessToken);
    assert.equal(stored.token_hash,hashed(order.accessToken));
    assert.equal((await h.request(`/api/orders/${order.id}`)).status,404);
    assert.equal((await h.request(`/api/orders/${order.id}`,{headers:auth('A'.repeat(43))})).status,404);
    const authorized=await h.request(`/api/orders/${order.id}`,{headers:auth(order.accessToken)});
    assert.equal(authorized.status,200);
    const detail=await authorized.json();
    assert.equal(detail.email,'buyer@example.com');
    assert.equal('token_hash' in detail,false);
    assert.equal('accessToken' in detail,false);
    assert.equal((await h.request('/api/orders')).status,404);
  }finally{h.close();}
});

test('unpaid buyers cannot claim, download or retrieve any protected app asset',async()=>{
  const h=harness();try{
    await enableSales(h);
    const order=await newOrder(h);
    const claim=await h.request(`/api/orders/${order.id}/claim`,{method:'POST',headers:{...auth(order.accessToken),Origin:origin}});
    assert.equal(claim.status,403);
    assert.equal(claim.headers.get('Set-Cookie'),null);
    assert.equal(h.DB.sqlite.prepare('SELECT COUNT(*) AS total FROM licenses').get().total,0);
    for(const path of ['/app/','/app/index.html','/app/style.css','/app/app.js','/download']){
      const response=await h.request(path,{headers:auth(order.accessToken)});
      assert.ok([303,403].includes(response.status),path);
      assert.equal(response.headers.get('X-PeraGym-Protected'),null,path);
      assert.equal((await response.text()).includes('privateApplication'),false,path);
    }
    assert.equal((await (await h.request('/api/session')).json()).licensed,false);
  }finally{h.close();}
});

test('approval requires owner, bank confirmation and a unique bank reference',async()=>{
  const h=harness();try{
    await enableSales(h);
    const first=await newOrder(h),second=await newOrder(h,{email:'second@example.com'});
    assert.equal((await approve(h,first,'E2E-EXTRATO-TESTE-001',otherHeaders)).status,403);
    const noAcknowledgment=await h.request(`/api/admin/orders/${first.id}/approve`,{method:'POST',headers:ownerHeaders,body:{bankReference:'E2E-EXTRATO-TESTE-001'}});
    assert.equal(noAcknowledgment.status,400);
    const shortReference=await h.request(`/api/admin/orders/${first.id}/approve`,{method:'POST',headers:ownerHeaders,body:{bankReference:'ABC',confirmedInBank:true}});
    assert.equal(shortReference.status,400);
    assert.equal((await approve(h,first,' e2e-extrato-teste-001 ')).status,200);
    const stored=h.DB.sqlite.prepare('SELECT status,bank_reference,approved_by FROM orders WHERE id = ?').get(first.id);
    assert.equal(stored.status,'paid');assert.equal(stored.bank_reference,'E2E-EXTRATO-TESTE-001');assert.equal(stored.approved_by,'site-owner-123');
    assert.equal((await approve(h,first,'E2E-EXTRATO-TESTE-001')).status,200,'Identical manual confirmation is idempotent.');
    assert.equal((await approve(h,first,'DIFFERENT-BANK-REFERENCE')).status,409);
    assert.equal((await approve(h,second,'E2E-EXTRATO-TESTE-001')).status,409,'A single received transfer cannot unlock two orders.');
    assert.equal(h.DB.sqlite.prepare('SELECT status FROM orders WHERE id = ?').get(second.id).status,'pending');
    const rejection=await h.request(`/api/admin/orders/${first.id}/reject`,{method:'POST',headers:ownerHeaders,body:{reason:'Não foi localizado'}});
    assert.equal(rejection.status,409,'A paid order cannot be rejected through the pending review action.');
  }finally{h.close();}
});

test('paid claim issues a secure HttpOnly cookie and gates app assets server-side',async()=>{
  const h=harness();try{
    await enableSales(h);
    const order=await newOrder(h);assert.equal((await approve(h,order)).status,200);
    const claim=await h.request(`/api/orders/${order.id}/claim`,{method:'POST',headers:{...auth(order.accessToken),Origin:origin}});
    assert.equal(claim.status,200);
    const header=claim.headers.get('Set-Cookie');
    assert.match(header,new RegExp(`^${cookieName}=[A-Za-z0-9_-]{43};`));
    assert.match(header,/; HttpOnly;/);assert.match(header,/; Secure;/);assert.match(header,/; SameSite=Lax;/);assert.match(header,/; Path=\//);
    const cookie=header.split(';')[0],token=cookie.slice(cookieName.length+1);
    const stored=h.DB.sqlite.prepare('SELECT * FROM licenses').get();
    assert.equal(stored.token_hash,hashed(token));assert.notEqual(stored.token_hash,token);
    assert.equal((await (await h.request('/api/session',{headers:{Cookie:cookie}})).json()).licensed,true);
    for(const path of ['/app/','/app/index.html','/app/style.css','/app/app.js']){
      const response=await h.request(path,{headers:{Cookie:cookie}});
      assert.equal(response.status,200,path);assert.equal(response.headers.get('X-PeraGym-Protected'),'1',path);
      assert.equal(response.headers.get('Cache-Control'),'private, no-store',path);
    }
    const fake=await h.request('/app/style.css',{headers:{Cookie:`${cookieName}=${'A'.repeat(43)}`}});
    assert.equal(fake.status,403);
    const duplicate=await h.request('/app/style.css',{headers:{Cookie:`${cookie}; ${cookie}`}});
    assert.equal(duplicate.status,403,'Duplicate cookie names fail closed.');
    assert.equal((await h.request('/download',{headers:{Cookie:cookie}})).headers.get('Location'),'/app/?instalar=1');
  }finally{h.close();}
});

test('cross-origin writes fail before altering configuration, orders or licenses',async()=>{
  const h=harness();try{
    await enableSales(h);
    const order=await newOrder(h);assert.equal((await approve(h,order)).status,200);
    const badConfig=await h.request('/api/admin/config',{method:'POST',headers:{...ownerHeaders,Origin:'https://attacker.example'},body:{priceCents:100,salesEnabled:false}});
    assert.equal(badConfig.status,403);
    const badOrder=await h.request('/api/orders',{method:'POST',headers:{Origin:'https://attacker.example'},body:{name:'Outra pessoa',email:'third@example.com'}});
    assert.equal(badOrder.status,403);
    const badClaim=await h.request(`/api/orders/${order.id}/claim`,{method:'POST',headers:{...auth(order.accessToken),Origin:'https://attacker.example'}});
    assert.equal(badClaim.status,403);
    const badFetchSite=await h.request('/api/admin/config',{method:'POST',headers:{...ownerHeaders,'Sec-Fetch-Site':'cross-site'},body:{priceCents:100,salesEnabled:false}});
    assert.equal(badFetchSite.status,403);
    assert.equal(h.DB.sqlite.prepare('SELECT COUNT(*) AS total FROM orders').get().total,1);
    assert.equal(h.DB.sqlite.prepare('SELECT COUNT(*) AS total FROM licenses').get().total,0);
    assert.equal((await (await h.request('/api/config')).json()).priceCents,2990);
  }finally{h.close();}
});

test('owner can pause new sales without changing existing orders or granting access',async()=>{
  const h=harness();try{
    await enableSales(h,1990);const order=await newOrder(h);
    const response=await h.request('/api/admin/config',{method:'POST',headers:ownerHeaders,body:{priceCents:3990,salesEnabled:false}});
    assert.equal(response.status,200);
    const blocked=await h.request('/api/orders',{method:'POST',body:{name:'Nova pessoa',email:'new@example.com'}});
    assert.equal(blocked.status,409);
    const original=await (await h.request(`/api/orders/${order.id}`,{headers:auth(order.accessToken)})).json();
    assert.equal(original.priceCents,1990);assert.equal(original.status,'pending');
    assert.equal((await h.request(`/api/orders/${order.id}/claim`,{method:'POST',headers:auth(order.accessToken)})).status,403);
  }finally{h.close();}
});

test('admin responses exclude buyer access tokens and public routes carry security headers',async()=>{
  const h=harness();try{
    await enableSales(h);const order=await newOrder(h);
    const stateResponse=await h.request('/api/admin/state',{headers:ownerHeaders});
    const text=await stateResponse.text();
    assert.equal(text.includes(order.accessToken),false);assert.equal(text.includes(hashed(order.accessToken)),false);
    assert.equal(stateResponse.headers.get('Cache-Control'),'private, no-store');
    assert.equal(stateResponse.headers.get('X-Content-Type-Options'),'nosniff');
    const landing=await h.request('/');assert.equal(landing.status,200);
    const csp=landing.headers.get('Content-Security-Policy');assert.ok(csp.includes("script-src 'self'"));assert.ok(csp.includes("object-src 'none'"));
    const sw=await h.request('/sw.js');assert.equal(sw.headers.get('Service-Worker-Allowed'),'/');assert.equal(sw.headers.get('Cache-Control'),'no-cache');
  }finally{h.close();}
});


test('Pix CRC matches the Banco Central reference vector and rejects invalid amounts',()=>{
  const reference='00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
  assert.equal(paymentModule.crc16(reference),'1D3D');
  const payload=paymentModule.pixPayload(2990,'PGABCDEF0123456789ABCD');
  assert.equal(payload.slice(-4),paymentModule.crc16(payload.slice(0,-4)));
  assert.ok(payload.includes('bruno.pera@unifesp.br'));
  assert.throws(()=>paymentModule.pixPayload(99,'ORDER1'));
  assert.throws(()=>paymentModule.pixPayload(2990.1,'ORDER1'));
  assert.throws(()=>paymentModule.pixPayload(2990,'INVALID-TXID'));
});
