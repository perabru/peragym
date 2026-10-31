/** Pure workout-clock transitions. Persistence and history belong to the caller. */
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value);
const milliseconds=value=>Number.isSafeInteger(value)&&value>=0;
const invalid=()=>{throw new Error('O estado ou horário deste treino é inválido. Abra a ficha e comece novamente.');};

export function createSession(workoutId,now=Date.now()) {
  if(!validId(workoutId)||!milliseconds(now))return invalid();
  return {id:workoutId,startedAt:now,done:[],pausedAt:null,pausedMs:0};
}

/** Older saved sessions have no pause fields; they remain running sessions. */
export function normalizeSession(saved,now=Date.now()) {
  if(!milliseconds(now)||!saved||typeof saved!=='object'||Array.isArray(saved)||!validId(saved.id)
    ||!milliseconds(saved.startedAt)||saved.startedAt>now||!Array.isArray(saved.done)||!saved.done.every(validId))return null;
  const pausedAt=saved.pausedAt===undefined?null:saved.pausedAt;
  const pausedMs=saved.pausedMs===undefined?0:saved.pausedMs;
  if(!milliseconds(pausedMs)||(pausedAt!==null&&(!milliseconds(pausedAt)||pausedAt<saved.startedAt||pausedAt>now)))return null;
  const end=pausedAt===null?now:pausedAt;
  if(pausedMs>end-saved.startedAt)return null;
  return {id:saved.id,startedAt:saved.startedAt,done:[...new Set(saved.done)],pausedAt,pausedMs};
}

export function elapsedSeconds(state,now=Date.now()) {
  const normalized=normalizeSession(state,now);
  if(!normalized)return 0;
  return Math.floor(Math.max(0,(normalized.pausedAt??now)-normalized.startedAt-normalized.pausedMs)/1000);
}

export function pauseSession(state,now=Date.now()) {
  const normalized=normalizeSession(state,now);
  if(!normalized)return invalid();
  return normalized.pausedAt===null?{...normalized,pausedAt:now}:normalized;
}

export function resumeSession(state,now=Date.now()) {
  const normalized=normalizeSession(state,now);
  if(!normalized)return invalid();
  if(normalized.pausedAt===null)return normalized;
  return {...normalized,pausedMs:normalized.pausedMs+(now-normalized.pausedAt),pausedAt:null};
}

export function restartSession(state,now=Date.now()) {
  const normalized=normalizeSession(state,now);
  if(!normalized)return invalid();
  return createSession(normalized.id,now);
}
