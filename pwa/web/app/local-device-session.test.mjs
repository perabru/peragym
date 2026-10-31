import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {webcrypto, createHash} from 'node:crypto';
import {createLocalDeviceSession} from './local-device-session.js';
import {createLocalAccount} from './local-account.js';

const require=createRequire(import.meta.url);
const {IDBFactory}=require('fake-indexeddb');
const DATABASE='peragym-device-session-v1';
const ORIGIN='https://perabru.github.io';
const TTL=30*24*60*60*1000;
const START=1_800_000_000_000;
const PROFILE_A='11111111-1111-4111-8111-111111111111';
const PROFILE_B='22222222-2222-4222-8222-222222222222';
const PASSWORD='NEVER-PERSIST-THIS-PASSWORD';
const TOKEN='NEVER-PERSIST-AN-OAUTH-TOKEN';
const CANARY='PRIVATE-TRAINING-DATA-CANARY';
const encoder=new TextEncoder(),decoder=new TextDecoder();
const encode=value=>Buffer.from(value).toString('base64url');
const decode=value=>Buffer.from(value,'base64url');
const fingerprint=value=>createHash('sha256').update(value).digest('base64url');

// This is a storage/crypto integration fixture, not a password-login fixture:
// wrapping and unwrapping use genuine AES-GCM keys, and a canary proves the
// restored DEK actually decrypts the profile's private data.
async function accountFixture({authenticated=true,guest=false}={}) {
  const profiles=new Map();
  for(const [index,id]of [PROFILE_A,PROFILE_B].entries()){
    const raw=Uint8Array.from({length:32},(_,offset)=>(offset+1+index*41)%256);
    const key=await webcrypto.subtle.importKey('raw',raw,{name:'AES-GCM',length:256},true,['encrypt','decrypt']);
    const iv=webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(CANARY));
    profiles.set(id,{profile:{id,name:index?'Perfil B':'Perfil A',username:index?'bruno-b':'bruno-a'},raw,key,iv,ciphertext,credential:fingerprint('credential-'+id)});
  }
  let generation=0,active=authenticated?PROFILE_A:null,activeKey=authenticated?profiles.get(PROFILE_A).key:null,isGuest=guest;
  let wrapCalls=0,unlockCalls=0,lockCalls=0;
  const hooks={};
  const aad=(id,purpose)=>encoder.encode(`peragym:${id}:${purpose}`);
  function lock(){lockCalls++;generation++;active=null;activeKey=null;isGuest=false;}
  const account={
    getState(){return {supported:true,unlocked:Boolean(active),guest:isGuest,profileId:active,profile:active?{...profiles.get(active).profile}:null,generation,revision:active?0:null};},
    lock,
    async wrapRememberedSessionKey(key){
      wrapCalls++;
      if(!active||isGuest)throw new Error('Authenticated profile required');
      const id=active,run=generation,record=profiles.get(id),purpose='remembered-device:'+record.credential;
      const iv=webcrypto.getRandomValues(new Uint8Array(12));
      const ciphertext=await webcrypto.subtle.wrapKey('raw',record.key,key,{name:'AES-GCM',iv,additionalData:aad(id,purpose),tagLength:128});
      if(generation!==run||active!==id)throw new Error('Account session cancelled');
      return {version:1,profileId:id,purpose,iv:encode(iv),ciphertext:encode(ciphertext)};
    },
    async unlockWithRememberedKey(id,key,envelope){
      unlockCalls++;
      const record=profiles.get(id),run=++generation;active=null;activeKey=null;isGuest=false;
      if(hooks.beforeUnlock)await hooks.beforeUnlock();
      if(!record||envelope?.version!==1||envelope.profileId!==id||envelope.purpose!=='remembered-device:'+record.credential)throw new Error('Remembered credential changed');
      const restored=await webcrypto.subtle.unwrapKey('raw',decode(envelope.ciphertext),key,
        {name:'AES-GCM',iv:decode(envelope.iv),additionalData:aad(id,envelope.purpose),tagLength:128},
        {name:'AES-GCM',length:256},true,['encrypt','decrypt']);
      const plaintext=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},restored,record.ciphertext);
      if(decoder.decode(plaintext)!==CANARY||generation!==run)throw new Error('Remembered session cancelled');
      active=id;activeKey=restored;return {...record.profile};
    }
  };
  return {account,profiles,hooks,
    get wrapCalls(){return wrapCalls;},get unlockCalls(){return unlockCalls;},get lockCalls(){return lockCalls;},
    activate(id=PROFILE_A){generation++;active=id;activeKey=profiles.get(id).key;isGuest=false;},
    changeCredentials(id=PROFILE_A){profiles.get(id).credential=fingerprint('changed-'+id);},
    async readCanary(){
      if(!activeKey)throw new Error('Locked');
      const record=profiles.get(active);
      return decoder.decode(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},activeKey,record.ciphertext));
    }
  };
}

