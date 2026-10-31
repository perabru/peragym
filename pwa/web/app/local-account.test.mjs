import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {createLocalAccount, localAccount} from './local-account.js';

const require=createRequire(import.meta.url);
const {IDBFactory,IDBKeyRange}=require('fake-indexeddb');
const DB='peragym-accounts-v1';
const PASSWORD='Correct-Horse-Rhythm-123!';
const SECOND_PASSWORD='Another-Strong-Rhythm-456!';

function setup(t){
  const keys=['indexedDB','IDBKeyRange','crypto','localStorage','sessionStorage'];
  const descriptors=Object.fromEntries(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,writable:true,value:new IDBFactory()});
  Object.defineProperty(globalThis,'IDBKeyRange',{configurable:true,writable:true,value:IDBKeyRange});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  for(const key of ['localStorage','sessionStorage'])Object.defineProperty(globalThis,key,{configurable:true,get(){throw new Error('Account keys and login state must not use browser storage');}});
  t.after(()=>{for(const [key,value]of Object.entries(descriptors)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  return createLocalAccount();
}

async function openDb(name=DB){
  return new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}

async function dump(){
  const db=await openDb();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['profiles','vaults'],'readonly'),out={};
    for(const name of ['profiles','vaults']){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{out[name]=r.result;};}
    tx.oncomplete=()=>resolve(out);tx.onerror=tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}

async function dumpGuest(){
  const db=await openDb('peragym-guest-v1');
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['keys','vaults'],'readonly'),out={};
    for(const name of ['keys','vaults']){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{out[name]=r.result;};}
    tx.oncomplete=()=>resolve(out);tx.onerror=tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}

async function changeStored(store,id,fn){
  const db=await openDb();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction([store],'readwrite'),s=tx.objectStore(store),r=s.get(id);
    r.onsuccess=()=>{const changed=fn(r.result);s.put(changed);};
    tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}

function bitflip(encoded){
  const chars=String(encoded).split('');const index=Math.min(8,chars.length-1);
  chars[index]=chars[index]==='A'?'B':'A';return chars.join('');
}

async function wrappingKey(){return webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['wrapKey','unwrapKey']);}
async function register(account,username='bruno',password=PASSWORD){return account.register({name:`Perfil ${username}`,username,password});}

test('factories and the exported singleton expose the account API without an automatically unlocked profile',async t=>{
  const account=setup(t);assert.equal(typeof localAccount.getState,'function');
  assert.equal(account.getState().supported,true);assert.equal(account.getState().unlocked,false);
  assert.deepEqual(await account.listProfiles(),[]);
  await assert.rejects(()=>account.readData(),Error);
  await assert.rejects(()=>account.mutateData(d=>d.workouts.push({id:'forbidden'})),Error);
});

test('registration unlocks an empty cloned vault; metadata uses PBKDF2-600k and encrypted records contain no private plaintext',async t=>{
  const account=setup(t),profile=await register(account);
  assert.deepEqual(Object.keys(profile).sort(),['id','name','username']);
  assert.equal(account.getState().unlocked,true);assert.equal(account.getState().profileId,profile.id);
  const data=await account.readData();
  assert.deepEqual(data,{workouts:[],sessions:[],loadHistory:[],bodyWeights:[],theme:'light',activeSession:null,musicLinks:[],legacyImport:null});
  data.workouts.push({id:'unsaved',name:'UNSAVED-PRIVATE-TEXT'});
  assert.equal((await account.readData()).workouts.length,0);
  const returned=await account.mutateData(d=>{d.workouts.push({id:'w1',name:'PRIVATE-WORKOUT-SENTINEL'});d.bodyWeights.push({id:'weight',value:73.25});return 'saved-directly';});
  assert.equal(returned,'saved-directly');
  const stored=await dump(),meta=stored.profiles[0],vault=stored.vaults[0];
  assert.equal(meta.kdf.name,'PBKDF2');assert.equal(meta.kdf.hash,'SHA-256');assert.equal(meta.kdf.iterations,600000);
  assert.equal(Buffer.from(meta.kdf.salt,'base64url').byteLength,16);
  assert.equal(meta.passwordEnvelope.version,1);assert.equal(meta.passwordEnvelope.profileId,profile.id);assert.equal(meta.passwordEnvelope.purpose,'password-key');
  assert.equal(vault.profileId,profile.id);assert.equal(vault.version,1);assert.equal(vault.revision,1);
  assert.equal(Buffer.from(vault.iv,'base64url').byteLength,12);
  const serialized=JSON.stringify(stored);
  for(const secret of [PASSWORD,'PRIVATE-WORKOUT-SENTINEL','UNSAVED-PRIVATE-TEXT'])assert.equal(serialized.includes(secret),false,secret);
  assert.equal('workouts' in vault,false);assert.equal('bodyWeights' in vault,false);
  assert.deepEqual(Object.keys((await account.listProfiles())[0]).sort(),['id','name','username']);
});

test('the same password creates independent salts and wrapping envelopes for independent profiles',async t=>{
  const account=setup(t),a=await register(account,'alice'),b=await register(account,'bruno');
  assert.notEqual(a.id,b.id);
  const stored=await dump(),ma=stored.profiles.find(x=>x.id===a.id),mb=stored.profiles.find(x=>x.id===b.id);
  assert.notEqual(ma.kdf.salt,mb.kdf.salt);
  assert.notEqual(ma.passwordEnvelope.iv,mb.passwordEnvelope.iv);
  assert.notEqual(ma.passwordEnvelope.ciphertext,mb.passwordEnvelope.ciphertext);
  assert.equal(stored.vaults.length,2);
  await assert.rejects(()=>register(account,'alice'),Error);
  assert.deepEqual(await dump(),stored);
});

test('wrong passwords never delete or replace the encrypted vault',async t=>{
  const account=setup(t),profile=await register(account);
  await account.mutateData(d=>{d.workouts.push({id:'saved',name:'Persistent secret'});});account.lock();
  const before=await dump();await assert.rejects(()=>account.login('bruno','Wrong-Password-123!'),Error);
  assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),before);
  await account.login('bruno',PASSWORD);
  assert.equal(account.getState().profileId,profile.id);assert.equal((await account.readData()).workouts[0].name,'Persistent secret');
});

test('profiles stay isolated when switching logins and returning to an earlier vault',async t=>{
  const account=setup(t),a=await register(account,'alice',PASSWORD);
  await account.mutateData(d=>{d.workouts.push({id:'alice-workout',name:'Alice private'});});
  const b=await register(account,'bruno',SECOND_PASSWORD);assert.notEqual(a.id,b.id);
  assert.equal((await account.readData()).workouts.length,0);
  await account.mutateData(d=>{d.musicLinks.push({id:'bruno-music',label:'Bruno private'});});account.lock();
  await account.login('alice',PASSWORD);let data=await account.readData();
  assert.equal(data.workouts[0].name,'Alice private');assert.deepEqual(data.musicLinks,[]);
  account.lock();await account.login('bruno',SECOND_PASSWORD);data=await account.readData();
  assert.deepEqual(data.workouts,[]);assert.equal(data.musicLinks[0].label,'Bruno private');
});

