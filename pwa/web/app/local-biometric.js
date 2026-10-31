/** Device unlock for an encrypted local profile. PRF secrets and vault keys are never persisted. */
const DATABASE = 'peragym-local-biometric';
const STORE = 'enrollments';
const VERSION = 1;
const PROFILE_ID = /^[A-Za-z0-9-]{1,80}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});

function fail(message, code='verification') {
  const error = new Error(message);
  error.name = 'LocalBiometricError';
  error.code = code;
  return error;
}
const verificationError = () => fail('Não foi possível verificar a chave deste aparelho. Use sua senha.');
function bytes(value, min, max=min) {
  let result;
  if(value instanceof ArrayBuffer)result=new Uint8Array(value);
  else if(ArrayBuffer.isView(value))result=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  else throw verificationError();
  if(result.length<min||result.length>max)throw verificationError();
  return result;
}
function encode(value) {
  let binary='';
  for(const byte of value)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decode(value, min, max=min) {
  if(typeof value!=='string'||value.length>Math.ceil(max*4/3)+4||!/^[A-Za-z0-9_-]+$/.test(value))throw verificationError();
  let result;
  try{result=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
  catch{throw verificationError();}
  if(result.length<min||result.length>max||encode(result)!==value)throw verificationError();
  return result;
}
function same(a,b) {
  if(a.length!==b.length)return false;
  let difference=0;
  for(let i=0;i<a.length;i++)difference|=a[i]^b[i];
  return difference===0;
}
function concat(a,b) {const result=new Uint8Array(a.length+b.length);result.set(a);result.set(b,a.length);return result;}
function profileId(value) {if(typeof value!=='string'||!PROFILE_ID.test(value))throw verificationError();return value;}

// Authenticators return ASN.1 DER for ES256; Web Crypto verifies fixed-width r || s.
function ecdsaSignature(value) {
  const signature=bytes(value,8,72);
  if(signature[0]!==0x30||signature[1]!==signature.length-2)throw verificationError();
  const result=new Uint8Array(64);
  let cursor=2;
  for(let part=0;part<2;part++) {
    if(signature[cursor++]!==0x02)throw verificationError();
    const length=signature[cursor++];
    if(!length||length>33||cursor+length>signature.length)throw verificationError();
    let integer=signature.subarray(cursor,cursor+length);cursor+=length;
    if(integer[0]&0x80)throw verificationError();
    if(integer[0]===0) {
      if(length===1||!(integer[1]&0x80))throw verificationError();
      integer=integer.subarray(1);
    }
    if(integer.length>32)throw verificationError();
    result.set(integer,part*32+32-integer.length);
  }
  if(cursor!==signature.length)throw verificationError();
  return result;
}
function envelopeFor(value,id) {
  if(!value||value.version!==1||value.profileId!==id||value.purpose!=='biometric-prf')throw verificationError();
  decode(value.iv,12);decode(value.ciphertext,48);
  return {version:1,profileId:id,purpose:'biometric-prf',iv:value.iv,ciphertext:value.ciphertext};
}
function friendly(error) {
  if(error?.name==='LocalBiometricError'||error?.name?.startsWith('LocalAccount'))return error;
  if(error?.name==='NotAllowedError'||error?.name==='AbortError')return fail('A confirmação foi cancelada ou não foi concluída. Use sua senha.','cancelled');
  if(error?.name==='NotSupportedError')return fail('Este aparelho não oferece a chave segura necessária. Use sua senha.','unsupported');
  return verificationError();
}

export function createLocalBiometric({account, environment={}}={}) {
  if(!account?.getState||!account?.wrapSessionKey||!account?.unlockWithWrappedKey)throw new TypeError('A local account is required.');
  const crypto=environment.crypto??globalThis.crypto;
  const indexedDB=environment.indexedDB??globalThis.indexedDB;
  const credentials=environment.credentials??globalThis.navigator?.credentials;
  const Credential=environment.PublicKeyCredential??globalThis.PublicKeyCredential;
  const Attestation=environment.AuthenticatorAttestationResponse??globalThis.AuthenticatorAttestationResponse;
  const location=environment.location??globalThis.location;
  const secureContext=environment.secureContext??globalThis.isSecureContext;
  const origin=location?.origin, rpId=location?.hostname;
  let connection, busy=false;
  const random=size=>crypto.getRandomValues(new Uint8Array(size));
  const hash=value=>crypto.subtle.digest('SHA-256',value).then(value=>new Uint8Array(value));

  async function support() {
    if(!secureContext||!origin||!rpId||!crypto?.subtle||!crypto?.getRandomValues||!indexedDB)
      return {available:false,reason:'Abra em HTTPS com armazenamento local e criptografia disponíveis. Use sua senha.'};
    if(!Credential||typeof credentials?.create!=='function'||typeof credentials?.get!=='function'
      ||typeof Credential.isUserVerifyingPlatformAuthenticatorAvailable!=='function'
      ||typeof Attestation?.prototype?.getPublicKey!=='function'
      ||typeof Attestation?.prototype?.getPublicKeyAlgorithm!=='function'
      ||typeof Attestation?.prototype?.getAuthenticatorData!=='function')
      return {available:false,reason:'Este navegador não permite verificar a chave segura do aparelho. Use sua senha.'};
    try {
      if(!await Credential.isUserVerifyingPlatformAuthenticatorAvailable())
        return {available:false,reason:'Configure o bloqueio de tela do aparelho ou use sua senha.'};
      if(typeof Credential.getClientCapabilities==='function') {
        const capabilities=await Credential.getClientCapabilities();
        if(capabilities?.['extension:prf']===false)
          return {available:false,reason:'Este navegador não oferece WebAuthn PRF para proteger os dados. Use sua senha.'};
      }
    }catch{return {available:false,reason:'Não foi possível verificar o desbloqueio deste aparelho. Use sua senha.'};}
    // A client capability is a precheck. Actual PRF output is mandatory during enrollment/unlock.
    return {available:true,reason:'A ativação verifica se o aparelho pode proteger a chave dos seus dados.'};
  }
  async function requireSupport() {const result=await support();if(!result.available)throw fail(result.reason,'unsupported');}
  function stateMatches(id,generation) {
    const state=account.getState();
    if(state.generation!==generation||(state.unlocked&&state.profile?.id!==id))
      throw fail('O perfil ou a sessão mudou. Entre novamente com sua senha.','session-changed');
    return state;
  }
  function requireUnlocked(id,generation) {
    const state=stateMatches(id,generation);
    if(!state.unlocked||state.profile?.id!==id)throw fail('Entre com sua senha antes de ativar o desbloqueio do aparelho.','locked');
    return state;
  }
  async function open() {
    if(connection)return connection;
    connection=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DATABASE,VERSION);
      let stopped=false;
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'profileId'});
      const stop=()=>{stopped=true;connection=null;reject(fail('Não foi possível abrir as chaves locais. Use sua senha.','storage'));};
      request.onerror=request.onblocked=stop;
      request.onsuccess=()=>{
        const db=request.result;
        if(stopped){db.close();return;}
        db.onversionchange=()=>{db.close();connection=null;};resolve(db);
      };
    });
    return connection;
  }
  async function stored(mode,action) {
    const db=await open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction(STORE,mode),store=transaction.objectStore(STORE);
      let result;
      transaction.oncomplete=()=>resolve(result);
      transaction.onerror=transaction.onabort=()=>reject(fail('Não foi possível salvar a chave local. Use sua senha.','storage'));
      const request=action(store);request.onsuccess=()=>{result=request.result;};
    });
  }
  async function replaceRecord(id,expected,next,check) {
    const fingerprint=JSON.stringify(expected??null),db=await open();
    check();
    return new Promise((resolve,reject)=>{
      let tx,store;
      try{tx=db.transaction(STORE,'readwrite');store=tx.objectStore(STORE);}
      catch{return reject(fail('Não foi possível salvar a chave local. Use sua senha.','storage'));}
      let customError,unsubscribe;
      const stop=error=>{customError=error;try{tx.abort();}catch{}};
      tx.oncomplete=()=>{unsubscribe?.();try{check();resolve(next);}catch(error){reject(error);}};
      tx.onerror=tx.onabort=()=>{unsubscribe?.();reject(customError||fail('Não foi possível salvar a chave local. Use sua senha.','storage'));};
      try{
        if(typeof account.subscribe==='function')unsubscribe=account.subscribe(()=>{try{check();}catch(error){stop(error);}});
        const request=store.get(id);
        request.onsuccess=()=>{
          try{
            check();
            if(JSON.stringify(request.result??null)!==fingerprint)throw fail('A proteção do aparelho mudou em outra aba. Tente novamente.','enrollment-changed');
            const writing=next?store.put(next):store.delete(id);
            writing.onsuccess=()=>{try{check();}catch(error){stop(error);}};
          }catch(error){stop(error);}
        };
      }catch(error){stop(error);}
    });
  }
  function updatedRecord(record,changes={}) {
    const revision=(record.revision||0)+1;
    if(!Number.isSafeInteger(revision))throw verificationError();
    return {...record,...changes,revision,updatedAt:Date.now()};
  }
  function validateRecord(value,id) {
    if(!value||value.version!==VERSION||value.profileId!==id||value.origin!==origin||value.rpId!==rpId||value.algorithm!==-7
      ||!Number.isInteger(value.signCount)||value.signCount<0||value.signCount>0xffffffff
      ||(value.revision!==undefined&&(!Number.isSafeInteger(value.revision)||value.revision<1)))throw verificationError();
    decode(value.credentialId,16,2048);decode(value.publicKey,64,512);decode(value.prfSalt,32);decode(value.hkdfSalt,32);
    envelopeFor(value.envelope,id);
    return value;
  }
  async function hasEnrollment(id) {
    try{profileId(id);return Boolean(validateRecord(await stored('readonly',store=>store.get(id)),id));}
    catch{return false;}
  }
  function credentialId(credential,expected) {
    if(!credential||credential.type!=='public-key'||(credential.authenticatorAttachment&&credential.authenticatorAttachment!=='platform'))throw verificationError();
    const id=bytes(credential.rawId,16,2048);
    if(credential.id!==encode(id)||(expected&&!same(id,decode(expected,16,2048))))throw verificationError();
    return id;
  }
  async function verifyClient(response,type,challenge) {
    const raw=bytes(response.clientDataJSON,1,8192);
    let data;try{data=JSON.parse(decoder.decode(raw));}catch{throw verificationError();}
    if(data.type!==type||data.challenge!==encode(challenge)||data.origin!==origin||data.crossOrigin===true||data.topOrigin!==undefined)throw verificationError();
    return hash(raw);
  }
  async function verifyAuthenticator(value,registration=false) {
    const data=bytes(value,37,8192);
    if(!same(data.subarray(0,32),await hash(encoder.encode(rpId)))||(data[32]&0x05)!==0x05||(registration&&!(data[32]&0x40)))throw verificationError();
    return {data,signCount:new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(33,false)};
  }
  async function assertion(record) {
    const challenge=random(32);
    const credential=await credentials.get({publicKey:{challenge,rpId,
      allowCredentials:[{type:'public-key',id:decode(record.credentialId,16,2048),transports:['internal']}],
      userVerification:'required',timeout:60_000,
      extensions:{prf:{eval:{first:decode(record.prfSalt,32)}}}}});
    credentialId(credential,record.credentialId);
    const response=credential.response;
    if(!response)throw verificationError();
    const clientHash=await verifyClient(response,'webauthn.get',challenge);
    const {data,signCount}=await verifyAuthenticator(response.authenticatorData);
    if((record.signCount!==0||signCount!==0)&&signCount<=record.signCount)throw verificationError();
    const publicKey=await crypto.subtle.importKey('spki',decode(record.publicKey,64,512),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,ecdsaSignature(response.signature),concat(data,clientHash)))throw verificationError();
    let secret;
    try {
      secret=bytes(credential.getClientExtensionResults?.()?.prf?.results?.first,32);
      const material=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);
      const info=encoder.encode(JSON.stringify(['PeraGym','biometric-prf',VERSION,origin,rpId,record.profileId]));
      const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:decode(record.hkdfSalt,32),info},material,
        {name:'AES-GCM',length:256},false,['wrapKey','unwrapKey']);
      const recoveryInfo=encoder.encode(JSON.stringify(['PeraGym','biometric-recovery-code',VERSION,origin,rpId,record.profileId,record.credentialId]));
      const recoveryKey=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:decode(record.hkdfSalt,32),info:recoveryInfo},material,
        {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      return {key,recoveryKey,signCount};
    }catch(error){
      if(!secret)throw fail('Este aparelho não forneceu a chave WebAuthn PRF. Continue usando sua senha.','prf-unavailable');
      throw error;
    }finally{secret?.fill(0);}
  }
  async function operation(action) {
    if(busy)throw fail('Aguarde a confirmação em andamento.','busy');
    busy=true;
    try{return await action();}catch(error){throw friendly(error);}finally{busy=false;}
  }
  function authenticated() {
    const state=account.getState();
    if(state.guest)throw fail('Crie um perfil com senha para proteger o código de recuperação.','locked');
    const id=profileId(state.profile?.id),generation=state.generation;
    requireUnlocked(id,generation);return {id,generation};
  }
  async function recoveryStatus(id,generation) {
    requireUnlocked(id,generation);
    if(typeof account.getRecoveryStatus!=='function')throw fail('A recuperação local precisa ser atualizada antes de usar este recurso.','recovery-unavailable');
    const status=await account.getRecoveryStatus({includeGeneration:true});requireUnlocked(id,generation);
    if(status?.enabled===false)return {enabled:false,generation:0};
    if(status?.enabled!==true||!Number.isSafeInteger(status.generation)||status.generation<1)throw verificationError();
    return {enabled:true,generation:status.generation};
  }
  async function verifyRecoveryCode(id,generation,code,expectedGeneration) {
    requireUnlocked(id,generation);
    if(typeof account.verifyRecoveryCode!=='function')throw fail('A verificação do código local precisa ser atualizada.','recovery-unavailable');
    const verified=await account.verifyRecoveryCode(code);requireUnlocked(id,generation);
    if(verified?.profileId!==id||!Number.isSafeInteger(verified.generation)||verified.generation<1
      ||(expectedGeneration!==undefined&&verified.generation!==expectedGeneration)) {
      throw fail('O código de recuperação mudou. Gere ou proteja o código atual.','recovery-stale');
    }
    return {enabled:true,generation:verified.generation};
  }
  function codeBytes(value) {
    if(typeof value!=='string'||value.length>128)throw fail('Use o código de recuperação gerado para este perfil.','recovery-code');
    const normalized=value.normalize('NFKC').trim().toUpperCase().replace(/[- ]/g,'');
    if(!/^PG[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{32}$/.test(normalized))throw fail('Use o código de recuperação gerado para este perfil.','recovery-code');
    return encoder.encode('PG-'+normalized.slice(2).match(/.{4}/g).join('-'));
  }
  function recoveryEnvelope(value,record) {
    if(!value||value.version!==VERSION||value.profileId!==record.profileId||value.credentialId!==record.credentialId
      ||value.origin!==origin||value.rpId!==rpId||!Number.isSafeInteger(value.recoveryGeneration)||value.recoveryGeneration<1)throw verificationError();
    decode(value.iv,12);decode(value.ciphertext,58);return value;
  }
  const recoveryAAD=(record,generation)=>encoder.encode(JSON.stringify(['PeraGym','biometric-recovery-code',VERSION,
    origin,rpId,record.profileId,record.credentialId,generation]));
  async function encryptCode(record,recoveryKey,code,status) {
    if(!status.enabled)throw fail('Ative um código de recuperação antes de protegê-lo no aparelho.','recovery-unavailable');
    const plain=codeBytes(code);
    try{
      const iv=random(12);
      const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:recoveryAAD(record,status.generation)},recoveryKey,plain);
      return {version:VERSION,profileId:record.profileId,credentialId:record.credentialId,origin,rpId,
        recoveryGeneration:status.generation,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
    }finally{plain.fill(0);}
  }
  async function unchangedRecovery(id,generation,expected) {
    const current=await recoveryStatus(id,generation);
    if(!current.enabled||current.generation!==expected)throw fail('O código de recuperação mudou. Gere ou proteja o código atual.','recovery-stale');
    return current;
  }
  async function getRecoveryCodeStatus(id) {
    profileId(id);const generation=account.getState().generation;requireUnlocked(id,generation);
    const status=await recoveryStatus(id,generation),record=await stored('readonly',store=>store.get(id));requireUnlocked(id,generation);
    if(!status.enabled||!record)return {protected:false};
    let envelope;
    try{
      validateRecord(record,id);
      envelope=recoveryEnvelope(record.recoveryCodeEnvelope,record);
    }catch{return {protected:false};}
    if(envelope.recoveryGeneration!==status.generation)return {protected:false};
    const latest=await recoveryStatus(id,generation);
    return {protected:latest.enabled&&envelope.recoveryGeneration===latest.generation};
  }
  async function enroll({recoveryCode}={}) {
    return operation(async()=>{
      const state=account.getState(),id=profileId(state.profile?.id),generation=state.generation;
      requireUnlocked(id,generation);await requireSupport();requireUnlocked(id,generation);
      if(state.guest)throw fail('Crie um perfil com senha para ativar o desbloqueio do aparelho.','locked');
      if(recoveryCode!==undefined){const checked=codeBytes(recoveryCode);checked.fill(0);}
      const initialRecovery=recoveryCode!==undefined?await verifyRecoveryCode(id,generation,recoveryCode):null;
      const previous=await stored('readonly',store=>store.get(id));requireUnlocked(id,generation);
      const challenge=random(32),prfSalt=random(32),hkdfSalt=random(32);
      const credential=await credentials.create({publicKey:{challenge,rp:{id:rpId,name:'PeraGym'},
        user:{id:random(32),name:String(state.profile.username),displayName:String(state.profile.name)},
        pubKeyCredParams:[{type:'public-key',alg:-7}],attestation:'none',timeout:60_000,
        authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'preferred',userVerification:'required'},
        extensions:{prf:{}}}});
      requireUnlocked(id,generation);
      const rawId=credentialId(credential),response=credential.response;
      if(typeof response?.getPublicKey!=='function'||typeof response?.getPublicKeyAlgorithm!=='function'
        ||typeof response?.getAuthenticatorData!=='function'||response.getPublicKeyAlgorithm()!==-7)throw verificationError();
      await verifyClient(response,'webauthn.create',challenge);
      const {signCount}=await verifyAuthenticator(response.getAuthenticatorData(),true);
      const record={version:VERSION,profileId:id,origin,rpId,algorithm:-7,credentialId:encode(rawId),
        publicKey:encode(bytes(response.getPublicKey(),64,512)),prfSalt:encode(prfSalt),hkdfSalt:encode(hkdfSalt),signCount,createdAt:Date.now()};
      // Do not trust prf.enabled alone: require a fresh, signed assertion and a real 32-byte result.
      const {key,recoveryKey,signCount:nextCount}=await assertion(record);
      requireUnlocked(id,generation);
      record.envelope=envelopeFor(await account.wrapSessionKey(key),id);
      requireUnlocked(id,generation);
      const profile=await account.unlockWithWrappedKey(id,key,record.envelope);
      const verified=account.getState();
      if(profile?.id!==id||!verified.unlocked||verified.profile?.id!==id)throw verificationError();
      if(recoveryCode!==undefined){
        const status=await verifyRecoveryCode(id,verified.generation,recoveryCode,initialRecovery.generation);
        record.recoveryCodeEnvelope=await encryptCode(record,recoveryKey,recoveryCode,status);
        await unchangedRecovery(id,verified.generation,status.generation);
      }
      const next=updatedRecord({...record,revision:previous?.revision||0},{signCount:nextCount});
      await replaceRecord(id,previous,next,()=>requireUnlocked(id,verified.generation));
      requireUnlocked(id,verified.generation);
      return {profileId:id,...(recoveryCode!==undefined?{protected:true}:{})};
    });
  }
  async function unlock(id) {
    return operation(async()=>{
      profileId(id);const generation=account.getState().generation;
      stateMatches(id,generation);await requireSupport();
      const record=validateRecord(await stored('readonly',store=>store.get(id)),id);
      stateMatches(id,generation);
      const {key,signCount}=await assertion(record);
      stateMatches(id,generation);
      const next=updatedRecord(record,{signCount});
      await replaceRecord(id,record,next,()=>stateMatches(id,generation));
      stateMatches(id,generation);
      const profile=await account.unlockWithWrappedKey(id,key,record.envelope);
      const verified=account.getState();
      if(profile?.id!==id||!verified.unlocked||verified.profile?.id!==id)throw verificationError();
      const current=await stored('readonly',store=>store.get(id));
      if(JSON.stringify(current)!==JSON.stringify(next)){
        if(account.getState().generation===verified.generation)account.lock();
        throw fail('A proteção do aparelho mudou durante a confirmação. Entre novamente.','enrollment-changed');
      }
      requireUnlocked(id,verified.generation);
      return profile;
    });
  }
  async function protectRecoveryCode(code) {
    return operation(async()=>{
      const {id,generation}=authenticated();const checked=codeBytes(code);checked.fill(0);
      await requireSupport();requireUnlocked(id,generation);
      const record=validateRecord(await stored('readonly',store=>store.get(id)),id);
      const status=await verifyRecoveryCode(id,generation,code);
      const {recoveryKey,signCount}=await assertion(record);requireUnlocked(id,generation);
      await verifyRecoveryCode(id,generation,code,status.generation);
      const recoveryCodeEnvelope=await encryptCode(record,recoveryKey,code,status);requireUnlocked(id,generation);
      await unchangedRecovery(id,generation,status.generation);
      await replaceRecord(id,record,updatedRecord(record,{signCount,recoveryCodeEnvelope}),()=>requireUnlocked(id,generation));
      await unchangedRecovery(id,generation,status.generation);
      return {profileId:id,protected:true};
    });
  }
  async function readRecoveryCode() {
    return operation(async()=>{
      const {id,generation}=authenticated();await requireSupport();requireUnlocked(id,generation);
      const record=validateRecord(await stored('readonly',store=>store.get(id)),id);
      if(!record.recoveryCodeEnvelope)throw fail('Nenhum código foi protegido neste aparelho. Gere um novo código e guarde-o.','recovery-unavailable');
      const envelope=recoveryEnvelope(record.recoveryCodeEnvelope,record);
      await unchangedRecovery(id,generation,envelope.recoveryGeneration);
      const {recoveryKey,signCount}=await assertion(record);requireUnlocked(id,generation);
      await unchangedRecovery(id,generation,envelope.recoveryGeneration);
      let plain,checked;
      try{
        plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv,12),
          additionalData:recoveryAAD(record,envelope.recoveryGeneration)},recoveryKey,decode(envelope.ciphertext,58)));
        requireUnlocked(id,generation);
        const code=decoder.decode(plain);checked=codeBytes(code);
        await verifyRecoveryCode(id,generation,code,envelope.recoveryGeneration);
        await replaceRecord(id,record,updatedRecord(record,{signCount}),()=>requireUnlocked(id,generation));
        await unchangedRecovery(id,generation,envelope.recoveryGeneration);
        return code;
      }finally{plain?.fill(0);checked?.fill(0);}
    });
  }
  async function rotateRecoveryCode() {
    return operation(async()=>{
      const {id,generation}=authenticated();await requireSupport();requireUnlocked(id,generation);
      const record=validateRecord(await stored('readonly',store=>store.get(id)),id);
      const {recoveryKey,signCount}=await assertion(record);requireUnlocked(id,generation);
      const confirmed=updatedRecord(record,{signCount});
      await replaceRecord(id,record,confirmed,()=>requireUnlocked(id,generation));
      requireUnlocked(id,generation);
      if(typeof account.createRecoveryCode!=='function')throw fail('A geração de códigos não está disponível nesta versão.','recovery-unavailable');
      const previous=await recoveryStatus(id,generation);
      if(!Number.isSafeInteger(previous.generation+1))throw verificationError();
      const code=await account.createRecoveryCode();
      try{
        requireUnlocked(id,generation);
        const status=await verifyRecoveryCode(id,generation,code,previous.generation+1);
        const recoveryCodeEnvelope=await encryptCode(confirmed,recoveryKey,code,status);requireUnlocked(id,generation);
        await unchangedRecovery(id,generation,status.generation);
        await replaceRecord(id,confirmed,updatedRecord(confirmed,{recoveryCodeEnvelope}),()=>requireUnlocked(id,generation));
        await unchangedRecovery(id,generation,status.generation);
        return {code,protected:true};
      }catch(error){
        // Preserve a committed code after a device-copy failure only while the account still proves it is current.
        requireUnlocked(id,generation);
        await verifyRecoveryCode(id,generation,code);
        return {code,protected:false,error:friendly(error).message};
      }
    });
  }
  async function remove(id) {
    return operation(async()=>{
      profileId(id);const generation=account.getState().generation;requireUnlocked(id,generation);
      const record=await stored('readonly',store=>store.get(id));requireUnlocked(id,generation);
      await replaceRecord(id,record,null,()=>requireUnlocked(id,generation));
      return {profileId:id}; // Removes the encrypted local wrapper, not the OS passkey.
    });
  }
  return {support,hasEnrollment,enroll,unlock,remove,getRecoveryCodeStatus,protectRecoveryCode,readRecoveryCode,rotateRecoveryCode};
}
