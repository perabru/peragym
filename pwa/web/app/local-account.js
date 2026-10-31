/** Offline profiles. Personal records are authenticated ciphertext at rest. */
const DATABASE = 'peragym-accounts-v1';
const GUEST_DATABASE = 'peragym-guest-v1';
const GUEST_ID = 'guest-local';
const GUEST_PROFILE = Object.freeze({id:GUEST_ID,name:'Visitante',username:'visitante'});
const VERSION = 1;
const ITERATIONS = 600_000;
const MAX_DATA_BYTES = 20 * 1024 * 1024;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const PROFILE_ID = /^[A-Za-z0-9-]{1,80}$/;
const connections = new WeakMap();
const guestConnections = new WeakMap();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8',{fatal:true});

function failure(message,name='LocalAccountValidationError') {const error=new Error(message);error.name=name;return error;}
function cryptoAPI() {
  const api=globalThis.crypto;
  if(!api?.subtle||!api?.getRandomValues||!globalThis.indexedDB)throw failure('Este navegador precisa oferecer armazenamento local e criptografia Web Crypto. Abra o PeraGym em HTTPS em um navegador atualizado.','LocalAccountUnsupported');
  return api;
}
function supported() {return Boolean(globalThis.crypto?.subtle&&globalThis.crypto?.getRandomValues&&globalThis.indexedDB);}
function randomBytes(size) {return cryptoAPI().getRandomValues(new Uint8Array(size));}
function encode(bytes) {
  let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decode(raw,min,max) {
  if(typeof raw!=='string'||raw.length>Math.ceil(max*4/3)+4||!/^[A-Za-z0-9_-]+$/.test(raw))throw failure('O perfil local contém dados criptografados inválidos.','LocalAccountDataError');
  let binary;try{binary=atob(raw.replace(/-/g,'+').replace(/_/g,'/'));}catch{throw failure('O perfil local contém dados criptografados inválidos.','LocalAccountDataError');}
  if(binary.length<min||binary.length>max)throw failure('O perfil local contém dados criptografados inválidos.','LocalAccountDataError');
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  if(encode(bytes)!==raw)throw failure('O perfil local contém dados criptografados inválidos.','LocalAccountDataError');
  return bytes;
}
function normalizeUsername(raw) {
  if(typeof raw!=='string')throw failure('Informe um nome de usuário local.');
  const value=raw.normalize('NFKC').trim().toLowerCase();
  if(!USERNAME.test(value))throw failure('Use um usuário de 3 a 40 caracteres: letras de a a z, números, ponto, hífen ou sublinhado.');
  return value;
}
function normalizedName(raw) {
  if(typeof raw!=='string')throw failure('Informe seu nome.');
  const value=raw.normalize('NFC').trim();
  if(!value||value.length>100||/[\u0000-\u001f\u007f]/.test(value))throw failure('Informe um nome de até 100 caracteres.');
  return value;
}
function checkPassword(raw) {
  if(typeof raw!=='string'||Array.from(raw).length<8||Array.from(raw).length>256||!raw.trim()||encoder.encode(raw).length>1024)throw failure('Use uma senha local com pelo menos 8 e no máximo 256 caracteres.');
  return raw; // Passwords are deliberately neither trimmed nor normalized.
}
function publicProfile(profile) {return {id:profile.id,name:profile.name,username:profile.username};}
function emptyData() {return {workouts:[],sessions:[],loadHistory:[],bodyWeights:[],theme:'light',activeSession:null,musicLinks:[],legacyImport:null};}
function plainObject(value) {return value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function dataJSON(data) {
  const fields=Object.keys(emptyData());
  if(!plainObject(data)||Object.keys(data).length!==fields.length||Object.keys(data).some(key=>!fields.includes(key))
    ||['workouts','sessions','loadHistory','bodyWeights','musicLinks'].some(key=>!Array.isArray(data[key]))
    ||!['light','dark'].includes(data.theme)||(data.activeSession!==null&&!plainObject(data.activeSession))
    ||(data.legacyImport!==null&&!plainObject(data.legacyImport)))throw failure('Os dados do perfil local não têm um formato compatível.','LocalAccountDataError');
  let serialized;
  try{
    serialized=JSON.stringify({schema:VERSION,data},(key,value)=>{
      if(typeof value==='undefined'||typeof value==='function'||typeof value==='symbol'||typeof value==='bigint'
        ||(typeof value==='number'&&!Number.isFinite(value)))throw new Error('invalid-json');
      return value;
    });
  }catch{throw failure('Os dados locais precisam conter apenas registros JSON válidos.','LocalAccountDataError');}
  const bytes=encoder.encode(serialized);
  if(bytes.length>MAX_DATA_BYTES)throw failure('Este perfil excede o limite local de 20 MB. Exporte um backup e reduza os registros.','LocalAccountDataError');
  return bytes;
}
function keyAAD(profile,purpose) {return encoder.encode(JSON.stringify(['PeraGym','local-account',VERSION,profile.id,profile.username,purpose]));}
function vaultAAD(profileId,revision) {return encoder.encode(JSON.stringify(['PeraGym','local-vault',VERSION,profileId,revision]));}
function validateMetadata(profile) {
  if(!profile||profile.version!==VERSION||!PROFILE_ID.test(profile.id)||normalizeUsername(profile.username)!==profile.username
    ||normalizedName(profile.name)!==profile.name||profile.kdf?.name!=='PBKDF2'||profile.kdf?.hash!=='SHA-256'
    ||!Number.isInteger(profile.kdf.iterations)||profile.kdf.iterations<ITERATIONS||profile.kdf.iterations>2_000_000)throw failure('Este perfil usa um formato local inválido ou não suportado.','LocalAccountDataError');
  decode(profile.kdf.salt,16,32);
  return profile;
}
function validateVault(vault,profileId) {
  if(!vault||vault.version!==VERSION||vault.profileId!==profileId||!Number.isSafeInteger(vault.revision)||vault.revision<0)throw failure('O cofre deste perfil está ausente ou não é compatível.','LocalAccountDataError');
  decode(vault.iv,12,12);decode(vault.ciphertext,17,MAX_DATA_BYTES+16);
  return vault;
}
async function derivePasswordKey(password,kdf) {
  const api=cryptoAPI(),bytes=encoder.encode(password);
  try{
    const material=await api.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);
    return await api.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:decode(kdf.salt,16,32),iterations:kdf.iterations},material,{name:'AES-GCM',length:256},false,['wrapKey','unwrapKey']);
  }finally{bytes.fill(0);}
}
function validateWrappingKey(key,usage) {
  if(!key||key.type!=='secret'||key.algorithm?.name!=='AES-GCM'||key.algorithm?.length!==256||!Array.isArray(key.usages)||!key.usages.includes(usage))throw failure('A chave de proteção biométrica não é válida.','LocalAccountValidationError');
}
async function wrapDataKey(profile,dataKey,wrappingKey,purpose) {
  validateWrappingKey(wrappingKey,'wrapKey');
  const iv=randomBytes(12),ciphertext=await cryptoAPI().subtle.wrapKey('raw',dataKey,wrappingKey,{name:'AES-GCM',iv,additionalData:keyAAD(profile,purpose),tagLength:128});
  return {version:VERSION,profileId:profile.id,purpose,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
}
async function unwrapDataKey(profile,wrappingKey,envelope,purpose) {
  validateWrappingKey(wrappingKey,'unwrapKey');
  if(!envelope||envelope.version!==VERSION||envelope.profileId!==profile.id||envelope.purpose!==purpose)throw failure('A proteção de acesso não corresponde a este perfil.','LocalAccountAuthError');
  return cryptoAPI().subtle.unwrapKey('raw',decode(envelope.ciphertext,48,48),wrappingKey,{name:'AES-GCM',iv:decode(envelope.iv,12,12),additionalData:keyAAD(profile,purpose),tagLength:128},{name:'AES-GCM',length:256},true,['encrypt','decrypt']);
}
async function encryptData(profileId,key,data,revision) {
  const iv=randomBytes(12),plain=dataJSON(data);
  try{
    const encrypted=await cryptoAPI().subtle.encrypt({name:'AES-GCM',iv,additionalData:vaultAAD(profileId,revision),tagLength:128},key,plain);
    return {profileId,version:VERSION,revision,iv:encode(iv),ciphertext:encode(new Uint8Array(encrypted)),updatedAt:Date.now()};
  }finally{plain.fill(0);}
}
async function decryptData(profileId,key,record) {
  const vault=validateVault(record,profileId);
  let bytes;
  try{
    bytes=new Uint8Array(await cryptoAPI().subtle.decrypt({name:'AES-GCM',iv:decode(vault.iv,12,12),additionalData:vaultAAD(profileId,vault.revision),tagLength:128},key,decode(vault.ciphertext,17,MAX_DATA_BYTES+16)));
    const parsed=JSON.parse(decoder.decode(bytes));
    if(parsed?.schema!==VERSION)throw new Error('schema');
    dataJSON(parsed.data);return parsed.data;
  }catch(error){
    if(error?.name?.startsWith('LocalAccount'))throw error;
    throw failure('Não foi possível abrir os registros deste perfil. Os dados não foram apagados.','LocalAccountDataError');
  }finally{bytes?.fill(0);}
}
function openDatabase() {
  cryptoAPI();const factory=globalThis.indexedDB;
  if(connections.has(factory))return connections.get(factory);
  const promise=new Promise((resolve,reject)=>{
    const request=factory.open(DATABASE,VERSION);let failed=false;
    request.onupgradeneeded=()=>{
      const db=request.result;
      const profiles=db.createObjectStore('profiles',{keyPath:'id'});profiles.createIndex('username','username',{unique:true});
      db.createObjectStore('vaults',{keyPath:'profileId'});
    };
    request.onsuccess=()=>{
      const db=request.result;if(failed){db.close();return;}
      db.onversionchange=()=>{db.close();connections.delete(factory);};resolve(db);
    };
    const stop=message=>{failed=true;connections.delete(factory);reject(failure(message,'LocalAccountStorageError'));};
    request.onerror=()=>stop('Não foi possível abrir os perfis locais. Verifique o armazenamento deste navegador.');
    request.onblocked=()=>stop('Feche outras abas antigas do PeraGym e tente abrir o perfil novamente.');
  });
  connections.set(factory,promise);return promise;
}
function openGuestDatabase() {
  cryptoAPI();const factory=globalThis.indexedDB;
  if(guestConnections.has(factory))return guestConnections.get(factory);
  const promise=new Promise((resolve,reject)=>{
    const request=factory.open(GUEST_DATABASE,VERSION);let failed=false;
    request.onupgradeneeded=()=>{request.result.createObjectStore('keys',{keyPath:'id'});request.result.createObjectStore('vaults',{keyPath:'profileId'});};
    request.onsuccess=()=>{
      const db=request.result;if(failed){db.close();return;}
      db.onversionchange=()=>{db.close();guestConnections.delete(factory);};resolve(db);
    };
    const stop=()=>{failed=true;guestConnections.delete(factory);reject(failure('Não foi possível abrir os dados de visitante neste navegador.','LocalAccountStorageError'));};
    request.onerror=stop;request.onblocked=stop;
  });
  guestConnections.set(factory,promise);return promise;
}
async function transact(names,mode,action,guest=false) {
  const db=await (guest?openGuestDatabase():openDatabase());
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(names,mode),stores=Object.fromEntries(names.map(name=>[name,transaction.objectStore(name)]));
    let value,customError;
    const fail=error=>{customError=error;try{transaction.abort();}catch{}};
    transaction.oncomplete=()=>resolve(value);
    transaction.onerror=transaction.onabort=()=>{
      if(customError)return reject(customError);
      if(transaction.error?.name==='ConstraintError')return reject(failure('Este nome de usuário já está cadastrado neste aparelho.'));
      reject(failure('Não foi possível salvar o perfil local. Verifique o espaço disponível e tente novamente.','LocalAccountStorageError'));
    };
    try{action(stores,result=>{value=result;},fail);}catch(error){fail(error);}
  });
}
async function profileByUsername(username) {
  return transact(['profiles'],'readonly',(stores,done)=>{const request=stores.profiles.index('username').get(username);request.onsuccess=()=>done(request.result||null);});
}
async function recordsFor(profileId,guest=false) {
  if(guest)return transact(['vaults'],'readonly',(stores,done)=>{const request=stores.vaults.get(profileId);request.onsuccess=()=>done({profile:GUEST_PROFILE,vault:request.result||null});},true);
  return transact(['profiles','vaults'],'readonly',(stores,done)=>{
    const result={};let pending=2;
    for(const [store,key]of [['profiles','profile'],['vaults','vault']]){const request=stores[store].get(profileId);request.onsuccess=()=>{result[key]=request.result||null;if(!--pending)done(result);};}
  });
}
async function guestRecords() {
  return transact(['keys','vaults'],'readonly',(stores,done)=>{
    const result={};let pending=2;
    for(const [store,key]of [['keys','keyRecord'],['vaults','vault']]){const request=stores[store].get(GUEST_ID);request.onsuccess=()=>{result[key]=request.result||null;if(!--pending)done(result);};}
  },true);
}
function guestKeyFrom(records) {
  const key=records.keyRecord?.key;
  if(!records.keyRecord&&!records.vault)return null;
  if(!key||!records.vault||key.type!=='secret'||key.algorithm?.name!=='AES-GCM'||key.algorithm?.length!==256
    ||key.extractable!==false||!key.usages?.includes('encrypt')||!key.usages?.includes('decrypt'))throw failure('Os dados de visitante não puderam ser abertos. Nenhum registro foi apagado.','LocalAccountDataError');
  validateVault(records.vault,GUEST_ID);return key;
}

