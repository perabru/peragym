import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYouTubeLink, makeEmbedUrl} from './music-links.js';

const VIDEO='dQw4w9WgXcQ';
const PLAYLIST='PLabcDEF_1234567890-xyz';

test('YouTube Music share links normalize to one safe video and drop tracking and mix lists',()=>{
  assert.deepEqual(parseYouTubeLink(` https://music.youtube.com/watch?v=${VIDEO}&list=RDAMVM${VIDEO}&si=tracking&t=42 `),{
    kind:'video',videoId:VIDEO,listId:null,url:`https://music.youtube.com/watch?v=${VIDEO}`,label:`Música · ${VIDEO}`
  });
});

test('accepted YouTube host variants and short/share formats normalize consistently',()=>{
  for(const raw of [
    `http://youtube.com:80/watch?v=${VIDEO}`,
    `https://WWW.YOUTUBE.COM:443/watch?v=${VIDEO}&feature=shared`,
    `https://m.youtube.com/watch?v=${VIDEO}`,
    `https://youtu.be/${VIDEO}?si=shared&list=WL`,
    `https://music.youtube.com/shorts/${VIDEO}/?feature=share`,
    `https://www.youtube.com/embed/${VIDEO}?list=${PLAYLIST}`
  ]) assert.deepEqual(parseYouTubeLink(raw),parseYouTubeLink(`https://music.youtube.com/watch?v=${VIDEO}`));
});

test('public playlist and playlist embed links produce canonical playlist records',()=>{
  const expected={kind:'playlist',videoId:null,listId:PLAYLIST,url:`https://music.youtube.com/playlist?list=${PLAYLIST}`,label:`Playlist · ${PLAYLIST}`};
  for(const raw of [
    `https://music.youtube.com/playlist?list=${PLAYLIST}&si=share`,
    `https://www.youtube.com/playlist/?list=${PLAYLIST}`,
    `https://youtube.com/watch?list=${PLAYLIST}`,
    `https://www.youtube.com/embed/videoseries?list=${PLAYLIST}`
  ])assert.deepEqual(parseYouTubeLink(raw),expected);
  assert.equal(parseYouTubeLink('https://music.youtube.com/playlist?list=OLAK5uy_a12345678').kind,'playlist');
});

test('special personal playlists and automatic mixes fail with a clear explanation',()=>{
  for(const id of ['LM','WL'])assert.throws(()=>parseYouTubeLink(`https://music.youtube.com/playlist?list=${id}`),/pessoais/);
  for(const id of ['RD'+VIDEO,'RDAMVM'+VIDEO])assert.throws(()=>parseYouTubeLink(`https://music.youtube.com/playlist?list=${id}`),/Mixes automáticos/);
  assert.equal(parseYouTubeLink(`https://music.youtube.com/watch?v=${VIDEO}&list=WL`).kind,'video');
});

test('rejects unrelated/suffix hosts, userinfo, uncommon ports and unsupported protocols',()=>{
  for(const raw of [
    `https://youtube.com.evil.example/watch?v=${VIDEO}`,
    `https://evil.youtube.com/watch?v=${VIDEO}`,
    `https://www.youtu.be/${VIDEO}`,
    `https://youtube.com./watch?v=${VIDEO}`,
    `https://user:pass@youtube.com/watch?v=${VIDEO}`,
    `https://@youtube.com/watch?v=${VIDEO}`,
    `https://:@youtube.com/watch?v=${VIDEO}`,
    `https://youtube.com@evil.example/watch?v=${VIDEO}`,
    `https://youtube.com:8080/watch?v=${VIDEO}`,
    `javascript:alert('${VIDEO}')`,
    `data:text/plain,${VIDEO}`,
    `ftp://youtube.com/watch?v=${VIDEO}`,
    `//youtube.com/watch?v=${VIDEO}`,
    `#${VIDEO}`
  ])assert.throws(()=>parseYouTubeLink(raw),Error,raw);
});

