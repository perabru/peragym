import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('./spotify-return.js',import.meta.url),'utf8');
const ORIGIN='https://perabru.github.io',APP=`${ORIGIN}/peragym/docs/app/`;
const STATE='a'.repeat(43),PENDING='peragym.spotify.pkce.v1',BYPASS='peragym.spotify.return.once.v1';
const CALLBACK=`${APP}?code=private-code&state=${STATE}&view=music#musica`;

class Element {
  constructor(tagName){this.tagName=tagName.toUpperCase();this.children=[];this.style={};this.attributes={};this.hidden=false;this.ownText='';}
  set textContent(value){this.ownText=String(value);this.children=[];}
  get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
  append(...children){this.children.push(...children);}
  setAttribute(key,value){this.attributes[key]=String(value);}
}
function setup(options={}) {
  let current=new URL(options.href??CALLBACK),sequence=0,opener;
  const storage=new Map([[PENDING,JSON.stringify({state:STATE,verifier:'private-pkce-verifier'})]]);
  const messages=[],replaced=[],events=[],timers=new Map(),listeners=new Map(),documentListeners=new Map();
  const app=new Element('div'),loading=new Element('div'),script=new Element('script');app.id='app';loading.id='loading';
  const deck=new Element('aside');deck.id='music-deck';app.append(deck);
  const body=new Element('body');body.append(loading,app,script);
  const document={body,readyState:options.loading?'loading':'complete',createElement:tag=>new Element(tag),
    addEventListener(type,listener){if(!documentListeners.has(type))documentListeners.set(type,new Set());documentListeners.get(type).add(listener);}};
  const window={name:'',closed:false,
    location:{get href(){return current.href;},get origin(){return current.origin;},replace(value){replaced.push(String(value));current=new URL(value,current);}},
    history:{state:{view:'music'},replaceState(_state,_title,url){if(options.historyError)throw new Error('blocked');current=new URL(url,current);}},
    sessionStorage:{
      getItem:key=>storage.get(key)??null,
      setItem(key,value){if(options.blockStorage)throw new Error('blocked');storage.set(key,String(value));},
      removeItem:key=>storage.delete(key)
    },
    close(){if(!options.blockClose)window.closed=true;},
    addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
    removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
    dispatchEvent(event){events.push(event.type);for(const listener of [...(listeners.get(event.type)||[])])listener(event);}
  };
  opener=options.noOpener?null:{closed:false,location:{origin:options.foreignOpener?'https://evil.example':ORIGIN},
    postMessage(data,origin){if(options.postError)throw new Error('blocked');messages.push({data,origin});}};
  if(options.inaccessibleOpener)Object.defineProperty(opener,'location',{get(){throw new Error('cross-origin');}});
  Object.defineProperty(window,'opener',{get:()=>opener,set:value=>{if(options.blockDetach)throw new Error('blocked');opener=value;},configurable:true});
  const context={window,document,URL,Event,setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id)};
  function execute(){runInNewContext(source,context);}
  execute();
  return {window,document,storage,messages,replaced,events,timers,listeners,app,loading,script,deck,
    get opener(){return opener;},execute,
    ready(){document.readyState='complete';for(const listener of [...(documentListeners.get('DOMContentLoaded')||[])])listener();},
    message(event){for(const listener of [...(listeners.get('message')||[])])listener(event);},
    timeout(){for(const timer of [...timers.values()])timer.callback();},
    panel:()=>body.children.find(child=>child.tagName==='MAIN')};
}

test('normal app entry and callbacks without an opener leave startup to the app',()=>{
  for(const options of [{href:APP},{noOpener:true},{foreignOpener:true},{inaccessibleOpener:true},
    {href:`${APP}?code=code&state=bad`},{href:`${APP}?code=code&state=${STATE}&state=${STATE}`},
    {href:`${APP}?code=code&error=denied&state=${STATE}`}]) {
    const env=setup(options);assert.equal(env.window.__peragymSpotifyReturn,undefined);
    assert.equal(env.messages.length,0);assert.equal(env.panel(),undefined);assert.equal(env.app.hidden,false);
  }
});

test('callback bridge works with an empty window name and sends only the URL to the exact opener origin',()=>{
  const env=setup();assert.equal(env.window.name,'');assert.equal(env.window.__peragymSpotifyReturn,true);
  assert.equal(env.messages.length,1);assert.equal(env.messages[0].origin,ORIGIN);
  assert.deepEqual(JSON.parse(JSON.stringify(env.messages[0].data)),{type:'peragym:spotify:callback',callbackUrl:CALLBACK});
  assert.equal(/verifier|access_token|refresh_token|password/.test(JSON.stringify(env.messages)),false);
  const clean=new URL(env.window.location.href);
  assert.equal(clean.searchParams.has('code'),false);assert.equal(clean.searchParams.has('state'),false);
  assert.equal(clean.searchParams.get('view'),'music');assert.equal(clean.hash,'#musica');
  assert.equal(env.panel().textContent.includes('private-code'),false);
  assert.ok(env.events.includes('peragym:app-ready'));
});