async function fixture(options={}) {
  const core=await accountFixture(options),factory=options.factory||new IDBFactory();
  let now=START;
  const environment={crypto:webcrypto,indexedDB:factory,location:{origin:ORIGIN},secureContext:true,now:()=>now,...options.environment};
  const device=createLocalDeviceSession({account:core.account,environment});
  return {core,factory,environment,device,
    fresh:()=>createLocalDeviceSession({account:core.account,environment}),
    setNow:value=>{now=value;},advance:value=>{now+=value;}};
}

function openDatabase(factory) {
  return new Promise((resolve,reject)=>{
    const request=factory.open(DATABASE,1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('sessions'))db.createObjectStore('sessions',{keyPath:'id'});
      if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function readStore(factory,name='sessions') {
  const db=await openDatabase(factory);
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction([name],'readonly'),request=tx.objectStore(name).getAll();let result;
    request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Transaction aborted'));
  });}finally{db.close();}
}
async function putRecord(factory,record) {
  const db=await openDatabase(factory);
  try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(['sessions'],'readwrite');tx.objectStore('sessions').put(record);
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Transaction aborted'));
  });}finally{db.close();}
}
async function mutateRecord(factory,mutate) {
  const [record]=await readStore(factory);assert.ok(record);
  await putRecord(factory,await mutate(record));
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function waitFor(predicate){
  const until=performance.now()+2000;
  while(!predicate()&&performance.now()<until)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(predicate(),'The expected asynchronous operation must start');
}
const cancelledRestore=promise=>promise.catch(()=>({restored:false}));

const originalGlobals=new Map();
test.before(()=>{
  for(const name of ['localStorage','sessionStorage','fetch']){
    originalGlobals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,get(){throw new Error('Device sessions must not use network or string browser storage');}});
  }
});
test.after(()=>{
  for(const [name,descriptor]of originalGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
});

test('an empty device session never unlocks an unknown or locked profile',async()=>{
  const h=await fixture({authenticated:false});
  assert.equal((await h.device.restore()).restored,false);
  assert.equal(await h.device.hasRemembered(PROFILE_A),false);
  assert.equal(await h.device.hasRemembered(''),false);
  assert.equal(h.core.unlockCalls,0);assert.equal(h.core.account.getState().unlocked,false);
  assert.deepEqual(await readStore(h.factory),[]);
});

test('remember persists only a nonextractable wrapping key and a bounded encrypted device envelope',async()=>{
  const h=await fixture(),result=await h.device.remember();
  assert.equal(result.profileId,PROFILE_A);assert.equal(result.expiresAt,START+TTL);
  const records=await readStore(h.factory);assert.equal(records.length,1);
  const record=records[0];
  assert.equal(record.id,'active');assert.equal(record.version,1);assert.equal(record.profileId,PROFILE_A);assert.equal(record.origin,ORIGIN);
  assert.equal(record.createdAt,START);assert.equal(record.expiresAt-record.createdAt,TTL);assert.ok(Number.isSafeInteger(record.epoch));
  const key=record.wrappingKey;
  assert.equal(key.type,'secret');assert.equal(key.extractable,false);assert.equal(key.algorithm.name,'AES-GCM');assert.equal(key.algorithm.length,256);
  assert.deepEqual([...key.usages].sort(),['unwrapKey','wrapKey']);
  await assert.rejects(()=>webcrypto.subtle.exportKey('raw',key));
  assert.match(record.envelope.purpose,/^remembered-device:[A-Za-z0-9_-]{43}$/);
  assert.equal(record.envelope.profileId,PROFILE_A);assert.equal(decode(record.envelope.iv).byteLength,12);assert.equal(decode(record.envelope.ciphertext).byteLength,48);
  const serialized=JSON.stringify(records);
  for(const secret of [PASSWORD,TOKEN,CANARY,encode(h.core.profiles.get(PROFILE_A).raw),Buffer.from(h.core.profiles.get(PROFILE_A).raw).toString('hex')])assert.equal(serialized.includes(secret),false,secret);
  for(const property of ['password','token','accessToken','refreshToken','rawKey','dataKey','dek'])assert.equal(property in record,false,property);
  assert.equal(await h.device.hasRemembered(PROFILE_A),true);
});

test('a fresh factory restores the persisted CryptoKey and genuinely decrypts the remembered profile',async()=>{
  const h=await fixture();await h.device.remember();h.core.account.lock();
  const restored=await h.fresh().restore();
  assert.equal(restored.restored,true);assert.equal(restored.profile.id,PROFILE_A);
  assert.equal(h.core.account.getState().unlocked,true);assert.equal(h.core.account.getState().profileId,PROFILE_A);
  assert.equal(await h.core.readCanary(),CANARY);assert.equal(h.core.unlockCalls,1);
});

test('remember refuses locked, guest and unsupported environments without creating a durable login',async t=>{
  for(const [name,options]of [
    ['locked',{authenticated:false}],['guest',{guest:true}],['insecure',{environment:{secureContext:false}}],
    ['missing crypto',{environment:{crypto:{}}}],['missing IndexedDB',{environment:{indexedDB:{}}}]
  ])await t.test(name,async()=>{
    const h=await fixture(options);
    await assert.rejects(()=>h.device.remember());
    assert.equal(h.core.wrapCalls,0);assert.deepEqual(await readStore(h.factory),[]);
  });
});

test('remembered access lasts up to thirty days and expires at the exact boundary',async()=>{
  const h=await fixture();await h.device.remember();h.core.account.lock();
  h.setNow(START+TTL-1);
  assert.equal((await h.fresh().restore()).restored,true);
  h.core.account.lock();h.setNow(START+TTL);
  assert.equal((await h.fresh().restore()).restored,false);
  assert.equal(h.core.account.getState().unlocked,false);assert.deepEqual(await readStore(h.factory),[]);
});

test('expired, future, cross-origin and corrupted records are removed instead of activating a profile',async t=>{
  const corruptions=[
    ['expired',record=>({...record,createdAt:START-TTL-1,expiresAt:START-1})],
    ['future creation',record=>({...record,createdAt:START+1,expiresAt:START+TTL+1})],
    ['extended lifetime',record=>({...record,expiresAt:START+TTL+1})],
    ['unsafe timestamp',record=>({...record,expiresAt:Number.MAX_SAFE_INTEGER+1})],
    ['other origin',record=>({...record,origin:'https://other.example'})],
    ['other version',record=>({...record,version:2})],
    ['empty profile',record=>({...record,profileId:''})],
    ['unknown profile',record=>({...record,profileId:'33333333-3333-4333-8333-333333333333',envelope:{...record.envelope,profileId:'33333333-3333-4333-8333-333333333333'}})],
    ['wrong envelope purpose',record=>({...record,envelope:{...record.envelope,purpose:'password-key'}})],
    ['corrupted IV',record=>({...record,envelope:{...record.envelope,iv:'not-a-valid-iv'}})],
    ['corrupted ciphertext',record=>({...record,envelope:{...record.envelope,ciphertext:'broken'}})],
    ['extractable wrapping key',async record=>({...record,wrappingKey:await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['wrapKey','unwrapKey'])})]
  ];
  for(const [name,corrupt]of corruptions)await t.test(name,async()=>{
    const h=await fixture();await h.device.remember();h.core.account.lock();await mutateRecord(h.factory,corrupt);
    assert.equal((await h.fresh().restore()).restored,false);
    assert.equal(h.core.account.getState().unlocked,false);assert.deepEqual(await readStore(h.factory),[]);
  });
});

