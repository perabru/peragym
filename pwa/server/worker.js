import qrcode from 'qrcode-generator';

// Runtime files are embedded by scripts/embed-assets.mjs. The PeraGym app is
// public and free; donating never creates a license or unlocks a download.
const ASSETS = __PERAGYM_ASSETS__;
export const PIX_KEY = 'bruno.pera@unifesp.br';
export const DONATION_CENTS = 199;
const enc = new TextEncoder();
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com";
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
function redirect(location){return new Response(null,{status:303,headers:{Location:location,'Cache-Control':'no-store'}});}

export function crc16(value){let crc=0xffff;for(const byte of enc.encode(value)){crc^=byte<<8;for(let i=0;i<8;i++)crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff;}return crc.toString(16).toUpperCase().padStart(4,'0');}
function field(id,value){const size=enc.encode(value).length;if(size>99)throw new Error('Pix field too long');return id+String(size).padStart(2,'0')+value;}
export function pixPayload(priceCents,txid,key=PIX_KEY){
  if(!Number.isInteger(priceCents)||priceCents<100||priceCents>99999900||!/^[A-Za-z0-9]{1,25}$/.test(txid))throw new Error('Invalid Pix amount or transaction identifier');
  const account=field('00','br.gov.bcb.pix')+field('01',key);
  const value=field('00','01')+field('26',account)+field('52','0000')+field('53','986')+field('54',(priceCents/100).toFixed(2))+field('58','BR')+field('59','BRUNO MICHEL PERA')+field('60','BRASIL')+field('62',field('05',txid))+'6304';
  return value+crc16(value);
}
function qrUrl(payload){const qr=qrcode(0,'M');qr.addData(payload,'Byte');qr.make();return 'data:image/svg+xml;base64,'+btoa(qr.createSvgTag({cellSize:4,margin:16,scalable:true}));}
let donationDetails;
function donation(){
  if(!donationDetails){
    const payload=pixPayload(DONATION_CENTS,'PERAGYMAPOIO');
    donationDetails={amountCents:DONATION_CENTS,pixKey:PIX_KEY,pixPayload:payload,qrDataUrl:qrUrl(payload),currency:'BRL',optional:true,appUrl:'/app/',downloadUrl:'/download'};
  }
  return donationDetails;
}
function asset(path,appAsset=false){
  const item=ASSETS[path];
  if(!item)return new Response('Não encontrado',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  const bytes=item.encoding==='base64'?Uint8Array.from(atob(item.body),c=>c.charCodeAt(0)):item.body;
  return new Response(bytes,{headers:{'Content-Type':item.type,'Cache-Control':path==='/sw.js'||item.type.startsWith('text/html')?'no-cache':'public, max-age=300',...(appAsset?{'X-PeraGym-App':'1'}:{}),...(path==='/sw.js'?{'Service-Worker-Allowed':'/'}:{})}});
}
function route(request){
  const path=new URL(request.url).pathname;
  // Old purchase endpoints are retired without reading or deleting any order.
  // Existing order tables remain private and unchanged.
  if(path==='/api/orders'||path.startsWith('/api/orders/')||path.startsWith('/api/admin/'))return json({error:'O PeraGym agora é gratuito. Não é necessário comprar nem confirmar Pix.',freeAccess:true,appUrl:'/app/'},410);
  if(!['GET','HEAD'].includes(request.method))return json({error:'Método não permitido.'},405);
  if(path==='/api/config')return json({freeAccess:true,priceCents:0,salesEnabled:false,donationAmountCents:DONATION_CENTS,pixKey:PIX_KEY,paymentMode:'donation',currency:'BRL',appUrl:'/app/',downloadUrl:'/download'});
  if(path==='/api/donation')return json(donation());
  // Compatibility with a previously installed shell; no cookie, account or
  // database is consulted. New service workers do not depend on this endpoint.
  if(path==='/api/session')return json({licensed:true,freeAccess:true,owner:false});
  if(path.startsWith('/api/'))return json({error:'Página não encontrada.'},404);
  if(path==='/admin'||path.startsWith('/admin/'))return redirect('/');
  if(path==='/app')return redirect('/app/');
  if(path==='/download')return redirect('/app/?instalar=1');
  if(path.startsWith('/app/'))return asset(path==='/app/'?'/app/index.html':path,true);
  if(path==='/index.html')return redirect('/');
  if(path==='/'||path==='/offline.html'||path==='/sw.js'||path==='/manifest.webmanifest'||path==='/pwa.js'||path==='/pwa.css'||path==='/promo.css'||path==='/promo.js'||path.startsWith('/icons/'))return asset(path==='/'?'/index.html':path);
  return new Response('Não encontrado',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
}
export default {
  async fetch(request){
    let response;
    try{response=route(request);}catch{response=json({error:'Não foi possível gerar o Pix agora. O aplicativo continua gratuito.',appUrl:'/app/'},503);}
    const headers=new Headers(response.headers);
    headers.set('Content-Security-Policy',CSP);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
  }
};