test('lock clears the RAM session and a fresh factory requires an explicit login',async t=>{
  const account=setup(t);await register(account);let notifications=0;
  const unsubscribe=account.subscribe(()=>notifications++);
  const before=account.getState().generation;account.lock();
  assert.equal(account.getState().unlocked,false);assert.ok(account.getState().generation>before);assert.ok(notifications>0);
  assert.equal(Boolean(account.getState().profile),false);
  await assert.rejects(()=>account.readData(),Error);
  const other=createLocalAccount();assert.equal(other.getState().unlocked,false);assert.equal((await other.listProfiles()).length,1);
  await assert.rejects(()=>other.readData(),Error);
  unsubscribe();const count=notifications;account.lock();assert.equal(notifications,count);
});

test('authenticated encryption rejects modified vault bytes while preserving stored records',async t=>{
  const account=setup(t),profile=await register(account);await account.mutateData(d=>{d.workouts.push({id:'secret',name:'Integrity matters'});});account.lock();
  const original=(await dump()).vaults[0];
  await changeStored('vaults',profile.id,row=>({...row,ciphertext:bitflip(row.ciphertext)}));
  const corrupt=await dump();await assert.rejects(()=>account.login('bruno',PASSWORD),Error);
  assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),corrupt);
  await changeStored('vaults',profile.id,()=>({...original,revision:original.revision+1}));
  const tamperedRevision=await dump();await assert.rejects(()=>account.login('bruno',PASSWORD),Error);
  assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),tamperedRevision);
});

test('each committed write uses a fresh IV and advances the authenticated vault revision',async t=>{
  const account=setup(t);await register(account);const zero=(await dump()).vaults[0];
  await account.mutateData(d=>{d.theme='dark';});const one=(await dump()).vaults[0];
  await account.mutateData(d=>{d.theme='light';});const two=(await dump()).vaults[0];
  assert.deepEqual([zero.revision,one.revision,two.revision],[0,1,2]);
  assert.equal(new Set([zero.iv,one.iv,two.iv]).size,3);
  assert.notEqual(one.ciphertext,two.ciphertext);assert.equal(account.getState().revision,2);
});

test('a throwing transaction or asynchronous mutator never partially commits its draft',async t=>{
  const account=setup(t);await register(account);const before=await dump();
  await assert.rejects(()=>account.mutateData(d=>{d.workouts.push({id:'partial'});throw new Error('Deliberate transaction failure');}),/Deliberate/);
  assert.deepEqual(await dump(),before);assert.deepEqual((await account.readData()).workouts,[]);
  await assert.rejects(()=>account.mutateData(async d=>{await Promise.resolve();d.workouts.push({id:'late'});}),Error);
  assert.deepEqual(await dump(),before);assert.deepEqual((await account.readData()).workouts,[]);
});

test('stale instances cannot overwrite another tab until readData refreshes the revision',async t=>{
  const first=setup(t);await register(first);const second=createLocalAccount();await second.login('bruno',PASSWORD);
  await first.mutateData(d=>{d.workouts.push({id:'first',name:'First tab'});});
  await assert.rejects(()=>second.mutateData(d=>{d.workouts.push({id:'stale',name:'Stale tab'});}),error=>error.name==='LocalAccountConflict');
  const refreshed=await second.readData();assert.equal(refreshed.workouts.length,1);assert.equal(second.getState().revision,1);
  await second.mutateData(d=>{d.workouts.push({id:'second',name:'Refreshed tab'});});
  assert.deepEqual((await first.readData()).workouts.map(w=>w.id),['first','second']);
});

