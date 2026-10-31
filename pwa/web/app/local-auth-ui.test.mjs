import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalAuthUI} from './local-auth-ui.js';

// A small event/form adapter, not a browser or a visual-layout implementation.
const entities=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function attributes(source){
  const result={};for(const match of source.matchAll(/([^\s=]+)(?:="([^"]*)")?/g))result[match[1]]=entities(match[2]??'');return result;
}
function matches(node,selector){
  if(selector==='form')return node.tagName==='FORM';
  const attr=/^\[([^=\]]+)(?:=([^\]]+))?\]$/.exec(selector);
  return Boolean(attr&&Object.hasOwn(node.attrs,attr[1])&&(attr[2]===undefined||node.attrs[attr[1]]===attr[2].replace(/^['"]|['"]$/g,'')));
}
class Element {
  constructor(tag,attrs={},text=''){
    this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=[];this.dataset={};this.isConnected=true;
    this.value=attrs.value??'';this.defaultValue=this.value;this.hidden=Object.hasOwn(attrs,'hidden');this.disabled=Object.hasOwn(attrs,'disabled');this.checked=Object.hasOwn(attrs,'checked');this.defaultChecked=this.checked;this.textContent=text;
    for(const [key,value]of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
  }
  querySelector(selector){return this.children.find(node=>matches(node,selector))??null;}
  querySelectorAll(selector){return this.children.filter(node=>matches(node,selector));}
}
class Mount extends Element {
  constructor(){super('div');this.html='';}
  set innerHTML(html){
    this.children.forEach(node=>{node.isConnected=false;});this.children=[];this.html=html;
    const formMatch=/<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
    let form=null,formStart=-1,formEnd=-1;
    if(formMatch){
      form=new Element('form',attributes(formMatch[1]));form.elements={};form.resetCount=0;
      form.reset=()=>{form.resetCount++;for(const field of Object.values(form.elements)){field.value=field.defaultValue;field.checked=field.defaultChecked;}};
      formStart=formMatch.index;formEnd=formMatch.index+formMatch[0].length;this.children.push(form);
    }
    for(const match of html.matchAll(/<(input|button|p)\b([^>]*)>/gi)){
      const node=new Element(match[1],attributes(match[2]));
      if(node.tagName==='BUTTON'){
        const rest=html.slice(match.index+match[0].length),end=rest.indexOf('</button>');
        node.textContent=entities((end>=0?rest.slice(0,end):'').replace(/<[^>]*>/g,'')).trim();
      }
      this.children.push(node);
      if(form&&match.index>formStart&&match.index<formEnd){form.children.push(node);if(node.attrs.name)form.elements[node.attrs.name]=node;}
    }
  }
  get innerHTML(){return this.html;}
}
class FormDataAdapter {
  constructor(form){this.fields=new Map(Object.entries(form.elements).filter(([,input])=>input.attrs.type!=='checkbox'||input.checked).map(([key,input])=>[key,input.value]));}
  get(key){return this.fields.get(key)??null;}
}
const A={id:'profile-a',name:'Alice',username:'alice'};
const B={id:'profile-b',name:'Bruno',username:'bruno'};
const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function harness(t,{profiles=[A],login,register,enterGuest,onUnlock,onRefresh,onBusy}={}){
  const originals=new Map();let networkCalls=0,storageTouches=0;
  for(const key of ['FormData','fetch','localStorage','sessionStorage','indexedDB'])originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,'FormData',{configurable:true,writable:true,value:FormDataAdapter});
  Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:()=>{networkCalls++;throw new Error('UI must not send credentials over the network');}});
  for(const key of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(globalThis,key,{configurable:true,get(){storageTouches++;throw new Error('UI must delegate storage to the account module');}});
  t.after(()=>{for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const mount=new Mount(),calls={register:[],login:[],guest:0,busy:[],lock:0,unlock:0,refresh:0,enroll:0,remove:[],has:[]};
  let state={unlocked:false,profile:null};
  const account={
    listProfiles:async()=>profiles.map(p=>({...p})),getState:()=>({...state,profile:state.profile?{...state.profile}:null}),
    lock(){calls.lock++;state={unlocked:false,profile:null};},
    async register(input){calls.register.push({...input});const p=register?await register(input):{id:'registered',name:input.name,username:input.username};state={unlocked:true,profile:p};return p;},
    async enterGuest(){calls.guest++;const p=enterGuest?await enterGuest():{id:'guest-local',name:'Visitante',username:'visitante'};state={unlocked:true,profile:p,guest:true};return p;},
    async login(username,password){calls.login.push({username,password});const p=login?await login(username,password):profiles.find(p=>p.username===username)||A;state={unlocked:true,profile:p};return p;}
  };
  const biometric={support:async()=>({available:true}),hasEnrollment:async id=>{calls.has.push(id);return false;},unlock:async id=>{state={unlocked:true,profile:profiles.find(p=>p.id===id)};},enroll:async()=>{calls.enroll++;},remove:async id=>{calls.remove.push(id);}};
  const ui=createLocalAuthUI({mount,account,biometric,onUnlock:async()=>{calls.unlock++;if(onUnlock)await onUnlock(mount,calls);},onLock:async()=>account.lock(),onRefresh:async()=>{calls.refresh++;if(onRefresh)await onRefresh();},onBusy:message=>{calls.busy.push(message);return onBusy?.(message);}});
  return {mount,account,biometric,ui,calls,setProfile(profile,guest=false){state={unlocked:true,profile,guest};},security:()=>({networkCalls,storageTouches})};
}
function fill(form,values){for(const [key,value]of Object.entries(values)){assert.ok(form.elements[key],`Missing field: ${key}`);form.elements[key].value=value;}}
const submit=form=>form.onsubmit({preventDefault(){}});

test('registration clears both password fields before calling onUnlock',async t=>{
  let submittedForm;
  const env=harness(t,{profiles:[],onUnlock:()=>{
    assert.equal(submittedForm.resetCount,1);assert.equal(submittedForm.elements.password.value,'');assert.equal(submittedForm.elements.confirmation.value,'');
  }});
  await env.ui.initialize();env.ui.render();submittedForm=env.mount.querySelector('form');
  fill(submittedForm,{name:'Alice',username:'alice',password:'local-pass-123',confirmation:'local-pass-123'});
  await submit(submittedForm);
  assert.deepEqual(env.calls.register,[{name:'Alice',username:'alice',password:'local-pass-123'}]);
  assert.equal(env.calls.unlock,1);assert.equal(env.account.getState().unlocked,true);
  assert.deepEqual(env.calls.busy,['Criando seu perfil local...',null]);
});

test('successful login clears the password before exposing training data',async t=>{
  let submittedForm;
  const env=harness(t,{onUnlock:()=>{assert.equal(submittedForm.resetCount,1);assert.equal(submittedForm.elements.password.value,'');}});
  await env.ui.initialize();env.ui.render();submittedForm=env.mount.querySelector('form');
  fill(submittedForm,{username:'alice',password:'local-pass-123'});await submit(submittedForm);
  assert.deepEqual(env.calls.login,[{username:'alice',password:'local-pass-123'}]);assert.equal(env.calls.unlock,1);
  assert.deepEqual(env.calls.busy,['Abrindo seu perfil local...',null]);
});

test('wrong passwords never invoke onUnlock and are absent from the replacement form',async t=>{
  const env=harness(t,{login:async()=>{throw new Error('Usuário ou senha inválidos.');}});
  await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
  fill(form,{username:'alice',password:'wrong-password-xyz'});await submit(form);
  assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);
  assert.equal(env.mount.querySelector('form').elements.password.value,'');assert.equal(env.mount.innerHTML.includes('wrong-password-xyz'),false);
  assert.equal(env.calls.busy.at(-1),null);
});

test('mismatched confirmation never calls the account module',async t=>{
  const env=harness(t,{profiles:[]});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
  fill(form,{name:'Alice',username:'alice',password:'first-password',confirmation:'second-password'});await submit(form);
  assert.equal(env.calls.register.length,0);assert.equal(env.calls.login.length,0);assert.equal(env.calls.unlock,0);
});

test('a pending login cannot be submitted twice or expose data twice',async t=>{
  const pending=deferred(),env=harness(t,{login:()=>pending.promise});
  await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');fill(form,{username:'alice',password:'local-pass-123'});
  const first=submit(form),second=submit(form);
  assert.equal(env.calls.login.length,1);assert.equal(form.querySelector('[type=submit]').disabled,true);assert.equal(env.calls.unlock,0);
  pending.resolve(A);await Promise.all([first,second]);assert.equal(env.calls.unlock,1);assert.equal(form.resetCount,1);
});

test('late enrollment status for profile A cannot enable removal of profile B enrollment',async t=>{
  const env=harness(t,{profiles:[A,B]}),statusA=deferred(),statusB=deferred();
  env.biometric.hasEnrollment=id=>id===A.id?statusA.promise:statusB.promise;
  await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();
  const oldButton=env.mount.querySelector('[data-local-enroll]');assert.equal(oldButton.disabled,true);
  env.setProfile(B);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();const currentButton=env.mount.querySelector('[data-local-enroll]');
  assert.equal(oldButton.isConnected,false);assert.equal(currentButton.disabled,true);
  statusB.resolve(false);await tick();assert.equal(currentButton.disabled,false);
  statusA.resolve(true);await tick();
  await currentButton.onclick();
  assert.equal(env.calls.enroll,1);assert.deepEqual(env.calls.remove,[]);assert.equal(env.calls.refresh,1);
});

test('credential handling delegates only to the local account and never uses storage or fetch in the UI',async t=>{
  const env=harness(t);await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
  fill(form,{username:'alice',password:'local-only-password-xyz'});await submit(form);
  assert.equal(env.calls.login[0].password,'local-only-password-xyz');
  assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
  assert.equal(env.mount.innerHTML.includes('local-only-password-xyz'),false);
});

test('guest entry bypasses required account fields and clears typed credentials before onUnlock',async t=>{
  let form;
  const env=harness(t,{profiles:[],onUnlock:()=>{
    assert.equal(form.resetCount,1);assert.equal(form.elements.password.value,'');assert.equal(form.elements.confirmation.value,'');
  }});
  await env.ui.initialize();env.ui.render();form=env.mount.querySelector('form');
  fill(form,{password:'do-not-retain-this',confirmation:'different-password'});
  const guest=env.mount.querySelector('[data-local-guest]');
  assert.equal(guest.attrs.type,'button');assert.equal(form.children.includes(guest),false);
  await guest.onclick();
  assert.equal(env.calls.guest,1);assert.equal(env.calls.unlock,1);
  assert.deepEqual(env.calls.register,[]);assert.deepEqual(env.calls.login,[]);
  assert.equal(env.account.getState().guest,true);
  assert.deepEqual(env.calls.busy,['Abrindo o uso sem cadastro...',null]);
  assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('pending guest entry guards duplicate clicks and account submissions',async t=>{
  const pending=deferred(),env=harness(t,{enterGuest:()=>pending.promise});
  await env.ui.initialize();env.ui.render();const guest=env.mount.querySelector('[data-local-guest]'),form=env.mount.querySelector('form');
  const first=guest.onclick(),second=guest.onclick(),third=submit(form);
  assert.equal(env.calls.guest,1);assert.equal(guest.disabled,true);assert.equal(env.calls.login.length,0);assert.equal(env.calls.unlock,0);
  pending.resolve({id:'guest-local',name:'Visitante',username:'visitante'});
  await Promise.all([first,second,third]);assert.equal(env.calls.unlock,1);assert.equal(env.calls.busy.at(-1),null);
});

test('failed guest entry leaves account locked and releases the operation loader',async t=>{
  const env=harness(t,{enterGuest:async()=>{throw new Error('Armazenamento indisponível.');}});
  await env.ui.initialize();env.ui.render();await env.mount.querySelector('[data-local-guest]').onclick();
  assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);
  assert.match(env.mount.innerHTML,/Armazenamento indisponível/);assert.equal(env.calls.busy.at(-1),null);
});

test('guest settings offer optional registration and never query or enroll biometrics',async t=>{
  const env=harness(t,{profiles:[]});await env.ui.initialize();
  env.setProfile({id:'guest-local',name:'Visitante',username:'visitante'},true);
  env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();
  assert.match(env.mount.innerHTML,/SEM CADASTRO/);assert.match(env.mount.innerHTML,/Uso sem senha neste aparelho/);
  assert.equal(env.mount.querySelector('[data-local-enroll]'),null);assert.deepEqual(env.calls.has,[]);
  await env.mount.querySelector('[data-local-create]').onclick();
  assert.equal(env.calls.lock,1);assert.equal(env.account.getState().unlocked,false);
  assert.ok(env.mount.querySelector('form').elements.confirmation);
  assert.equal(env.mount.querySelector('form').querySelector('[type=submit]').disabled,false);
  assert.equal(env.calls.enroll,0);assert.equal(env.calls.register.length,0);assert.equal(env.calls.busy.at(-1),null);
});

test('copying guest records requires an explicit checked opt-in on registration',async t=>{
  const env=harness(t,{profiles:[]});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
  const checkbox=form.elements.copyGuestData;assert.equal(checkbox.checked,false);
  fill(form,{name:'Alice',username:'alice',password:'local-pass-123',confirmation:'local-pass-123'});checkbox.checked=true;
  await submit(form);assert.equal(env.calls.register[0].copyGuestData,true);assert.equal(checkbox.checked,false);
});

test('operation callbacks are never awaited before biometric user-gesture methods',async t=>{
  const never=deferred(),enroll=deferred(),env=harness(t,{onBusy:()=>never.promise});
  await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
  env.biometric.enroll=()=>{env.calls.enroll++;return enroll.promise;};
  const button=env.mount.querySelector('[data-local-enroll]'),operation=button.onclick();
  assert.equal(env.calls.enroll,1);assert.equal(button.disabled,true);
  enroll.resolve();await operation;assert.equal(env.calls.busy.at(-1),null);assert.equal(button.disabled,false);
});

test('biometric removal failure always clears the operation loader without claiming removal',async t=>{
  const env=harness(t);env.biometric.hasEnrollment=async()=>true;
  env.biometric.remove=async id=>{env.calls.remove.push(id);throw new Error('Cancelado pelo aparelho.');};
  await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
  const button=env.mount.querySelector('[data-local-enroll]');await button.onclick();
  assert.deepEqual(env.calls.remove,[A.id]);assert.equal(env.calls.refresh,0);assert.equal(button.disabled,false);
  assert.match(env.mount.querySelector('[data-local-bio-status]').textContent,/Cancelado/);
  assert.match(button.textContent,/Desativar/);assert.deepEqual(env.calls.busy,['Desativando o acesso pelo aparelho...',null]);
});
