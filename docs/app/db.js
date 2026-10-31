/* Personal records live only in the unlocked encrypted profile; legacy IndexedDB is read-only. */
import {parseMusicLink} from './music-links.js?v=3.8.0';
import {localAccount} from './local-account.js?v=3.8.0';

const LEGACY_DB_NAME = 'peragym-local';
const LEGACY_STORES = ['workouts', 'sessions', 'settings', 'loadHistory', 'bodyWeights'];
const RECORDS = ['workouts', 'sessions', 'loadHistory', 'bodyWeights'];

export const uid = () => crypto.randomUUID();
const invalid = message => { throw new Error(message); };
const cleanText = (value, max, required = false) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) invalid('Um campo contém texto inválido ou muito longo.');
  const result = value.trim();
  if (required && !result) invalid('Preencha os nomes e as repetições dos exercícios.');
  return result;
};
export function parseKg(raw, min = 0, max = 2000) {
  const text = String(raw).trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) invalid('Informe um peso válido com até duas casas decimais, como 12,5.');
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value) || value < min || value > max) invalid(`Informe um peso entre ${min} e ${max} kg.`);
  return Math.round(value * 100) / 100;
}
const integer = (raw, min, max, message) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) invalid(message);
  return n;
};
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
function validateMusicLinks(input) {
  if (!Array.isArray(input) || input.length > 8) invalid('Salve até 8 links do YouTube ou Spotify.');
  return Array.from(input, raw => {
    if (typeof raw !== 'string') invalid('Cada música precisa de um link válido do YouTube ou Spotify.');
    let parsed;
    try { parsed = parseMusicLink(raw); } catch (error) { invalid(error instanceof Error ? error.message : 'Um link de música não é válido.'); }
    if (!parsed || typeof parsed.url !== 'string' || !parsed.url) invalid('Um link de música não é válido.');
    // Persist only the canonical URL, never the source URL or other parser metadata.
    return parsed.url;
  });
}
export function validateWorkout(input) {
  if (!input || typeof input !== 'object') invalid('Ficha inválida.');
  if (!Array.isArray(input.exercises) || input.exercises.length < 1 || input.exercises.length > 100) invalid('Adicione de 1 a 100 exercícios à ficha.');
  const w = {
    id: validId(input.id) ? input.id : uid(),
    name: cleanText(input.name, 100, true),
    focus: cleanText(input.focus, 100), days: cleanText(input.days, 140),
    notes: cleanText(input.notes, 2000),
    exercises: input.exercises.map(e => ({
      id: validId(e.id) ? e.id : uid(), name: cleanText(e.name, 120, true),
      sets: integer(e.sets, 1, 100, 'Use de 1 a 100 séries.'),
      reps: cleanText(String(e.reps ?? ''), 40, true), weight: parseKg(e.weight),
      rest: integer(e.rest ?? 60, 0, 3600, 'Use de 0 a 3.600 segundos de descanso.'),
      notes: cleanText(e.notes, 1000)
    }))
  };
  if (new Set(w.exercises.map(e => e.id)).size !== w.exercises.length) invalid('Há exercícios duplicados nesta ficha.');
  return w;
}
export function validateBodyWeight(input, now = Date.now()) {
  if (!input || typeof input !== 'object') invalid('Registro de peso inválido.');
  const at = Number(input.at);
  if (!Number.isFinite(at) || at < new Date('1900-01-01').getTime() || at > now + 60000) invalid('Escolha uma data e horário válidos, sem datas futuras.');
  return {id: validId(input.id) ? input.id : uid(), at, value: parseKg(input.value, 20, 400), notes: cleanText(input.notes, 500)};
}
function requireSnapshot(data) {
  if (!data || RECORDS.some(name => !Array.isArray(data[name]))) invalid('O cofre deste perfil contém dados inválidos. Nenhuma alteração foi salva.');
  return data;
}
function captureSession() {
  const session = localAccount.getState();
  if (!session.unlocked || !session.profileId) throw Object.assign(new Error('Desbloqueie seu perfil para acessar os dados.'), {name:'LocalAccountLocked'});
  return {profileId:session.profileId, generation:session.generation};
}
function checkSession(expected) {
  const current = localAccount.getState();
  if (!current.unlocked || current.profileId !== expected.profileId || current.generation !== expected.generation) {
    throw Object.assign(new Error('O perfil foi bloqueado ou alterado. Nenhum dado foi importado.'), {name:'LocalAccountCancelled'});
  }
}
export async function load() {
  const data = requireSnapshot(await localAccount.readData());
  return {
    workouts:data.workouts.sort((a,b) => a.createdAt - b.createdAt),
    sessions:data.sessions.sort((a,b) => b.completedAt - a.completedAt),
    loadHistory:data.loadHistory.sort((a,b) => a.at - b.at),
    bodyWeights:data.bodyWeights.sort((a,b) => a.at - b.at),
    theme:data.theme || (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    activeSession:data.activeSession || null,
    musicLinks:data.musicLinks === undefined ? [] : validateMusicLinks(data.musicLinks),
    legacyImport:data.legacyImport || null
  };
}
export async function saveWorkout(input) {
  const workout = validateWorkout(input), now = Date.now();
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    const old = data.workouts.find(w => w.id === workout.id);
    const otherIds = new Set(data.workouts.filter(w => w.id !== workout.id).flatMap(w => w.exercises.map(e => e.id)));
    if (workout.exercises.some(e => otherIds.has(e.id))) invalid('Um exercício pertence a outra ficha. Adicione-o novamente.');
    workout.createdAt = old?.createdAt ?? now; workout.updatedAt = now;
    workout.exercises.forEach(e => {
      const previous = old?.exercises.find(x => x.id === e.id);
      if (!previous || previous.weight !== e.weight) data.loadHistory.push({id:uid(),workoutId:workout.id,workoutName:workout.name,exerciseId:e.id,name:e.name,at:now,value:e.weight});
    });
    const index = data.workouts.findIndex(w => w.id === workout.id);
    if (index < 0) data.workouts.push(workout); else data.workouts[index] = workout;
    if (data.activeSession?.id === workout.id) {
      const remaining = new Set(workout.exercises.map(exercise => exercise.id));
      data.activeSession.done = Array.isArray(data.activeSession.done)
        ? data.activeSession.done.filter(id => remaining.has(id)) : [];
    }
    return {id:workout.id};
  });
}
export async function deleteWorkout(id) {
  if (!validId(id)) invalid('O identificador da ficha é inválido.');
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    const index = data.workouts.findIndex(workout => workout.id === id);
    if (index < 0) invalid('A ficha não foi encontrada neste perfil.');
    data.workouts.splice(index, 1);
    data.sessions.forEach(s => {if (s.workoutId === id) s.workoutId = null;});
    if (data.activeSession?.id === id) data.activeSession = null;
    return {ok:true}; // Historical completed sessions and loads survive fiche deletion.
  });
}
export async function updateWeight(exerciseId, raw) {
  const weight = parseKg(raw);
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    const w = data.workouts.find(w => w.exercises.some(e => e.id === exerciseId));
    if (!w) invalid('Exercício não encontrado. Abra a ficha novamente.');
    const e = w.exercises.find(e => e.id === exerciseId);
    if (e.weight !== weight) {
      e.weight = weight; w.updatedAt = Date.now();
      data.loadHistory.push({id:uid(),workoutId:w.id,workoutName:w.name,exerciseId:e.id,name:e.name,at:Date.now(),value:weight});
    }
    return {ok:true};
  });
}
export async function finishWorkout(input) {
  if (!input || typeof input !== 'object') invalid('Treino inválido.');
  const duration = integer(input.duration, 0, 2147483647, 'Tempo de treino inválido.');
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    const w = data.workouts.find(w => w.id === input.workoutId);
    if (!w) invalid('Ficha não encontrada.');
    const session = {id:uid(),workoutId:w.id,workoutName:w.name,completedAt:Date.now(),duration};
    data.sessions.push(session); data.activeSession = null;
    return {id:session.id};
  });
}
export async function deleteSession(id) {
  if (!validId(id)) invalid('O identificador do registro de treino é inválido.');
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    const index = data.sessions.findIndex(session => session.id === id);
    if (index < 0) invalid('O registro de treino não foi encontrado neste perfil.');
    data.sessions.splice(index, 1);
    return {ok:true};
  });
}
export async function setSetting(key, value) {
  if (!['theme','activeSession','musicLinks'].includes(key)) invalid('Preferência inválida.');
  if (key === 'theme' && !['light','dark'].includes(value)) invalid('Tema inválido.');
  value = key === 'musicLinks' ? validateMusicLinks(value) : structuredClone(value);
  return localAccount.mutateData(data => {requireSnapshot(data);data[key] = value;return {ok:true};});
}
export async function saveBodyWeight(input) {
  const row = validateBodyWeight(input);
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    const index = data.bodyWeights.findIndex(w => w.id === row.id);
    if (index < 0) data.bodyWeights.push(row); else data.bodyWeights[index] = row;
    return {id:row.id};
  });
}
export async function deleteBodyWeight(id) {
  return localAccount.mutateData(data => {
    requireSnapshot(data);data.bodyWeights = data.bodyWeights.filter(w => w.id !== id);return {ok:true};
  });
}
export async function exportBackup() {
  const {legacyImport, ...data} = await load(); // A migration receipt belongs to its profile, never to a portable backup.
  return {app:'PeraGym',version:1,exportedAt:Date.now(),data};
}
export function validateBackup(raw) {
  if (!raw || raw.app !== 'PeraGym' || raw.version !== 1 || !raw.data) invalid('Este arquivo não é um backup compatível do PeraGym.');
  const d = raw.data;
  const musicLinks = validateMusicLinks(d.musicLinks === undefined ? [] : d.musicLinks);
  for (const n of ['workouts','sessions','loadHistory','bodyWeights']) if (!Array.isArray(d[n]) || d[n].length > 50000) invalid('O backup possui dados inválidos ou excede o limite de registros.');
  if (d.workouts.length > 1000) invalid('O backup excede o limite de fichas.');
  const workouts = d.workouts.map(w => {
    if(!validId(w.id)||!Array.isArray(w.exercises)||w.exercises.some(e=>!validId(e.id)))invalid('O backup contém identificadores de ficha ou exercício inválidos.');
    const createdAt=Number(w.createdAt),updatedAt=Number(w.updatedAt);
    if(!Number.isFinite(createdAt)||!Number.isFinite(updatedAt)||createdAt<0||updatedAt<createdAt||updatedAt>Date.now()+60000)invalid('O backup contém datas de ficha inválidas.');
    return {...validateWorkout(w),createdAt,updatedAt};
  });
  const allExerciseIds = workouts.flatMap(w => w.exercises.map(e => e.id));
  if (new Set(allExerciseIds).size !== allExerciseIds.length) invalid('O backup contém exercícios com identificadores duplicados.');
  const bodyWeights = d.bodyWeights.map(w => {if(!validId(w.id))invalid('Identificador de peso inválido.');return validateBodyWeight(w);});
  const loadHistory = d.loadHistory.map(h => {
    if (!validId(h.id) || !validId(h.exerciseId) || !validId(h.workoutId)) invalid('Histórico de cargas inválido.');
    const at = Number(h.at); if (!Number.isFinite(at) || at < 0 || at > Date.now()+60000) invalid('Data inválida no histórico.');
    return {id:h.id,exerciseId:h.exerciseId,workoutId:h.workoutId,name:cleanText(h.name,120,true),workoutName:cleanText(h.workoutName,100,true),value:parseKg(h.value),at};
  });
  const sessions = d.sessions.map(s => {
    const at=Number(s.completedAt);if(!validId(s.id)||!Number.isFinite(at)||at<0||at>Date.now()+60000)invalid('Histórico de treinos inválido.');
    return {id:s.id,workoutId:validId(s.workoutId)?s.workoutId:null,workoutName:cleanText(s.workoutName,100,true),completedAt:at,duration:integer(s.duration,0,2147483647,'Duração inválida.')};
  });
  const result = {workouts,bodyWeights,loadHistory,sessions};
  for (const name of Object.keys(result)) if (new Set(result[name].map(r => r.id)).size !== result[name].length) invalid('O backup contém registros duplicados.');
  return {...result,theme:d.theme==='dark'?'dark':'light',musicLinks};
}
export async function importBackup(raw) {
  const validated = validateBackup(raw); // Validate completely before touching the encrypted profile.
  return localAccount.mutateData(data => {
    requireSnapshot(data);
    RECORDS.forEach(name => {data[name] = validated[name];});
    data.theme = validated.theme; data.musicLinks = validated.musicLinks; data.activeSession = null;
    // Preserve this profile's existing migration receipt; a backup cannot claim another profile's receipt.
    return {ok:true};
  });
}

