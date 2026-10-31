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
  if(selector.startsWith('#'))return node.attrs.id===selector.slice(1);
  if(selector.startsWith('.'))return String(node.attrs.class||'').split(/\s+/).includes(selector.slice(1));
  const attr=/^\[([^=\]]+)(?:=([^\]]+))?\]$/.exec(selector);
  return Boolean(attr&&Object.hasOwn(node.attrs,attr[1])&&(attr[2]===undefined||node.attrs[attr[1]]===attr[2].replace(/^['"]|['"]$/g,'')));
}
class Element {
  constructor(tag,attrs={},text=''){
    this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=[];this.dataset={};this.isConnected=true;this.events=new Map();this.ownerDocument=null;this.open=false;
    this.value=attrs.value??'';this.defaultValue=this.value;this.hidden=Object.hasOwn(attrs,'hidden');this.disabled=Object.hasOwn(attrs,'disabled');this.checked=Object.hasOwn(attrs,'checked');this.defaultChecked=this.checked;this.textContent=text;
    for(const [key,value]of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
  }
  get id(){return this.attrs.id||'';}set id(value){this.attrs.id=value;}
  setAttribute(name,value){this.attrs[name]=String(value);}getAttribute(name){return this.attrs[name]??null;}removeAttribute(name){delete this.attrs[name];}
  append(...nodes){for(const node of nodes){node.ownerDocument=this.ownerDocument;node.parentNode=this;node.isConnected=this.isConnected;this.children.push(node);}}
  remove(){this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
  replaceChildren(...nodes){this.children.forEach(node=>{node.isConnected=false;});this.children=[];this.append(...nodes);}
  showModal(){this.open=true;}close(){this.open=false;for(const fn of this.events.get('close')||[])fn({target:this});this.onclose?.({target:this});}
  addEventListener(name,fn){const listeners=this.events.get(name)||[];listeners.push(fn);this.events.set(name,listeners);}
  focus(){}select(){}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  querySelectorAll(selector){const result=[],seen=new Set();const visit=node=>{for(const child of node.children){if(seen.has(child))continue;seen.add(child);if(matches(child,selector))result.push(child);visit(child);}};visit(this);return result;}
}
class Mount extends Element {
  constructor(tag='div'){super(tag);this.html='';}
  set innerHTML(html){
    this.children.forEach(node=>{node.isConnected=false;});this.children=[];this.html=html;
    const formMatch=/<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
    let form=null,formStart=-1,formEnd=-1;
    if(formMatch){
      form=new Element('form',attributes(formMatch[1]));form.ownerDocument=this.ownerDocument;form.elements={};form.resetCount=0;
      form.reset=()=>{form.resetCount++;for(const field of Object.values(form.elements)){field.value=field.defaultValue;field.checked=field.defaultChecked;}};
      formStart=formMatch.index;formEnd=formMatch.index+formMatch[0].length;this.children.push(form);
    }
    for(const match of html.matchAll(/<(input|button|p|code|output|textarea|span|h1|h2)\b([^>]*)>/gi)){
      const node=new Element(match[1],attributes(match[2]));node.ownerDocument=this.ownerDocument;
      if(node.tagName!=='INPUT'){
        const rest=html.slice(match.index+match[0].length),end=rest.indexOf('</'+match[1].toLowerCase()+'>');
        node.textContent=entities((end>=0?rest.slice(0,end):'').replace(/<[^>]*>/g,'')).trim();
        if(node.tagName==='TEXTAREA')node.value=node.defaultValue=node.textContent;
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
function harness(t,{profiles=[A],login,register,enterGuest,onUnlock,onRefresh,onBusy,createRecoveryCode,recoverPassword,getRecoveryStatus}={}){
  const originals=new Map();let networkCalls=0,storageTouches=0;
  for(const key of ['FormData','fetch','localStorage','sessionStorage','indexedDB'])originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,'FormData',{configurable:true,writable:true,value:FormDataAdapter});
  Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:()=>{networkCalls++;throw new Error('UI must not send credentials over the network');}});
  for(const key of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(globalThis,key,{configurable:true,get(){storageTouches++;throw new Error('UI must delegate storage to the account module');}});
  t.after(()=>{for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const mount=new Mount();
  const document={body:new Mount('body'),createElement:tag=>{const node=new Mount(tag);node.ownerDocument=document;return node;},getElementById:id=>document.body.querySelector('#'+id),querySelector:selector=>document.body.querySelector(selector)};document.body.ownerDocument=document;mount.ownerDocument=document;document.body.append(mount);
  const calls={register:[],login:[],guest:0,busy:[],lock:0,unlock:0,refresh:0,enroll:0,remove:[],has:[],recoveryStatus:0,recoveryCodes:0,recover:[]};
  let state={unlocked:false,profile:null};
  const account={
    getRecoveryStatus:async()=>{calls.recoveryStatus++;return getRecoveryStatus?getRecoveryStatus():{enabled:false};},
    createRecoveryCode:async()=>{calls.recoveryCodes++;return createRecoveryCode?createRecoveryCode():'RECOVERY-INITIAL-LOCAL-SECRET';},
    recoverPassword:async input=>{calls.recover.push({...input});const result=recoverPassword?await recoverPassword(input):{profile:A,recoveryCode:'RECOVERY-ROTATED-LOCAL-SECRET'};state={unlocked:true,profile:result.profile};return result;},
    listProfiles:async()=>profiles.map(p=>({...p})),getState:()=>({...state,profile:state.profile?{...state.profile}:null}),
    lock(){calls.lock++;state={unlocked:false,profile:null};},
    async register(input){calls.register.push({...input});const p=register?await register(input):{id:'registered',name:input.name,username:input.username};state={unlocked:true,profile:p};return p;},
    async enterGuest(){calls.guest++;const p=enterGuest?await enterGuest():{id:'guest-local',name:'Visitante',username:'visitante'};state={unlocked:true,profile:p,guest:true};return p;},
    async login(username,password){calls.login.push({username,password});const p=login?await login(username,password):profiles.find(p=>p.username===username)||A;state={unlocked:true,profile:p};return p;}
  };
  const biometric={support:async()=>({available:true}),hasEnrollment:async id=>{calls.has.push(id);return false;},unlock:async id=>{state={unlocked:true,profile:profiles.find(p=>p.id===id)};},enroll:async()=>{calls.enroll++;},remove:async id=>{calls.remove.push(id);}};
  const ui=createLocalAuthUI({mount,account,biometric,onUnlock:async()=>{calls.unlock++;if(onUnlock)await onUnlock(mount,calls);},onLock:async()=>account.lock(),onRefresh:async()=>{calls.refresh++;if(onRefresh)await onRefresh();},onBusy:message=>{calls.busy.push(message);return onBusy?.(message);}});
  return {mount,document,account,biometric,ui,calls,setProfile(profile,guest=false){state={unlocked:true,profile,guest};},security:()=>({networkCalls,storageTouches})};
}
function fill(form,values){for(const [key,value]of Object.entries(values)){assert.ok(form.elements[key],`Missing field: ${key}`);form.elements[key].value=value;}}
const submit=form=>form.onsubmit({preventDefault(){}});
async function trigger(node,type='click'){assert.ok(node,`Missing ${type} target`);if(type==='click'&&node.disabled)return;const event={target:node,preventDefault(){}};const results=[];if(typeof node['on'+type]==='function')results.push(node['on'+type](event));for(const listener of node.events.get(type)||[])results.push(listener(event));await Promise.all(results);}
async function acknowledge(env,root=env.mount){const code=root.querySelector('[data-local-recovery-code]'),ack=root.querySelector('[data-local-recovery-ack]'),button=root.querySelector('[data-local-recovery-continue]');assert.ok(code);assert.ok(ack);assert.ok(button);assert.equal(button.disabled,true);ack.checked=true;await trigger(ack,'change');assert.equal(button.disabled,false);await trigger(button);return code;}

test('registration clears both password fields before calling onUnlock',async t=>{
  let submittedForm;
  const env=harness(t,{profiles:[],onUnlock:()=>{
    assert.equal(submittedForm.resetCount,1);assert.equal(submittedForm.elements.password.value,'');assert.equal(submittedForm.elements.confirmation.value,'');
  }});
  await env.ui.initialize();env.ui.render();submittedForm=env.mount.querySelector('form');
  fill(submittedForm,{name:'Alice',username:'alice',password:'local-pass-123',confirmation:'local-pass-123'});
  await submit(submittedForm);
  assert.deepEqual(env.calls.register,[{name:'Alice',username:'alice',password:'local-pass-123'}]);
  assert.equal(env.calls.unlock,0);assert.equal(env.ui.hasPendingRecovery(),true);assert.equal(env.calls.recoveryCodes,1);
  assert.equal(submittedForm.elements.password.value,'');assert.equal(submittedForm.elements.confirmation.value,'');
  const code=await acknowledge(env);assert.equal(code.value,'');
  assert.equal(env.calls.unlock,1);assert.equal(env.account.getState().unlocked,true);assert.equal(env.ui.hasPendingRecovery(),false);
  assert.equal(env.calls.busy.at(-1),null);
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
  env.calls.busy.length=0;
  const button=env.mount.querySelector('[data-local-enroll]'),operation=button.onclick();
  assert.equal(env.calls.enroll,1);assert.equal(button.disabled,true);
  enroll.resolve();await operation;assert.equal(env.calls.busy.at(-1),null);assert.equal(button.disabled,false);
});

test('biometric removal failure always clears the operation loader without claiming removal',async t=>{
  const env=harness(t);env.biometric.hasEnrollment=async()=>true;
  env.biometric.remove=async id=>{env.calls.remove.push(id);throw new Error('Cancelado pelo aparelho.');};
  await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
  env.calls.busy.length=0;
  const button=env.mount.querySelector('[data-local-enroll]');await button.onclick();
  assert.deepEqual(env.calls.remove,[A.id]);assert.equal(env.calls.refresh,0);assert.equal(button.disabled,false);
  assert.match(env.mount.querySelector('[data-local-bio-status]').textContent,/Cancelado/);
  assert.match(button.textContent,/Desativar/);assert.deepEqual(env.calls.busy,['Desativando o acesso pelo aparelho...',null]);
});

test('registration shows a one-time recovery code and requires acknowledgement before opening training data',async t=>{
 const env=harness(t,{profiles:[]});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'first-local-pass-123',confirmation:'first-local-pass-123'});await submit(form);
 const code=env.mount.querySelector('[data-local-recovery-code]'),button=env.mount.querySelector('[data-local-recovery-continue]');
 assert.equal(env.calls.recoveryCodes,1);assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');assert.ok(Object.hasOwn(code.attrs,'readonly'));assert.equal(code.attrs.value??'','');
 assert.equal(env.ui.hasPendingRecovery(),true);assert.equal(env.calls.unlock,0);assert.equal(form.elements.password.value,'');assert.equal(form.elements.confirmation.value,'');
 await trigger(button);assert.equal(env.calls.unlock,0,'A disabled acknowledgement button cannot open the account');
 if(typeof button.onclick==='function')await button.onclick({preventDefault(){}});
 assert.equal(env.calls.unlock,0,'The acknowledgement handler itself must reject an unchecked box');
 await acknowledge(env);assert.equal(env.calls.unlock,1);assert.equal(env.ui.hasPendingRecovery(),false);assert.equal(code.value,'');assert.equal(env.mount.innerHTML.includes('RECOVERY-INITIAL-LOCAL-SECRET'),false);
 assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('forgot-password form checks confirmation before calling the local recovery API',async t=>{
 const env=harness(t);await env.ui.initialize();env.ui.render();await trigger(env.mount.querySelector('[data-local-forgot]'));
 const form=env.mount.querySelector('#local-recovery-form');assert.ok(form);
 fill(form,{username:'alice',recoveryCode:'WRONG-LOCAL-CODE',newPassword:'new-password-123',confirmation:'different-password-456'});await submit(form);
 assert.deepEqual(env.calls.recover,[]);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);assert.equal(env.calls.recoveryCodes,0);
 assert.match(env.mount.innerHTML,/iguais|coincid/i);assert.equal(env.mount.innerHTML.includes('new-password-123'),false);assert.equal(env.mount.innerHTML.includes('different-password-456'),false);
});

test('a wrong recovery code leaves the account locked and clears sensitive fields for a new attempt',async t=>{
 const env=harness(t,{recoverPassword:async()=>{throw new Error('Usuário ou código de recuperação inválido.');}});await env.ui.initialize();env.ui.render();await trigger(env.mount.querySelector('[data-local-forgot]'));
 const form=env.mount.querySelector('#local-recovery-form');fill(form,{username:'alice',recoveryCode:'INVALID-SECRET-CODE',newPassword:'another-local-pass-123',confirmation:'another-local-pass-123'});await submit(form);
 assert.deepEqual(env.calls.recover,[{username:'alice',recoveryCode:'INVALID-SECRET-CODE',newPassword:'another-local-pass-123'}]);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);assert.equal(env.ui.hasPendingRecovery(),false);
 const replacement=env.mount.querySelector('#local-recovery-form');assert.equal(replacement.elements.recoveryCode.value,'');assert.equal(replacement.elements.newPassword.value,'');assert.equal(replacement.elements.confirmation.value,'');
 assert.equal(env.calls.busy.at(-1),null);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('successful recovery clears the old credentials and requires saving the rotated code before onUnlock',async t=>{
 let form,oneTime;
 const env=harness(t,{onUnlock:()=>{assert.equal(form.elements.recoveryCode.value,'');assert.equal(form.elements.newPassword.value,'');assert.equal(form.elements.confirmation.value,'');assert.equal(oneTime.value,'');}});
 await env.ui.initialize();env.ui.render();await trigger(env.mount.querySelector('[data-local-forgot]'));form=env.mount.querySelector('#local-recovery-form');
 fill(form,{username:'alice',recoveryCode:'PREVIOUS-RECOVERY-SECRET',newPassword:'brand-new-pass-123',confirmation:'brand-new-pass-123'});await submit(form);
 assert.equal(env.calls.unlock,0);assert.equal(env.ui.hasPendingRecovery(),true);assert.equal(env.calls.recoveryCodes,0,'Recovery already returned a rotated code; do not rotate again');
 oneTime=env.mount.querySelector('[data-local-recovery-code]');assert.equal(oneTime.value,'RECOVERY-ROTATED-LOCAL-SECRET');assert.equal(form.elements.recoveryCode.value,'');assert.equal(form.elements.newPassword.value,'');assert.equal(form.elements.confirmation.value,'');
 await acknowledge(env);assert.equal(env.calls.unlock,1);assert.equal(env.ui.hasPendingRecovery(),false);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('a pending recovery rejects duplicate submissions and only acknowledges one rotated result',async t=>{
 const pending=deferred(),env=harness(t,{recoverPassword:()=>pending.promise});await env.ui.initialize();env.ui.render();await trigger(env.mount.querySelector('[data-local-forgot]'));
 const form=env.mount.querySelector('#local-recovery-form');fill(form,{username:'alice',recoveryCode:'RECOVERY-SECRET',newPassword:'replacement-pass-123',confirmation:'replacement-pass-123'});
 const first=submit(form),second=submit(form);assert.equal(env.calls.recover.length,1);assert.equal(form.querySelector('[type=submit]').disabled,true);assert.equal(env.calls.unlock,0);
 pending.resolve({profile:A,recoveryCode:'ROTATED-SECRET-ONLY-ONCE'});await Promise.all([first,second]);assert.equal(env.calls.unlock,0);assert.equal(env.mount.querySelector('[data-local-recovery-code]').value,'ROTATED-SECRET-ONLY-ONCE');
 await acknowledge(env);assert.equal(env.calls.unlock,1);assert.equal(env.calls.busy.at(-1),null);
});

test('failed registration-code generation offers retry without registering twice or opening data unacknowledged',async t=>{
 let attempt=0;const env=harness(t,{profiles:[],createRecoveryCode:async()=>{if(++attempt===1)throw new Error('Falha ao guardar recuperação.');return 'NEW-RETRY-RECOVERY-CODE';}});
 await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');fill(form,{name:'Alice',username:'alice',password:'safe-local-pass-123',confirmation:'safe-local-pass-123'});await submit(form);
 assert.equal(env.calls.register.length,1);assert.equal(env.calls.unlock,0);assert.equal(env.ui.hasPendingRecovery(),true);assert.ok(env.mount.querySelector('[data-local-recovery-retry]'));assert.ok(env.mount.querySelector('[data-local-recovery-later]'));
 await trigger(env.mount.querySelector('[data-local-recovery-retry]'));assert.equal(env.calls.register.length,1);assert.equal(env.calls.recoveryCodes,2);assert.equal(env.mount.querySelector('[data-local-recovery-code]').value,'NEW-RETRY-RECOVERY-CODE');
 await acknowledge(env);assert.equal(env.calls.unlock,1);assert.equal(env.calls.busy.at(-1),null);
});

test('leaving a failed recovery setup locks the newly created account and preserves its login route',async t=>{
 const env=harness(t,{profiles:[],createRecoveryCode:async()=>{throw new Error('Sem espaço.');}});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'safe-local-pass-123',confirmation:'safe-local-pass-123'});await submit(form);await trigger(env.mount.querySelector('[data-local-recovery-later]'));
 assert.equal(env.calls.register.length,1);assert.equal(env.calls.lock,1);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);assert.equal(env.ui.hasPendingRecovery(),false);assert.ok(env.mount.querySelector('form').elements.password);assert.equal(env.mount.querySelector('form').elements.confirmation,undefined);
});

test('guest settings do not query recovery status or generate an account recovery code',async t=>{
 const env=harness(t,{profiles:[]});await env.ui.initialize();env.setProfile({id:'guest-local',name:'Visitante',username:'visitante'},true);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 assert.equal(env.mount.querySelector('[data-local-recovery-generate]'),null);assert.equal(env.calls.recoveryStatus,0);assert.equal(env.calls.recoveryCodes,0);assert.deepEqual(env.calls.recover,[]);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('protected settings show real recovery status and require confirmation before rotating the code',async t=>{
 const env=harness(t,{getRecoveryStatus:async()=>({enabled:true})});await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 assert.equal(env.calls.recoveryStatus,1);assert.match(env.mount.querySelector('[data-local-recovery-status]').textContent,/ativ|config|dispon|habilit/i);
 await trigger(env.mount.querySelector('[data-local-recovery-generate]'));assert.equal(env.calls.recoveryCodes,0,'Opening the confirmation cannot rotate the existing code');
 const dialog=env.document.getElementById('local-recovery-dialog');assert.ok(dialog);assert.equal(dialog.open,true);assert.equal(env.ui.hasPendingRecovery(),false,'A settings dialog must not replace the account session gate');
 await trigger(dialog.querySelector('[data-local-recovery-confirm]'));assert.equal(env.calls.recoveryCodes,1);const code=dialog.querySelector('[data-local-recovery-code]');assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');assert.equal(env.calls.unlock,0);
 await acknowledge(env,dialog);assert.equal(code.value,'');assert.equal(dialog.isConnected,false);assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.unlock,0);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('acknowledging a generated code twice cannot unlock twice while the first unlock is pending',async t=>{
 const pending=deferred(),env=harness(t,{profiles:[],onUnlock:()=>pending.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'local-strong-pass-123',confirmation:'local-strong-pass-123'});await submit(form);
 const ack=env.mount.querySelector('[data-local-recovery-ack]'),button=env.mount.querySelector('[data-local-recovery-continue]');ack.checked=true;await trigger(ack,'change');
 const first=button.onclick({preventDefault(){}}),second=button.onclick({preventDefault(){}});assert.equal(env.calls.unlock,1);pending.resolve();await Promise.all([first,second]);assert.equal(env.calls.unlock,1);assert.equal(env.ui.hasPendingRecovery(),false);
});

test('settings recovery errors release busy state, reject duplicate generation and preserve the unlocked account',async t=>{
 const pending=deferred(),env=harness(t,{getRecoveryStatus:async()=>{throw new Error('Consulta indisponível.');},createRecoveryCode:()=>pending.promise});
 await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 const generate=env.mount.querySelector('[data-local-recovery-generate]');assert.equal(generate.disabled,false);assert.match(env.mount.querySelector('[data-local-recovery-status]').textContent,/Consulta indisponível/);assert.equal(env.calls.busy.at(-1),null);
 await trigger(generate);const dialog=env.document.getElementById('local-recovery-dialog'),confirm=dialog.querySelector('[data-local-recovery-confirm]');
 const first=confirm.onclick(),second=confirm.onclick();assert.equal(env.calls.recoveryCodes,1);assert.equal(env.calls.unlock,0);
 pending.reject(new Error('Sem espaço para gerar.'));await Promise.all([first,second]);
 assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.lock,0);assert.equal(env.calls.unlock,0);assert.equal(dialog.querySelector('[data-local-recovery-code]'),null);assert.match(dialog.innerHTML,/Sem espaço para gerar/);assert.equal(dialog.querySelector('[data-local-recovery-confirm]').disabled,false);assert.equal(env.calls.busy.at(-1),null);
 assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('a stale settings action from a protected profile cannot call recovery APIs after switching to guest',async t=>{
 const env=harness(t);await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 const oldButton=env.mount.querySelector('[data-local-recovery-generate]'),statusReads=env.calls.recoveryStatus;assert.equal(oldButton.disabled,false);
 env.setProfile({id:'guest-local',name:'Visitante',username:'visitante'},true);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 await oldButton.onclick();assert.equal(env.calls.recoveryStatus,statusReads);assert.equal(env.calls.recoveryCodes,0);assert.equal(env.document.getElementById('local-recovery-dialog'),null);assert.equal(env.account.getState().guest,true);
});

test('Escape keeps an unacknowledged recovery code open, then acknowledges and refreshes settings exactly once',async t=>{
 const pending=deferred(),env=harness(t,{getRecoveryStatus:async()=>({enabled:false}),onRefresh:()=>pending.promise});
 await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 await trigger(env.mount.querySelector('[data-local-recovery-generate]'));const dialog=env.document.getElementById('local-recovery-dialog');
 await trigger(dialog.querySelector('[data-local-recovery-confirm]'));const code=dialog.querySelector('[data-local-recovery-code]'),ack=dialog.querySelector('[data-local-recovery-ack]');
 let prevented=0;const escape=()=>dialog.oncancel({preventDefault(){prevented++;}});
 escape();assert.equal(prevented,1);assert.equal(dialog.open,true);assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');assert.equal(env.calls.refresh,0);
 ack.checked=true;await trigger(ack,'change');escape();
 assert.equal(prevented,2);assert.equal(code.value,'');assert.equal(dialog.isConnected,false);assert.equal(env.calls.refresh,1,'Escape after acknowledgement must refresh the recovery status, just like the close button');
 escape();assert.equal(env.calls.refresh,1);pending.resolve();await tick();assert.equal(env.calls.busy.at(-1),null);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,true);
});
