import {makeEmbedUrl,makeSpotifyEmbedUrl} from './music-links.js?v=3.6.0';
import {createSpotifyPlayback} from './spotify-playback.js?v=3.6.0';

let youtubePromise;
function youtubeApi(){
  if(window.YT?.Player)return Promise.resolve(window.YT);
  if(youtubePromise)return youtubePromise;
  youtubePromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    const previous=window.onYouTubeIframeAPIReady;
    const timeout=setTimeout(()=>reject(new Error('O controle do YouTube não carregou.')),12000);
    window.onYouTubeIframeAPIReady=()=>{clearTimeout(timeout);if(typeof previous==='function')previous();resolve(window.YT);};
    script.src='https://www.youtube.com/iframe_api';script.async=true;
    script.onerror=()=>{clearTimeout(timeout);reject(new Error('O controle do YouTube não carregou.'));};
    document.head.append(script);
  }).catch(error=>{youtubePromise=undefined;throw error;});
  return youtubePromise;
}
const clock=ms=>{const n=Math.max(0,Math.floor(Number(ms||0)/1000));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};

export function createMusicPlayer(mount,options={}){
  const $=selector=>mount.querySelector(selector);
  const status=$('[data-music-status]'),host=$('[data-music-frame]'),source=$('[data-music-source]');
  const controls=$('[data-music-controls]'),now=$('[data-music-now]'),name=$('[data-music-provider]');
  let youtube,spotify,media,ready=false,generation=0,stallTimer,tickTimer,modalOpen=false;
  let state={paused:true,position:0,duration:0};
  const obscured=()=>document.hidden||!!document.querySelector('dialog[open]:not(#operation-loading)');
  const fits=()=>window.innerHeight>=280&&window.innerWidth>=(window.innerHeight<=520?420:240);
  const setStatus=(message,busy=false)=>{status.textContent=message;status.classList.toggle('is-loading',busy);};
  function update(next){
    state={...state,...next};
    $('[data-music-toggle]').textContent=state.paused?'▶':'Ⅱ';
    $('[data-music-toggle]').setAttribute('aria-label',state.paused?'Reproduzir':'Pausar');
    $('[data-music-position]').textContent=clock(state.position);
    $('[data-music-duration]').textContent=clock(state.duration);
    const seek=$('[data-music-seek]');seek.max=String(Math.max(1,state.duration||1));
    if(document.activeElement!==seek)seek.value=String(Math.min(state.position||0,state.duration||0));
    seek.disabled=!ready||!state.duration;
    if(next.title)$('[data-track-title]').textContent=next.title;
    if(next.artist)$('[data-track-artist]').textContent=next.artist;
    if(next.image){
      const image=$('[data-track-image]');
      try{const url=new URL(next.image);if(url.protocol==='https:'&&(url.hostname==='i.scdn.co'||url.hostname.endsWith('.scdn.co'))){image.src=url.href;image.hidden=false;}}catch(_){}
    }
  }
  function transport(enabled,skip=false){
    controls.hidden=!enabled;
    $('[data-music-previous]').disabled=!skip;
    $('[data-music-next]').disabled=!skip;
    $('[data-music-volume]').disabled=!enabled;
  }
  function destroy(){
    generation++;clearTimeout(stallTimer);clearInterval(tickTimer);
    try{youtube?.destroy();}catch(_){}
    spotify?.disconnect();youtube=undefined;spotify=undefined;
    ready=false;host.replaceChildren();transport(false);now.hidden=true;host.hidden=false;
    const image=$('[data-track-image]');image.removeAttribute('src');image.hidden=true;
    update({paused:true,position:0,duration:0});
  }
  function close(){destroy();media=undefined;mount.hidden=true;state={paused:true,position:0,duration:0};source.removeAttribute('href');source.textContent='Abrir no serviço ↗';$('[data-track-title]').textContent='';$('[data-track-artist]').textContent='';const image=$('[data-track-image]');image.removeAttribute('src');image.hidden=true;name.textContent='player';setStatus('');document.body.classList.remove('music-active');}
  function openAccount(provider,profile){
    destroy();media=undefined;state={paused:true,position:0,duration:0};
    mount.hidden=false;document.body.classList.add('music-active');host.hidden=true;now.hidden=false;
    name.textContent=provider==='spotify'?'Spotify':'YouTube';
    source.href=provider==='spotify'?'https://open.spotify.com/':'https://music.youtube.com/';
    source.textContent=provider==='spotify'?'Abrir no Spotify ↗':'Abrir no YouTube Music ↗';
    $('[data-track-title]').textContent='Conta conectada';$('[data-track-artist]').textContent=profile?.displayName||'Escolha uma música';
    setStatus('Carregando suas playlists…',true);
  }
  function pause(){
    if(!media)return;
    if(!ready){close();return;}
    clearTimeout(stallTimer);clearInterval(tickTimer);
    try{
      if(youtube)youtube.pauseVideo();
      else if(spotify)void spotify.pause().catch(()=>close());
      else{close();return;}
      setStatus('Pausado. Toque no play para continuar.');
    }catch(_){close();}
  }
  function iframe(url,title,provider){
    const element=document.createElement('iframe');element.id='peragym-service-player';element.title=title;
    element.width='400';element.height=provider==='spotify'?'152':'225';
    element.referrerPolicy='strict-origin-when-cross-origin';element.allow='autoplay; encrypted-media; fullscreen; clipboard-write';
    element.allowFullscreen=true;element.src=url;host.dataset.provider=provider;host.replaceChildren(element);return element;
  }
  async function load(next){
    if(!fits())throw new Error('Aumente a janela ou gire o aparelho para exibir o player.');
    if(!navigator.onLine)throw new Error('Conecte-se à internet para ouvir música.');
    destroy();media=next;const current=generation;
    mount.hidden=false;document.body.classList.add('music-active');source.href=next.url;
    source.textContent=next.provider==='spotify'?'Abrir no Spotify ↗':'Abrir no YouTube Music ↗';
    name.textContent=next.provider==='spotify'?'Spotify':'YouTube';
    $('[data-track-title]').textContent='Preparando player...';$('[data-track-artist]').textContent='PeraGym';
    const account=options.account?.();
    if(next.provider==='spotify'&&account?.getState().connected){
      host.hidden=true;now.hidden=false;setStatus('Conectando ao player do PeraGym...',true);
      spotify=createSpotifyPlayback({account,onState:value=>{
        if(current!==generation)return;
        ready=!!value.ready;transport(ready,true);update(value);
        clearInterval(tickTimer);
        if(ready&&!value.paused&&value.duration>0){
          const at=Date.now(),position=Number(value.position)||0,duration=Number(value.duration);
          tickTimer=setInterval(()=>{if(current===generation)update({position:Math.min(duration,position+Date.now()-at)});},500);
        }
        if(!value.paused&&obscured()){pause();return;}
        if(value.ready)setStatus(value.paused?'Pausado.':'Reproduzindo com sua conta Spotify.');
      },onError:error=>{if(current===generation)setStatus(error.message);}});
      try{await spotify.play(next);if(current===generation&&obscured())pause();}
      catch(error){if(current===generation)setStatus(error.message);}
      return;
    }
    if(next.provider==='spotify'){
      iframe(makeSpotifyEmbedUrl(next),'Player oficial do Spotify','spotify');
      setStatus('Player oficial Spotify. A disponibilidade depende do serviço e da sua conta.');
      return;
    }
    setStatus('Carregando player do YouTube…',true);
    const frame=iframe(makeEmbedUrl(next,location.origin),'Player oficial do YouTube','youtube');
    try{
      const YT=await youtubeApi();if(current!==generation||!frame.isConnected)return;
      if(obscured()){close();return;}
      youtube=new YT.Player(frame,{events:{
        onReady:()=>{
          if(current!==generation)return;ready=true;transport(true,next.kind==='playlist');
          if(obscured()){pause();return;}
          setStatus('Toque no play do YouTube para ouvir.');
          tickTimer=setInterval(()=>{
            if(current!==generation||!ready)return;
            try{update({position:youtube.getCurrentTime()*1000,duration:youtube.getDuration()*1000,paused:youtube.getPlayerState()!==1});}catch(_){}
          },650);
        },
        onStateChange:event=>{
          if(current!==generation)return;clearTimeout(stallTimer);
          if(event.data===1&&obscured()){pause();return;}
          update({paused:event.data!==1});
          if(event.data===3)stallTimer=setTimeout(()=>{if(current===generation)setStatus('O YouTube está demorando. Você pode abrir pelo link abaixo.');},12000);
          const messages={1:'Reproduzindo no YouTube.',2:'Pausado.',0:'Reprodução encerrada.',3:'Carregando música...'};
          if(messages[event.data])setStatus(messages[event.data],event.data===3);
        },
        onError:event=>{
          if(current!==generation)return;clearTimeout(stallTimer);
          const messages={2:'Link inválido.',5:'O navegador não conseguiu reproduzir.',100:'Conteúdo privado, removido ou indisponível.',101:'O autor permite tocar apenas no YouTube.',150:'O autor permite tocar apenas no YouTube.',153:'O YouTube não autorizou este navegador.'};
          setStatus((messages[event.data]||'O conteúdo não pôde ser reproduzido.')+' Use o link abaixo.');
        },
        onAutoplayBlocked:()=>{if(current===generation)setStatus('Toque no play do YouTube para ouvir.');}
      }});
    }catch(_){if(current===generation)setStatus('Use os controles do serviço. Se não abrir, toque no link abaixo.');}
  }
  const command=async action=>{
    try{
      if(!ready)return;
      if(spotify){await spotify[action]();return;}
      if(action==='toggle'){if(youtube.getPlayerState()===1)youtube.pauseVideo();else youtube.playVideo();}
      if(action==='next')youtube.nextVideo();if(action==='previous')youtube.previousVideo();
    }catch(error){setStatus(error.message||'Não foi possível usar este controle.');}
  };
  $('[data-music-toggle]').onclick=()=>void command('toggle');
  $('[data-music-previous]').onclick=()=>void command('previous');$('[data-music-next]').onclick=()=>void command('next');
  $('[data-music-seek]').onchange=async event=>{
    try{if(!ready)return;const ms=Number(event.target.value);if(spotify)await spotify.seek(ms);else youtube.seekTo(ms/1000,true);}catch(error){setStatus(error.message);}
  };
  $('[data-music-volume]').onchange=async event=>{
    try{if(!ready)return;const percent=Number(event.target.value);if(spotify)await spotify.setVolume(percent/100);else youtube.setVolume(percent);}catch(error){setStatus(error.message);}
  };
  $('[data-music-close]').onclick=close;
  window.addEventListener('resize',()=>{if(media&&!fits())close();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  new MutationObserver(()=>{const open=!!document.querySelector('dialog[open]:not(#operation-loading)');const justOpened=open&&!modalOpen;modalOpen=open;if(justOpened)pause();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  return {load,openAccount,setMessage:setStatus,close};
}
