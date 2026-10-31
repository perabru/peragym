import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import * as db from './db.js';
const require=createRequire(import.meta.url);
// Run with fake-indexeddb installed in the project, or provide its absolute entry point.
const fake=require(process.env.PERAGYM_FAKE_IDB||'fake-indexeddb');
globalThis.indexedDB=fake.indexedDB;
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const input = () => ({name:'Treino A',focus:'Peito',days:'Segunda',notes:'',exercises:[{name:'Supino',sets:3,reps:'8–12',weight:'12,5',rest:60}]});
test('validates kg, rejects invalid precision, blanks, NaN and unsafe bounds',()=>{
 assert.equal(db.parseKg('12,75'),12.75);assert.equal(db.parseKg(0),0);
 for(const n of ['',-1,'1e2','1.222','NaN','Infinity',2001])assert.throws(()=>db.parseKg(n));
 assert.throws(()=>db.validateWorkout({...input(),name:' '}));
 const w=input();w.exercises[0].sets=2.5;assert.throws(()=>db.validateWorkout(w));
 assert.throws(()=>db.validateBodyWeight({value:70,at:Date.now()+120000}));
});
test('IndexedDB preserves records, UUID identity and exact changes without duplicate history',async()=>{
 assert.equal((await db.load()).workouts.length,0);
 const saved=await db.saveWorkout(input());let d=await db.load();
 assert.equal(d.workouts.length,1);assert.equal(d.loadHistory.length,1);
 const w=d.workouts[0],id=w.exercises[0].id;assert.equal(w.id,saved.id);assert.equal(w.exercises[0].weight,12.5);
 w.name='Treino atualizado';await db.saveWorkout(w);d=await db.load();
 assert.equal(d.workouts[0].exercises[0].id,id);assert.equal(d.loadHistory.length,1);
 await db.updateWeight(id,15.25);await db.updateWeight(id,15.25);d=await db.load();
 assert.equal(d.loadHistory.length,2);assert.equal(d.workouts[0].exercises[0].weight,15.25);
 const invalid=structuredClone(d.workouts[0]);invalid.exercises[0].weight=-1;
 await assert.rejects(()=>db.saveWorkout(invalid));assert.equal((await db.load()).workouts[0].exercises[0].weight,15.25);
 await db.setSetting('theme','dark');await db.setSetting('activeSession',{id:w.id,startedAt:Date.now(),done:[]});
 d=await db.load();assert.equal(d.theme,'dark');assert.equal(d.activeSession.id,w.id);
 await db.finishWorkout({workoutId:w.id,duration:120});await db.deleteWorkout(w.id);d=await db.load();
 assert.equal(d.workouts.length,0);assert.equal(d.sessions.length,1);assert.equal(d.sessions[0].workoutId,null);
 assert.equal(d.loadHistory.length,2);assert.equal(d.activeSession,null);
});
test('body weight edit/delete and atomic backup validation and replacement',async()=>{
 const saved=await db.saveBodyWeight({value:'72,5',at:Date.now()-1000,notes:'Registro'});
 await db.saveBodyWeight({id:saved.id,value:'72,25',at:Date.now()-1000});let d=await db.load();
 assert.equal(d.bodyWeights.length,1);assert.equal(d.bodyWeights[0].value,72.25);
 const backup=await db.exportBackup();const corrupted=structuredClone(backup);corrupted.data.bodyWeights[0].value=-10;
 await assert.rejects(()=>db.importBackup(corrupted));assert.equal((await db.load()).bodyWeights[0].value,72.25);
 await db.deleteBodyWeight(saved.id);assert.equal((await db.load()).bodyWeights.length,0);
 await db.importBackup(backup);d=await db.load();assert.equal(d.bodyWeights.length,1);assert.equal(d.theme,'dark');assert.equal(d.sessions.length,1);
});
