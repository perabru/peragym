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
    this.value=attrs.value??(attrs.type==='checkbox'?'on':'');this.defaultValue=this.value;this.hidden=Object.hasOwn(attrs,'hidden');this.disabled=Object.hasOwn(attrs,'disabled');this.checked=Object.hasOwn(attrs,'checked');this.defaultChecked=this.checked;this.textContent=text;
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
function harness(t,{profiles=[A],login,verifyPassword,register,enterGuest,onUnlock,onLock,onRefresh,onBusy,createRecoveryCode,recoverPassword,getRecoveryStatus,remember,restore,clear,hasRemembered}={}){
  const originals=new Map();let networkCalls=0,storageTouches=0;
  for(const key of ['FormData','fetch','localStorage','sessionStorage','indexedDB'])originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,'FormData',{configurable:true,writable:true,value:FormDataAdapter});
  Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:()=>{networkCalls++;throw new Error('UI must not send credentials over the network');}});
  for(const key of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(globalThis,key,{configurable:true,get(){storageTouches++;throw new Error('UI must delegate storage to the account module');}});
  t.after(()=>{for(const [key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const mount=new Mount();
  const document={body:new Mount('body'),createElement:tag=>{const node=new Mount(tag);node.ownerDocument=document;return node;},getElementById:id=>document.body.querySelector('#'+id),querySelector:selector=>document.body.querySelector(selector)};document.body.ownerDocument=document;mount.ownerDocument=document;document.body.append(mount);
  const calls={register:[],login:[],verifyPassword:[],guest:0,busy:[],lock:0,unlock:0,refresh:0,enroll:0,enrollArgs:[],remove:[],has:[],recoveryStatus:0,recoveryCodes:0,recover:[],remember:[],restore:0,clearRemembered:0,hasRemembered:0,protectedStatus:[],protectCode:[],readCode:0,rotateCode:0,events:[]};
  let state={unlocked:false,profile:null,generation:0};
  const unlockState=(profile,guest=false)=>{state={unlocked:true,profile,profileId:profile?.id,guest,generation:state.generation+1};};
  const account={
    getRecoveryStatus:async()=>{calls.recoveryStatus++;return getRecoveryStatus?getRecoveryStatus():{enabled:false};},
    createRecoveryCode:async()=>{calls.recoveryCodes++;calls.events.push('create-code');return createRecoveryCode?createRecoveryCode():'RECOVERY-INITIAL-LOCAL-SECRET';},
    verifyPassword:async password=>{calls.verifyPassword.push(password);calls.events.push('verify-password');return verifyPassword?verifyPassword(password):{profileId:state.profile?.id};},
    recoverPassword:async input=>{calls.recover.push({...input});const result=recoverPassword?await recoverPassword(input):{profile:A,recoveryCode:'RECOVERY-ROTATED-LOCAL-SECRET'};unlockState(result.profile);return result;},
    listProfiles:async()=>profiles.map(p=>({...p})),getState:()=>({...state,profile:state.profile?{...state.profile}:null}),
    lock(){calls.lock++;calls.events.push('lock');state={unlocked:false,profile:null,generation:state.generation+1};},
    async register(input){calls.register.push({...input});const p=register?await register(input):{id:'registered',name:input.name,username:input.username};unlockState(p);return p;},
    async enterGuest(){calls.guest++;const p=enterGuest?await enterGuest():{id:'guest-local',name:'Visitante',username:'visitante'};unlockState(p,true);return p;},
    async login(username,password){calls.login.push({username,password});calls.events.push('login');const p=login?await login(username,password):profiles.find(p=>p.username===username)||A;unlockState(p);return p;}
  };
  const biometric={support:async()=>({available:true}),hasEnrollment:async id=>{calls.has.push(id);return false;},unlock:async id=>{calls.events.push('biometric-unlock');unlockState(profiles.find(p=>p.id===id));},enroll:async(...args)=>{calls.enroll++;calls.enrollArgs.push(args);return {protected:true};},remove:async id=>{calls.remove.push(id);},
    getRecoveryCodeStatus:async id=>{calls.protectedStatus.push(id);return {protected:false};},protectRecoveryCode:async code=>{calls.protectCode.push(code);return {protected:true};},readRecoveryCode:async()=>{calls.readCode++;return 'RECOVERY-BIOMETRIC-READ-SECRET';},rotateRecoveryCode:async()=>{calls.rotateCode++;return {code:'RECOVERY-BIOMETRIC-ROTATED-SECRET',protected:true};}};
  const deviceSession={remember:async(...args)=>{calls.remember.push(args);calls.events.push('remember');return remember?remember(...args):true;},restore:async()=>{calls.restore++;calls.events.push('restore');return restore?restore():false;},clear:async()=>{calls.clearRemembered++;calls.events.push('clear-remembered');return clear?clear():undefined;},hasRemembered:async()=>{calls.hasRemembered++;return hasRemembered?hasRemembered():false;}};
  const ui=createLocalAuthUI({mount,account,biometric,deviceSession,onUnlock:async()=>{calls.unlock++;calls.events.push('onUnlock');if(onUnlock)await onUnlock(mount,calls);},onLock:async()=>{if(onLock)return onLock();account.lock();},onRefresh:async()=>{calls.refresh++;if(onRefresh)await onRefresh();},onBusy:message=>{calls.busy.push(message);return onBusy?.(message);}});
  return {mount,document,account,biometric,deviceSession,ui,calls,setProfile:unlockState,security:()=>({networkCalls,storageTouches})};
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
 fill(dialog.querySelector('form'),{password:'fresh-current-password'});await trigger(dialog.querySelector('[data-local-recovery-confirm]'));assert.equal(env.calls.recoveryCodes,1);const code=dialog.querySelector('[data-local-recovery-code]');assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');assert.equal(env.calls.unlock,0);
 await acknowledge(env,dialog);assert.equal(code.value,'');assert.equal(dialog.isConnected,false);assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.unlock,0);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('acknowledging a generated code twice cannot unlock twice while the first unlock is pending',async t=>{
 const pending=deferred(),env=harness(t,{profiles:[],onUnlock:()=>pending.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'local-strong-pass-123',confirmation:'local-strong-pass-123'});await submit(form);
 const ack=env.mount.querySelector('[data-local-recovery-ack]'),button=env.mount.querySelector('[data-local-recovery-continue]');ack.checked=true;await trigger(ack,'change');
 const first=button.onclick({preventDefault(){}}),second=button.onclick({preventDefault(){}});await tick();assert.equal(env.calls.unlock,1);pending.resolve();await Promise.all([first,second]);assert.equal(env.calls.unlock,1);assert.equal(env.ui.hasPendingRecovery(),false);
});

test('settings recovery errors release busy state, reject duplicate generation and preserve the unlocked account',async t=>{
 const pending=deferred(),env=harness(t,{getRecoveryStatus:async()=>{throw new Error('Consulta indisponível.');},createRecoveryCode:()=>pending.promise});
 await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 const generate=env.mount.querySelector('[data-local-recovery-generate]');assert.equal(generate.disabled,false);assert.match(env.mount.querySelector('[data-local-recovery-status]').textContent,/Consulta indisponível/);assert.equal(env.calls.busy.at(-1),null);
 await trigger(generate);const dialog=env.document.getElementById('local-recovery-dialog'),confirm=dialog.querySelector('[data-local-recovery-confirm]');
 fill(dialog.querySelector('form'),{password:'fresh-current-password'});const first=confirm.onclick(),second=confirm.onclick();await tick();assert.equal(env.calls.recoveryCodes,1);assert.equal(env.calls.unlock,0);
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
 fill(dialog.querySelector('form'),{password:'fresh-current-password'});await trigger(dialog.querySelector('[data-local-recovery-confirm]'));const code=dialog.querySelector('[data-local-recovery-code]'),ack=dialog.querySelector('[data-local-recovery-ack]');
 let prevented=0;const escape=()=>dialog.oncancel({preventDefault(){prevented++;}});
 escape();assert.equal(prevented,1);assert.equal(dialog.open,true);assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');assert.equal(env.calls.refresh,0);
 ack.checked=true;await trigger(ack,'change');escape();
 assert.equal(prevented,2);assert.equal(code.value,'');assert.equal(dialog.isConnected,false);assert.equal(env.calls.refresh,1,'Escape after acknowledgement must refresh the recovery status, just like the close button');
 escape();assert.equal(env.calls.refresh,1);pending.resolve();await tick();assert.equal(env.calls.busy.at(-1),null);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,true);
});

test('remembering this device is an explicit unchecked choice on both login and registration',async t=>{
 const env=harness(t);await env.ui.initialize();env.ui.render();
 let checkbox=env.mount.querySelector('form').elements.rememberDevice;assert.ok(checkbox);assert.equal(checkbox.attrs.type,'checkbox');assert.equal(checkbox.checked,false);
 checkbox.checked=true;await trigger(env.mount.querySelector('[data-auth-mode="register"]'));
 checkbox=env.mount.querySelector('form').elements.rememberDevice;assert.ok(checkbox);assert.equal(checkbox.checked,false);
 assert.equal(env.calls.restore,0,'initializing or drawing authentication cannot silently restore a session');assert.deepEqual(env.calls.remember,[]);
});

test('checked login awaits device persistence before exposing data and clears the password immediately',async t=>{
 const pending=deferred(),env=harness(t,{remember:()=>pending.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{username:'alice',password:'not-a-persisted-password'});assert.ok(form.elements.rememberDevice);form.elements.rememberDevice.checked=true;
 const first=submit(form);await tick();assert.equal(form.elements.password.value,'');assert.equal(env.calls.remember.length,1);assert.equal(env.calls.unlock,0);
 await submit(form);assert.equal(env.calls.login.length,1);assert.equal(env.calls.remember.length,1);pending.resolve(true);await first;
 assert.equal(env.calls.unlock,1);assert.ok(env.calls.events.indexOf('remember')<env.calls.events.indexOf('onUnlock'));assert.equal(env.calls.clearRemembered,0);
 assert.equal(JSON.stringify(env.calls.remember).includes('not-a-persisted-password'),false);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('unchecked login removes a prior remembered device before exposing the account',async t=>{
 const pending=deferred(),env=harness(t,{clear:()=>pending.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{username:'alice',password:'local-pass-with-no-remember'});const first=submit(form);await tick();assert.equal(env.calls.clearRemembered,1);assert.equal(env.calls.unlock,0);assert.deepEqual(env.calls.remember,[]);
 pending.resolve();await first;assert.equal(env.calls.unlock,1);assert.ok(env.calls.events.indexOf('clear-remembered')<env.calls.events.indexOf('onUnlock'));assert.equal(form.elements.password.value,'');
});

test('registration never remembers an unlocked profile until its recovery code is acknowledged',async t=>{
 const pending=deferred(),env=harness(t,{profiles:[],remember:()=>pending.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'registered-password-123',confirmation:'registered-password-123'});assert.ok(form.elements.rememberDevice);form.elements.rememberDevice.checked=true;await submit(form);
 assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.remember.length,0);assert.equal(env.calls.unlock,0);assert.equal(env.ui.hasPendingRecovery(),true);
 const code=env.mount.querySelector('[data-local-recovery-code]'),ack=env.mount.querySelector('[data-local-recovery-ack]'),button=env.mount.querySelector('[data-local-recovery-continue]');ack.checked=true;await trigger(ack,'change');
 const completing=button.onclick();await tick();assert.equal(env.calls.remember.length,1);assert.equal(env.calls.unlock,0);assert.equal(env.ui.hasPendingRecovery(),true);assert.equal(code.value,'');pending.resolve(true);await completing;
 assert.equal(env.calls.unlock,1);assert.equal(env.ui.hasPendingRecovery(),false);assert.equal(JSON.stringify(env.calls.remember).includes('registered-password-123'),false);
});

test('biometric login honors the same remember choice without delaying the user gesture',async t=>{
 const gesture=deferred(),remembering=deferred(),env=harness(t,{remember:()=>remembering.promise});env.biometric.hasEnrollment=async()=>true;
 await env.ui.initialize();env.ui.render();await tick();const form=env.mount.querySelector('form');assert.ok(form.elements.rememberDevice);form.elements.rememberDevice.checked=true;
 let activeGesture=true,calls=0;env.biometric.unlock=id=>{assert.equal(activeGesture,true);assert.equal(id,A.id);calls++;return gesture.promise.then(()=>env.setProfile(A));};
 const unlocking=env.mount.querySelector('[data-local-biometric]').onclick();activeGesture=false;assert.equal(calls,1);assert.equal(env.calls.remember.length,0);
 gesture.resolve();await tick();assert.equal(env.calls.remember.length,1);assert.equal(env.calls.unlock,0);remembering.resolve(true);await unlocking;assert.equal(env.calls.unlock,1);assert.deepEqual(env.calls.login,[]);
});

test('using the guest profile never remembers account credentials even when a login checkbox was checked',async t=>{
 const env=harness(t);await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');assert.ok(form.elements.rememberDevice);form.elements.rememberDevice.checked=true;
 fill(form,{username:'alice',password:'discard-on-guest-entry'});await trigger(env.mount.querySelector('[data-local-guest]'));
 assert.equal(env.calls.guest,1);assert.equal(env.calls.unlock,1);assert.deepEqual(env.calls.remember,[]);assert.equal(form.elements.password.value,'');assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

for(const result of [true,{restored:true}])test(`remembered restoration (${typeof result}) is explicit and only opens the actual restored profile`,async t=>{
 const env=harness(t,{restore:async()=>{env.setProfile(A);return result;}});await env.ui.initialize();env.ui.render();assert.equal(env.calls.restore,0);
 assert.equal(await env.ui.restoreRememberedSession(),true);assert.equal(env.calls.restore,1);assert.equal(env.calls.unlock,1);assert.equal(env.account.getState().profile.id,A.id);
 assert.deepEqual(env.calls.login,[]);assert.deepEqual(env.calls.remember,[]);assert.equal(env.calls.recoveryCodes,0);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

for(const result of [false,true])test(`a remembered restore returning ${result} without a real unlocked account never opens training data`,async t=>{
 const env=harness(t,{restore:async()=>result});await env.ui.initialize();env.ui.render();assert.equal(await env.ui.restoreRememberedSession(),false);
 assert.equal(env.calls.restore,1);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);assert.equal(env.calls.busy.at(-1),null);
});

test('a failed remembered restore falls back to normal authentication with no password or token storage in the UI',async t=>{
 const env=harness(t,{restore:async()=>{throw new Error('Sessão deste aparelho expirada.');}});await env.ui.initialize();env.ui.render();
 assert.equal(await env.ui.restoreRememberedSession(),false);assert.equal(env.calls.unlock,0);assert.equal(env.calls.busy.at(-1),null);assert.equal(env.account.getState().unlocked,false);
 env.ui.render();assert.ok(env.mount.querySelector('form').elements.password);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('password recovery waits for rotated-code acknowledgement before remembering the device',async t=>{
 const env=harness(t);await env.ui.initialize();env.ui.render();await trigger(env.mount.querySelector('[data-local-forgot]'));const form=env.mount.querySelector('form');
 assert.ok(form.elements.rememberDevice);assert.equal(form.elements.rememberDevice.checked,false);form.elements.rememberDevice.checked=true;
 fill(form,{username:'alice',recoveryCode:'PREVIOUS-CODE-SECRET',newPassword:'recovered-password-123',confirmation:'recovered-password-123'});await submit(form);
 assert.equal(env.calls.remember.length,0);assert.equal(env.calls.unlock,0);await acknowledge(env);assert.equal(env.calls.remember.length,1);assert.equal(env.calls.unlock,1);
 assert.equal(JSON.stringify(env.calls.remember).includes('PREVIOUS-CODE-SECRET'),false);assert.equal(JSON.stringify(env.calls.remember).includes('recovered-password-123'),false);
});

test('a rejected settings logout keeps the profile unlocked and reports the failure without faking success',async t=>{
 const pending=deferred(),env=harness(t,{onLock:()=>pending.promise});await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 const lock=env.mount.querySelector('[data-local-lock]'),locking=lock.onclick();await tick();assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.lock,0);
 pending.reject(new Error('Não foi possível apagar a sessão lembrada.'));await locking;await tick();
 assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.lock,0);assert.equal(env.calls.busy.at(-1),null);assert.match(env.mount.innerHTML+' '+env.mount.querySelector('[data-local-device-status]')?.textContent+' '+env.mount.querySelector('[data-local-bio-status]')?.textContent,/Não foi possível apagar/);
});

test('a new recovery code can enroll device protection directly in the click gesture without opening training data',async t=>{
 const ignored=deferred(),env=harness(t,{profiles:[],onBusy:()=>ignored.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'onboard-password-123',confirmation:'onboard-password-123'});await submit(form);
 const code=env.mount.querySelector('[data-local-recovery-code]'),protect=env.mount.querySelector('[data-local-recovery-protect]');assert.ok(protect);assert.equal(env.calls.enroll,0);
 let gesture=true;const original=env.biometric.enroll;env.biometric.enroll=(...args)=>{assert.equal(gesture,true);return original(...args);};const protecting=protect.onclick();gesture=false;await protecting;
 assert.equal(env.calls.enroll,1);assert.deepEqual(env.calls.enrollArgs,[[{recoveryCode:'RECOVERY-INITIAL-LOCAL-SECRET'}]]);assert.deepEqual(env.calls.protectCode,[]);assert.equal(env.calls.unlock,0);assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');
 assert.match(env.mount.querySelector('[data-local-recovery-protection-status]').textContent,/proteg|ativ|salv/i);await acknowledge(env);assert.equal(code.value,'');assert.equal(env.calls.unlock,1);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('an already-enrolled recovery code uses fresh protection and keeps manual acknowledgement available after cancellation',async t=>{
 const env=harness(t,{profiles:[]});env.biometric.hasEnrollment=async()=>true;env.biometric.protectRecoveryCode=async code=>{env.calls.protectCode.push(code);throw new Error('Confirmação do aparelho cancelada.');};
 await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');fill(form,{name:'Alice',username:'alice',password:'onboard-password-123',confirmation:'onboard-password-123'});await submit(form);
 await trigger(env.mount.querySelector('[data-local-recovery-protect]'));assert.deepEqual(env.calls.protectCode,['RECOVERY-INITIAL-LOCAL-SECRET']);assert.equal(env.calls.enroll,0);assert.equal(env.calls.unlock,0);
 assert.equal(env.mount.querySelector('[data-local-recovery-code]').value,'RECOVERY-INITIAL-LOCAL-SECRET');assert.match(env.mount.querySelector('[data-local-recovery-protection-status]').textContent,/cancelada/);assert.equal(env.calls.busy.at(-1),null);
 await acknowledge(env);assert.equal(env.calls.unlock,1);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('viewing a protected recovery code requires a fresh read each time and scrubs the displayed code on close',async t=>{
 const env=harness(t,{getRecoveryStatus:async()=>({enabled:true})});env.biometric.hasEnrollment=async()=>true;env.biometric.getRecoveryCodeStatus=async id=>{env.calls.protectedStatus.push(id);return {protected:true};};
 await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 assert.equal(env.calls.readCode,0,'checking metadata must not read/decrypt the recovery secret');const view=env.mount.querySelector('[data-local-recovery-view]');assert.ok(view);assert.equal(view.hidden,false);assert.equal(view.disabled,false);
 for(let attempt=1;attempt<=2;attempt++){
  await trigger(view);assert.equal(env.calls.readCode,attempt);const dialog=env.document.getElementById('local-recovery-dialog'),code=dialog?.querySelector('[data-local-recovery-code]');assert.ok(code);assert.equal(code.value,'RECOVERY-BIOMETRIC-READ-SECRET');assert.ok(Object.hasOwn(code.attrs,'readonly'));assert.equal(dialog.querySelector('[data-local-recovery-ack]'),null);
  await trigger(dialog.querySelector('[data-local-recovery-continue]'));assert.equal(code.value,'');assert.equal(dialog.isConnected,false);
 }
 assert.equal(env.calls.recoveryCodes,0);assert.equal(env.calls.rotateCode,0);assert.equal(env.calls.unlock,0);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('a protected-code read finishing after a profile switch cannot expose the previous profile secret',async t=>{
 const pending=deferred(),env=harness(t,{profiles:[A,B],getRecoveryStatus:async()=>({enabled:true})});env.biometric.hasEnrollment=async()=>true;env.biometric.getRecoveryCodeStatus=async()=>({protected:true});env.biometric.readRecoveryCode=()=>{env.calls.readCode++;return pending.promise;};
 await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();const reading=env.mount.querySelector('[data-local-recovery-view]').onclick();
 env.setProfile(B);pending.resolve('PROFILE-A-CODE-MUST-NOT-APPEAR');await reading;await tick();
 const dialog=env.document.getElementById('local-recovery-dialog');assert.equal(dialog?.querySelector('[data-local-recovery-code]')?.value||'','');assert.equal(env.mount.innerHTML.includes('PROFILE-A-CODE-MUST-NOT-APPEAR'),false);assert.equal(env.document.body.innerHTML.includes('PROFILE-A-CODE-MUST-NOT-APPEAR'),false);assert.equal(env.calls.unlock,0);assert.equal(env.calls.busy.at(-1),null);
});

test('enrolled recovery rotation performs fresh device verification instead of generating an unverified code',async t=>{
 const pending=deferred(),env=harness(t,{getRecoveryStatus:async()=>({enabled:true})});env.biometric.hasEnrollment=async()=>true;let gesture=true;
 env.biometric.rotateRecoveryCode=()=>{assert.equal(gesture,true);env.calls.rotateCode++;return pending.promise;};await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 await trigger(env.mount.querySelector('[data-local-recovery-generate]'));const dialog=env.document.getElementById('local-recovery-dialog');assert.equal(env.calls.rotateCode,0);
 const generating=dialog.querySelector('[data-local-recovery-confirm]').onclick();gesture=false;assert.equal(env.calls.rotateCode,1);assert.equal(env.calls.recoveryCodes,0);assert.deepEqual(env.calls.login,[]);
 pending.resolve({code:'FRESH-ROTATED-PROTECTED-CODE',protected:true});await generating;assert.equal(dialog.querySelector('[data-local-recovery-code]').value,'FRESH-ROTATED-PROTECTED-CODE');await acknowledge(env,dialog);assert.equal(env.calls.unlock,0);assert.equal(env.calls.refresh,1);
});

test('unavailable biometric hardware falls back to a fresh current password before recovery rotation',async t=>{
 const env=harness(t,{getRecoveryStatus:async()=>({enabled:true})});env.biometric.support=async()=>({available:false});env.biometric.hasEnrollment=async()=>true;
 await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();await trigger(env.mount.querySelector('[data-local-recovery-generate]'));const dialog=env.document.getElementById('local-recovery-dialog'),form=dialog.querySelector('form');
 assert.ok(form.elements.password);form.elements.password.value='fresh-current-password';await trigger(dialog.querySelector('[data-local-recovery-confirm]'));
 assert.deepEqual(env.calls.verifyPassword,['fresh-current-password']);assert.deepEqual(env.calls.login,[]);assert.ok(env.calls.events.indexOf('verify-password')<env.calls.events.indexOf('create-code'));assert.equal(env.calls.recoveryCodes,1);assert.equal(env.calls.rotateCode,0);assert.equal(form.elements.password.value,'');assert.equal(dialog.innerHTML.includes('fresh-current-password'),false);assert.equal(env.calls.unlock,0);
 await acknowledge(env,dialog);assert.equal(env.calls.refresh,1);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('settings can explicitly enable and remove device persistence without reopening the account',async t=>{
 let remembered=false;const env=harness(t,{hasRemembered:async()=>remembered,remember:async()=>{remembered=true;return true;},clear:async()=>{remembered=false;}});await env.ui.initialize();env.setProfile(A);
 for(const target of [true,false]){
  env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();const button=env.mount.querySelector('[data-local-remember]');assert.ok(button);assert.equal(button.disabled,false);await trigger(button);assert.equal(remembered,target);
 }
 assert.equal(env.calls.remember.length,1);assert.equal(env.calls.clearRemembered,1);assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,true);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('failure to remove remembered-device data leaves the setting active and does not claim a logout',async t=>{
 const env=harness(t,{hasRemembered:async()=>true,clear:async()=>{throw new Error('Falha ao remover acesso lembrado.');}});await env.ui.initialize();env.setProfile(A);env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 await trigger(env.mount.querySelector('[data-local-remember]'));assert.equal(env.calls.clearRemembered,1);assert.equal(env.account.getState().unlocked,true);assert.equal(env.calls.lock,0);assert.equal(env.calls.busy.at(-1),null);
 assert.match(env.mount.querySelector('[data-local-device-status]').textContent,/Falha ao remover/);assert.equal(env.calls.unlock,0);
});

test('an incorrect current password cannot rotate recovery or leave the attempted password in the dialog',async t=>{
 const env=harness(t,{getRecoveryStatus:async()=>({enabled:true}),verifyPassword:async()=>{throw new Error('Senha atual incorreta.');}});await env.ui.initialize();env.setProfile(A);const profileBefore=env.account.getState();env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 await trigger(env.mount.querySelector('[data-local-recovery-generate]'));const dialog=env.document.getElementById('local-recovery-dialog'),form=dialog.querySelector('form');assert.ok(form.elements.password);form.elements.password.value='incorrect-fresh-password';
 await trigger(dialog.querySelector('[data-local-recovery-confirm]'));assert.deepEqual(env.calls.verifyPassword,['incorrect-fresh-password']);assert.deepEqual(env.calls.login,[]);assert.deepEqual(env.account.getState(),profileBefore);assert.equal(env.calls.lock,0);assert.equal(env.calls.recoveryCodes,0);assert.equal(env.calls.rotateCode,0);assert.equal(env.calls.unlock,0);assert.equal(form.elements.password.value,'');assert.equal(dialog.innerHTML.includes('incorrect-fresh-password'),false);
 assert.match(dialog.innerHTML,/Senha atual incorreta/);assert.equal(dialog.querySelector('[data-local-recovery-code]'),null);assert.equal(env.calls.busy.at(-1),null);
});

test('a remember failure after recovery acknowledgement keeps the data gate closed and allows retry without another registration',async t=>{
 let attempt=0;const env=harness(t,{profiles:[],remember:async()=>{if(++attempt===1)throw new Error('Não foi possível lembrar este aparelho.');return true;}});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{name:'Alice',username:'alice',password:'recovery-gated-password',confirmation:'recovery-gated-password'});assert.ok(form.elements.rememberDevice);form.elements.rememberDevice.checked=true;await submit(form);await acknowledge(env);
 assert.equal(env.calls.unlock,0);assert.equal(env.ui.hasPendingRecovery(),true);assert.equal(env.calls.recoveryCodes,1);assert.equal(env.calls.register.length,1);assert.equal(env.calls.busy.at(-1),null);
 const code=env.mount.querySelector('[data-local-recovery-code]'),ack=env.mount.querySelector('[data-local-recovery-ack]'),button=env.mount.querySelector('[data-local-recovery-continue]');assert.equal(code.value,'RECOVERY-INITIAL-LOCAL-SECRET');ack.checked=true;await trigger(ack,'change');await trigger(button);
 assert.equal(env.calls.remember.length,2);assert.equal(env.calls.unlock,1);assert.equal(env.ui.hasPendingRecovery(),false);assert.equal(env.calls.register.length,1);assert.equal(code.value,'');assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('remember completion from an old login cannot call onUnlock after authentication UI reset',async t=>{
 const pending=deferred(),env=harness(t,{remember:()=>pending.promise});await env.ui.initialize();env.ui.render();const form=env.mount.querySelector('form');
 fill(form,{username:'alice',password:'old-login-password'});assert.ok(form.elements.rememberDevice);form.elements.rememberDevice.checked=true;const login=submit(form);await tick();assert.equal(env.calls.remember.length,1);
 env.account.lock();await env.ui.reset();pending.resolve(true);await login;assert.equal(env.calls.unlock,0);assert.equal(env.account.getState().unlocked,false);assert.equal(env.mount.querySelector('form').elements.password.value,'');
});

test('binding a page without settings controls never queries authentication metadata or starts an operation loader',async t=>{
 const env=harness(t);await env.ui.initialize();env.setProfile(A);env.mount.innerHTML='<h1>Treinos</h1>';env.ui.bindSettings();await tick();
 assert.deepEqual(env.calls.has,[]);assert.equal(env.calls.recoveryStatus,0);assert.deepEqual(env.calls.protectedStatus,[]);assert.equal(env.calls.hasRemembered,0);assert.deepEqual(env.calls.busy,[]);
 assert.equal(env.calls.recoveryCodes,0);assert.deepEqual(env.calls.verifyPassword,[]);assert.equal(env.calls.unlock,0);assert.deepEqual(env.security(),{networkCalls:0,storageTouches:0});
});

test('password verification for a different profile cannot generate a recovery code for the current profile',async t=>{
 const env=harness(t,{verifyPassword:async()=>({profileId:B.id})});await env.ui.initialize();env.setProfile(A);const original=env.account.getState();env.mount.innerHTML=env.ui.settingsMarkup();env.ui.bindSettings();await tick();
 await trigger(env.mount.querySelector('[data-local-recovery-generate]'));const dialog=env.document.getElementById('local-recovery-dialog');fill(dialog.querySelector('form'),{password:'verified-for-wrong-profile'});await trigger(dialog.querySelector('[data-local-recovery-confirm]'));
 assert.deepEqual(env.calls.verifyPassword,['verified-for-wrong-profile']);assert.equal(env.calls.recoveryCodes,0);assert.deepEqual(env.account.getState(),original);assert.equal(env.calls.unlock,0);assert.equal(dialog.querySelector('[data-local-recovery-code]'),null);assert.equal(env.calls.busy.at(-1),null);
});

for(const outcome of ['false','reject'])test(`a delayed remembered restore returning ${outcome} cannot lock a newer manual login`,async t=>{
 const pending=deferred(),env=harness(t,{profiles:[A,B],restore:()=>pending.promise});await env.ui.initialize();env.ui.render();const restoring=env.ui.restoreRememberedSession();await tick();assert.equal(env.calls.restore,1);
 env.setProfile(B);const manualSession=env.account.getState();if(outcome==='false')pending.resolve(false);else pending.reject(new Error('A sessão lembrada antiga expirou.'));
 assert.equal(await restoring,false);assert.deepEqual(env.account.getState(),manualSession);assert.equal(env.calls.lock,0);assert.equal(env.calls.unlock,0);assert.equal(env.calls.busy.at(-1),null);
});

test('failure to open data for an accepted remembered session locks that same restored session',async t=>{
 const env=harness(t,{restore:async()=>{env.setProfile(A);return {restored:true};},onUnlock:async()=>{throw new Error('Não foi possível abrir o banco restaurado.');}});await env.ui.initialize();env.ui.render();
 assert.equal(await env.ui.restoreRememberedSession(),false);assert.equal(env.calls.unlock,1);assert.equal(env.calls.lock,1);assert.equal(env.account.getState().unlocked,false);assert.equal(env.calls.busy.at(-1),null);
});

test('late failure opening restored data preserves a newer manually unlocked profile',async t=>{
 const pending=deferred(),env=harness(t,{profiles:[A,B],restore:async()=>{env.setProfile(A);return {restored:true};},onUnlock:()=>pending.promise});await env.ui.initialize();env.ui.render();const restoring=env.ui.restoreRememberedSession();await tick();assert.equal(env.calls.unlock,1);
 env.setProfile(B);const manualSession=env.account.getState();pending.reject(new Error('A leitura do perfil restaurado falhou tarde.'));
 assert.equal(await restoring,false);assert.deepEqual(env.account.getState(),manualSession);assert.equal(env.calls.lock,0);assert.equal(env.calls.busy.at(-1),null);
});
