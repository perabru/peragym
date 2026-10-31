import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {createLocalBiometric} from './local-biometric.js';
import {createLocalAccount} from './local-account.js';

const require=createRequire(import.meta.url);
const {IDBFactory,IDBDatabase}=require(process.env.PERAGYM_FAKE_IDB||'fake-indexeddb');
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
  let generation=1,unlocked=true,recoveryGeneration=1;
  let recoveryCode='PG-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ';
  const generatedCode=value=>'PG-'+String(value).padStart(4,'0')+'-1111-2222-3333-4444-5555-6666-7777';
  const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const iv=random(12),vault=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode('private workout records'));
  const calls={wrap:0,unlock:0};
  const aad=encoder.encode(JSON.stringify(['PeraGym',PROFILE.id,'biometric-prf']));
  return {calls,
    getState:()=>({supported:true,unlocked,profileId:unlocked?PROFILE.id:null,profile:unlocked?{...PROFILE}:null,generation}),
    lock(){generation++;unlocked=false;},
    async getRecoveryStatus(options={}) {
      assert.equal(unlocked,true);
      return {enabled:recoveryGeneration>0,...(options.includeGeneration?{generation:recoveryGeneration}:{})};
    },
    async createRecoveryCode() {
      assert.equal(unlocked,true);recoveryGeneration++;
      recoveryCode=generatedCode(recoveryGeneration);return recoveryCode;
    },
    async verifyRecoveryCode(code) {
      assert.equal(unlocked,true);
      if(!recoveryGeneration||String(code).replace(/[- ]/g,'').toUpperCase()!==recoveryCode.replace(/-/g,'')) {
        throw Object.assign(new Error('O código de recuperação mudou. Gere ou proteja o código atual.'),{name:'LocalAccountAuthError'});
      }
      return {profileId:PROFILE.id,generation:recoveryGeneration};
    },
    setRecoveryGeneration(value){recoveryGeneration=value;recoveryCode=generatedCode(value);},
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
  assert.deepEqual(Object.keys(saved).sort(),['algorithm','createdAt','credentialId','envelope','hkdfSalt','origin','prfSalt','profileId','publicKey','revision','rpId','signCount','updatedAt','version'].sort());
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

const CODE='PG-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ';

test('recovery code enrollment shares its signed assertion, encrypts at rest and requires a fresh assertion to read',async()=>{
  const env=await setup();
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:false});
  assert.deepEqual(await env.biometric.enroll({recoveryCode:CODE}),{profileId:PROFILE.id,protected:true});
  assert.equal(env.provider.requests.length,2,'Register and one signed confirmation also protect the code');
  const [record]=await records(env.indexedDB);
  assert.equal(record.recoveryCodeEnvelope.recoveryGeneration,1);
  assert.equal(raw(record.recoveryCodeEnvelope.ciphertext).length,58);
  assert.equal(JSON.stringify(record).includes(CODE),false);
  const requestCount=env.provider.requests.length;
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:true});
  assert.equal(env.provider.requests.length,requestCount,'Status returns metadata without opening a biometric prompt');
  assert.equal(await env.biometric.readRecoveryCode(),CODE);
  assert.equal(env.provider.requests.length,requestCount+1);
  assert.equal((await records(env.indexedDB))[0].signCount,2);
  assert.notEqual(b64(env.provider.requests[1].request.publicKey.challenge),b64(env.provider.requests[2].request.publicKey.challenge));
});