test('concurrent compare-and-swap writes have one winner instead of silently losing data',async t=>{
  const a=setup(t);await register(a);const b=createLocalAccount();await b.login('bruno',PASSWORD);
  const outcomes=await Promise.allSettled([
    a.mutateData(d=>{d.workouts.push({id:'a'});}),b.mutateData(d=>{d.workouts.push({id:'b'});})
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  const failed=outcomes.find(x=>x.status==='rejected');assert.equal(failed.reason.name,'LocalAccountConflict');
  const data=await a.readData();assert.equal(data.workouts.length,1);assert.ok(['a','b'].includes(data.workouts[0].id));
  assert.equal((await dump()).vaults[0].revision,1);
});

test('registration leaves the older unclaimed database untouched and starts with no implicit legacy claim',async t=>{
  const account=setup(t);
  const legacy=await new Promise((resolve,reject)=>{
    const r=indexedDB.open('peragym-local',1);r.onupgradeneeded=()=>r.result.createObjectStore('workouts',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  await new Promise((resolve,reject)=>{const tx=legacy.transaction('workouts','readwrite');tx.objectStore('workouts').put({id:'legacy',name:'Legacy private sentinel'});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  await register(account);const data=await account.readData();assert.deepEqual(data.workouts,[]);assert.equal(data.legacyImport,null);
  const old=await new Promise((resolve,reject)=>{const tx=legacy.transaction('workouts','readonly'),r=tx.objectStore('workouts').get('legacy');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  assert.equal(old.name,'Legacy private sentinel');legacy.close();
});

test('a biometric wrapping envelope unlocks the correct profile without returning a raw key',async t=>{
  const account=setup(t),profile=await register(account),key=await wrappingKey();
  await account.mutateData(d=>{d.workouts.push({id:'wrap',name:'Wrapped private record'});});
  const envelope=await account.wrapSessionKey(key);
  assert.equal(envelope.version,1);assert.equal(envelope.profileId,profile.id);assert.equal(envelope.purpose,'biometric-prf');
  assert.equal(Buffer.from(envelope.iv,'base64url').byteLength,12);assert.ok(typeof envelope.ciphertext==='string');
  for(const forbidden of ['key','rawKey','dataKey','password','workouts'])assert.equal(forbidden in envelope,false);
  const serialized=JSON.stringify(envelope);assert.equal(serialized.includes(PASSWORD),false);assert.equal(serialized.includes('Wrapped private record'),false);
  account.lock();const unlocked=await account.unlockWithWrappedKey(profile.id,key,envelope);
  assert.equal(unlocked.id,profile.id);assert.equal((await account.readData()).workouts[0].name,'Wrapped private record');
});

test('wrapped keys reject a wrong wrapping key, another profile and an invalid key type',async t=>{
  const account=setup(t),key=await wrappingKey();await assert.rejects(()=>account.wrapSessionKey(key),Error);
  const a=await register(account,'alice'),envelope=await account.wrapSessionKey(key),b=await register(account,'bruno');
  const wrongKey=await wrappingKey();account.lock();await assert.rejects(()=>account.unlockWithWrappedKey(a.id,wrongKey,envelope),Error);
  assert.equal(account.getState().unlocked,false);
  await assert.rejects(()=>account.unlockWithWrappedKey(b.id,key,{...envelope,profileId:b.id}),Error);
  assert.equal(account.getState().unlocked,false);
  await assert.rejects(()=>account.unlockWithWrappedKey(a.id,{},envelope),Error);
  await account.login('alice',PASSWORD);await assert.rejects(()=>account.wrapSessionKey({}),Error);
  const weak=await webcrypto.subtle.generateKey({name:'AES-GCM',length:128},false,['wrapKey','unwrapKey']);
  const wrongUsage=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  await assert.rejects(()=>account.wrapSessionKey(weak),Error);
  await assert.rejects(()=>account.wrapSessionKey(wrongUsage),Error);
});

test('locking immediately cancels pending work before its mutator can run',async t=>{
  const account=setup(t);await register(account);let ran=false;
  const write=account.mutateData(d=>{ran=true;d.workouts.push({id:'after-lock'});});account.lock();
  await assert.rejects(()=>write,Error);assert.equal(ran,false);assert.equal(account.getState().unlocked,false);
  await account.login('bruno',PASSWORD);assert.deepEqual((await account.readData()).workouts,[]);
});

test('locking during encryption prevents a completed ciphertext from committing after the session ends',async t=>{
  const account=setup(t);await register(account);const before=await dump();
  const subtle=webcrypto.subtle,original=Object.getOwnPropertyDescriptor(subtle,'encrypt'),encrypt=subtle.encrypt.bind(subtle);
  let enteredResolve,release;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  Object.defineProperty(subtle,'encrypt',{configurable:true,value:(...args)=>{
    enteredResolve();return new Promise((resolve,reject)=>{release=()=>encrypt(...args).then(resolve,reject);});
  }});
  t.after(()=>{if(original)Object.defineProperty(subtle,'encrypt',original);else delete subtle.encrypt;});
  const write=account.mutateData(d=>{d.workouts.push({id:'encrypted-after-lock'});});
  let timeout;
  try{await Promise.race([entered,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Encryption was not reached')),3000);})]);}
  finally{clearTimeout(timeout);}
  account.lock();release();await assert.rejects(()=>write,Error);
  assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),before);
});

test('guest entry persists its own records across locks and new factories without appearing in registered profiles',async t=>{
  const account=setup(t),guest=await account.enterGuest();
  assert.deepEqual(guest,{id:'guest-local',name:'Visitante',username:'visitante'});
  assert.equal(account.getState().guest,true);assert.equal(account.getState().unlocked,true);
  await account.mutateData(d=>{d.workouts.push({id:'guest-workout',name:'Guest record'});});
  account.lock();const another=createLocalAccount();assert.equal(another.getState().unlocked,false);
  await another.enterGuest();assert.equal((await another.readData()).workouts[0].name,'Guest record');
  assert.deepEqual(await another.listProfiles(),[]);
  const registered=await register(another,'registered');assert.notEqual(registered.id,'guest-local');
  assert.equal(another.getState().guest,false);assert.deepEqual((await another.readData()).workouts,[]);
  assert.deepEqual((await another.listProfiles()).map(p=>p.id),[registered.id]);
  another.lock();await another.enterGuest();assert.equal((await another.readData()).workouts[0].id,'guest-workout');
});

test('guest storage keeps a nonextractable AES-256 CryptoKey and authenticated ciphertext rather than plaintext records',async t=>{
  const account=setup(t);await account.enterGuest();
  await account.mutateData(d=>{d.workouts.push({id:'guest-private',name:'GUEST-PRIVATE-SENTINEL'});d.bodyWeights.push({id:'guest-weight',value:81.75});});
  const stored=await dumpGuest();assert.equal(stored.keys.length,1);assert.equal(stored.vaults.length,1);
  const record=stored.keys[0],vault=stored.vaults[0];
  assert.equal(record.id,'guest-local');assert.equal(record.key.type,'secret');assert.equal(record.key.extractable,false);
  assert.equal(record.key.algorithm.name,'AES-GCM');assert.equal(record.key.algorithm.length,256);
  assert.deepEqual([...record.key.usages].sort(),['decrypt','encrypt']);
  await assert.rejects(()=>webcrypto.subtle.exportKey('raw',record.key),Error);
  assert.equal(vault.profileId,'guest-local');assert.equal(vault.version,1);assert.equal(vault.revision,1);
  assert.equal(Buffer.from(vault.iv,'base64url').byteLength,12);assert.equal(typeof vault.ciphertext,'string');
  assert.equal(JSON.stringify(stored).includes('GUEST-PRIVATE-SENTINEL'),false);
  assert.equal('workouts' in vault,false);assert.equal('bodyWeights' in vault,false);assert.equal('passwordEnvelope' in record,false);
});

test('guest data is copied to a new password profile only after explicit opt-in and its source always remains intact',async t=>{
  const account=setup(t);await account.enterGuest();
  await account.mutateData(d=>{d.workouts.push({id:'guest-source',name:'Original visitor record'});d.musicLinks.push({id:'guest-track',label:'Visitor track'});d.theme='dark';});
  await account.register({name:'Blank profile',username:'blank',password:PASSWORD});
  assert.deepEqual((await account.readData()).workouts,[]);assert.equal((await account.readData()).theme,'light');
  account.lock();await account.enterGuest();const original=await account.readData();
  await account.register({name:'Copied profile',username:'copied',password:SECOND_PASSWORD,copyGuestData:true});
  const copied=await account.readData();assert.deepEqual(copied.workouts,original.workouts);assert.deepEqual(copied.musicLinks,original.musicLinks);assert.equal(copied.theme,'dark');
  await account.mutateData(d=>{d.workouts[0].name='Registered-only edit';});
  account.lock();await account.enterGuest();assert.deepEqual(await account.readData(),original);
  account.lock();await account.login('copied',SECOND_PASSWORD);assert.equal((await account.readData()).workouts[0].name,'Registered-only edit');
  account.lock();await account.login('blank',PASSWORD);assert.deepEqual((await account.readData()).workouts,[]);
});

test('concurrent first guest entry shares one persisted key and guest writes retain the same conflict protection',async t=>{
  const a=setup(t),b=createLocalAccount();
  await Promise.all([a.enterGuest(),b.enterGuest()]);
  const initial=await dumpGuest();assert.equal(initial.keys.length,1);assert.equal(initial.vaults.length,1);
  await a.mutateData(d=>{d.workouts.push({id:'first-guest-tab'});});
  await assert.rejects(()=>b.mutateData(d=>{d.workouts.push({id:'stale-guest-tab'});}),error=>error.name==='LocalAccountConflict');
  await b.readData();
  const outcomes=await Promise.allSettled([
    a.mutateData(d=>{d.workouts.push({id:'guest-a'});}),b.mutateData(d=>{d.workouts.push({id:'guest-b'});})
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.find(x=>x.status==='rejected').reason.name,'LocalAccountConflict');
  const data=await a.readData();assert.equal(data.workouts.length,2);assert.equal(data.workouts[0].id,'first-guest-tab');
  assert.ok(['guest-a','guest-b'].includes(data.workouts[1].id));assert.equal((await dumpGuest()).vaults[0].revision,2);
});

test('guest access never pretends to offer biometric key wrapping or biometric unlock',async t=>{
  const account=setup(t),key=await wrappingKey();await account.enterGuest();
  await assert.rejects(()=>account.wrapSessionKey(key),Error);
  account.lock();
  const envelope={version:1,profileId:'guest-local',purpose:'biometric-prf',iv:'A'.repeat(16),ciphertext:'A'.repeat(64)};
  await assert.rejects(()=>account.unlockWithWrappedKey('guest-local',key,envelope),Error);
  assert.equal(account.getState().unlocked,false);
  await account.enterGuest();assert.equal(account.getState().guest,true);
});

test('guest locking cancels both pending mutators and encryption without committing after the lock',async t=>{
  const account=setup(t);await account.enterGuest();let ran=false;
  const immediate=account.mutateData(d=>{ran=true;d.workouts.push({id:'after-guest-lock'});});account.lock();
  await assert.rejects(()=>immediate,Error);assert.equal(ran,false);
  await account.enterGuest();const before=await dumpGuest();
  const subtle=webcrypto.subtle,original=Object.getOwnPropertyDescriptor(subtle,'encrypt'),encrypt=subtle.encrypt.bind(subtle);
  let enteredResolve,release;const entered=new Promise(resolve=>{enteredResolve=resolve;});
  Object.defineProperty(subtle,'encrypt',{configurable:true,value:(...args)=>{
    enteredResolve();return new Promise((resolve,reject)=>{release=()=>encrypt(...args).then(resolve,reject);});
  }});
  t.after(()=>{if(original)Object.defineProperty(subtle,'encrypt',original);else delete subtle.encrypt;});
  const write=account.mutateData(d=>{d.workouts.push({id:'encrypted-guest-after-lock'});});let timeout;
  try{await Promise.race([entered,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Guest encryption was not reached')),3000);})]);}
  finally{clearTimeout(timeout);}
  account.lock();release();await assert.rejects(()=>write,Error);
  assert.equal(account.getState().unlocked,false);assert.deepEqual(await dumpGuest(),before);
});

const recoveryPattern=/^PG-(?:[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-){7}[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const fakeRecovery='PG-0000-0000-0000-0000-0000-0000-0000-0000';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function patchMethod(t,object,name,value){
 const descriptor=Object.getOwnPropertyDescriptor(object,name);Object.defineProperty(object,name,{configurable:true,writable:true,value});
 let restored=false;const restore=()=>{if(restored)return;restored=true;if(descriptor)Object.defineProperty(object,name,descriptor);else delete object[name];};
 t.after(restore);return restore;
}

test('recovery is explicit, requires an authenticated password profile and never becomes available for guest data',async t=>{
 const account=setup(t);
 for(const operation of [()=>account.getRecoveryStatus(),()=>account.createRecoveryCode()])await assert.rejects(operation,error=>error.name==='LocalAccountLocked');
 await account.enterGuest();const guest=await dumpGuest();assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});
 await assert.rejects(()=>account.createRecoveryCode(),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dumpGuest(),guest);
 await register(account);assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});const before=await dump();account.lock();
 await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:fakeRecovery,newPassword:SECOND_PASSWORD}),error=>error.name==='LocalAccountAuthError');
 assert.deepEqual(await dump(),before);assert.equal(account.getState().unlocked,false);assert.deepEqual(await dumpGuest(),guest);
 await account.login('bruno',PASSWORD);assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});
});

test('recovery codes contain 160 random bits and persist only profile-bound HKDF/AES envelopes, never plaintext codes',async t=>{
 const account=setup(t),profile=await register(account);const before=await dump();
 const code=await account.createRecoveryCode();assert.match(code,recoveryPattern);assert.equal(code.replace(/[^0-9A-Z]/g,'').slice(2).length,32);
 const stored=await dump(),record=stored.profiles[0].recovery;
 assert.equal(record.version,1);assert.equal(record.generation,1);assert.equal(record.kdf.name,'HKDF');assert.equal(record.kdf.hash,'SHA-256');
 assert.equal(Buffer.from(record.kdf.salt,'base64url').byteLength,16);assert.equal(record.envelope.purpose,'recovery-key');assert.equal(record.envelope.profileId,profile.id);
 assert.equal(Buffer.from(record.envelope.iv,'base64url').byteLength,12);assert.equal(Buffer.from(record.envelope.ciphertext,'base64url').byteLength,48);
 assert.deepEqual(stored.vaults,before.vaults);assert.deepEqual(stored.profiles[0].kdf,before.profiles[0].kdf);
 assert.deepEqual(stored.profiles[0].passwordEnvelope,before.profiles[0].passwordEnvelope);assert.deepEqual(await account.getRecoveryStatus(),{enabled:true});
 for(const secret of [code,code.replaceAll('-','').slice(2),PASSWORD])assert.equal(JSON.stringify(stored).includes(secret),false);
 assert.deepEqual(Object.keys((await account.listProfiles())[0]).sort(),['id','name','username']);
 const rotated=await account.createRecoveryCode();assert.match(rotated,recoveryPattern);assert.notEqual(rotated,code);
 const after=await dump();assert.equal(after.profiles[0].recovery.generation,2);assert.notEqual(after.profiles[0].recovery.kdf.salt,record.kdf.salt);assert.deepEqual(after.vaults,before.vaults);
 account.lock();await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD}),error=>error.name==='LocalAccountAuthError');
 assert.deepEqual(await dump(),after);await account.login('bruno',PASSWORD);
});

test('password recovery rotates credentials atomically while preserving the exact vault and existing biometric data key',async t=>{
 const account=setup(t),profile=await register(account),bioKey=await wrappingKey();
 await account.mutateData(d=>{d.workouts.push({id:'w-recover',name:'Recovered private workout'});d.sessions.push({id:'s-recover',duration:125});d.loadHistory.push({id:'load-recover',value:22.5});d.bodyWeights.push({id:'body-recover',value:73.25});d.activeSession={id:'w-recover',startedAt:1000,done:[],pausedAt:3000,pausedMs:100};d.musicLinks=['https://music.youtube.com/watch?v=dQw4w9WgXcQ'];d.theme='dark';d.legacyImport={source:'peragym-local'};});
 const data=await account.readData(),biometric=await account.wrapSessionKey(bioKey),code=await account.createRecoveryCode(),before=await dump();account.lock();
 const result=await account.recoverPassword({username:' BRUNO ',recoveryCode:code.toLowerCase().replaceAll('-',' '),newPassword:SECOND_PASSWORD});
 assert.deepEqual(result.profile,profile);assert.match(result.recoveryCode,recoveryPattern);assert.notEqual(result.recoveryCode,code);
 assert.equal(account.getState().unlocked,true);assert.deepEqual(await account.readData(),data);
 const after=await dump();assert.deepEqual(after.vaults,before.vaults);assert.notEqual(after.profiles[0].kdf.salt,before.profiles[0].kdf.salt);
 assert.notDeepEqual(after.profiles[0].passwordEnvelope,before.profiles[0].passwordEnvelope);assert.equal(after.profiles[0].recovery.generation,2);
 for(const secret of [code,result.recoveryCode,PASSWORD,SECOND_PASSWORD])assert.equal(JSON.stringify(after).includes(secret),false);
 const generation=account.getState().generation;
 await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:result.recoveryCode,newPassword:PASSWORD}));assert.equal(account.getState().generation,generation);assert.equal(account.getState().unlocked,true);
 account.lock();await assert.rejects(()=>account.login('bruno',PASSWORD),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dump(),after);
 await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:PASSWORD}),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dump(),after);
 await account.login('bruno',SECOND_PASSWORD);assert.deepEqual(await account.readData(),data);account.lock();
 await account.unlockWithWrappedKey(profile.id,bioKey,biometric);assert.deepEqual(await account.readData(),data);account.lock();
 const next=await account.recoverPassword({username:'bruno',recoveryCode:result.recoveryCode,newPassword:'Third-Strong-Rhythm-789!'});assert.match(next.recoveryCode,recoveryPattern);assert.deepEqual(await account.readData(),data);assert.deepEqual((await dump()).vaults,before.vaults);
});

