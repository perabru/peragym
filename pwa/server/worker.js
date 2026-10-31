import qrcode from 'qrcode-generator';

// Replaced with a build-time map by scripts/embed-assets.mjs. Protected assets
// exist inside the Worker, never in a public static assets directory.
const ASSETS = __PERAGYM_ASSETS__;
export const PIX_KEY = 'bruno.pera@unifesp.br';
const COOKIE = '__Host-peragym_session';
const OWNER_SETTING = 'admin_user_id';
const PRICE_SETTING = 'sale_config';
const YEAR = 365 * 24 * 60 * 60;
const enc = new TextEncoder();
const currency = 'BRL';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com";

class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
function fail(status,message){throw new HttpError(status,message);}
function json(value,status=200,extra={}){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store',...extra}});}
function redirect(location,status=303){return new Response(null,{status,headers:{Location:location,'Cache-Control':'private, no-store'}});}
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');}
function randomToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function digest(text){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))));}
function tokenFrom(request){const value=request.headers.get('Authorization')||'';return /^Bearer [A-Za-z0-9_-]{43}$/.test(value)?value.slice(7):null;}
function cookieFrom(request){const parts=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));return parts.length===1?parts[0].slice(COOKIE.length+1):null;}
function needDB(env){if(!env.DB)fail(503,'O serviço de compras está sendo preparado. Tente novamente mais tarde.');return env.DB;}
function onlySameOrigin(request){
  const origin=request.headers.get('Origin');
  if((origin&&origin!==new URL(request.url).origin)||request.headers.get('Sec-Fetch-Site')==='cross-site')fail(403,'Origem da solicitação não permitida.');
}
async function body(request){
  onlySameOrigin(request);
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))fail(415,'Envie os dados em JSON.');
  if(Number(request.headers.get('Content-Length')||0)>8192)fail(413,'Solicitação muito grande.');
  const text=await request.text();if(enc.encode(text).length>8192)fail(413,'Solicitação muito grande.');
  try {const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{fail(400,'Dados inválidos.');}
}
function text(value,label,min,max){if(typeof value!=='string')fail(400,`Preencha ${label}.`);const v=value.trim();if(v.length<min||v.length>max)fail(400,`Preencha ${label} com ${min} a ${max} caracteres.`);return v;}