test('recovery encryption uses a separate credential-bound HKDF key and PRF output is cleared',async()=>{
  let output;
  const env=await setup({assertionCredential:credential=>{output=credential.getClientExtensionResults().prf.results.first;}});
  await env.biometric.enroll({recoveryCode:CODE});
  assert(new Uint8Array(output).every(value=>value===0));
  const [record]=await records(env.indexedDB),credential=env.provider.credentials.get(record.credentialId);
  const hmac=await webcrypto.subtle.importKey('raw',credential.master,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const secret=await webcrypto.subtle.sign('HMAC',hmac,raw(record.prfSalt));
  const material=await webcrypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);
  const derive=purpose=>webcrypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:raw(record.hkdfSalt),
    info:encoder.encode(JSON.stringify(['PeraGym',purpose,1,ORIGIN,RP,PROFILE.id,...(purpose==='biometric-recovery-code'?[record.credentialId]:[])]))},material,
    {name:'AES-GCM',length:256},false,['decrypt']);
  const options={name:'AES-GCM',iv:raw(record.recoveryCodeEnvelope.iv),additionalData:encoder.encode(JSON.stringify([
    'PeraGym','biometric-recovery-code',1,ORIGIN,RP,PROFILE.id,record.credentialId,1]))};
  const cipher=raw(record.recoveryCodeEnvelope.ciphertext);
  await assert.rejects(()=>derive('biometric-prf').then(key=>webcrypto.subtle.decrypt(options,key,cipher)));
  const clear=await webcrypto.subtle.decrypt(options,await derive('biometric-recovery-code'),cipher);
  assert.equal(new TextDecoder().decode(clear),CODE);
});

test('protecting an existing code requires fresh UV and failures preserve the previously encrypted code',async()=>{
  const env=await setup();await env.biometric.enroll();
  assert.deepEqual(await env.biometric.protectRecoveryCode(CODE),{profileId:PROFILE.id,protected:true});
  const before=await records(env.indexedDB);
  env.provider.options.getError=Object.assign(new Error('cancelled'),{name:'NotAllowedError'});
  await assert.rejects(()=>env.biometric.protectRecoveryCode(CODE),error=>error.code==='cancelled');
  await assert.rejects(()=>env.biometric.readRecoveryCode(),error=>error.code==='cancelled');
  assert.deepEqual(await records(env.indexedDB),before);
  delete env.provider.options.getError;
  env.provider.options.noPrf=true;
  await assert.rejects(()=>env.biometric.readRecoveryCode(),error=>error.code==='prf-unavailable');
  assert.deepEqual(await records(env.indexedDB),before);
});

test('locked, stale-session and unsupported recovery requests never disclose a saved code',async()=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  env.provider.options.assertionCredential=()=>env.account.lock();
  await assert.rejects(()=>env.biometric.readRecoveryCode(),error=>error.code==='session-changed');
  await assert.rejects(()=>env.biometric.getRecoveryCodeStatus(PROFILE.id));
  await assert.rejects(()=>env.biometric.protectRecoveryCode(CODE));
  await assert.rejects(()=>env.biometric.rotateRecoveryCode());
  const other=await setup();await other.biometric.enroll({recoveryCode:CODE});
  other.provider.options.capabilities={'extension:prf':false};
  await assert.rejects(()=>other.biometric.readRecoveryCode(),error=>error.code==='unsupported');
});

test('recovery generation changes invalidate the device copy without deleting the biometric login',async()=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  env.account.setRecoveryGeneration(2);
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:false});
  const count=env.provider.requests.length;
  await assert.rejects(()=>env.biometric.readRecoveryCode(),error=>error.code==='recovery-stale');
  assert.equal(env.provider.requests.length,count,'Stale saved codes are rejected before requesting the device');
  assert.equal(await env.biometric.hasEnrollment(PROFILE.id),true);
  env.account.lock();await env.biometric.unlock(PROFILE.id);
});

test('ciphertext, origin, generation and credential binding changes fail closed',async()=>{
  for(const alteration of ['ciphertext','origin','generation','credential']) {
    const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
    await records(env.indexedDB,record=>{
      const envelope=record.recoveryCodeEnvelope;
      if(alteration==='ciphertext'){const value=raw(envelope.ciphertext);value[0]^=1;envelope.ciphertext=b64(value);}
      if(alteration==='origin')envelope.origin='https://evil.example';
      if(alteration==='generation')envelope.recoveryGeneration++;
      if(alteration==='credential')envelope.credentialId=b64(random(32));
    });
    await assert.rejects(()=>env.biometric.readRecoveryCode());
    assert.equal(await env.biometric.hasEnrollment(PROFILE.id),true);
    assert.equal((await records(env.indexedDB)).length,1);
  }
});