test('wrong recovery code, wrong profile and malformed inputs cannot alter password profiles or guest records',async t=>{
 const account=setup(t);await account.enterGuest();await account.mutateData(d=>{d.workouts.push({id:'guest-isolated',name:'Guest stays intact'});});const guest=await dumpGuest();
 const a=await register(account,'alice');await account.mutateData(d=>{d.workouts.push({id:'alice-isolated'});});const codeA=await account.createRecoveryCode();
 const b=await register(account,'bruno',SECOND_PASSWORD);await account.mutateData(d=>{d.workouts.push({id:'bruno-isolated'});});const codeB=await account.createRecoveryCode();account.lock();
 const before=await dump();
 for(const input of [{username:'bruno',recoveryCode:codeA,newPassword:PASSWORD},{username:'missing',recoveryCode:codeA,newPassword:PASSWORD},
  {username:'alice',recoveryCode:fakeRecovery,newPassword:SECOND_PASSWORD},{username:'alice',recoveryCode:'PG-invalid',newPassword:SECOND_PASSWORD},
  {username:'alice',recoveryCode:codeA,newPassword:'short'}]){
  await assert.rejects(()=>account.recoverPassword(input));assert.deepEqual(await dump(),before);assert.deepEqual(await dumpGuest(),guest);assert.equal(account.getState().unlocked,false);
 }
 const recovered=await account.recoverPassword({username:'alice',recoveryCode:codeA,newPassword:SECOND_PASSWORD});assert.equal(recovered.profile.id,a.id);
 assert.deepEqual((await account.readData()).workouts,[{id:'alice-isolated'}]);assert.deepEqual((await dump()).vaults,before.vaults);account.lock();
 await account.login('bruno',SECOND_PASSWORD);assert.equal(account.getState().profileId,b.id);assert.deepEqual((await account.readData()).workouts,[{id:'bruno-isolated'}]);
 assert.deepEqual((await dump()).profiles.find(p=>p.id===b.id),before.profiles.find(p=>p.id===b.id));assert.deepEqual(await dumpGuest(),guest);assert.equal(JSON.stringify(await dump()).includes(codeB),false);
});

