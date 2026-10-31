import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {createLocalBiometric} from './local-biometric.js';
import {createLocalAccount} from './local-account.js';

const require=createRequire(import.meta.url);
const {IDBFactory}=require(process.env.PERAGYM_FAKE_IDB||'fake-indexeddb');
const ORIGIN='https://perabru.github.io',RP='perabru.github.io';
const PROFILE={id:'d1630109-dc02-4cba-ac0c-24b860ae55c7',name:'Bruno',username:'bruno'};
const encoder=new TextEncoder();
const b64=value=>Buffer.from(value).toString('base64url');
const raw=value=>Uint8Array.from(Buffer.from(value,'base64url'));
const random=size=>webcrypto.getRandomValues(new Uint8Array(size));
const hash=async value=>new Uint8Array(await webcrypto.subtle.digest('SHA-256',value));
const concat=(a,b)=>new Uint8Array([...a,...b]);

function derSignature(raw) {
  function integer(bytes) {
    let first=0;while(first<bytes.length-1&&bytes[first]===0)first++;
    let result=bytes.subarray(first);
    if(result[0]&128)result=concat(new Uint8Array([0]),result);
    return concat(new Uint8Array([2,result.length]),result);
  }
  const payload=concat(integer(raw.subarray(0,32)),integer(raw.subarray(32)));
  return concat(new Uint8Array([0x30,payload.length]),payload);
}

// The mock device signs real challenges with P-256 and provides a deterministic per-credential PRF.
async function device(options={}) {
  const requests=[],credentials=new Map();
  class Attestation {
    getPublicKey(){return this.publicKey;}
    getPublicKeyAlgorithm(){return this.algorithm??-7;}
    getAuthenticatorData(){return this.authenticatorData;}
  }
  class Credential {
    static async isUserVerifyingPlatformAuthenticatorAvailable(){return options.platform??true;}
    static async getClientCapabilities(){return options.capabilities??{'extension:prf':true};}
  }
  async function authData(counter,registration=false) {
    const result=new Uint8Array(registration?85:37);
    result.set(await hash(encoder.encode(RP)));
    result[32]=registration?0x45:0x05;
    new DataView(result.buffer).setUint32(33,counter,false);
    return result;
  }
  function clientData(type,challenge) {
    return {type,challenge:b64(challenge),origin:ORIGIN,crossOrigin:false};
  }
  function credential(record,response,extensions) {
    return {id:b64(record.id),rawId:record.id.slice().buffer,type:'public-key',authenticatorAttachment:'platform',response,
      getClientExtensionResults:()=>extensions};
  }
  const manager={
    async create(request) {
      requests.push({type:'create',request});
      if(options.createError)throw options.createError;
      const record={id:random(32),master:random(32),counter:0,
        keys:await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])};
      const response=new Attestation();
      response.publicKey=await webcrypto.subtle.exportKey('spki',record.keys.publicKey);
      response.authenticatorData=(await authData(0,true)).buffer;
      const data=clientData('webauthn.create',request.publicKey.challenge);
      options.createData?.(data,response);
      response.clientDataJSON=encoder.encode(JSON.stringify(data)).buffer;
      const result=credential(record,response,{prf:{enabled:true}});
      options.createCredential?.(result);
      credentials.set(b64(record.id),record);
      return result;
    },
    async get(request) {
      requests.push({type:'get',request});
      if(options.getError)throw options.getError;
      const record=credentials.get(b64(request.publicKey.allowCredentials[0].id));
      assert.ok(record,'The app must ask for the enrolled credential');
      const data=clientData('webauthn.get',request.publicKey.challenge);
      const authenticatorData=await authData(options.zeroCounters?0:++record.counter);
      options.assertionData?.(data,authenticatorData);
      const clientDataJSON=encoder.encode(JSON.stringify(data));
      const signed=concat(authenticatorData,await hash(clientDataJSON));
      const signature=derSignature(new Uint8Array(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},record.keys.privateKey,signed)));
      const hmac=await webcrypto.subtle.importKey('raw',record.master,{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const prf=await webcrypto.subtle.sign('HMAC',hmac,request.publicKey.extensions.prf.eval.first);
      const extensions=options.noPrf?{prf:{enabled:true}}:{prf:{results:{first:prf}}};
      const result=credential(record,{clientDataJSON:clientDataJSON.buffer,authenticatorData:authenticatorData.buffer,signature:signature.buffer},extensions);
      await options.assertionCredential?.(result,record);
      return result;
    }
  };
  return {manager,Credential,Attestation,requests,credentials,options};
}