test('rejects HTML/control content, excess length and malformed video IDs and paths',()=>{
  for(const raw of [
    `<iframe src="https://youtube.com/embed/${VIDEO}"></iframe>`,
    `https://youtube.com/watch?v=${VIDEO}&html=%3Cscript%3E`,
    `https://you\ntube.com/watch?v=${VIDEO}`,
    `https:\\youtube.com\\watch?v=${VIDEO}`,
    `https://youtube.com/watch?v=${VIDEO}&si=${'a'.repeat(2048)}`,
    'https://youtube.com/watch?v=short',
    `https://youtube.com/watch?v=${VIDEO}x`,
    'https://youtube.com/watch?v=áQw4w9WgXcQ',
    `https://youtu.be/${VIDEO}/extra`,
    `https://youtube.com/shorts/${VIDEO}/extra`,
    `https://youtube.com/live/${VIDEO}`,
    'https://youtube.com/watch?v=',
    'https://youtube.com/',
    '',null,42
  ])assert.throws(()=>parseYouTubeLink(raw),Error,String(raw));
});

test('playlist IDs have safe characters and exact length limits; ambiguous IDs are rejected',()=>{
  for(const id of ['1234567','A'.repeat(151),'bad.id123','bad id123'])assert.throws(()=>parseYouTubeLink(`https://youtube.com/playlist?list=${encodeURIComponent(id)}`));
  for(const id of ['A'.repeat(8),'A'.repeat(150)])assert.equal(parseYouTubeLink(`https://youtube.com/playlist?list=${id}`).listId,id);
  assert.throws(()=>parseYouTubeLink(`https://youtube.com/watch?v=${VIDEO}&v=${VIDEO}`),/repetidos/);
  assert.throws(()=>parseYouTubeLink(`https://youtube.com/playlist?list=${PLAYLIST}&list=${PLAYLIST}`),/repetidos/);
});

test('video embeds use only the validated video and safe playback parameters',()=>{
  const media=parseYouTubeLink(`https://music.youtube.com/watch?v=${VIDEO}&list=RDAMVM${VIDEO}`);
  const url=new URL(makeEmbedUrl({...media,listId:'RDunsafe',url:'javascript:alert(1)'},'https://peragym.example'));
  assert.equal(url.origin,'https://www.youtube.com');assert.equal(url.pathname,`/embed/${VIDEO}`);
  assert.equal(url.searchParams.has('list'),false);
  assert.deepEqual(Object.fromEntries(url.searchParams),{enablejsapi:'1',origin:'https://peragym.example',playsinline:'1',autoplay:'0',rel:'0'});
});

test('playlist embeds preserve only the safe playlist ID and accept a valid local HTTP origin',()=>{
  const url=new URL(makeEmbedUrl(parseYouTubeLink(`https://youtube.com/playlist?list=${PLAYLIST}`),'http://localhost:5173/'));
  assert.equal(url.pathname,'/embed/videoseries');assert.equal(url.searchParams.get('list'),PLAYLIST);
  assert.equal(url.searchParams.get('origin'),'http://localhost:5173');
  assert.equal(url.searchParams.get('enablejsapi'),'1');assert.equal(url.searchParams.get('playsinline'),'1');
});

test('embed builders revalidate IDs and prevent origin injection or non-origin values',()=>{
  for(const origin of [
    'javascript:alert(1)','data:text/html,test','https://user:pass@safe.example','https://@safe.example',
    'https://safe.example/path','https://safe.example?other=1','https://safe.example#fragment',
    'https://safe.example"><script>','https://safe.example\n.evil.example','',null
  ])assert.throws(()=>makeEmbedUrl(parseYouTubeLink(`https://youtu.be/${VIDEO}`),origin),Error,String(origin));
  assert.throws(()=>makeEmbedUrl({kind:'video',videoId:'bad"id'},'https://safe.example'));
  assert.throws(()=>makeEmbedUrl({kind:'playlist',listId:'WL'},'https://safe.example'));
  assert.throws(()=>makeEmbedUrl({kind:'playlist',listId:'RDAMVM'+VIDEO},'https://safe.example'));
  assert.throws(()=>makeEmbedUrl({kind:'html',url:'https://safe.example'},'https://safe.example'));
});