test('changing the profile credential invalidates its previously remembered encrypted envelope',async()=>{
  const h=await fixture();await h.device.remember();h.core.account.lock();h.core.changeCredentials();
  assert.equal((await h.fresh().restore()).restored,false);
  assert.equal(h.core.account.getState().unlocked,false);assert.deepEqual(await readStore(h.factory),[]);
});

test('only one active profile is remembered and replacing it does not expose the old profile key',async()=>{
  const h=await fixture();await h.device.remember();const [first]=await readStore(h.factory);
  h.core.activate(PROFILE_B);await h.fresh().remember();
  const records=await readStore(h.factory);assert.equal(records.length,1);assert.equal(records[0].profileId,PROFILE_B);
  assert.notEqual(records[0].envelope.ciphertext,first.envelope.ciphertext);
  assert.equal(await h.device.hasRemembered(PROFILE_A),false);assert.equal(await h.device.hasRemembered(PROFILE_B),true);
  h.core.account.lock();const result=await h.fresh().restore();assert.equal(result.restored,true);assert.equal(result.profile.id,PROFILE_B);
  assert.equal(await h.core.readCanary(),CANARY);
});

test('clear durably removes every remembered row and advances the shared epoch across factories',async()=>{
  const h=await fixture();await h.device.remember();const [record]=await readStore(h.factory);
  await putRecord(h.factory,{...record,id:'orphan'});
  await h.device.clear();
  assert.deepEqual(await readStore(h.factory),[]);
  const metadata=await readStore(h.factory,'meta'),epoch=metadata.find(item=>item.id==='epoch');
  assert.ok(epoch&&Number.isSafeInteger(epoch.value)&&epoch.value>record.epoch);
  h.core.account.lock();assert.equal((await h.fresh().restore()).restored,false);assert.equal(await h.fresh().hasRemembered(PROFILE_A),false);
});

