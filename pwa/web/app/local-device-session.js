/** Explicit, local-only automatic unlock. This database never contains a password or a raw vault key. */
const DATABASE='peragym-device-session-v1', VERSION=1, STORE='sessions', META='meta';
const ACTIVE='active', TTL=30*24*60*60*1000;
const PROFILE_ID=/^[A-Za-z0-9-]{1,80}$/, NONCE=/^[A-Za-z0-9_-]{22}$/;
const PURPOSE=/^remembered-device:[A-Za-z0-9_-]{43}$/;

function failure(message,code='verification') {
  const error=new Error(message);error.name='LocalDeviceSessionError';error.code=code;return error;
}
const storageError=()=>failure('Não foi possível atualizar a entrada automática neste aparelho. Tente novamente.','storage');
const changedError=()=>failure('O perfil ou a entrada automática mudou. Tente novamente.','session-changed');
function encode(bytes) {
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function validBase64(value,length) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)||value.length!==Math.ceil(length*4/3))return false;
  try{const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));return bytes.length===length&&encode(bytes)===value;}
  catch{return false;}
}
function validId(id) {return typeof id==='string'&&PROFILE_ID.test(id)&&id!=='guest-local';}
function envelopeFor(value,id) {
  if(!value||value.version!==1||value.profileId!==id||!PURPOSE.test(value.purpose)
    ||!validBase64(value.iv,12)||!validBase64(value.ciphertext,48))throw failure('A entrada automática deste aparelho não é válida. Entre com sua senha.');
  return {version:1,profileId:id,purpose:value.purpose,iv:value.iv,ciphertext:value.ciphertext};
}
function control(value) {
  if(value===undefined)return {value:0,nonce:null};
  if(value?.id!=='epoch'||!Number.isSafeInteger(value.value)||value.value<0||!NONCE.test(value.nonce))return null;
  return {value:value.value,nonce:value.nonce};
}
function sameControl(a,b) {return Boolean(a&&b&&a.value===b.value&&a.nonce===b.nonce);}
function marker(record) {
  // CryptoKey itself is not JSON data. The random record ID identifies each replacement.
  try{return JSON.stringify({...record,wrappingKey:undefined});}catch{return String(record?.recordId);}
}