const emptyLegacy = () => Object.fromEntries(LEGACY_STORES.map(name => [name, []]));
/** Read the original database without upgrades, edits, deletion or creating a missing database. */
async function readLegacy() {
  if (!globalThis.indexedDB) invalid('Este navegador não oferece o banco local necessário.');
  if (typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases();
    if (!databases.some(db => db.name === LEGACY_DB_NAME)) return null;
  }
  return new Promise((resolve, reject) => {
    let creating = false;
    const request = indexedDB.open(LEGACY_DB_NAME);
    request.onupgradeneeded = () => {creating = true;request.transaction.abort();};
    request.onerror = () => creating ? resolve(null) : reject(new Error('Não foi possível ler os dados anteriores. Nenhum dado foi alterado.'));
    request.onblocked = () => reject(new Error('Feche outras abas antigas do PeraGym e tente importar novamente.'));
    request.onsuccess = () => {
      const db = request.result;
      if (db.version !== 1 || LEGACY_STORES.some(name => !db.objectStoreNames.contains(name))) {
        db.close(); reject(new Error('A estrutura dos dados anteriores não é compatível. Exporte-os pela versão anterior.')); return;
      }
      const tx = db.transaction(LEGACY_STORES, 'readonly'), result = emptyLegacy();
      LEGACY_STORES.forEach(name => {const r = tx.objectStore(name).getAll();r.onsuccess = () => {result[name] = r.result;};});
      tx.oncomplete = () => {db.close();resolve(result);};
      tx.onerror = tx.onabort = () => {db.close();reject(new Error('Não foi possível ler os dados anteriores. Nenhum dado foi alterado.'));};
    };
  });
}
const legacyCounts = raw => Object.fromEntries(LEGACY_STORES.map(name => [name, raw?.[name]?.length || 0]));
export async function inspectLegacy() {
  const legacy = await readLegacy(), counts = legacyCounts(legacy);
  return {available:legacy !== null,hasData:Object.values(counts).some(Boolean),counts};
}
function legacyActiveSession(raw, workouts) {
  if (raw === null || raw === undefined) return null;
  const workout = workouts.find(w => w.id === raw.id), startedAt = Number(raw.startedAt);
  if (!workout || !Number.isFinite(startedAt) || startedAt < 0 || startedAt > Date.now()+60000
      || !Array.isArray(raw.done) || raw.done.some(id => !workout.exercises.some(e => e.id === id))
      || new Set(raw.done).size !== raw.done.length) invalid('O treino em andamento anterior é inválido. Nenhum dado foi importado.');
  return {id:raw.id,startedAt,done:[...raw.done]};
}
export async function migrateLegacy() {
  const session = captureSession(), previous = requireSnapshot(await localAccount.readData());
  checkSession(session);
  if (previous.legacyImport) return {ok:true,alreadyImported:true,counts:structuredClone(previous.legacyImport.counts)};
  const legacy = await readLegacy(), counts = legacyCounts(legacy);
  checkSession(session);
  if (!legacy || !Object.values(counts).some(Boolean)) invalid('Não há dados anteriores para importar.');
  const settings = Object.fromEntries(legacy.settings.map(row => [row.key,row.value]));
  const validated = validateBackup({app:'PeraGym',version:1,data:{...legacy,theme:settings.theme,musicLinks:settings.musicLinks}});
  const activeSession = legacyActiveSession(settings.activeSession, validated.workouts);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(legacy)));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  checkSession(session);
  const importedAt = Date.now();
  return localAccount.mutateData(data => {
    checkSession(session);requireSnapshot(data);
    if (data.legacyImport) return {ok:true,alreadyImported:true,counts:structuredClone(data.legacyImport.counts)};
    if (RECORDS.some(name => data[name].length) || data.activeSession || data.musicLinks?.length) invalid('Importe os dados anteriores em um perfil vazio para preservar seus registros atuais.');
    RECORDS.forEach(name => {data[name] = validated[name];});
    data.theme = validated.theme;data.musicLinks = validated.musicLinks;data.activeSession = activeSession;
    data.legacyImport = {source:LEGACY_DB_NAME,version:1,importedAt,fingerprint,counts};
    return {ok:true,alreadyImported:false,counts};
  });
}
