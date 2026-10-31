import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYouTubeLink, makeEmbedUrl, parseMusicLink, makeSpotifyEmbedUrl} from './music-links.js';

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

const SPOTIFY='0Lr4kGOYn9l83EjuK6cZFQ';

test('generic music parsing preserves YouTube contracts and adds only the provider discriminator',()=>{
  for(const raw of [`https://youtu.be/${VIDEO}`,`https://music.youtube.com/playlist?list=${PLAYLIST}`]){
    assert.deepEqual(parseMusicLink(raw),{provider:'youtube',...parseYouTubeLink(raw)});
    assert.equal(makeEmbedUrl(parseMusicLink(raw),'https://peragym.example'),makeEmbedUrl(parseYouTubeLink(raw),'https://peragym.example'));
  }
});

test('Spotify tracks, playlists and albums normalize HTTPS/locale links and URIs without retaining tracking',()=>{
  for(const [kind,label] of [['track','faixa'],['playlist','playlist'],['album','álbum']]){
    const expected={provider:'spotify',kind,id:SPOTIFY,uri:`spotify:${kind}:${SPOTIFY}`,url:`https://open.spotify.com/${kind}/${SPOTIFY}`,label:`Spotify · ${label} · ${SPOTIFY}`};
    for(const raw of [
      `https://open.spotify.com/${kind}/${SPOTIFY}`,
      ` https://OPEN.SPOTIFY.COM/intl-pt/${kind}/${SPOTIFY}/?si=share&utm_source=copy#fragment `,
      `https://open.spotify.com/intl-en/${kind}/${SPOTIFY}?si=a&si=b`,
      `spotify:${kind}:${SPOTIFY}`
    ])assert.deepEqual(parseMusicLink(raw),expected,raw);
  }
});

test('Spotify short links require the complete official link and are not resolved through the network',()=>{
  const original=globalThis.fetch;
  globalThis.fetch=()=>{assert.fail('Music link parsing must never make a network request');};
  try {
    for(const raw of ['https://spotify.link/shortcode','https://www.spotify.link/shortcode'])assert.throws(()=>parseMusicLink(raw),/link completo de open\.spotify\.com/);
    assert.equal(parseMusicLink(`spotify:track:${SPOTIFY}`).id,SPOTIFY);
  } finally {globalThis.fetch=original;}
});

test('Spotify parser rejects credentials, suffix/encoded hosts, every explicit port and unsafe schemes',()=>{
  for(const raw of [
    `https://open.spotify.com.evil.example/track/${SPOTIFY}`,
    `https://www.open.spotify.com/track/${SPOTIFY}`,
    `https://spotify.com/track/${SPOTIFY}`,
    `https://open%2Espotify.com/track/${SPOTIFY}`,
    `https://%6fpen.spotify.com/track/${SPOTIFY}`,
    `https://user:password@open.spotify.com/track/${SPOTIFY}`,
    `https://@open.spotify.com/track/${SPOTIFY}`,
    `https://:@open.spotify.com/track/${SPOTIFY}`,
    `https://open.spotify.com@evil.example/track/${SPOTIFY}`,
    `https://open.spotify.com:443/track/${SPOTIFY}`,
    `https://open.spotify.com:80/track/${SPOTIFY}`,
    `https://open.spotify.com:8080/track/${SPOTIFY}`,
    `http://open.spotify.com/track/${SPOTIFY}`,
    `ftp://open.spotify.com/track/${SPOTIFY}`,
    `//open.spotify.com/track/${SPOTIFY}`,
    `javascript:open('https://open.spotify.com/track/${SPOTIFY}')`,
    `data:text/plain,spotify:track:${SPOTIFY}`
  ])assert.throws(()=>parseMusicLink(raw),Error,raw);
});

test('Spotify parser rejects malformed IDs, unsupported kinds and ambiguous or normalized paths',()=>{
  for(const id of [SPOTIFY.slice(1),SPOTIFY+'x','_'.repeat(22),'-'.repeat(22),'á'.repeat(22),'%30'+SPOTIFY.slice(1)]){
    assert.throws(()=>parseMusicLink(`https://open.spotify.com/track/${id}`));
    assert.throws(()=>parseMusicLink(`spotify:track:${id}`));
  }
  for(const path of [
    `track/track/${SPOTIFY}`,`track/${SPOTIFY}/extra`,`track/${SPOTIFY}//`,
    `intl-en/intl-pt/track/${SPOTIFY}`,`intl-pt-BR/track/${SPOTIFY}`,
    `./track/${SPOTIFY}`,`album/../track/${SPOTIFY}`,`intl-en/%2e%2e/track/${SPOTIFY}`,
    `/track/${SPOTIFY}`,`embed/track/${SPOTIFY}`,`artist/${SPOTIFY}`,`episode/${SPOTIFY}`
  ])assert.throws(()=>parseMusicLink(`https://open.spotify.com/${path}`),Error,path);
  for(const raw of [
    `spotify:show:${SPOTIFY}`,`spotify://track/${SPOTIFY}`,`spotify:track:${SPOTIFY}?si=share`,
    `<iframe src="https://open.spotify.com/embed/track/${SPOTIFY}"></iframe>`,
    `https://open.spotify.com/track/${SPOTIFY}?html=%3Cscript%3E`,
    `https://open.spoti\nfy.com/track/${SPOTIFY}`,
    `https:\\open.spotify.com\\track\\${SPOTIFY}`,
    `https://open.spotify.com/track/${SPOTIFY}?si=${'x'.repeat(2048)}`,
    '',null,123
  ])assert.throws(()=>parseMusicLink(raw),Error,String(raw));
});

test('Spotify embed URLs use checked kinds and IDs, fixed origin and theme, never supplied HTML/URLs',()=>{
  for(const kind of ['track','playlist','album']){
    const media=parseMusicLink(`spotify:${kind}:${SPOTIFY}`);
    const url=new URL(makeSpotifyEmbedUrl({...media,url:'javascript:alert(1)',uri:'spotify:track:bad',html:'<iframe>'}));
    assert.equal(url.origin,'https://open.spotify.com');assert.equal(url.pathname,`/embed/${kind}/${SPOTIFY}`);
    assert.deepEqual(Object.fromEntries(url.searchParams),{theme:'0'});
    assert.equal(makeSpotifyEmbedUrl({kind,id:SPOTIFY}),url.toString());
  }
  for(const media of [null,[],{},'<iframe>',{provider:'youtube',kind:'track',id:SPOTIFY},
    {kind:'episode',id:SPOTIFY},{kind:'track',id:'bad-id'},{kind:'track',id:SPOTIFY+'/path'},
    {kind:'track',id:'<script>'},{kind:'track',url:`https://open.spotify.com/track/${SPOTIFY}`}])assert.throws(()=>makeSpotifyEmbedUrl(media));
});