export function createLocalAccount({onChange}={}) {
  let session=null,generation=0;
  const listeners=new Set();if(typeof onChange==='function')listeners.add(onChange);
  function getState() {return {supported:supported(),unlocked:Boolean(session),guest:Boolean(session?.guest),profileId:session?.profile.id||null,profile:session?publicProfile(session.profile):null,revision:session?.revision??null,generation};}
  function publish() {for(const listener of listeners){try{listener(getState());}catch{}}}
  function subscribe(listener) {if(typeof listener!=='function')throw failure('Observador de sessão inválido.');listeners.add(listener);return()=>listeners.delete(listener);}
  function lock() {generation++;session=null;publish();}
  function assertGeneration(run) {if(run!==generation)throw failure('A sessão local foi encerrada. Entre novamente.','LocalAccountCancelled');}
  function requireSession() {if(!session)throw failure('Entre no seu perfil local para abrir os registros.','LocalAccountLocked');return {run:generation,profile:session.profile,key:session.key,revision:session.revision,guest:session.guest};}
  function beginAuthentication() {generation++;session=null;return generation;}
  function activate(run,profile,key,revision,guest=false) {assertGeneration(run);session={profile,key,revision,guest};publish();return publicProfile(profile);}
  async function listProfiles() {
    const profiles=await transact(['profiles'],'readonly',(stores,done)=>{const request=stores.profiles.getAll();request.onsuccess=()=>done(request.result);});
    return profiles.map(profile=>publicProfile(profile)).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
  }
  async function register({name,username,password,copyGuestData=false}={}) {
    cryptoAPI();name=normalizedName(name);username=normalizeUsername(username);password=checkPassword(password);
    if(typeof copyGuestData!=='boolean')throw failure('Escolha se deseja copiar os dados de visitante.');
    const run=beginAuthentication(),id=globalThis.crypto.randomUUID();
    const profile={id,version:VERSION,name,username,createdAt:Date.now(),kdf:{name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:encode(randomBytes(16))}};
    const existing=await profileByUsername(username);assertGeneration(run);
    if(existing)throw failure('Este nome de usuário já está cadastrado neste aparelho.');
    let initial=emptyData();
    if(copyGuestData){
      const guest=await guestRecords();assertGeneration(run);const key=guestKeyFrom(guest);
      if(key){initial=await decryptData(GUEST_ID,key,guest.vault);assertGeneration(run);}
    }
    const key=await cryptoAPI().subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);assertGeneration(run);
    const wrappingKey=await derivePasswordKey(password,profile.kdf);password=null;assertGeneration(run);
    profile.passwordEnvelope=await wrapDataKey(profile,key,wrappingKey,'password-key');assertGeneration(run);
    const vault=await encryptData(id,key,initial,0);assertGeneration(run);
    await transact(['profiles','vaults'],'readwrite',(stores,done)=>{assertGeneration(run);stores.profiles.add(profile);stores.vaults.add(vault);done(null);});
    return activate(run,profile,key,0);
  }
  async function login(username,password) {
    cryptoAPI();username=normalizeUsername(username);password=checkPassword(password);const run=beginAuthentication();
    const profile=await profileByUsername(username);assertGeneration(run);
    if(!profile)throw failure('Usuário ou senha local inválidos.','LocalAccountAuthError');
    validateMetadata(profile);
    const wrappingKey=await derivePasswordKey(password,profile.kdf);password=null;assertGeneration(run);
    let key;
    try{key=await unwrapDataKey(profile,wrappingKey,profile.passwordEnvelope,'password-key');}
    catch(error){assertGeneration(run);throw failure('Usuário ou senha local inválidos. Os registros não foram apagados.','LocalAccountAuthError');}
    assertGeneration(run);
    const records=await recordsFor(profile.id);assertGeneration(run);
    await decryptData(profile.id,key,records.vault);assertGeneration(run);
    return activate(run,profile,key,records.vault.revision);
  }
  async function enterGuest() {
    cryptoAPI();const run=beginAuthentication();
    let records=await guestRecords();assertGeneration(run);
    let key=guestKeyFrom(records);
    if(!key){
      const candidate=await cryptoAPI().subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);assertGeneration(run);
      const initial=await encryptData(GUEST_ID,candidate,emptyData(),0);assertGeneration(run);
      // Concurrent first visits choose one persisted key/vault pair atomically.
      records=await transact(['keys','vaults'],'readwrite',(stores,done,fail)=>{
        const current={};let pending=2;
        for(const [store,name]of [['keys','keyRecord'],['vaults','vault']]){
          const request=stores[store].get(GUEST_ID);request.onsuccess=()=>{
            current[name]=request.result||null;if(--pending)return;
            try{
              assertGeneration(run);
              if(guestKeyFrom(current))return done(current);
              const keyRecord={id:GUEST_ID,key:candidate};stores.keys.add(keyRecord);stores.vaults.add(initial);
              done({keyRecord,vault:initial});
            }catch(error){fail(error);}
          };
        }
      },true);
      assertGeneration(run);key=guestKeyFrom(records);
    }
    await decryptData(GUEST_ID,key,records.vault);assertGeneration(run);
    return activate(run,GUEST_PROFILE,key,records.vault.revision,true);
  }
  async function readData() {
    const current=requireSession(),records=await recordsFor(current.profile.id,current.guest);assertGeneration(current.run);
    if(!records.profile)throw failure('Este perfil local não foi encontrado.','LocalAccountDataError');
    const data=await decryptData(current.profile.id,current.key,records.vault);assertGeneration(current.run);
    session.revision=records.vault.revision;
    return data;
  }
  async function mutateData(mutator) {
    if(typeof mutator!=='function')throw failure('A alteração de registros é inválida.');
    const current=requireSession(),records=await recordsFor(current.profile.id,current.guest);assertGeneration(current.run);
    validateVault(records.vault,current.profile.id);
    if(records.vault.revision!==current.revision)throw failure('Os registros foram alterados em outra aba. Atualize o perfil antes de tentar novamente.','LocalAccountConflict');
    const data=await decryptData(current.profile.id,current.key,records.vault);assertGeneration(current.run);
    const result=mutator(data);
    if(result&&typeof result.then==='function')throw failure('As alterações do cofre devem ser síncronas.');
    const revision=current.revision+1;
    if(!Number.isSafeInteger(revision))throw failure('A versão dos registros locais excedeu o limite suportado.','LocalAccountDataError');
    const next=await encryptData(current.profile.id,current.key,data,revision);assertGeneration(current.run);
    await transact(['vaults'],'readwrite',(stores,done,fail)=>{
      assertGeneration(current.run);
      const request=stores.vaults.get(current.profile.id);
      request.onsuccess=()=>{
        try{
          assertGeneration(current.run);
          if(request.result?.revision!==current.revision)return fail(failure('Outra aba salvou registros primeiro. Atualize o perfil e tente novamente.','LocalAccountConflict'));
          stores.vaults.put(next);done(null);
        }catch(error){fail(error);}
      };
    },current.guest);
    assertGeneration(current.run);session.revision=revision;return result;
  }
  async function wrapSessionKey(wrappingKey) {
    const current=requireSession();
    if(current.guest)throw failure('O uso sem cadastro não tem senha ou desbloqueio biométrico. Crie um perfil protegido para ativar esse recurso.','LocalAccountAuthError');
    const envelope=await wrapDataKey(current.profile,current.key,wrappingKey,'biometric-prf');
    assertGeneration(current.run);return envelope;
  }
  async function unlockWithWrappedKey(profileId,wrappingKey,envelope) {
    cryptoAPI();if(typeof profileId!=='string'||!PROFILE_ID.test(profileId))throw failure('Escolha um perfil local válido.');
    if(profileId===GUEST_ID)throw failure('Use a opção sem cadastro para abrir os dados de visitante.','LocalAccountAuthError');
    const run=beginAuthentication(),records=await recordsFor(profileId);assertGeneration(run);
    if(!records.profile)throw failure('Este perfil local não foi encontrado neste aparelho.','LocalAccountAuthError');
    const profile=validateMetadata(records.profile);let key;
    try{key=await unwrapDataKey(profile,wrappingKey,envelope,'biometric-prf');}
    catch{assertGeneration(run);throw failure('Não foi possível desbloquear este perfil com a proteção biométrica. Use sua senha local.','LocalAccountAuthError');}
    assertGeneration(run);await decryptData(profileId,key,records.vault);assertGeneration(run);
    return activate(run,profile,key,records.vault.revision);
  }
  return {register,login,enterGuest,listProfiles,getState,subscribe,lock,readData,mutateData,wrapSessionKey,unlockWithWrappedKey};
}

export const localAccount=createLocalAccount();