async function core() {
  let generation=1,unlocked=true;
  const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const iv=random(12),vault=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode('private workout records'));
  const calls={wrap:0,unlock:0};
  const aad=encoder.encode(JSON.stringify(['PeraGym',PROFILE.id,'biometric-prf']));
  return {calls,
    getState:()=>({supported:true,unlocked,profileId:unlocked?PROFILE.id:null,profile:unlocked?{...PROFILE}:null,generation}),
    lock(){generation++;unlocked=false;},
    async wrapSessionKey(wrappingKey) {
      assert.equal(unlocked,true);calls.wrap++;
      assert.equal(wrappingKey.extractable,false);
      assert.deepEqual([...wrappingKey.usages],['wrapKey','unwrapKey']);
      const wrapIV=random(12);
      const ciphertext=await webcrypto.subtle.wrapKey('raw',key,wrappingKey,{name:'AES-GCM',iv:wrapIV,additionalData:aad});
      return {version:1,profileId:PROFILE.id,purpose:'biometric-prf',iv:b64(wrapIV),ciphertext:b64(ciphertext)};
    },
    async unlockWithWrappedKey(id,wrappingKey,envelope) {
      generation++;unlocked=false;calls.unlock++;
      assert.equal(id,PROFILE.id);
      const restored=await webcrypto.subtle.unwrapKey('raw',raw(envelope.ciphertext),wrappingKey,
        {name:'AES-GCM',iv:raw(envelope.iv),additionalData:aad},{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      const plain=await webcrypto.subtle.decrypt({name:'AES-GCM',iv},restored,vault);
      assert.equal(new TextDecoder().decode(plain),'private workout records');
      unlocked=true;return {...PROFILE};
    }
  };
}

async function setup(options={}) {
  const provider=await device(options),account=options.account??await core(),indexedDB=new IDBFactory();
  const environment={crypto:webcrypto,indexedDB,credentials:provider.manager,PublicKeyCredential:provider.Credential,
    AuthenticatorAttestationResponse:provider.Attestation,location:{origin:ORIGIN,hostname:RP},secureContext:true,...options.environment};
  const biometric=createLocalBiometric({account,environment});
  return {biometric,account,indexedDB,provider,environment};
}
async function records(indexedDB,change) {
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('peragym-local-biometric',1);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('enrollments',change?'readwrite':'readonly'),store=tx.objectStore('enrollments');
    const request=store.getAll();let result;
    request.onsuccess=()=>{result=request.result;if(change)for(const record of result){change(record);store.put(record);}};
    tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>reject(tx.error);
  });
}

test('support is a precheck; absent PRF capability is unknown, explicit false is unavailable',async()=>{
  const env=await setup();assert.equal((await env.biometric.support()).available,true);
  env.provider.options.capabilities={};assert.equal((await env.biometric.support()).available,true);
  env.provider.options.capabilities={'extension:prf':false};assert.equal((await env.biometric.support()).available,false);
  assert.equal(env.provider.requests.length,0,'Precheck must never open a credential prompt');
  for(const options of [{platform:false},{environment:{secureContext:false}},
    {environment:{AuthenticatorAttestationResponse:class {}}},{environment:{credentials:{}}}]) {
    const unsupported=await setup(options);
    const result=await unsupported.biometric.support();assert.equal(result.available,false);assert.ok(result.reason);
  }
});

test('enrollment and unlock decrypt the wrapped vault key; only public metadata and ciphertext reach IndexedDB',async()=>{
  const env=await setup();assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
  assert.deepEqual(await env.biometric.enroll(),{profileId:PROFILE.id});
  assert.equal(await env.biometric.hasEnrollment(PROFILE.id),true);
  assert.deepEqual(env.account.calls,{wrap:1,unlock:1},'Enrollment must prove the encrypted vault roundtrip');
  const [saved]=await records(env.indexedDB);
  assert.deepEqual(Object.keys(saved).sort(),['algorithm','createdAt','credentialId','envelope','hkdfSalt','origin','prfSalt','profileId','publicKey','rpId','signCount','updatedAt','version'].sort());
  assert.equal(saved.envelope.ciphertext.length,64);
  assert.equal(saved.signCount,1);
  assert.equal(JSON.stringify(saved).includes('private workout'),false);
  const create=env.provider.requests[0].request.publicKey,get=env.provider.requests[1].request.publicKey;
  assert.equal(create.authenticatorSelection.authenticatorAttachment,'platform');
  assert.equal(create.authenticatorSelection.userVerification,'required');assert.equal(create.attestation,'none');
  assert.equal(get.userVerification,'required');assert.equal(get.rpId,RP);
  assert.notEqual(b64(create.challenge),b64(get.challenge));
  env.account.lock();const profile=await env.biometric.unlock(PROFILE.id);
  assert.deepEqual(profile,PROFILE);assert.equal(env.account.getState().unlocked,true);
  assert.equal((await records(env.indexedDB))[0].signCount,2);
  assert.notEqual(b64(env.provider.requests[1].request.publicKey.challenge),b64(env.provider.requests[2].request.publicKey.challenge));
});

