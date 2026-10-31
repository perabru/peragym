import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,normalizeSession,elapsedSeconds,pauseSession,resumeSession,restartSession} from './workout-session.js';

test('creates a running empty session at the exact supplied clock, including epoch zero',()=>{
  assert.deepEqual(createSession('workout-1',0),{id:'workout-1',startedAt:0,done:[],pausedAt:null,pausedMs:0});
  assert.equal(elapsedSeconds(createSession('workout-1',1000),2999),1);
  assert.equal(elapsedSeconds(createSession('workout-1',1000),3000),2);
});

test('legacy saved sessions normalize pause defaults and safely deduplicate completed exercises',()=>{
  const legacy={id:'workout-1',startedAt:1000,done:['exercise-a','exercise-a','exercise-b']};
  const normalized=normalizeSession(legacy,6000);
  assert.deepEqual(normalized,{id:'workout-1',startedAt:1000,done:['exercise-a','exercise-b'],pausedAt:null,pausedMs:0});
  assert.equal(elapsedSeconds(normalized,6000),5);
  assert.notEqual(normalized,legacy);assert.notEqual(normalized.done,legacy.done);
  assert.equal('pausedAt' in legacy,false);assert.deepEqual(legacy.done,['exercise-a','exercise-a','exercise-b']);
});

test('pausing freezes elapsed time and resuming excludes the complete pause interval',()=>{
  const running=createSession('workout-1',1000),paused=pauseSession(running,6500);
  assert.equal(elapsedSeconds(paused,7000),5);assert.equal(elapsedSeconds(paused,100_000),5);
  const resumed=resumeSession(paused,20_000);
  assert.equal(resumed.pausedMs,13_500);assert.equal(resumed.pausedAt,null);
  assert.equal(elapsedSeconds(resumed,21_000),6);
  assert.equal(running.pausedAt,null);assert.equal(paused.pausedAt,6500);
});

test('repeated pause or resume calls are idempotent and return independent clones',()=>{
  const paused=pauseSession(createSession('workout-1',0),5000);
  const pausedAgain=pauseSession(paused,15_000);
  assert.deepEqual(pausedAgain,paused);assert.notEqual(pausedAgain,paused);assert.notEqual(pausedAgain.done,paused.done);
  const resumed=resumeSession(paused,20_000),resumedAgain=resumeSession(resumed,25_000);
  assert.deepEqual(resumedAgain,resumed);assert.notEqual(resumedAgain,resumed);assert.notEqual(resumedAgain.done,resumed.done);
  assert.equal(resumedAgain.pausedMs,15_000);
});

test('multiple pause cycles accumulate only paused milliseconds and retain completed exercises',()=>{
  let state={...createSession('workout-1',0),done:['exercise-a']};
  state=pauseSession(state,10_000);state=resumeSession(state,15_000);
  state=pauseSession(state,23_000);state=resumeSession(state,35_000);
  assert.equal(state.pausedMs,17_000);assert.equal(elapsedSeconds(state,40_000),23);
  assert.deepEqual(state.done,['exercise-a']);
});

test('a persisted paused session remains paused after reload or login much later',()=>{
  const persisted=JSON.parse(JSON.stringify(pauseSession(createSession('workout-1',1000),7000)));
  const reloaded=normalizeSession(persisted,86_400_000);
  assert.equal(reloaded.pausedAt,7000);assert.equal(elapsedSeconds(reloaded,86_400_000),6);
  const resumed=resumeSession(reloaded,86_400_000);
  assert.equal(elapsedSeconds(resumed,86_402_000),8);
});

test('restarting a running or paused session preserves the workout ID and resets progress and clock',()=>{
  const running={...createSession('workout-1',1000),done:['exercise-a']};
  const paused=pauseSession(running,5000);
  for(const previous of [running,paused]){
    const restarted=restartSession(previous,20_000);
    assert.deepEqual(restarted,{id:'workout-1',startedAt:20_000,done:[],pausedAt:null,pausedMs:0});
    assert.equal(elapsedSeconds(restarted,21_000),1);
  }
  assert.deepEqual(running.done,['exercise-a']);assert.equal(paused.pausedAt,5000);
});

test('zero-duration pauses and an immediate restart remain valid',()=>{
  const started=createSession('workout-1',0),paused=pauseSession(started,0),resumed=resumeSession(paused,0);
  assert.equal(paused.pausedAt,0);assert.equal(elapsedSeconds(paused,90_000),0);
  assert.deepEqual(resumed,started);assert.deepEqual(restartSession(paused,0),started);
});

test('normalization rejects invalid IDs, timestamps, future states and impossible pause totals',()=>{
  const valid=createSession('workout-1',1000);
  for(const state of [null,[],{}, {...valid,id:''},{...valid,id:1},{...valid,id:'bad id'},
    {...valid,startedAt:NaN},{...valid,startedAt:Infinity},{...valid,startedAt:-1},{...valid,startedAt:1000.5},
    {...valid,startedAt:6000},{...valid,pausedAt:999},{...valid,pausedAt:6000},
    {...valid,pausedMs:-1},{...valid,pausedMs:4001},{...valid,pausedMs:NaN},
    {...valid,pausedAt:2000,pausedMs:1001},{...valid,done:null},{...valid,done:['valid','bad id']}]){
    assert.equal(normalizeSession(state,5000),null,JSON.stringify(state));
  }
  for(const clock of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(normalizeSession(valid,clock),null);
});

test('backward clocks cannot make elapsed negative or perform an invalid transition',()=>{
  const state=createSession('workout-1',10_000);
  assert.equal(elapsedSeconds(state,9000),0);assert.equal(normalizeSession(state,9000),null);
  for(const transition of [pauseSession,resumeSession,restartSession])assert.throws(()=>transition(state,9000),Error);
  for(const id of ['',123,'bad id'])assert.throws(()=>createSession(id,0),Error);
  assert.throws(()=>createSession('workout-1',-1),Error);
  assert.equal(elapsedSeconds({startedAt:0},1000),0);
});