function faultingFactory(factory,state) {
  return {open(...args){
    const request=factory.open(...args);
    request.addEventListener('success',()=>{
      const db=request.result,original=db.transaction.bind(db);
      db.transaction=(names,mode,...rest)=>{
        if(state.fail&&mode==='readwrite')throw new DOMException('Storage write denied','QuotaExceededError');
        const tx=original(names,mode,...rest);
        if(state.abort&&mode==='readwrite')queueMicrotask(()=>{try{tx.abort();}catch{}});
        return tx;
      };
    });
    return request;
  }};
}

test('clear rejects a storage failure instead of falsely reporting that durable remembered access was removed',async()=>{
  const factory=new IDBFactory(),state={},h=await fixture({factory,environment:{indexedDB:faultingFactory(factory,state)}});
  await h.device.remember();const before=await readStore(factory);
  state.fail=true;
  await assert.rejects(()=>h.device.clear());
  assert.deepEqual(await readStore(factory),before);
  assert.equal(await h.device.hasRemembered(PROFILE_A),true,'A failed durable clear must not claim that the saved key is gone');
  h.core.account.lock();assert.equal((await h.device.restore()).restored,false,'This factory must still fail closed after an unsuccessful clear');
  state.fail=false;await h.device.clear();assert.deepEqual(await readStore(factory),[]);
});

test('a transaction abort cannot make clear report success before its durable write commits',async()=>{
  const factory=new IDBFactory(),state={},h=await fixture({factory,environment:{indexedDB:faultingFactory(factory,state)}});
  await h.device.remember();state.abort=true;
  await assert.rejects(()=>h.device.clear());
  assert.equal((await readStore(factory)).length,1);
  state.abort=false;await h.device.clear();assert.deepEqual(await readStore(factory),[]);
});