test('no profile or locked profile cannot enroll or remove a wrapper',async()=>{
  const env=await setup();await env.biometric.enroll();env.account.lock();
  await assert.rejects(()=>env.biometric.enroll());await assert.rejects(()=>env.biometric.remove(PROFILE.id));
  assert.equal(env.provider.requests.length,2);assert.equal(await env.biometric.hasEnrollment(PROFILE.id),true);
});

test('PRF enabled without actual secret never enables device unlock',async()=>{
  const env=await setup({noPrf:true});
  await assert.rejects(()=>env.biometric.enroll(),error=>error.code==='prf-unavailable');
  assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
  assert.deepEqual(env.account.calls,{wrap:0,unlock:0});
});

test('wrong-size PRF results and a failed vault roundtrip cannot persist an enrollment',async()=>{
  for(const size of [0,16,31,33,64]) {
    const env=await setup({assertionCredential:credential=>{
      credential.getClientExtensionResults=()=>({prf:{results:{first:random(size).buffer}}});
    }});
    await assert.rejects(()=>env.biometric.enroll());
    assert.equal(env.account.calls.wrap,0);assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
  }
  const env=await setup();
  env.account.unlockWithWrappedKey=async()=>{throw new Error('Cannot authenticate encrypted vault');};
  await assert.rejects(()=>env.biometric.enroll());
  assert.equal(env.account.calls.wrap,1);assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
});

test('failed re-enrollment preserves the previous working encrypted wrapper',async()=>{
  const env=await setup();await env.biometric.enroll();
  const previous=await records(env.indexedDB);
  env.provider.options.noPrf=true;
  await assert.rejects(()=>env.biometric.enroll());
  assert.deepEqual(await records(env.indexedDB),previous);
  env.provider.options.noPrf=false;env.account.lock();
  assert.deepEqual(await env.biometric.unlock(PROFILE.id),PROFILE);
});

test('registration requires the original challenge, exact origin, UV, RP hash and ES256 key',async()=>{
  const mutations=[
    {createData:data=>{data.challenge=b64(random(32));}},
    {createData:data=>{data.type='webauthn.get';}},
    {createData:data=>{data.origin='https://example.com';}},
    {createData:data=>{data.crossOrigin=true;}},
    {createData:(_data,response)=>{new Uint8Array(response.authenticatorData)[0]^=1;}},
    {createData:(_data,response)=>{new Uint8Array(response.authenticatorData)[32]=0x41;}},
    {createData:(_data,response)=>{response.algorithm=-257;}},
    {createCredential:credential=>{credential.authenticatorAttachment='cross-platform';}},
    {createCredential:credential=>{credential.id=b64(random(32));}}
  ];
  for(const mutation of mutations) {
    const env=await setup(mutation);await assert.rejects(()=>env.biometric.enroll());
    assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);assert.equal(env.account.calls.wrap,0);
  }
});

test('a signed assertion still requires exact challenge/origin/RP/UP/UV and the enrolled credential',async()=>{
  const mutations=[
    {assertionData:data=>{data.challenge=b64(random(32));}},
    {assertionData:data=>{data.type='webauthn.create';}},
    {assertionData:data=>{data.origin=`${ORIGIN}.evil.example`;}},
    {assertionData:data=>{data.topOrigin=ORIGIN;}},
    {assertionData:data=>{data.crossOrigin=true;}},
    {assertionData:(_data,auth)=>{auth[0]^=1;}},
    {assertionData:(_data,auth)=>{auth[32]=1;}},
    {assertionData:(_data,auth)=>{auth[32]=4;}},
    {assertionCredential:credential=>{credential.rawId=random(32).buffer;credential.id=b64(credential.rawId);}}
  ];
  for(const mutation of mutations) {
    const env=await setup(mutation);await assert.rejects(()=>env.biometric.enroll());
    assert.equal(env.account.calls.wrap,0);assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
  }
});