export function createLocalDeviceSession({account,environment={}}={}) {
  if(!account?.getState||!account?.lock||!account?.wrapRememberedSessionKey||!account?.unlockWithRememberedKey)
    throw new TypeError('A local account with remembered unlock is required.');
  const crypto=environment.crypto??globalThis.crypto,indexedDB=environment.indexedDB??globalThis.indexedDB;
  const location=environment.location??globalThis.location,secureContext=environment.secureContext??globalThis.isSecureContext;
  const now=environment.now??(()=>Date.now()),origin=location?.origin;
  let connection,generation=0,clearBarrier=null,restoresDisabled=false;
  const writes=new Set(),restores=new Set();
  function timestamp() {const value=now();if(!Number.isSafeInteger(value)||value<0)throw failure('A data deste aparelho não é válida. Confira o relógio.');return value;}
  function nonce() {
    if(crypto?.getRandomValues)try{return encode(crypto.getRandomValues(new Uint8Array(16)));}catch{}
    // Only a concurrency marker, never encryption material. Clearing must work without Web Crypto.
    return (Date.now().toString(36)+Math.random().toString(36).slice(2)).padEnd(22,'0').slice(0,22);
  }
  function requireSupport() {
    let url;try{url=new URL(origin);}catch{}
    if(!secureContext||!url||!['https:','http:'].includes(url.protocol)||url.origin!==origin
      ||!crypto?.subtle||!crypto?.getRandomValues||!indexedDB)
      throw failure('Abra em HTTPS com armazenamento local disponível para manter o perfil conectado.','unsupported');
  }
  function checkRun(run) {if(run!==generation)throw changedError();}
  function authenticated() {
    const state=account.getState(),id=state.profile?.id??state.profileId;
    if(!state.unlocked||state.guest||!validId(id))throw failure('Entre em um perfil com senha antes de manter a conexão.','locked');
    return {id,generation:state.generation};
  }
  function checkAccount(current) {
    const state=authenticated();if(state.id!==current.id||state.generation!==current.generation)throw changedError();
  }
  async function open() {
    if(!indexedDB)throw storageError();
    if(connection)return connection;
    const opening=new Promise((resolve,reject)=>{
      let request,stopped=false;
      const stop=()=>{stopped=true;connection=null;reject(storageError());};
      try{request=indexedDB.open(DATABASE,VERSION);}catch{stop();return;}
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});
        if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:'id'});
      };
      request.onerror=request.onblocked=stop;
      request.onsuccess=()=>{
        const db=request.result;if(stopped){db.close();return;}
        db.onversionchange=()=>{db.close();connection=null;};resolve(db);
      };
    });
    connection=opening;
    try{return await opening;}catch(error){if(connection===opening)connection=null;throw error;}
  }
  async function transaction(mode,action,{check,abortable=false}={}) {
    const db=await open();check?.();
    return new Promise((resolve,reject)=>{
      let tx,result,customError;
      try{tx=db.transaction([STORE,META],mode);}catch{reject(storageError());return;}
      if(abortable)writes.add(tx);
      const stop=error=>{customError=error;try{tx.abort();}catch{}};
      tx.oncomplete=()=>{writes.delete(tx);try{check?.();resolve(result);}catch(error){reject(error);}};
      tx.onerror=tx.onabort=()=>{writes.delete(tx);reject(customError||storageError());};
      try{action(tx.objectStore(STORE),tx.objectStore(META),value=>{result=value;},stop);}catch(error){stop(error);}
    });
  }
  function read() {
    return transaction('readonly',(store,meta,done)=>{
      const result={},record=store.get(ACTIVE),epoch=meta.get('epoch');
      record.onsuccess=()=>{result.record=record.result;};epoch.onsuccess=()=>{result.control=control(epoch.result);};done(result);
    });
  }
  function advance(meta,previous) {
    meta.put({id:'epoch',value:previous&&previous.value<Number.MAX_SAFE_INTEGER?previous.value+1:1,nonce:nonce()});
  }
  async function removeIfCurrent(snapshot) {
    await transaction('readwrite',(store,meta,done,stop)=>{
      const request=store.get(ACTIVE);
      request.onsuccess=()=>{
        try{
          if(marker(request.result)!==marker(snapshot.record))return;
          const epoch=meta.get('epoch');epoch.onsuccess=()=>{
            try{store.clear();advance(meta,control(epoch.result));}catch(error){stop(error);}
          };
        }catch(error){stop(error);}
      };
    });
  }
  function validRecord(record,epoch) {
    if(!record||record.id!==ACTIVE||record.version!==VERSION||!validId(record.profileId)||record.origin!==origin
      ||!NONCE.test(record.recordId)||!epoch||record.epoch!==epoch.value||record.epochNonce!==epoch.nonce
      ||!Number.isSafeInteger(record.createdAt)||record.createdAt<0||!Number.isSafeInteger(record.expiresAt)
      ||record.expiresAt-record.createdAt!==TTL)throw failure('A entrada automática expirou ou não é válida. Entre com sua senha.');
    const time=timestamp();if(record.createdAt>time||record.expiresAt<=time)throw failure('A entrada automática expirou. Entre com sua senha.','expired');
    const key=record.wrappingKey;
    if(Object.prototype.toString.call(key)!=='[object CryptoKey]'||key.type!=='secret'||key.extractable!==false
      ||key.algorithm?.name!=='AES-GCM'||key.algorithm?.length!==256||key.usages?.length!==2
      ||!key.usages.includes('wrapKey')||!key.usages.includes('unwrapKey'))throw failure('A chave local deste aparelho não é válida.');
    envelopeFor(record.envelope,record.profileId);return record;
  }
  function cancelOwned(attempt) {
    const state=account.getState();
    if(attempt.accountGeneration!==undefined&&state.generation===attempt.accountGeneration
      &&(!state.unlocked||(state.profile?.id??state.profileId)===attempt.id))account.lock();
  }
  async function remember() {
    requireSupport();const run=generation,current=authenticated();
    if(clearBarrier)await clearBarrier;checkRun(run);checkAccount(current);
    const snapshot=await read();checkRun(run);checkAccount(current);
    if(!snapshot.control)throw failure('A entrada automática local precisa ser removida antes de ser ativada novamente.','storage');
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['wrapKey','unwrapKey']);
    checkRun(run);checkAccount(current);
    const envelope=envelopeFor(await account.wrapRememberedSessionKey(wrappingKey),current.id);
    checkRun(run);checkAccount(current);
    const createdAt=timestamp(),expiresAt=createdAt+TTL;
    if(!Number.isSafeInteger(expiresAt))throw failure('A data deste aparelho não é válida. Confira o relógio.');
    const record={id:ACTIVE,version:VERSION,recordId:nonce(),profileId:current.id,origin,createdAt,expiresAt,
      wrappingKey,envelope,epoch:snapshot.control.value,epochNonce:snapshot.control.nonce};
    const check=()=>{checkRun(run);checkAccount(current);};
    await transaction('readwrite',(store,meta,done,stop)=>{
      const request=meta.get('epoch');request.onsuccess=()=>{
        try{check();if(!sameControl(control(request.result),snapshot.control))throw changedError();store.put(record);}
        catch(error){stop(error);}
      };
    },{check,abortable:true});
    restoresDisabled=false;return {profileId:current.id,expiresAt};
  }
  async function restore() {
    let attempt,snapshot;
    try{
      requireSupport();if(account.getState().unlocked||restoresDisabled||restores.size)return {restored:false};
      const run=generation,initialGeneration=account.getState().generation;
      if(clearBarrier)await clearBarrier;checkRun(run);
      if(restoresDisabled||account.getState().unlocked||account.getState().generation!==initialGeneration)return {restored:false};
      snapshot=await read();checkRun(run);
      if(!snapshot.record)return {restored:false};
      const record=validRecord(snapshot.record,snapshot.control);
      if(account.getState().unlocked||account.getState().generation!==initialGeneration)return {restored:false};
      attempt={id:record.profileId};restores.add(attempt);
      const pending=account.unlockWithRememberedKey(record.profileId,record.wrappingKey,record.envelope);
      attempt.accountGeneration=account.getState().generation;
      const profile=await pending;checkRun(run);
      const latest=await read();checkRun(run);
      validRecord(latest.record,latest.control);
      const state=account.getState();
      if(marker(latest.record)!==marker(record)||!sameControl(latest.control,snapshot.control)
        ||state.generation!==attempt.accountGeneration||!state.unlocked||state.guest
        ||(state.profile?.id??state.profileId)!==record.profileId)throw changedError();
      return {restored:true,profile};
    }catch{
      if(attempt)cancelOwned(attempt);
      if(snapshot?.record)try{await removeIfCurrent(snapshot);}catch{}
      return {restored:false};
    }finally{if(attempt)restores.delete(attempt);}
  }
  function clear() {
    generation++;restoresDisabled=true;
    for(const tx of writes)try{tx.abort();}catch{}
    for(const attempt of restores)cancelOwned(attempt);
    const pending=transaction('readwrite',(store,meta,done,stop)=>{
      const request=meta.get('epoch');request.onsuccess=()=>{
        try{store.clear();advance(meta,control(request.result));}catch(error){stop(error);}
      };
    });
    clearBarrier=pending;
    // Keep the rejected promise observable by the caller without leaving an unhandled finally promise.
    pending.then(()=>{if(clearBarrier===pending)clearBarrier=null;},()=>{if(clearBarrier===pending)clearBarrier=null;});
    return pending;
  }
  async function hasRemembered(profileId) {
    if(!validId(profileId))return false;
    let snapshot;
    try{
      requireSupport();const run=generation;if(clearBarrier)await clearBarrier;checkRun(run);
      snapshot=await read();checkRun(run);if(!snapshot.record)return false;
      return validRecord(snapshot.record,snapshot.control).profileId===profileId;
    }catch{
      if(snapshot?.record)try{await removeIfCurrent(snapshot);}catch{}
      return false;
    }
  }
  return {remember,restore,clear,hasRemembered};
}