test('callback UI preserves all application nodes for top-level module bindings',()=>{
  const env=setup();
  assert.ok(env.document.body.children.includes(env.app));assert.ok(env.document.body.children.includes(env.loading));
  assert.ok(env.app.children.includes(env.deck));assert.ok(env.document.body.children.includes(env.script));
  assert.equal(env.app.hidden,true);assert.equal(env.loading.hidden,true);assert.equal(env.app.style.display,'none');
  assert.equal(env.script.hidden,false);assert.equal(env.panel().hidden,false);
});

test('pre-app flag is synchronous even when callback UI waits for DOMContentLoaded',()=>{
  const env=setup({loading:true});assert.equal(env.window.__peragymSpotifyReturn,true);assert.equal(env.panel(),undefined);
  assert.equal(env.messages.length,1);env.ready();assert.ok(env.panel());assert.ok(env.events.includes('peragym:app-ready'));
});

test('only the exact opener source/origin/state ACK clears temporary PKCE and closes the popup',()=>{
  const env=setup();
  const correct={origin:ORIGIN,source:env.opener,data:{type:'peragym:spotify:ack',state:STATE}};
  for(const event of [{...correct,origin:'https://evil.example'},{...correct,source:{}},
    {...correct,data:{type:'peragym:spotify:ack',state:'b'.repeat(43)}},
    {...correct,data:{type:'other',state:STATE}}])env.message(event);
  assert.equal(env.window.closed,false);assert.ok(env.storage.get(PENDING));assert.equal(env.timers.size,1);
  env.message(correct);assert.equal(env.window.closed,true);assert.equal(env.storage.has(PENDING),false);
  assert.equal(env.timers.size,0);assert.equal(env.listeners.get('message').size,0);
});

test('missing ACK reveals one-shot same-tab continuation without exposing the code',()=>{
  const env=setup();assert.equal([...env.timers.values()][0].delay,5000);
  env.timeout();const button=env.panel().children.find(child=>child.tagName==='BUTTON');
  assert.equal(button.hidden,false);assert.match(env.panel().textContent,/senha/);assert.equal(env.panel().textContent.includes('private-code'),false);
  button.onclick();assert.equal(env.opener,null);assert.equal(env.window.__peragymSpotifyReturn,false);
  assert.equal(env.replaced[0],CALLBACK);assert.equal(env.storage.get(BYPASS),STATE);
  assert.ok(env.storage.get(PENDING),'Same-tab callback can still consume temporary PKCE');
  env.execute();assert.equal(env.window.__peragymSpotifyReturn,false);assert.equal(env.storage.has(BYPASS),false);
  assert.equal(env.messages.length,1,'One-shot fallback must not send another callback or loop');
});

test('ACK with blocked close offers the clean app route without replaying an already consumed code',()=>{
  const env=setup({blockClose:true});env.message({origin:ORIGIN,source:env.opener,data:{type:'peragym:spotify:ack',state:STATE}});
  assert.equal(env.window.closed,false);assert.match(env.panel().textContent,/Autorização enviada/);
  env.panel().children.find(child=>child.tagName==='BUTTON').onclick();
  assert.equal(new URL(env.replaced[0]).searchParams.has('code'),false);assert.equal(env.storage.has(PENDING),false);
});

test('postMessage failure immediately exposes a usable fallback, rather than an endless loading screen',()=>{
  const env=setup({postError:true});assert.match(env.panel().textContent,/Continue no PeraGym/);
  assert.equal(env.timers.size,0);assert.equal(env.panel().children.find(child=>child.tagName==='BUTTON').hidden,false);
});

test('if opener detach and temporary storage are both blocked, fallback uses a clean URL to avoid loops',()=>{
  const env=setup({blockStorage:true,blockDetach:true});env.timeout();
  env.panel().children.find(child=>child.tagName==='BUTTON').onclick();
  const next=new URL(env.replaced[0]);assert.equal(next.searchParams.has('code'),false);assert.equal(next.searchParams.has('state'),false);
  env.execute();assert.equal(env.messages.length,1);
});

test('OAuth access denial is forwarded and the bridge never performs network token exchange',()=>{
  const env=setup({href:`${APP}?error=access_denied&state=${STATE}`});
  assert.equal(env.messages.length,1);assert.equal(new URL(env.messages[0].data.callbackUrl).searchParams.get('error'),'access_denied');
  assert.equal(env.window.location.href,APP);assert.equal(/fetch\(|client_secret/.test(source),false);
});