test('signature tampering and malformed DER fail before wrapping the vault key',async()=>{
  for(const signature of ['tamper','raw','negative','trailing']) {
    const env=await setup({assertionCredential:credential=>{
      const current=new Uint8Array(credential.response.signature);
      if(signature==='tamper')current[current.length-1]^=1;
      if(signature==='raw')credential.response.signature=random(64).buffer;
      if(signature==='negative')credential.response.signature=new Uint8Array([48,6,2,1,128,2,1,1]).buffer;
      if(signature==='trailing')credential.response.signature=concat(current,new Uint8Array([0])).buffer;
    }});
    await assert.rejects(()=>env.biometric.enroll());assert.equal(env.account.calls.wrap,0);
  }
});

test('zero counters are accepted for synced passkeys; decreasing counters fall back to password',async()=>{
  const synced=await setup({zeroCounters:true});await synced.biometric.enroll();synced.account.lock();
  await synced.biometric.unlock(PROFILE.id);assert.equal((await records(synced.indexedDB))[0].signCount,0);
  const env=await setup();await env.biometric.enroll();env.account.lock();
  env.provider.options.assertionData=(_data,auth)=>{new DataView(auth.buffer).setUint32(33,1,false);};
  await assert.rejects(()=>env.biometric.unlock(PROFILE.id));assert.equal(env.account.getState().unlocked,false);
  assert.equal(env.account.calls.unlock,1,'Bad assertion must not reach the encrypted vault');
});

test('PRF loss, salt changes, origin changes and encrypted wrapper tampering never unlock records',async()=>{
  for(const alteration of ['prf','salt','origin','ciphertext']) {
    const env=await setup();await env.biometric.enroll();env.account.lock();
    if(alteration==='prf')env.provider.options.noPrf=true;
    else await records(env.indexedDB,record=>{
      if(alteration==='salt')record.hkdfSalt=b64(random(32));
      if(alteration==='origin')record.origin='https://other.example';
      if(alteration==='ciphertext'){const encrypted=raw(record.envelope.ciphertext);encrypted[0]^=1;record.envelope.ciphertext=b64(encrypted);}
    });
    await assert.rejects(()=>env.biometric.unlock(PROFILE.id));assert.equal(env.account.getState().unlocked,false);
    assert.equal((await records(env.indexedDB)).length,1,'Failure must preserve the encrypted enrollment');
  }
});

test('changing the local session during a credential prompt cancels enrollment and unlock',async()=>{
  const env=await setup();env.provider.options.assertionCredential=()=>env.account.lock();
  await assert.rejects(()=>env.biometric.enroll(),error=>error.code==='session-changed');
  assert.equal(env.account.calls.wrap,0);assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
  const other=await setup();await other.biometric.enroll();other.account.lock();
  other.provider.options.assertionCredential=()=>other.account.lock();
  await assert.rejects(()=>other.biometric.unlock(PROFILE.id),error=>error.code==='session-changed');
  assert.equal(other.account.calls.unlock,1);
});

test('cancelled platform prompt is a password fallback without an enrollment',async()=>{
  const error=new Error('cancelled');error.name='NotAllowedError';
  const env=await setup({getError:error});
  await assert.rejects(()=>env.biometric.enroll(),error=>error.code==='cancelled'&&/senha/.test(error.message));
  assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
});

test('removing enrollment only deletes the local encrypted wrapper',async()=>{
  const env=await setup();await env.biometric.enroll();await env.biometric.remove(PROFILE.id);
  assert.equal(await env.biometric.hasEnrollment(PROFILE.id),false);
  assert.equal(env.account.getState().unlocked,true);assert.equal(env.provider.credentials.size,1);
  env.account.lock();await assert.rejects(()=>env.biometric.unlock(PROFILE.id));
});

test('real local account module opens its encrypted records through PRF, without a password or plaintext DEK API',async t=>{
  const previous=Object.fromEntries(['crypto','indexedDB'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const indexedDB=new IDBFactory();
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:indexedDB});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const account=createLocalAccount();await account.register({name:'Bruno',username:'bruno',password:'senha local de teste'});
  const id=account.getState().profile.id;
  await account.mutateData(data=>{data.musicLinks=['https://music.youtube.com/watch?v=dQw4w9WgXcQ'];});
  const env=await setup({account,environment:{indexedDB}});
  await env.biometric.enroll();account.lock();
  await env.biometric.unlock(id);
  assert.deepEqual((await account.readData()).musicLinks,['https://music.youtube.com/watch?v=dQw4w9WgXcQ']);
  await env.biometric.remove(id);account.lock();await account.login('bruno','senha local de teste');
  assert.equal(account.getState().unlocked,true,'Password access remains available after device unlock removal');
});
