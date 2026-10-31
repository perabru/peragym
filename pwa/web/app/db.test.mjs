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
test('music preference defaults empty and stores only canonical public URLs',async()=>{
 assert.deepEqual((await db.load()).musicLinks,[]);
 const links=['https://youtu.be/dQw4w9WgXcQ?si=share','https://www.youtube.com/playlist?list=PLabcdefghijk123456'];
 await db.setSetting('musicLinks',links);
 assert.deepEqual((await db.load()).musicLinks,[
  'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://music.youtube.com/playlist?list=PLabcdefghijk123456'
 ]);
 // Normalize into a new array rather than changing the caller's values.
 assert.equal(links[0],'https://youtu.be/dQw4w9WgXcQ?si=share');
 const backup=await db.exportBackup();
 assert.deepEqual(backup.data.musicLinks,(await db.load()).musicLinks);
 await db.setSetting('musicLinks',[]);
 const withSourceLinks=structuredClone(backup);withSourceLinks.data.musicLinks=links;
 await db.importBackup(withSourceLinks);
 assert.deepEqual((await db.load()).musicLinks,backup.data.musicLinks);
});
test('invalid music preferences reject before changing any local records',async()=>{
 const before=await db.load();
 const valid='https://music.youtube.com/watch?v=dQw4w9WgXcQ';
 for(const links of [undefined,null,valid,{},[null],[123],[{}],Array(2),Array(9).fill(valid),
  ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
  ['javascript:alert(1)'],['https://example.com/watch?v=dQw4w9WgXcQ'],
  ['https://user:password@youtube.com/watch?v=dQw4w9WgXcQ']]) {
  await assert.rejects(()=>db.setSetting('musicLinks',links));
  assert.deepEqual(await db.load(),before);
 }
 await assert.rejects(()=>db.setSetting('musicAccount','person@example.com'));
 assert.deepEqual(await db.load(),before);
});
test('legacy v1 backups default music links empty and invalid music import is atomic',async()=>{
 const backup=await db.exportBackup();
 const before=await db.load();
 for(const links of [null,'https://youtu.be/dQw4w9WgXcQ',[false],Array(9).fill('https://youtu.be/dQw4w9WgXcQ'),
  ['https://music.youtube.com.evil.example/watch?v=dQw4w9WgXcQ']]) {
  const invalid=structuredClone(backup);invalid.data.musicLinks=links;
  // Other changes in an invalid import must not replace real local data.
  invalid.data.workouts=[];invalid.data.bodyWeights=[];invalid.data.theme='light';
  await assert.rejects(()=>db.importBackup(invalid));
  assert.deepEqual(await db.load(),before);
 }
 const legacy=structuredClone(backup);delete legacy.data.musicLinks;
 assert.deepEqual(db.validateBackup(legacy).musicLinks,[]);
 await db.importBackup(legacy);
 const restored=await db.load();
 assert.deepEqual(restored.musicLinks,[]);
 assert.deepEqual(restored.workouts,before.workouts);
 assert.deepEqual(restored.sessions,before.sessions);
 assert.deepEqual(restored.bodyWeights,before.bodyWeights);
 assert.deepEqual(restored.loadHistory,before.loadHistory);
 assert.equal(restored.theme,before.theme);
});

test('Spotify and YouTube links round-trip as canonical URL strings in unchanged backup v1',async()=>{
 const id='0Lr4kGOYn9l83EjuK6cZFQ';
 const source=[`spotify:track:${id}`,`https://open.spotify.com/intl-pt/playlist/${id}?si=share`,
  `https://open.spotify.com/album/${id}/#shared`,'https://youtu.be/dQw4w9WgXcQ?si=share'];
 const expected=[`https://open.spotify.com/track/${id}`,`https://open.spotify.com/playlist/${id}`,
  `https://open.spotify.com/album/${id}`,'https://music.youtube.com/watch?v=dQw4w9WgXcQ'];
 await db.setSetting('musicLinks',source);
 assert.deepEqual((await db.load()).musicLinks,expected);
 assert.equal(source[0],`spotify:track:${id}`);
 const backup=await db.exportBackup();assert.equal(backup.version,1);assert.deepEqual(backup.data.musicLinks,expected);
 await db.setSetting('musicLinks',[]);await db.importBackup(backup);
 assert.deepEqual((await db.load()).musicLinks,expected);
 const rawBackup=structuredClone(backup);rawBackup.data.musicLinks=source;
 await db.importBackup(rawBackup);assert.deepEqual((await db.load()).musicLinks,expected);
});

test('invalid Spotify preferences and imports leave all existing IndexedDB data unchanged',async()=>{
 const id='0Lr4kGOYn9l83EjuK6cZFQ';
 const before=await db.load();const backup=await db.exportBackup();
 for(const links of [
  [`spotify:episode:${id}`],[`https://open.spotify.com:443/track/${id}`],
  [`https://open.spotify.com.evil.example/track/${id}`],['https://spotify.link/shortcode'],
  [`spotify:track:${id.slice(1)}`],Array(9).fill(`spotify:track:${id}`),
  ['https://youtu.be/dQw4w9WgXcQ',`https://open.spotify.com/track/${id}/extra`]
 ]){
  await assert.rejects(()=>db.setSetting('musicLinks',links));assert.deepEqual(await db.load(),before);
  const corrupted=structuredClone(backup);corrupted.data.musicLinks=links;
  corrupted.data.workouts=[];corrupted.data.bodyWeights=[];corrupted.data.theme='light';
  await assert.rejects(()=>db.importBackup(corrupted));assert.deepEqual(await db.load(),before);
 }
 await db.setSetting('musicLinks',Array(8).fill(`spotify:track:${id}`));
 assert.equal((await db.load()).musicLinks.length,8);
 const legacy=structuredClone(backup);delete legacy.data.musicLinks;await db.importBackup(legacy);
 assert.deepEqual((await db.load()).musicLinks,[]);
 assert.deepEqual((await db.load()).bodyWeights,before.bodyWeights);
});