test('crypto wrapping failures never enable a code or replace existing recovery/password metadata',async t=>{
 const account=setup(t);await register(account);const initial=await dump(),subtle=webcrypto.subtle;
 let restore=patchMethod(t,subtle,'wrapKey',async()=>{throw new DOMException('Synthetic wrap failure','OperationError');});
 await assert.rejects(()=>account.createRecoveryCode());assert.deepEqual(await dump(),initial);assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});restore();
 const code=await account.createRecoveryCode(),before=await dump();account.lock();
 restore=patchMethod(t,subtle,'wrapKey',async()=>{throw new DOMException('Synthetic wrap failure','OperationError');});
 await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD}));assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),before);restore();
 await account.login('bruno',PASSWORD);assert.deepEqual(await account.getRecoveryStatus(),{enabled:true});account.lock();
 await account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});assert.deepEqual((await dump()).vaults,before.vaults);
});

test('failed metadata storage rolls back both newly generated recovery codes and password resets',async t=>{
 const account=setup(t);await register(account);const initial=await dump();
 const Store=require('fake-indexeddb').IDBObjectStore,put=Store.prototype.put;
 const failPut=function(value,...args){if(this.name==='profiles'&&value.recovery)throw new DOMException('Synthetic quota failure','QuotaExceededError');return put.call(this,value,...args);};
 let restore=patchMethod(t,Store.prototype,'put',failPut);await assert.rejects(()=>account.createRecoveryCode());assert.deepEqual(await dump(),initial);restore();
 const code=await account.createRecoveryCode(),before=await dump();account.lock();restore=patchMethod(t,Store.prototype,'put',failPut);
 await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD}));assert.deepEqual(await dump(),before);assert.equal(account.getState().unlocked,false);restore();
 await account.login('bruno',PASSWORD);account.lock();await account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});assert.deepEqual((await dump()).vaults,before.vaults);
});

test('a stale recovery-code rotation cannot overwrite a password reset committed by another instance',async t=>{
 const account=setup(t);await register(account);const oldCode=await account.createRecoveryCode(),reset=createLocalAccount(),before=await dump();
 const subtle=webcrypto.subtle,wrap=subtle.wrapKey.bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,'wrapKey',async(...args)=>{
  if(!held&&new TextDecoder().decode(args[3].additionalData).includes('recovery-key')){held=true;entered.resolve();await release.promise;}
  return wrap(...args);
 });
 const stale=account.createRecoveryCode(),rejected=assert.rejects(stale,error=>error.name==='LocalAccountConflict');await entered.promise;
 const recovered=await reset.recoverPassword({username:'bruno',recoveryCode:oldCode,newPassword:SECOND_PASSWORD}),committed=await dump();
 release.resolve();await rejected;restore();assert.deepEqual(await dump(),committed);assert.deepEqual(committed.vaults,before.vaults);
 assert.match(recovered.recoveryCode,recoveryPattern);assert.equal(committed.profiles[0].recovery.generation,2);reset.lock();account.lock();
 await assert.rejects(()=>account.login('bruno',PASSWORD),error=>error.name==='LocalAccountAuthError');await account.login('bruno',SECOND_PASSWORD);
});

test('concurrent password recovery has one metadata CAS winner and never replaces the data vault',async t=>{
 const account=setup(t);await register(account);const code=await account.createRecoveryCode(),before=await dump();account.lock();
 const a=createLocalAccount(),b=createLocalAccount(),subtle=webcrypto.subtle,wrap=subtle.wrapKey.bind(subtle),both=deferred(),release=deferred();let entered=0;
 const restore=patchMethod(t,subtle,'wrapKey',async(...args)=>{
  if(new TextDecoder().decode(args[3].additionalData).includes('password-key')){entered++;if(entered===2)both.resolve();await release.promise;}
  return wrap(...args);
 });
 const promises=[a.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD}),b.recoverPassword({username:'bruno',recoveryCode:code,newPassword:'Third-Strong-Rhythm-789!'})];
 const settled=Promise.allSettled(promises);await both.promise;release.resolve();const outcomes=await settled;restore();
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);assert.equal(outcomes.find(result=>result.status==='rejected').reason.name,'LocalAccountConflict');
 const winner=outcomes.findIndex(result=>result.status==='fulfilled'),stored=await dump();assert.deepEqual(stored.vaults,before.vaults);assert.equal(stored.profiles[0].recovery.generation,2);
 a.lock();b.lock();await account.login('bruno',winner===0?SECOND_PASSWORD:'Third-Strong-Rhythm-789!');account.lock();
 await assert.rejects(()=>account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:PASSWORD}),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dump(),stored);
});