test('clear during a pending remember prevents late crypto completion from resurrecting a session',{timeout:3000},async()=>{
  const h=await fixture(),gate=deferred(),wrap=h.core.account.wrapRememberedSessionKey;
  let entered=false;
  h.core.account.wrapRememberedSessionKey=async key=>{entered=true;await gate.promise;return wrap(key);};
  const remembering=h.device.remember();remembering.catch(()=>{});await waitFor(()=>entered);
  await h.device.clear();gate.resolve();
  await assert.rejects(()=>remembering);
  assert.deepEqual(await readStore(h.factory),[]);h.core.account.lock();assert.equal((await h.fresh().restore()).restored,false);
});

test('an older factory cannot overwrite a new remember completed after another factory cleared the epoch',{timeout:3000},async()=>{
  const h=await fixture(),other=h.fresh(),gate=deferred(),wrap=h.core.account.wrapRememberedSessionKey;
  let calls=0,entered=false;
  h.core.account.wrapRememberedSessionKey=async key=>{if(++calls===1){entered=true;await gate.promise;}return wrap(key);};
  const older=h.device.remember();older.catch(()=>{});await waitFor(()=>entered);
  await other.clear();h.advance(1000);const current=await other.remember();
  const [saved]=await readStore(h.factory);
  gate.resolve();await assert.rejects(()=>older);
  const [after]=await readStore(h.factory);
  assert.equal(after.createdAt,START+1000);assert.equal(after.expiresAt,current.expiresAt);assert.equal(after.envelope.ciphertext,saved.envelope.ciphertext);assert.equal(after.epoch,saved.epoch);
  h.core.account.lock();assert.equal((await other.restore()).restored,true);
});

test('clear during an in-flight restore invalidates its reserved account generation before activation',{timeout:3000},async()=>{
  const h=await fixture();await h.device.remember();h.core.account.lock();
  const gate=deferred();let entered=false;
  h.core.hooks.beforeUnlock=async()=>{entered=true;await gate.promise;};
  const restoring=cancelledRestore(h.device.restore());await waitFor(()=>entered);
  await h.device.clear();gate.resolve();
  assert.equal((await restoring).restored,false);
  assert.equal(h.core.account.getState().unlocked,false);assert.deepEqual(await readStore(h.factory),[]);
});

test('a stale restore completion never locks a different profile authenticated after that attempt',{timeout:3000},async()=>{
  const h=await fixture();await h.device.remember();h.core.account.lock();
  const gate=deferred(),unlock=h.core.account.unlockWithRememberedKey;let activated=false;
  h.core.account.unlockWithRememberedKey=async(...args)=>{const result=await unlock(...args);activated=true;await gate.promise;return result;};
  const restoring=cancelledRestore(h.device.restore());await waitFor(()=>activated);
  h.core.activate(PROFILE_B);await h.device.clear();gate.resolve();
  assert.equal((await restoring).restored,false);
  assert.equal(h.core.account.getState().unlocked,true);assert.equal(h.core.account.getState().profileId,PROFILE_B);
  assert.equal(await h.core.readCanary(),CANARY);
});

async function blockSessionWrites(factory) {
  const db=await openDatabase(factory),tx=db.transaction(['sessions','meta'],'readwrite');
  let holding=true;
  const completed=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Blocker aborted'));});
  const keepAlive=()=>{const request=tx.objectStore('meta').get('epoch');request.onsuccess=()=>{if(holding)keepAlive();};};
  keepAlive();
  return {async release(){holding=false;await completed;db.close();}};
}

test('a clear queued behind an IndexedDB transaction still wins over an older pending remember',{timeout:3000},async()=>{
  const h=await fixture(),other=h.fresh(),gate=deferred(),wrap=h.core.account.wrapRememberedSessionKey;let entered=false;
  h.core.account.wrapRememberedSessionKey=async key=>{entered=true;await gate.promise;return wrap(key);};
  const remembering=h.device.remember();remembering.catch(()=>{});await waitFor(()=>entered);
  const blocker=await blockSessionWrites(h.factory);
  const clearing=other.clear();
  await new Promise(resolve=>setImmediate(resolve));gate.resolve();
  await new Promise(resolve=>setImmediate(resolve));await blocker.release();
  await clearing;await assert.rejects(()=>remembering);
  assert.deepEqual(await readStore(h.factory),[]);
});