test('rotation confirms the device before creating a new code, saves its generation and can read it later',async()=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  let generated=0;const create=env.account.createRecoveryCode;
  env.account.createRecoveryCode=async()=>{generated++;return create();};
  env.provider.options.getError=Object.assign(new Error('cancelled'),{name:'NotAllowedError'});
  await assert.rejects(()=>env.biometric.rotateRecoveryCode());assert.equal(generated,0);
  delete env.provider.options.getError;
  const result=await env.biometric.rotateRecoveryCode();
  assert.equal(result.protected,true);assert.equal(generated,1);
  assert.equal((await records(env.indexedDB))[0].recoveryCodeEnvelope.recoveryGeneration,2);
  assert.equal(await env.biometric.readRecoveryCode(),result.code);
});

test('a committed new code remains available to the authenticated UI if its encrypted device copy cannot be saved',async t=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  const before=(await records(env.indexedDB))[0].recoveryCodeEnvelope;
  const transaction=IDBDatabase.prototype.transaction;
  t.after(()=>{IDBDatabase.prototype.transaction=transaction;});
  let failStorage=false;const create=env.account.createRecoveryCode;
  env.account.createRecoveryCode=async()=>{const code=await create();failStorage=true;return code;};
  IDBDatabase.prototype.transaction=function(names,mode,...args){
    if(failStorage&&mode==='readwrite')throw new Error('storage full');
    return transaction.call(this,names,mode,...args);
  };
  const result=await env.biometric.rotateRecoveryCode();
  assert.equal(result.protected,false);assert.match(result.code,/^PG-/);assert.equal(typeof result.error,'string');
  assert.deepEqual((await records(env.indexedDB))[0].recoveryCodeEnvelope,before);
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:false});
});

test('a recovery generation changed by another tab during rotation never returns its obsolete code',async()=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  const create=env.account.createRecoveryCode;
  env.account.createRecoveryCode=async()=>{const code=await create();env.account.setRecoveryGeneration(3);return code;};
  await assert.rejects(()=>env.biometric.rotateRecoveryCode(),error=>error.name==='LocalAccountAuthError');
  assert.equal((await records(env.indexedDB))[0].recoveryCodeEnvelope.recoveryGeneration,1);
});

test('removal or re-enrollment during an assertion cannot revive an old encrypted enrollment or code',async()=>{
  for(const method of ['protect','unlock','enroll']) {
    const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
    const other=createLocalBiometric({account:await core(),environment:env.environment});
    env.provider.options.assertionCredential=async()=>{delete env.provider.options.assertionCredential;await other.remove(PROFILE.id);};
    if(method==='protect')await assert.rejects(()=>env.biometric.protectRecoveryCode(CODE),error=>error.code==='enrollment-changed');
    if(method==='enroll')await assert.rejects(()=>env.biometric.enroll(),error=>error.code==='enrollment-changed');
    if(method==='unlock'){env.account.lock();await assert.rejects(()=>env.biometric.unlock(PROFILE.id),error=>error.code==='enrollment-changed');assert.equal(env.account.getState().unlocked,false);}
    assert.equal((await records(env.indexedDB)).length,0);
  }
});

test('concurrent assertions cannot move the persisted signature counter backwards',async()=>{
  const env=await setup();await env.biometric.enroll();
  const other=createLocalBiometric({account:env.account,environment:env.environment});
  let resume,started;const waiting=new Promise(resolve=>{resume=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  env.provider.options.assertionCredential=async(_credential,record)=>{if(record.counter===2){started();await waiting;}};
  const first=env.biometric.protectRecoveryCode(CODE);await entered;
  await other.protectRecoveryCode(CODE);resume();
  await assert.rejects(()=>first,error=>error.code==='enrollment-changed');
  assert.equal((await records(env.indexedDB))[0].signCount,3);
});

test('successful credential replacement and removal discard the encrypted recovery copy',async()=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  const credential=(await records(env.indexedDB))[0].credentialId;
  await env.biometric.enroll();
  assert.notEqual((await records(env.indexedDB))[0].credentialId,credential);
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:false});
  await assert.rejects(()=>env.biometric.readRecoveryCode(),error=>error.code==='recovery-unavailable');
  await env.biometric.protectRecoveryCode(CODE);await env.biometric.remove(PROFILE.id);
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:false});
});