test('locking cancels recovery generation and password recovery before any credentials commit',async t=>{
 const account=setup(t);await register(account);let before=await dump();
 const early=account.createRecoveryCode();account.lock();await assert.rejects(early,error=>error.name==='LocalAccountCancelled');assert.deepEqual(await dump(),before);
 await account.login('bruno',PASSWORD);const code=await account.createRecoveryCode();before=await dump();account.lock();
 const immediate=account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});account.lock();await assert.rejects(immediate,error=>error.name==='LocalAccountCancelled');assert.deepEqual(await dump(),before);
 const subtle=webcrypto.subtle,wrap=subtle.wrapKey.bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,'wrapKey',async(...args)=>{if(!held){held=true;entered.resolve();await release.promise;}return wrap(...args);});
 const pending=account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD}),rejected=assert.rejects(pending,error=>error.name==='LocalAccountCancelled');await entered.promise;
 account.lock();release.resolve();await rejected;restore();assert.deepEqual(await dump(),before);assert.equal(account.getState().unlocked,false);
});

test('lock aborts a pending metadata transaction even after its profile put has been queued',async t=>{
 const account=setup(t);await register(account);const before=await dump();
 const Store=require('fake-indexeddb').IDBObjectStore,put=Store.prototype.put;
 const restore=patchMethod(t,Store.prototype,'put',function(value,...args){const request=put.call(this,value,...args);if(this.name==='profiles'&&value.recovery)queueMicrotask(()=>account.lock());return request;});
 await assert.rejects(()=>account.createRecoveryCode(),error=>error.name==='LocalAccountCancelled');restore();
 assert.deepEqual(await dump(),before);assert.equal(account.getState().unlocked,false);await account.login('bruno',PASSWORD);assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});
});

for(const phase of ['deriveKey','decrypt'])test(`a reset committed during login ${phase} prevents the old credential snapshot from unlocking`,async t=>{
 const account=setup(t);await register(account);const code=await account.createRecoveryCode();account.lock();
 const login=createLocalAccount(),reset=createLocalAccount(),subtle=webcrypto.subtle,original=subtle[phase].bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,phase,async(...args)=>{
  if(!held&&(phase==='decrypt'||args[0]?.name==='PBKDF2')){held=true;entered.resolve();await release.promise;}
  return original(...args);
 });
 const pending=login.login('bruno',PASSWORD),rejected=assert.rejects(pending,error=>error.name==='LocalAccountConflict');await entered.promise;
 const recovered=await reset.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD}),committed=await dump();
 assert.match(recovered.recoveryCode,recoveryPattern);release.resolve();await rejected;restore();
 assert.equal(login.getState().unlocked,false);assert.deepEqual(await dump(),committed);
 await login.login('bruno',SECOND_PASSWORD);assert.equal(login.getState().unlocked,true);assert.deepEqual((await dump()).vaults,committed.vaults);
});

const rememberedPattern=/^remembered-device:[A-Za-z0-9_-]{43}$/;
test('remembered session wrappers restore a locked new instance without exposing keys or changing profile storage',async t=>{
 const account=setup(t),profile=await register(account),key=await wrappingKey();
 await account.mutateData(data=>{data.workouts.push({id:'remembered-data',name:'Private remembered workout'});});
 const before=await dump(),data=await account.readData(),envelope=await account.wrapRememberedSessionKey(key);
 assert.match(envelope.purpose,rememberedPattern);assert.equal(envelope.profileId,profile.id);assert.equal(envelope.version,1);
 assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','iv','profileId','purpose','version']);
 assert.equal(Buffer.from(envelope.ciphertext,'base64url').byteLength,48);assert.equal(Buffer.from(envelope.iv,'base64url').byteLength,12);
 for(const secret of [PASSWORD,'Private remembered workout'])assert.equal(JSON.stringify(envelope).includes(secret),false);
 assert.deepEqual(await dump(),before);account.lock();
 const fresh=createLocalAccount();assert.equal(fresh.getState().unlocked,false);
 assert.deepEqual(await fresh.unlockWithRememberedKey(profile.id,key,envelope),profile);assert.deepEqual(await fresh.readData(),data);assert.deepEqual(await dump(),before);
 const generation=fresh.getState().generation;await assert.rejects(()=>fresh.unlockWithRememberedKey(profile.id,key,envelope));assert.equal(fresh.getState().generation,generation);assert.equal(fresh.getState().unlocked,true);
});

test('remembered wrappers reject corrupted ciphertext, wrong wrapping keys and cross-purpose biometric use',async t=>{
 const account=setup(t),profile=await register(account),key=await wrappingKey(),wrongKey=await wrappingKey();
 const remembered=await account.wrapRememberedSessionKey(key),biometric=await account.wrapSessionKey(key),before=await dump();account.lock();
 for(const [usedKey,envelope] of [[key,{...remembered,ciphertext:bitflip(remembered.ciphertext)}],[key,{...remembered,iv:bitflip(remembered.iv)}],
  [wrongKey,remembered],[key,biometric],[key,{...remembered,purpose:'biometric-prf'}],[key,{...remembered,profileId:'missing-profile'}]]){
  await assert.rejects(()=>account.unlockWithRememberedKey(profile.id,usedKey,envelope),error=>error.name==='LocalAccountAuthError');
  assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),before);
 }
 await assert.rejects(()=>account.unlockWithWrappedKey(profile.id,key,remembered),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dump(),before);
 await account.unlockWithRememberedKey(profile.id,key,remembered);assert.equal(account.getState().profileId,profile.id);
});

test('a password reset revokes old remembered wrappers cryptographically while preserving biometric wrappers and vault bytes',async t=>{
 const account=setup(t),profile=await register(account),key=await wrappingKey();
 await account.mutateData(data=>{data.workouts.push({id:'same-data-key',name:'Preserved private data'});});
 const code=await account.createRecoveryCode(),oldRemembered=await account.wrapRememberedSessionKey(key),biometric=await account.wrapSessionKey(key),before=await dump();account.lock();
 await account.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});
 const currentRemembered=await account.wrapRememberedSessionKey(key);assert.notEqual(currentRemembered.purpose,oldRemembered.purpose);
 const committed=await dump();assert.deepEqual(committed.vaults,before.vaults);account.lock();
 await assert.rejects(()=>account.unlockWithRememberedKey(profile.id,key,oldRemembered),error=>error.name==='LocalAccountAuthError');
 // Editing the public purpose to the new fingerprint still fails because the old ciphertext authenticates the old AAD.
 await assert.rejects(()=>account.unlockWithRememberedKey(profile.id,key,{...oldRemembered,purpose:currentRemembered.purpose}),error=>error.name==='LocalAccountAuthError');
 assert.deepEqual(await dump(),committed);assert.equal(account.getState().unlocked,false);
 await account.unlockWithWrappedKey(profile.id,key,biometric);assert.equal((await account.readData()).workouts[0].id,'same-data-key');account.lock();
 await account.unlockWithRememberedKey(profile.id,key,currentRemembered);assert.equal((await account.readData()).workouts[0].id,'same-data-key');assert.deepEqual(await dump(),committed);
});

