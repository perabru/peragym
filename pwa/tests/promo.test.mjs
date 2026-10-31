import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const script = await readFile(new URL('../web/promo.js',import.meta.url),'utf8');

function harness(fetchResponse) {
  class Element {
    constructor(id='') {this.id=id;this.textContent='';this.hidden=false;this.open=false;this.value='';this.href='';this.listeners={};this.children=[];this.attrs={};this.classes=new Set();this.classList={contains:c=>this.classes.has(c),toggle:(c,v)=>v?this.classes.add(c):this.classes.delete(c),add:c=>this.classes.add(c),remove:c=>this.classes.delete(c)};}
    setAttribute(k,v){this.attrs[k]=v;}
    addEventListener(type,fn){this.listeners[type]=fn;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    replaceChildren(){this.children=[];}
    append(child){this.children.push(child);}
    querySelector(){throw new Error('Unexpected contextual query');}
  }
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element=elements[tag[1]];
    element.hidden=/\bhidden\b/.test(tag[0]);element.disabled=/\bdisabled\b/.test(tag[0]);
    element.href=tag[0].match(/\bhref="([^"]*)"/)?.[1]||'';
  }
  const brand = new Element();brand.textContent='PG';
  const ctas=Array.from({length:4},()=>new Element());
  const body=new Element();
  const document={body,querySelector:selector=>selector==='meta[name="theme-color"]'?new Element():selector==='span'?brand:elements[selector.slice(1)],querySelectorAll:selector=>selector==='[data-install-free], [data-donation]'?ctas:[],createElement:()=>new Element()};
  const requests=[],copies=[];
  const context={document,localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:false}),navigator:{clipboard:{writeText:async text=>{copies.push(text);}}},fetch:async(path,options)=>{requests.push({path,options});return fetchResponse();},AbortController,Image:Element,URL,Intl,Date,console,setTimeout,clearTimeout};
  vm.runInNewContext(script,context);
  return {elements,ctas,brand,requests,copies};
}

async function flush(){await new Promise(resolve=>setImmediate(resolve));}

test('free promo has no commerce gate, payment form or disabled installation CTA',()=>{
  assert.match(html,/Continuar sem doar e instalar/);
  assert.match(html,/A doação é opcional e não exige confirmação para continuar/);
  assert.match(html,/id="install-free" href="\/app\/\?instalar=1"/);
  assert.match(html,/id="open-free-app" href="\/app\/"/);
  assert.doesNotMatch(html,/data-buy|data-restore|checkout-dialog|Vendas em preparação|Preço em definição|\/admin\//);
  assert.doesNotMatch(script,/api\/orders|api\/session|accessToken|licensed|method\s*:\s*['"]POST/);
  assert.doesNotMatch(html,/<(?:button|a)\b[^>]*data-install-free[^>]*\bdisabled/);
});

test('initial page loads optional Pix and the modal reuses its read-only request without gating links',async()=>{
  const app=harness(()=>({ok:true,json:async()=>({optional:true,amountCents:199,pixKey:'bruno.pera@unifesp.br',pixPayload:'PIX-CODE',qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'})}));
  assert.equal(app.brand.textContent,'PG');
  app.ctas[0].listeners.click();
  assert.equal(app.elements['donation-dialog'].open,true);
  // The free links must work immediately, even before the API resolves.
  assert.equal(app.elements['install-free'].hidden,false);
  await flush();
  assert.equal(app.brand.textContent,'PG');
  assert.equal(app.requests.length,1);
  assert.equal(app.requests[0].path,'/api/donation');
  assert.equal(app.requests[0].options.method,undefined);
  assert.equal(app.elements['pix-payload'].value,'PIX-CODE');
  assert.equal(app.elements['install-free'].href,'/app/?instalar=1');
  assert.equal(app.elements['open-free-app'].href,'/app/');
});

test('donation API failure never hides or blocks free installation',async()=>{
  const app=harness(()=>{throw new Error('offline');});
  app.ctas[0].listeners.click();await flush();
  assert.equal(app.elements['donation-dialog'].open,true);
  assert.equal(app.elements['install-free'].hidden,false);
  assert.equal(app.elements['install-free'].href,'/app/?instalar=1');
  assert.equal(app.elements['open-free-app'].href,'/app/');
  assert.equal(app.elements['pix-key'].textContent,'bruno.pera@unifesp.br');
  assert.match(app.elements['donation-message'].textContent,/continuar gratuitamente/);
});


test('Pix support appears in the first section with a usable free app entry and optional registration',()=>{
  assert.match(html,/GRÁTIS · CADASTRO OPCIONAL/);
  assert.match(html,/id="install-app" href="\/app\/\?instalar=1">Instalar grátis/);
  assert.match(html,/id="open-app" href="\/app\/"/);
  assert.match(html,/id="inline-copy-pix"[^>]*>Copiar Pix/);
  assert.match(html,/id="inline-copy-key"[^>]*>Copiar chave/);
  assert.match(html,/id="pix-promo-title">Apoie com <strong>R\$ 1,99/);
  assert(html.indexOf('id="apoie"')<html.indexOf('id="instalar"'));
});

test('inline QR loads without opening a modal and copies the generated payload',async()=>{
  const app=harness(()=>({ok:true,json:async()=>({optional:true,amountCents:199,pixKey:'bruno.pera@unifesp.br',pixPayload:'GENERATED-PIX-199',qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'})}));
  assert.equal(app.requests.length,1);
  assert.equal(app.elements['donation-dialog'].open,false);
  await flush();
  assert.equal(app.elements['inline-qr'].children[0].src,'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(app.elements['inline-copy-pix'].disabled,false);
  app.elements['inline-copy-pix'].listeners.click();await flush();
  assert.equal(app.copies[0],'GENERATED-PIX-199');
  assert.equal(app.elements['install-app'].href,'/app/?instalar=1');
  assert.equal(app.elements['open-app'].href,'/app/');
});

test('loading and a failed Pix request leave both free links available, and retry can load the QR',async()=>{
  let attempts=0,release;
  const app=harness(()=>{attempts++;if(attempts===1)return new Promise(resolve=>{release=resolve;});return {ok:true,json:async()=>({optional:true,amountCents:199,pixKey:'bruno.pera@unifesp.br',pixPayload:'RETRY-PIX',qrDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'})};});
  assert.equal(app.elements['inline-qr'].children[0].textContent,'Carregando Pix…');
  assert.equal(app.elements['inline-copy-pix'].disabled,true);
  for(const id of ['install-app','open-app']){assert.equal(app.elements[id].hidden,false);assert.equal(app.elements[id].disabled,false);}
  release({ok:false});await flush();
  assert.equal(app.elements['inline-pix-retry'].hidden,false);
  assert.equal(app.elements['inline-copy-pix'].disabled,true);
  app.elements['inline-copy-key'].listeners.click();await flush();
  assert.equal(app.copies[0],'bruno.pera@unifesp.br');
  app.elements['inline-pix-retry'].listeners.click();await flush();
  assert.equal(attempts,2);
  assert.equal(app.elements['inline-pix-retry'].hidden,true);
  assert.equal(app.elements['inline-copy-pix'].disabled,false);
  assert.equal(app.elements['donation-dialog'].open,false);
});