test('an old pending code cannot be protected under a newer recovery generation before or during device confirmation',async()=>{
  for(const moment of ['before','during']) {
    const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
    const previous=(await records(env.indexedDB))[0].recoveryCodeEnvelope;
    const count=env.provider.requests.length;
    if(moment==='before')env.account.setRecoveryGeneration(2);
    else env.provider.options.assertionCredential=()=>env.account.setRecoveryGeneration(2);
    await assert.rejects(()=>env.biometric.protectRecoveryCode(CODE),error=>error.name==='LocalAccountAuthError');
    assert.deepEqual((await records(env.indexedDB))[0].recoveryCodeEnvelope,previous);
    assert.deepEqual(await env.biometric.getRecoveryCodeStatus(PROFILE.id),{protected:false});
    if(moment==='before')assert.equal(env.provider.requests.length,count,'Known stale plaintext does not trigger a device prompt');
  }
});

test('locking after code creation prevents a stale operation from disclosing its newly generated code',async()=>{
  const env=await setup();await env.biometric.enroll({recoveryCode:CODE});
  const create=env.account.createRecoveryCode;
  env.account.createRecoveryCode=async()=>{const code=await create();env.account.lock();return code;};
  await assert.rejects(()=>env.biometric.rotateRecoveryCode(),error=>error.code==='session-changed');
  assert.equal(env.account.getState().unlocked,false);
});

test('real encrypted account recovery codes roundtrip through PRF and invalidate correctly after password recovery',async t=>{
  const previous=Object.fromEntries(['crypto','indexedDB'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const indexedDB=new IDBFactory();
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:indexedDB});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const account=createLocalAccount();await account.register({name:'Recovery',username:'recovery',password:'local password test'});
  const id=account.getState().profile.id,code=await account.createRecoveryCode();
  const env=await setup({account,environment:{indexedDB}});
  await env.biometric.enroll({recoveryCode:code});
  account.lock();await env.biometric.unlock(id);
  assert.equal(await env.biometric.readRecoveryCode(),code);
  const rotated=await env.biometric.rotateRecoveryCode();assert.equal(rotated.protected,true);
  assert.equal(await env.biometric.readRecoveryCode(),rotated.code);
  account.lock();
  const recovered=await account.recoverPassword({username:'recovery',recoveryCode:rotated.code,newPassword:'another local password'});
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(id),{protected:false});
  await assert.rejects(()=>env.biometric.protectRecoveryCode(rotated.code),error=>error.name==='LocalAccountAuthError');
  await env.biometric.protectRecoveryCode(recovered.recoveryCode);
  assert.equal(await env.biometric.readRecoveryCode(),recovered.recoveryCode);
});

test('real cross-tab rotation during biometric encryption cannot expose the invalidated intermediate code',async t=>{
  const previous=Object.fromEntries(['crypto','indexedDB'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const indexedDB=new IDBFactory();
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:indexedDB});
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const account=createLocalAccount();await account.register({name:'Race',username:'race',password:'local password race'});
  const id=account.getState().profile.id,initialCode=await account.createRecoveryCode();
  const second=createLocalAccount();await second.login('race','local password race');
  let block=false,resume,entered;
  const waiting=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const subtle=new Proxy(webcrypto.subtle,{get(target,property){
    if(property==='encrypt')return async(...args)=>{
      if(block){block=false;entered();await waiting;}
      return target.encrypt(...args);
    };
    const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
  }});
  const crypto={getRandomValues:value=>webcrypto.getRandomValues(value),subtle};
  const env=await setup({account,environment:{indexedDB,crypto}});
  await env.biometric.enroll({recoveryCode:initialCode});
  let intermediateCode;const create=account.createRecoveryCode;
  account.createRecoveryCode=async()=>{intermediateCode=await create();return intermediateCode;};
  block=true;const pending=env.biometric.rotateRecoveryCode();await started;
  const latestCode=await second.createRecoveryCode();resume();
  await assert.rejects(()=>pending,error=>error.name==='LocalAccountAuthError'||error.name==='LocalAccountConflict');
  assert.notEqual(latestCode,intermediateCode);
  await assert.rejects(()=>account.verifyRecoveryCode(intermediateCode),error=>error.name==='LocalAccountAuthError');
  assert.equal((await account.verifyRecoveryCode(latestCode)).profileId,id);
  assert.deepEqual(await env.biometric.getRecoveryCodeStatus(id),{protected:false});
});