test('a stale restore completion preserves a newer password login into the same profile',{timeout:3000},async()=>{
  const h=await fixture();await h.device.remember();h.core.account.lock();
  const gate=deferred(),unlock=h.core.account.unlockWithRememberedKey;let activated=false;
  h.core.account.unlockWithRememberedKey=async(...args)=>{const result=await unlock(...args);activated=true;await gate.promise;return result;};
  const restoring=cancelledRestore(h.device.restore());await waitFor(()=>activated);
  h.core.activate(PROFILE_A);const newerGeneration=h.core.account.getState().generation;
  await h.device.clear();gate.resolve();
  assert.equal((await restoring).restored,false);
  assert.equal(h.core.account.getState().unlocked,true);assert.equal(h.core.account.getState().profileId,PROFILE_A);
  assert.equal(h.core.account.getState().generation,newerGeneration);assert.equal(await h.core.readCanary(),CANARY);
});

test('a new remember in the same factory after clear is not removed by an older cancelled attempt',{timeout:3000},async()=>{
  const h=await fixture(),gate=deferred(),wrap=h.core.account.wrapRememberedSessionKey;let calls=0,entered=false;
  h.core.account.wrapRememberedSessionKey=async key=>{if(++calls===1){entered=true;await gate.promise;}return wrap(key);};
  const older=h.device.remember();older.catch(()=>{});await waitFor(()=>entered);
  await h.device.clear();h.advance(2000);const newer=h.device.remember();newer.catch(()=>{});
  gate.resolve();await assert.rejects(()=>older);const result=await newer;
  const [record]=await readStore(h.factory);
  assert.equal(record.createdAt,START+2000);assert.equal(record.expiresAt,result.expiresAt);
  h.core.account.lock();assert.equal((await h.fresh().restore()).restored,true);
});


test('real local-account data restores with the device key and password recovery revokes the older remembered envelope',{timeout:15000},async t=>{
  const factory=new IDBFactory();
  const descriptors=new Map(['indexedDB','crypto'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,writable:true,value:factory});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  const account=createLocalAccount();
  t.after(()=>{
    account.lock();
    for(const [name,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
  });
  const username='device-integration',password='Device-Strong-Rhythm-123!',newPassword='Device-New-Rhythm-456!';
  const profile=await account.register({name:'Perfil real',username,password});
  const recoveryCode=await account.createRecoveryCode();
  await account.mutateData(data=>{
    data.workouts.push({id:'private-workout',name:'Treino privado preservado',exercises:[{id:'private-exercise',name:'Supino',weight:22.5}]});
    data.bodyWeights.push({id:'private-body',value:72.5,at:Date.now()});data.theme='dark';
  });
  const expected=await account.readData();
  const environment={crypto:webcrypto,indexedDB:factory,location:{origin:ORIGIN},secureContext:true,now:()=>START};
  const device=createLocalDeviceSession({account,environment});
  await device.remember();account.lock();
  const fresh=createLocalDeviceSession({account,environment});
  const restored=await fresh.restore();assert.equal(restored.restored,true);assert.equal(restored.profile.id,profile.id);
  assert.deepEqual(await account.readData(),expected);
  account.lock();
  const changed=await account.recoverPassword({username,recoveryCode,newPassword});
  assert.equal(changed.profile.id,profile.id);assert.deepEqual(await account.readData(),expected);
  account.lock();
  const afterReset=createLocalDeviceSession({account,environment});
  assert.equal((await afterReset.restore()).restored,false);assert.equal(account.getState().unlocked,false);
  assert.deepEqual(await readStore(factory),[]);
  await account.login(username,newPassword);assert.deepEqual(await account.readData(),expected);
});
