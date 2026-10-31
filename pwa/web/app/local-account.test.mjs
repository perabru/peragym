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