test('recovery status exposes its current generation only on request and code-only rotation preserves remembered credential binding',async t=>{
 const account=setup(t);await register(account);assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});assert.deepEqual(await account.getRecoveryStatus({includeGeneration:true}),{enabled:false,generation:0});
 await account.createRecoveryCode();assert.deepEqual(await account.getRecoveryStatus(),{enabled:true});assert.deepEqual(await account.getRecoveryStatus({includeGeneration:true}),{enabled:true,generation:1});
 const key=await wrappingKey(),first=await account.wrapRememberedSessionKey(key),other=createLocalAccount();await other.login('bruno',PASSWORD);await other.createRecoveryCode();
 assert.deepEqual(await account.getRecoveryStatus({includeGeneration:true}),{enabled:true,generation:2});assert.deepEqual(await account.getRecoveryStatus({includeGeneration:false}),{enabled:true});
 const second=await account.wrapRememberedSessionKey(key);assert.equal(second.purpose,first.purpose);account.lock();await account.unlockWithRememberedKey(first.profileId,key,first);
 for(const options of [null,[],{includeGeneration:'yes'}])await assert.rejects(()=>account.getRecoveryStatus(options));
 account.lock();await account.enterGuest();assert.deepEqual(await account.getRecoveryStatus({includeGeneration:true}),{enabled:false,generation:0});assert.deepEqual(await account.getRecoveryStatus(),{enabled:false});
});

test('remembered access cannot wrap a guest or substitute a different open profile',async t=>{
 const account=setup(t),key=await wrappingKey();await account.enterGuest();await account.mutateData(data=>{data.workouts.push({id:'guest-safe'});});const guest=await dumpGuest();
 await assert.rejects(()=>account.wrapRememberedSessionKey(key),error=>error.name==='LocalAccountAuthError');account.lock();
 await assert.rejects(()=>account.unlockWithRememberedKey('guest-local',key,{}),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dumpGuest(),guest);
 const a=await register(account,'alice'),rememberedA=await account.wrapRememberedSessionKey(key),b=await register(account,'bruno'),rememberedB=await account.wrapRememberedSessionKey(key),before=await dump();
 const generation=account.getState().generation;
 await assert.rejects(()=>account.unlockWithRememberedKey(a.id,key,rememberedA));assert.equal(account.getState().profileId,b.id);assert.equal(account.getState().generation,generation);account.lock();
 await assert.rejects(()=>account.unlockWithRememberedKey(b.id,key,{...rememberedA,profileId:b.id,purpose:rememberedB.purpose}),error=>error.name==='LocalAccountAuthError');
 assert.deepEqual(await dump(),before);assert.deepEqual(await dumpGuest(),guest);assert.equal(account.getState().unlocked,false);
});

test('locking cancels remembered wrapping and restore while cryptography is pending',async t=>{
 const account=setup(t),profile=await register(account),key=await wrappingKey(),envelope=await account.wrapRememberedSessionKey(key),before=await dump();
 let entered=deferred(),release=deferred();const subtle=webcrypto.subtle,wrap=subtle.wrapKey.bind(subtle);
 let restore=patchMethod(t,subtle,'wrapKey',async(...args)=>{entered.resolve();await release.promise;return wrap(...args);});
 let pending=account.wrapRememberedSessionKey(key),rejected=assert.rejects(pending,error=>error.name==='LocalAccountCancelled');await entered.promise;
 account.lock();release.resolve();await rejected;restore();assert.deepEqual(await dump(),before);
 entered=deferred();release=deferred();const decrypt=subtle.decrypt.bind(subtle);
 restore=patchMethod(t,subtle,'decrypt',async(...args)=>{entered.resolve();await release.promise;return decrypt(...args);});
 pending=account.unlockWithRememberedKey(profile.id,key,envelope);rejected=assert.rejects(pending,error=>error.name==='LocalAccountCancelled');await entered.promise;
 account.lock();release.resolve();await rejected;restore();assert.deepEqual(await dump(),before);assert.equal(account.getState().unlocked,false);
});

test('metadata changed during remembered wrapping prevents returning a stale wrapper',async t=>{
 const account=setup(t);await register(account);const key=await wrappingKey(),code=await account.createRecoveryCode(),before=await dump(),reset=createLocalAccount();
 const subtle=webcrypto.subtle,wrap=subtle.wrapKey.bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,'wrapKey',async(...args)=>{if(!held&&new TextDecoder().decode(args[3].additionalData).includes('remembered-device:')){held=true;entered.resolve();await release.promise;}return wrap(...args);});
 const pending=account.wrapRememberedSessionKey(key),rejected=assert.rejects(pending,error=>error.name==='LocalAccountConflict');await entered.promise;
 await reset.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});const committed=await dump();release.resolve();await rejected;restore();
 assert.deepEqual(await dump(),committed);assert.deepEqual(committed.vaults,before.vaults);
});

test('a reset committed during remembered restore prevents activation of the stale credential snapshot',async t=>{
 const account=setup(t),profile=await register(account),key=await wrappingKey(),code=await account.createRecoveryCode(),envelope=await account.wrapRememberedSessionKey(key);account.lock();
 const reset=createLocalAccount(),subtle=webcrypto.subtle,decrypt=subtle.decrypt.bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,'decrypt',async(...args)=>{if(!held){held=true;entered.resolve();await release.promise;}return decrypt(...args);});
 const pending=account.unlockWithRememberedKey(profile.id,key,envelope),rejected=assert.rejects(pending,error=>error.name==='LocalAccountConflict');await entered.promise;
 await reset.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});const committed=await dump();release.resolve();await rejected;restore();
 assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),committed);
 await assert.rejects(()=>account.unlockWithRememberedKey(profile.id,key,envelope),error=>error.name==='LocalAccountAuthError');
});

test('verifyRecoveryCode authenticates only the current password profile and performs no storage or session mutation',async t=>{
 const account=setup(t);await assert.rejects(()=>account.verifyRecoveryCode(fakeRecovery),error=>error.name==='LocalAccountLocked');
 await account.enterGuest();const guest=await dumpGuest();await assert.rejects(()=>account.verifyRecoveryCode(fakeRecovery),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dumpGuest(),guest);
 const profile=await register(account);await assert.rejects(()=>account.verifyRecoveryCode(fakeRecovery),error=>error.name==='LocalAccountAuthError');
 const code=await account.createRecoveryCode();await account.mutateData(data=>{data.workouts.push({id:'verify-private',name:'Never returned by code verification'});});
 const before=await dump(),state=account.getState();
 assert.deepEqual(await account.verifyRecoveryCode(code.toLowerCase().replaceAll('-',' ')),{profileId:profile.id,generation:1});
 assert.deepEqual(await dump(),before);assert.deepEqual(account.getState(),state);assert.deepEqual(await dumpGuest(),guest);
});

test('verifyRecoveryCode rejects old, malformed and other-profile tokens without rotating or locking the active session',async t=>{
 const account=setup(t),a=await register(account,'alice'),old=await account.createRecoveryCode(),current=await account.createRecoveryCode();
 let before=await dump(),state=account.getState();
 for(const code of [old,fakeRecovery,'invalid',null]){
  await assert.rejects(()=>account.verifyRecoveryCode(code),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dump(),before);assert.deepEqual(account.getState(),state);
 }
 assert.deepEqual(await account.verifyRecoveryCode(current),{profileId:a.id,generation:2});
 await register(account,'bruno');await account.createRecoveryCode();before=await dump();state=account.getState();
 await assert.rejects(()=>account.verifyRecoveryCode(current),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dump(),before);assert.deepEqual(account.getState(),state);
});

