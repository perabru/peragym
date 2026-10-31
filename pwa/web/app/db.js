/* PeraGym's personal data stays in this browser's private IndexedDB. */
import {parseYouTubeLink} from './music-links.js?v=3.1.0';

const DB_NAME = 'peragym-local';
const VERSION = 1;
const STORES = ['workouts', 'sessions', 'settings', 'loadHistory', 'bodyWeights'];
let opened;

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
  if (!Array.isArray(input) || input.length > 8) invalid('Salve até 8 links públicos do YouTube ou YouTube Music.');
  return Array.from(input, raw => {
    if (typeof raw !== 'string') invalid('Cada música precisa de um link público válido do YouTube ou YouTube Music.');
    let parsed;
    try { parsed = parseYouTubeLink(raw); } catch { invalid('Um link de música não é um endereço público válido do YouTube ou YouTube Music.'); }
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
function open() {
  if (!opened) opened = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Este navegador não oferece o banco local necessário. Abra no Safari ou Chrome atualizado.'));
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      STORES.forEach(name => {
        const store = db.createObjectStore(name, {keyPath: name === 'settings' ? 'key' : 'id'});
        if (name === 'loadHistory') store.createIndex('exerciseId', 'exerciseId');
        if (name === 'loadHistory' || name === 'bodyWeights') store.createIndex('at', 'at');
      });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {db.close(); opened = null;}; resolve(db);
    };
    request.onerror = () => {opened = null; reject(new Error('Não foi possível abrir o banco local. Verifique se o navegador permite armazenar dados.'));};
    request.onblocked = () => reject(new Error('Feche outras abas do PeraGym e tente novamente.'));
  });
  return opened;
}
async function transact(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode), stores = Object.fromEntries(names.map(n => [n, tx.objectStore(n)]));
    let result, failure;
    const fail = error => {failure = error; tx.abort();};
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(failure || new Error('Não foi possível salvar no aparelho. Verifique o espaço disponível e tente novamente.'));
    try { fn(stores, value => {result = value;}, fail); } catch (error) { fail(error); }
  });
}
export async function load() {
  const all = await transact(STORES, 'readonly', (stores, done) => {
    const result = {}; let pending = STORES.length;
    STORES.forEach(name => {const r = stores[name].getAll(); r.onsuccess = () => {result[name] = r.result; if (!--pending) done(result);};});
  });
  const settings = Object.fromEntries(all.settings.map(row => [row.key, row.value]));
  return {
    workouts: all.workouts.sort((a,b) => a.createdAt - b.createdAt),
    sessions: all.sessions.sort((a,b) => b.completedAt - a.completedAt),
    loadHistory: all.loadHistory.sort((a,b) => a.at - b.at),
    bodyWeights: all.bodyWeights.sort((a,b) => a.at - b.at),
    theme: settings.theme || (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    activeSession: settings.activeSession || null,
    musicLinks: settings.musicLinks === undefined ? [] : validateMusicLinks(settings.musicLinks)
  };
}
export async function saveWorkout(input) {
  const workout = validateWorkout(input), now = Date.now();
  return transact(['workouts','loadHistory'], 'readwrite', (stores, done, fail) => {
    const r = stores.workouts.get(workout.id);
    r.onsuccess = () => {
      try {
        const old = r.result;
        workout.createdAt = old?.createdAt || now; workout.updatedAt = now;
        // An exercise ID belongs to one fiche: reject collisions with a different workout.
        const all = stores.workouts.getAll();
        all.onsuccess = () => {
          const otherIds = new Set(all.result.filter(w => w.id !== workout.id).flatMap(w => w.exercises.map(e => e.id)));
          if (workout.exercises.some(e => otherIds.has(e.id))) return fail(new Error('Um exercício pertence a outra ficha. Adicione-o novamente.'));
          workout.exercises.forEach(e => {
            const previous = old?.exercises.find(x => x.id === e.id);
            if (!previous || previous.weight !== e.weight) stores.loadHistory.add({id:uid(), workoutId:workout.id, workoutName:workout.name, exerciseId:e.id, name:e.name, at:now, value:e.weight});
          });
          stores.workouts.put(workout); done({id:workout.id});
        };
      } catch (e) { fail(e); }
    };
  });
}
export async function deleteWorkout(id) {
  return transact(['workouts','sessions'], 'readwrite', (stores, done) => {
    stores.workouts.delete(id);
    const r = stores.sessions.getAll(); r.onsuccess = () => r.result.filter(s => s.workoutId === id).forEach(s => stores.sessions.put({...s,workoutId:null}));
    done({ok:true}); // Load history intentionally survives fiche deletion.
  });
}
export async function updateWeight(exerciseId, raw) {
  const weight = parseKg(raw);
  return transact(['workouts','loadHistory'], 'readwrite', (stores, done, fail) => {
    const r = stores.workouts.getAll(); r.onsuccess = () => {
      const w = r.result.find(w => w.exercises.some(e => e.id === exerciseId));
      if (!w) return fail(new Error('Exercício não encontrado. Abra a ficha novamente.'));
      const e = w.exercises.find(e => e.id === exerciseId);
      if (e.weight !== weight) {
        e.weight = weight; w.updatedAt = Date.now(); stores.workouts.put(w);
        stores.loadHistory.add({id:uid(),workoutId:w.id,workoutName:w.name,exerciseId:e.id,name:e.name,at:Date.now(),value:weight});
      }
      done({ok:true});
    };
  });
}
export async function finishWorkout(input) {
  const duration = integer(input.duration, 0, 2147483647, 'Tempo de treino inválido.');
  return transact(['workouts','sessions','settings'], 'readwrite', (stores, done, fail) => {
    const r = stores.workouts.get(input.workoutId); r.onsuccess = () => {
      if (!r.result) return fail(new Error('Ficha não encontrada.'));
      const s = {id:uid(),workoutId:r.result.id,workoutName:r.result.name,completedAt:Date.now(),duration};
      stores.sessions.add(s);stores.settings.delete('activeSession');done({id:s.id});
    };
  });
}
export async function setSetting(key, value) {
  if (!['theme','activeSession','musicLinks'].includes(key)) invalid('Preferência inválida.');
  if (key === 'theme' && !['light','dark'].includes(value)) invalid('Tema inválido.');
  if (key === 'musicLinks') value = validateMusicLinks(value);
  return transact(['settings'],'readwrite',(stores,done) => {stores.settings.put({key,value});done({ok:true});});
}
export async function saveBodyWeight(input) {
  const row = validateBodyWeight(input);
  return transact(['bodyWeights'],'readwrite',(stores,done) => {stores.bodyWeights.put(row);done({id:row.id});});
}
export async function deleteBodyWeight(id) {
  return transact(['bodyWeights'],'readwrite',(stores,done) => {stores.bodyWeights.delete(id);done({ok:true});});
}
export async function exportBackup() {
  return {app:'PeraGym',version:1,exportedAt:Date.now(),data:await load()};
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
  const d = validateBackup(raw); // Validate completely before opening a write transaction.
  return transact(STORES,'readwrite',(stores,done) => {
    STORES.forEach(name => stores[name].clear());
    ['workouts','sessions','loadHistory','bodyWeights'].forEach(name => d[name].forEach(row => stores[name].add(row)));
    stores.settings.put({key:'theme',value:d.theme});
    stores.settings.put({key:'musicLinks',value:d.musicLinks});done({ok:true});
  });
}