export function crc16(value){let crc=0xffff;for(const byte of enc.encode(value)){crc^=byte<<8;for(let i=0;i<8;i++)crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff;}return crc.toString(16).toUpperCase().padStart(4,'0');}
function field(id,value){const size=enc.encode(value).length;if(size>99)throw new Error('Pix field too long');return id+String(size).padStart(2,'0')+value;}
export function pixPayload(priceCents,txid,key=PIX_KEY){
  if(!Number.isInteger(priceCents)||priceCents<100||priceCents>99999900||!/^[A-Za-z0-9]{1,25}$/.test(txid))throw new Error('Invalid Pix amount or transaction identifier');
  const account=field('00','br.gov.bcb.pix')+field('01',key);
  const value=field('00','01')+field('26',account)+field('52','0000')+field('53','986')+field('54',(priceCents/100).toFixed(2))+field('58','BR')+field('59','BRUNO MICHEL PERA')+field('60','BRASIL')+field('62',field('05',txid))+'6304';
  return value+crc16(value);
}
function qrUrl(payload){const qr=qrcode(0,'M');qr.addData(payload,'Byte');qr.make();return 'data:image/svg+xml;base64,'+btoa(qr.createSvgTag({cellSize:4,margin:16,scalable:true}));}
async function getSetting(db,key){return (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first())?.value??null;}
async function config(db){
  let stored={};const value=db?await getSetting(db,PRICE_SETTING):null;
  if(value){try{stored=JSON.parse(value);}catch{/* Fail closed if configuration is invalid. */}}
  const price=Number.isInteger(stored.priceCents)&&stored.priceCents>=100&&stored.priceCents<=99999900?stored.priceCents:null;
  return {priceCents:price,salesEnabled:stored.salesEnabled===true&&price!==null,pixKey:PIX_KEY,paymentMode:'manual',currency,merchantName:'BRUNO MICHEL PERA',merchantCity:'BRASIL'};
}
async function isOwner(request,env){
  const id=request.headers.get('oai-authenticated-user-id');if(!id||!env.DB)return false;
  const current=await getSetting(env.DB,OWNER_SETTING);if(current)return current===id;
  // Only a dispatch-authenticated, verified owner email can bootstrap the stable
  // per-Site ID. Thereafter email changes cannot silently change administrators.
  const email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if(!env.ADMIN_EMAIL||email!==env.ADMIN_EMAIL.trim().toLowerCase())return false;
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind(OWNER_SETTING,id).run();
  return await getSetting(env.DB,OWNER_SETTING)===id;
}
async function entitled(request,env,owner){
  if(owner)return true;const token=cookieFrom(request);if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token)||!env.DB)return false;
  const row=await env.DB.prepare("SELECT orders.status FROM licenses JOIN orders ON orders.id = licenses.order_id WHERE licenses.token_hash = ?").bind(await digest(token)).first();
  return row?.status==='paid';
}
function ownerDisplay(request){let name=request.headers.get('oai-authenticated-user-full-name')||'';if(request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8'){try{name=decodeURIComponent(name);}catch{name='';}}return {name,email:request.headers.get('oai-authenticated-user-email')||''};}
function publicOrder(row){return {id:row.id,name:row.name,email:row.email,priceCents:row.price_cents,status:row.status,createdAt:row.created_at,approvedAt:row.approved_at,bankReference:row.bank_reference,rejectionReason:row.rejection_reason};}
async function ownOrder(request,env,id){
  if(!/^PG[A-F0-9]{20}$/.test(id))fail(404,'Pedido não encontrado.');
  const token=tokenFrom(request);if(!token)fail(404,'Pedido não encontrado ou chave de acesso inválida.');
  const row=await needDB(env).prepare('SELECT * FROM orders WHERE id = ? AND token_hash = ?').bind(id,await digest(token)).first();
  if(!row)fail(404,'Pedido não encontrado ou chave de acesso inválida.');return row;
}
async function createOrder(request,env){
  const input=await body(request);const db=needDB(env),sale=await config(db);
  if(!sale.salesEnabled)fail(409,'As vendas ainda não estão abertas.');
  const name=text(input.name,'seu nome',2,100),email=text(input.email,'seu e-mail',5,200).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Informe um e-mail válido.');
  const recent=await db.prepare('SELECT COUNT(*) AS total FROM orders WHERE email = ? AND created_at >= ?').bind(email,Date.now()-3600000).first();
  if(Number(recent?.total)>=5)fail(429,'Você já criou pedidos recentemente. Recupere seu pedido salvo ou tente mais tarde.');
  const id='PG'+crypto.randomUUID().replace(/-/g,'').slice(0,20).toUpperCase(),accessToken=randomToken(),createdAt=Date.now();
  await db.prepare('INSERT INTO orders(id,token_hash,name,email,price_cents,status,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,await digest(accessToken),name,email,sale.priceCents,'pending',createdAt).run();
  const payload=pixPayload(sale.priceCents,id);
  return json({id,accessToken,pixKey:PIX_KEY,pixPayload:payload,qrDataUrl:qrUrl(payload),priceCents:sale.priceCents,status:'pending',createdAt,paymentMode:'manual'},201);
}
async function orderRoute(request,env,id,claim){
  const row=await ownOrder(request,env,id);
  if(!claim){if(request.method!=='GET')fail(405,'Método não permitido.');return json({...publicOrder(row),claimUrl:`/api/orders/${id}/claim`});}
  if(request.method!=='POST')fail(405,'Método não permitido.');onlySameOrigin(request);
  if(row.status!=='paid')fail(403,'O Pix ainda não foi confirmado. Aguarde a conferência do recebimento.');
  const token=randomToken();await env.DB.prepare('INSERT INTO licenses(token_hash,order_id,created_at) VALUES(?,?,?)').bind(await digest(token),id,Date.now()).run();
  return json({ok:true,appUrl:'/app/'},200,{'Set-Cookie':`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${YEAR}`});
}
async function adminRoute(request,env,path,owner){
  if(!owner)fail(request.headers.get('oai-authenticated-user-id')?403:401,'Entre com a conta do responsável pelo PeraGym.');
  const db=needDB(env);
  if(path==='/api/admin/state'&&request.method==='GET'){
    const result=await db.prepare('SELECT id,name,email,price_cents,status,created_at,approved_at,bank_reference,rejection_reason FROM orders ORDER BY created_at DESC LIMIT 200').all();
    return json({config:await config(db),orders:result.results.map(publicOrder),owner:ownerDisplay(request)});
  }
  if(path==='/api/admin/config'&&request.method==='POST'){
    const input=await body(request);
    if(!Number.isInteger(input.priceCents)||input.priceCents<100||input.priceCents>99999900)fail(400,'Defina um preço de R$ 1,00 a R$ 999.999,00.');
    if(typeof input.salesEnabled!=='boolean')fail(400,'Defina o estado das vendas.');
    await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(PRICE_SETTING,JSON.stringify({priceCents:input.priceCents,salesEnabled:input.salesEnabled})).run();
    return json({ok:true,config:await config(db)});
  }
  const match=path.match(/^\/api\/admin\/orders\/(PG[A-F0-9]{20})\/(approve|reject)$/);
  if(match&&request.method==='POST'){
    const input=await body(request),id=match[1],row=await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if(!row)fail(404,'Pedido não encontrado.');
    if(match[2]==='reject'){
      if(row.status!=='pending')fail(409,'Somente pedidos pendentes podem ser recusados.');
      const reason=text(input.reason,'o motivo',3,300);
      const result=await db.prepare("UPDATE orders SET status = 'rejected', rejection_reason = ? WHERE id = ? AND status = 'pending'").bind(reason,id).run();
      if(result.meta?.changes!==1)fail(409,'O pedido já foi atualizado. Recarregue o painel.');
      return json({ok:true});
    }
    if(input.confirmedInBank!==true)fail(400,'Confirme primeiro que conferiu o recebimento no extrato bancário.');
    const reference=text(input.bankReference,'a referência bancária',6,100).toUpperCase();
    if(row.status==='paid'){if(row.bank_reference===reference)return json({ok:true});fail(409,'Este pedido já foi aprovado com outra referência bancária.');}
    if(row.status!=='pending')fail(409,'Somente pedidos pendentes podem ser aprovados.');
    try{
      const result=await db.prepare("UPDATE orders SET status = 'paid', approved_at = ?, approved_by = ?, bank_reference = ? WHERE id = ? AND status = 'pending'").bind(Date.now(),request.headers.get('oai-authenticated-user-id'),reference,id).run();
      if(result.meta?.changes!==1)fail(409,'O pedido já foi atualizado. Recarregue o painel.');
    }catch(error){if(error instanceof HttpError)throw error;if(String(error).includes('UNIQUE'))fail(409,'Esta referência de Pix já foi usada em outro pedido. Confira o extrato.');throw error;}
    return json({ok:true});
  }
  fail(404,'Página não encontrada.');
}
function asset(path,protectedAsset=false){
  const item=ASSETS[path];if(!item)return new Response('Não encontrado',{status:404});
  const bytes=item.encoding==='base64'?Uint8Array.from(atob(item.body),c=>c.charCodeAt(0)):item.body;
  return new Response(bytes,{headers:{'Content-Type':item.type,'Cache-Control':protectedAsset?'private, no-store':path==='/sw.js'?'no-cache':'public, max-age=300',...(protectedAsset?{'X-PeraGym-Protected':'1'}:{}),...(path==='/sw.js'?{'Service-Worker-Allowed':'/'}:{})}});
}
async function route(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/config'&&request.method==='GET')return json(await config(env.DB));
  const owner=path.startsWith('/api/admin/')||path.startsWith('/admin')||path.startsWith('/app')||path==='/api/session'||path==='/download'?await isOwner(request,env):false;
  if(path==='/api/session'&&request.method==='GET')return json({licensed:await entitled(request,env,owner),owner});
  if(path==='/api/orders'&&request.method==='POST')return createOrder(request,env);
  const orderMatch=path.match(/^\/api\/orders\/(PG[A-F0-9]{20})(\/claim)?$/);if(orderMatch)return orderRoute(request,env,orderMatch[1],!!orderMatch[2]);
  if(path.startsWith('/api/admin/'))return adminRoute(request,env,path,owner);
  if(path.startsWith('/api/'))fail(404,'Página não encontrada.');
  if(request.method!=='GET'&&request.method!=='HEAD')fail(405,'Método não permitido.');
  if(path==='/admin')return redirect('/admin/');
  if(path.startsWith('/admin/')){
    if(!owner){if(!request.headers.get('oai-authenticated-user-id'))return redirect('/signin-with-chatgpt?return_to=%2Fadmin%2F');fail(403,'Esta área é exclusiva do responsável pelo PeraGym.');}
    return asset(path==='/admin/'?'/admin/index.html':path,true);
  }
  if(path==='/app')return redirect('/app/');
  if(path==='/download'){
    if(!await entitled(request,env,owner))return redirect('/?acesso=necessario');return redirect('/app/?instalar=1');
  }
  if(path.startsWith('/app/')){
    if(!await entitled(request,env,owner)){
      if(path==='/app/'||path==='/app/index.html')return redirect('/?acesso=necessario');fail(403,'Confirme sua compra para acessar o aplicativo.');
    }
    return asset(path==='/app/'?'/app/index.html':path,true);
  }
  if(path==='/index.html')return redirect('/');
  if(path==='/'||path==='/offline.html'||path==='/sw.js'||path==='/manifest.webmanifest'||path==='/pwa.js'||path==='/pwa.css'||path==='/promo.css'||path==='/promo.js'||path.startsWith('/icons/'))return asset(path==='/'?'/index.html':path);
  fail(404,'Página não encontrada.');
}
export default {
  async fetch(request,env){
    let response;
    try{response=await route(request,env);}catch(error){
      response=json({error:error instanceof HttpError?error.message:'Não foi possível concluir agora. Tente novamente mais tarde.'},error instanceof HttpError?error.status:503);
    }
    const headers=new Headers(response.headers);
    headers.set('Content-Security-Policy',CSP);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');headers.set('Vary','Cookie');
    return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
  }
};