for(const phase of ['deriveKey','decrypt'])test(`a recovery-code rotation during verification ${phase} rejects the stale generation`,async t=>{
 const account=setup(t);await register(account);const code=await account.createRecoveryCode(),rotator=createLocalAccount();await rotator.login('bruno',PASSWORD);
 const subtle=webcrypto.subtle,original=subtle[phase].bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,phase,async(...args)=>{
  if(!held&&(phase==='decrypt'||args[0]?.name==='HKDF')){held=true;entered.resolve();await release.promise;}
  return original(...args);
 });
 const pending=account.verifyRecoveryCode(code),rejected=assert.rejects(pending,error=>error.name==='LocalAccountConflict');await entered.promise;
 const latest=await rotator.createRecoveryCode(),committed=await dump(),state=account.getState();release.resolve();await rejected;restore();
 assert.deepEqual(await dump(),committed);assert.deepEqual(account.getState(),state);
 await assert.rejects(()=>account.verifyRecoveryCode(code),error=>error.name==='LocalAccountAuthError');
 assert.deepEqual(await account.verifyRecoveryCode(latest),{profileId:state.profileId,generation:2});
});

test('lock cancels a pending recovery-code verification before it can return a credential generation',async t=>{
 const account=setup(t);await register(account);const code=await account.createRecoveryCode(),before=await dump();
 const subtle=webcrypto.subtle,decrypt=subtle.decrypt.bind(subtle),entered=deferred(),release=deferred();
 const restore=patchMethod(t,subtle,'decrypt',async(...args)=>{entered.resolve();await release.promise;return decrypt(...args);});
 const pending=account.verifyRecoveryCode(code),rejected=assert.rejects(pending,error=>error.name==='LocalAccountCancelled');await entered.promise;
 account.lock();release.resolve();await rejected;restore();assert.deepEqual(await dump(),before);assert.equal(account.getState().unlocked,false);
});

test('read-only recovery verification does not refresh the known data revision or bypass a stale-data CAS conflict',async t=>{
 const account=setup(t);await register(account);const code=await account.createRecoveryCode(),other=createLocalAccount();await other.login('bruno',PASSWORD);
 const revision=account.getState().revision;await other.mutateData(data=>{data.workouts.push({id:'other-tab-data'});});const before=await dump();
 assert.equal((await account.verifyRecoveryCode(code)).generation,1);assert.equal(account.getState().revision,revision);assert.deepEqual(await dump(),before);
 await assert.rejects(()=>account.mutateData(data=>{data.workouts=[];}),error=>error.name==='LocalAccountConflict');assert.deepEqual(await dump(),before);
});

test('verifyPassword confirms the current password without mutating storage, session or known data revision',async t=>{
 const account=setup(t),profile=await register(account);await account.mutateData(data=>{data.workouts.push({id:'password-proof-private'});});
 let before=await dump(),state=account.getState();assert.deepEqual(await account.verifyPassword(PASSWORD),{profileId:profile.id});assert.deepEqual(await dump(),before);assert.deepEqual(account.getState(),state);
 for(const password of [SECOND_PASSWORD,'short']){await assert.rejects(()=>account.verifyPassword(password));assert.deepEqual(await dump(),before);assert.deepEqual(account.getState(),state);}
 const other=createLocalAccount();await other.login('bruno',PASSWORD);await other.mutateData(data=>{data.theme='dark';});before=await dump();state=account.getState();
 await account.verifyPassword(PASSWORD);assert.deepEqual(await dump(),before);assert.deepEqual(account.getState(),state);
 await assert.rejects(()=>account.mutateData(data=>{data.workouts=[];}),error=>error.name==='LocalAccountConflict');assert.deepEqual(await dump(),before);
});

test('verifyPassword rejects locked and guest access without disturbing guest records',async t=>{
 const account=setup(t);await assert.rejects(()=>account.verifyPassword(PASSWORD),error=>error.name==='LocalAccountLocked');
 await account.enterGuest();await account.mutateData(data=>{data.workouts.push({id:'guest-password-proof-safe'});});const before=await dumpGuest(),state=account.getState();
 await assert.rejects(()=>account.verifyPassword(PASSWORD),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await dumpGuest(),before);assert.deepEqual(account.getState(),state);
});

test('a reset during verifyPassword PBKDF2 rejects stale credentials without closing the already open profile',async t=>{
 const account=setup(t);await register(account);const code=await account.createRecoveryCode(),reset=createLocalAccount(),state=account.getState();
 const subtle=webcrypto.subtle,derive=subtle.deriveKey.bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,'deriveKey',async(...args)=>{if(!held&&args[0]?.name==='PBKDF2'){held=true;entered.resolve();await release.promise;}return derive(...args);});
 const pending=account.verifyPassword(PASSWORD),rejected=assert.rejects(pending,error=>error.name==='LocalAccountConflict');await entered.promise;
 await reset.recoverPassword({username:'bruno',recoveryCode:code,newPassword:SECOND_PASSWORD});const committed=await dump();release.resolve();await rejected;restore();
 assert.deepEqual(await dump(),committed);assert.deepEqual(account.getState(),state);
 await assert.rejects(()=>account.verifyPassword(PASSWORD),error=>error.name==='LocalAccountAuthError');assert.deepEqual(await account.verifyPassword(SECOND_PASSWORD),{profileId:state.profileId});
});

test('lock cancels verifyPassword while PBKDF2 is pending without any credential or data writes',async t=>{
 const account=setup(t);await register(account);const before=await dump(),subtle=webcrypto.subtle,derive=subtle.deriveKey.bind(subtle),entered=deferred(),release=deferred();
 const restore=patchMethod(t,subtle,'deriveKey',async(...args)=>{entered.resolve();await release.promise;return derive(...args);});
 const pending=account.verifyPassword(PASSWORD),rejected=assert.rejects(pending,error=>error.name==='LocalAccountCancelled');await entered.promise;
 account.lock();release.resolve();await rejected;restore();assert.equal(account.getState().unlocked,false);assert.deepEqual(await dump(),before);
});

test('an old password verification cannot replace or close a manual login to another profile',async t=>{
 const account=setup(t);await register(account,'alice');const b=await register(account,'bruno',SECOND_PASSWORD);await account.login('alice',PASSWORD);
 const subtle=webcrypto.subtle,derive=subtle.deriveKey.bind(subtle),entered=deferred(),release=deferred();let held=false;
 const restore=patchMethod(t,subtle,'deriveKey',async(...args)=>{if(!held){held=true;entered.resolve();await release.promise;}return derive(...args);});
 const pending=account.verifyPassword(PASSWORD),rejected=assert.rejects(pending,error=>error.name==='LocalAccountCancelled');await entered.promise;
 await account.login('bruno',SECOND_PASSWORD);const before=await dump(),state=account.getState();release.resolve();await rejected;restore();
 assert.equal(account.getState().profileId,b.id);assert.deepEqual(account.getState(),state);assert.deepEqual(await dump(),before);
});
