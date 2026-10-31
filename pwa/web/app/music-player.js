import {parseMusicLink,makeEmbedUrl,makeSpotifyEmbedUrl} from './music-links.js?v=3.9.0';
import {createSpotifyPlayback} from './spotify-playback.js?v=3.9.0';

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
  const spotifyFactory=options.createSpotifyPlayback||createSpotifyPlayback;
  let youtube,spotify,media,ready=false,generation=0,selection=0,stallTimer,tickTimer,modalOpen=false;
  let queue=null,pendingSpotifyIndex=null,state={paused:true,position:0,duration:0};
  const obscured=()=>document.hidden||!!document.querySelector('dialog[open]:not(#operation-loading)');
  const fits=()=>window.innerHeight>=280&&window.innerWidth>=(window.innerHeight<=520?420:240);
  const setStatus=(message,busy=false)=>{status.textContent=message;status.classList.toggle('is-loading',busy);};
  const nativeContext=()=>!!queue?.context&&!!spotify;
  const hasNext=()=>!!queue&&(nativeContext()?ready&&state.canSkipNext===true:queue.index<queue.items.length-1);
  const hasPrevious=()=>!!queue&&(nativeContext()?ready&&state.canSkipPrevious===true:queue.index>0);
  function getQueueState(){
    return {items:queue?queue.items.map(item=>({...item})):[],index:queue?queue.index:-1,name:queue?.name||'',provider:queue?.provider||null,
      context:queue?.context?{...queue.context}:null,positionKnown:!!queue&&queue.positionKnown!==false,hasNext:hasNext(),hasPrevious:hasPrevious()};
  }
  function emitQueue(){try{options.onQueueChange?.(getQueueState());}catch(_){}}
  function queueHint(){return queue?(queue.positionKnown===false?` Playlist · ${queue.items.length} faixas.`:` Faixa ${queue.index+1} de ${queue.items.length}.`):'';}
  function transport(enabled,skip=false){
    const queued=!!queue;
    controls.hidden=!enabled&&!queued;
    $('[data-music-previous]').disabled=queued?!hasPrevious():!skip;
    $('[data-music-next]').disabled=queued?!hasNext():!skip;
    $('[data-music-toggle]').disabled=!enabled&&!queued;
    $('[data-music-volume]').disabled=!enabled;
  }
  function update(next){
    state={...state,...next};
    $('[data-music-toggle]').textContent=state.paused?'▶':'Ⅱ';
    $('[data-music-toggle]').setAttribute('aria-label',state.paused?'Reproduzir':'Pausar');
    $('[data-music-position]').textContent=clock(state.position);$('[data-music-duration]').textContent=clock(state.duration);
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
  function destroy(){
    generation++;selection++;clearTimeout(stallTimer);clearInterval(tickTimer);
    try{youtube?.destroy();}catch(_){}
    spotify?.disconnect();youtube=undefined;spotify=undefined;pendingSpotifyIndex=null;
    ready=false;host.replaceChildren();transport(false);now.hidden=true;host.hidden=false;
    const image=$('[data-track-image]');image.removeAttribute('src');image.hidden=true;
    update({paused:true,position:0,duration:0,canSkipNext:false,canSkipPrevious:false});
  }
  function clearQueue(){queue=null;pendingSpotifyIndex=null;emitQueue();}
  function close(){clearQueue();destroy();media=undefined;mount.hidden=true;state={paused:true,position:0,duration:0};source.removeAttribute('href');source.textContent='Abrir no serviço ↗';$('[data-track-title]').textContent='';$('[data-track-artist]').textContent='';const image=$('[data-track-image]');image.removeAttribute('src');image.hidden=true;name.textContent='player';setStatus('');document.body.classList.remove('music-active');}
  function openAccount(provider,profile){
    clearQueue();destroy();media=undefined;state={paused:true,position:0,duration:0};
    mount.hidden=false;document.body.classList.add('music-active');host.hidden=true;now.hidden=false;
    name.textContent=provider==='spotify'?'Spotify':'YouTube';source.href=provider==='spotify'?'https://open.spotify.com/':'https://music.youtube.com/';
    source.textContent=provider==='spotify'?'Abrir no Spotify ↗':'Abrir no YouTube Music ↗';
    $('[data-track-title]').textContent='Conta conectada';$('[data-track-artist]').textContent=profile?.displayName||'Escolha uma música';setStatus('Carregando suas playlists…',true);
  }
  function pause(){
    if(!media)return;
    if(!ready){
      if(!queue){close();return;}
      const selected=media;destroy();media=selected;transport(false);setStatus('Pausado. Toque no play para continuar a fila.');return;
    }
    clearTimeout(stallTimer);clearInterval(tickTimer);
    try{
      if(youtube)youtube.pauseVideo();
      else if(spotify){const current=generation;void spotify.pause().catch(()=>{if(current===generation)close();});}
      else{close();return;}
      update({paused:true});setStatus('Pausado. Toque no play para continuar.'+queueHint());
    }catch(_){close();}
  }
  function iframe(url,title,provider){
    const element=document.createElement('iframe');element.id='peragym-service-player';element.title=title;
    element.width='400';element.height=provider==='spotify'?'152':'225';element.referrerPolicy='strict-origin-when-cross-origin';
    element.allow='autoplay; encrypted-media; fullscreen; clipboard-write';element.allowFullscreen=true;element.src=url;
    host.dataset.provider=provider;host.replaceChildren(element);return element;
  }
  function checkedItem(value,forQueue=false){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Escolha uma faixa válida para a fila.');
    let raw=value.url||value.uri;
    if(!raw&&value.provider==='youtube'&&(value.videoId||value.id))raw=`https://music.youtube.com/watch?v=${value.videoId||value.id}`;
    if(!raw&&value.provider==='spotify'&&value.kind&&value.id)raw=`spotify:${value.kind}:${value.id}`;
    const checked=parseMusicLink(raw);
    if(value.provider!==undefined&&value.provider!==checked.provider)throw new Error('O serviço da faixa não corresponde ao link.');
    if(value.kind!==undefined&&value.kind!==checked.kind)throw new Error('O tipo da faixa não corresponde ao link.');
    if(checked.provider==='spotify'&&value.uri!==undefined&&value.uri!==checked.uri)throw new Error('A URI da faixa Spotify não corresponde ao link.');
    if(checked.provider==='spotify'&&value.id!==undefined&&value.id!==checked.id)throw new Error('O identificador da faixa não corresponde ao link.');
    if(checked.provider==='youtube'&&checked.kind==='video'&&value.videoId!==undefined&&value.videoId!==checked.videoId)throw new Error('O identificador do vídeo não corresponde ao link.');
    if(forQueue&&!((checked.provider==='spotify'&&checked.kind==='track')||(checked.provider==='youtube'&&checked.kind==='video')))throw new Error('A fila precisa conter faixas individuais do mesmo serviço.');
    if(value.unavailable)throw new Error('Esta faixa não está disponível para reprodução.');
    const item={...checked};
    for(const key of ['name','title'])if(typeof value[key]==='string')item[key]=value[key].slice(0,300);
    if(Number.isInteger(value.position)&&value.position>=0)item.position=value.position;
    return item;
  }
  function available(){if(!fits())throw new Error('Aumente a janela ou gire o aparelho para exibir o player.');if(!navigator.onLine)throw new Error('Conecte-se à internet para ouvir música.');}
  function selectedSource(next){
    media=next;source.href=next.url;source.textContent=next.provider==='spotify'?'Abrir no Spotify ↗':'Abrir no YouTube Music ↗';name.textContent=next.provider==='spotify'?'Spotify':'YouTube';
  }
  function syncSpotifyQueue(value){
    if(!queue?.context||queue.provider!=='spotify'||typeof value.uri!=='string'||!value.uri)return;
    const target=queue.items[queue.index],candidates=[];
    queue.items.forEach((item,index)=>{if(item.uri===value.uri)candidates.push(index);});
    if(pendingSpotifyIndex!==null){
      if(value.uri!==target.uri)return;
      pendingSpotifyIndex=null;queue.positionKnown=true;emitQueue();return;
    }
    // Identical URIs cannot identify which repeated occurrence the native player reached.
    if(value.uri===target.uri){
      const known=candidates.length===1;
      if(queue.positionKnown!==known){queue.positionKnown=known;emitQueue();}
      return;
    }
    if(!candidates.length){queue.positionKnown=false;emitQueue();return;}
    queue.index=candidates.find(index=>index>queue.index)??candidates[candidates.length-1];
    queue.positionKnown=candidates.length===1;selectedSource(queue.items[queue.index]);emitQueue();
  }
  function spotifyState(value,current){
    if(current!==generation)return;
    if(queue?.context&&pendingSpotifyIndex!==null&&value.uri&&value.uri!==queue.items[queue.index].uri){ready=!!value.ready;state={...state,canSkipNext:value.canSkipNext===true,canSkipPrevious:value.canSkipPrevious===true};transport(ready,true);return;}
    const skipChanged=state.canSkipNext!==value.canSkipNext||state.canSkipPrevious!==value.canSkipPrevious;
    ready=!!value.ready;update(value);syncSpotifyQueue(value);transport(ready,true);if(queue&&skipChanged)emitQueue();clearInterval(tickTimer);
    if(ready&&!value.paused&&value.duration>0){
      const at=Date.now(),position=Number(value.position)||0,duration=Number(value.duration);
      tickTimer=setInterval(()=>{if(current===generation)update({position:Math.min(duration,position+Date.now()-at)});},500);
    }
    if(!value.paused&&obscured()){pause();return;}
    if(value.ready)setStatus((value.paused?'Pausado.':'Reproduzindo com sua conta Spotify.')+queueHint());
  }
  function spotifyTarget(next){return queue?.context?{...queue.context,offsetPosition:next.position??queue.index}:next;}
  async function playSpotify(next,current){
    const operation=++selection,instance=spotify;
    if(queue?.context)pendingSpotifyIndex=queue.index;
    setStatus('Carregando faixa do Spotify…'+queueHint(),true);
    try{await instance.play(spotifyTarget(next));if(current===generation&&operation===selection&&obscured())pause();}
    catch(error){if(current===generation&&operation===selection){pendingSpotifyIndex=null;setStatus(error.message||'Não foi possível tocar esta faixa.');transport(ready,true);}}
  }
  async function start(next,{autoplay=false,reuseSpotify=false}={}){
    if(reuseSpotify&&spotify&&queue?.context){selectedSource(next);update({paused:true,position:0,duration:0});transport(ready,true);await playSpotify(next,generation);return;}
    destroy();selectedSource(next);const current=generation;
    mount.hidden=false;document.body.classList.add('music-active');
    $('[data-track-title]').textContent=next.name||next.title||'Preparando player...';$('[data-track-artist]').textContent=queue?.name||'PeraGym';
    const account=options.account?.();
    if(next.provider==='spotify'&&account?.getState().connected){
      host.hidden=true;now.hidden=false;setStatus('Conectando ao player do PeraGym...',true);
      spotify=spotifyFactory({account,onState:value=>spotifyState(value,current),onError:error=>{if(current===generation)setStatus(error.message);}});
      await playSpotify(next,current);return;
    }
    if(next.provider==='spotify'){
      iframe(makeSpotifyEmbedUrl(next),'Player oficial do Spotify','spotify');transport(false);
      setStatus('Player oficial Spotify. A disponibilidade depende do serviço e da sua conta.'+queueHint());return;
    }
    let endedHandled=false,failed=false;
    setStatus('Carregando player do YouTube…'+queueHint(),true);
    const frame=iframe(makeEmbedUrl(next,location.origin),'Player oficial do YouTube','youtube');
    try{
      const YT=await youtubeApi();if(current!==generation||!frame.isConnected)return;
      youtube=new YT.Player(frame,{events:{
        onReady:()=>{
          if(current!==generation)return;ready=true;transport(true,next.kind==='playlist');
          if(obscured()){pause();return;}
          setStatus('Toque no play do YouTube para ouvir.'+queueHint());
          if(autoplay){try{youtube.playVideo();}catch(_){setStatus('Toque no play do YouTube para ouvir.'+queueHint());}}
          tickTimer=setInterval(()=>{
            if(current!==generation||!ready)return;
            try{update({position:youtube.getCurrentTime()*1000,duration:youtube.getDuration()*1000,paused:youtube.getPlayerState()!==1});}catch(_){}
          },650);
        },
        onStateChange:event=>{
          if(current!==generation)return;clearTimeout(stallTimer);
          if(event.data===1){endedHandled=false;failed=false;if(obscured()){pause();return;}}
          update({paused:event.data!==1});
          if(event.data===0&&queue?.provider==='youtube'){
            if(failed||endedHandled)return;endedHandled=true;
            if(hasNext()&&!obscured()){const currentQueue=queue;void moveQueue(1,true).catch(error=>{if(queue===currentQueue)setStatus(error.message||'Não foi possível avançar a fila.');});return;}
            setStatus(hasNext()?'Pausado. Toque em próxima para continuar a fila.':'Fila concluída.');return;
          }
          if(event.data===3)stallTimer=setTimeout(()=>{if(current===generation)setStatus('O YouTube está demorando. Você pode abrir pelo link abaixo.');},12000);
          const messages={1:'Reproduzindo no YouTube.',2:'Pausado.',0:'Reprodução encerrada.',3:'Carregando música...'};
          if(messages[event.data])setStatus(messages[event.data]+queueHint(),event.data===3);
        },
        onError:event=>{
          if(current!==generation)return;failed=true;clearTimeout(stallTimer);update({paused:true});transport(ready,next.kind==='playlist');
          const messages={2:'Link inválido.',5:'O navegador não conseguiu reproduzir.',100:'Conteúdo privado, removido ou indisponível.',101:'O autor permite tocar apenas no YouTube.',150:'O autor permite tocar apenas no YouTube.',153:'O YouTube não autorizou este navegador.'};
          setStatus((messages[event.data]||'O conteúdo não pôde ser reproduzido.')+(hasNext()?' Toque em próxima para continuar.':' Use o link abaixo.'));
        },
        onAutoplayBlocked:()=>{if(current===generation)setStatus('Toque no play do YouTube para ouvir.'+queueHint());}
      }});
    }catch(_){if(current===generation){transport(false);setStatus('Use os controles do serviço. Se não abrir, toque no link abaixo.');}}
  }
  async function load(next){const checked=checkedItem(next);available();clearQueue();await start(checked);}
  async function loadQueue(items,{index=0,name:queueName='',context=null}={}){
    if(!Array.isArray(items)||!items.length)throw new Error('Escolha uma playlist com faixas disponíveis.');
    const checked=items.map(item=>checkedItem(item,true));
    if(checked.some(item=>item.provider!==checked[0].provider))throw new Error('A fila deve conter apenas um serviço de música.');
    if(!Number.isInteger(index)||index<0||index>=checked.length)throw new Error('Escolha uma posição válida na playlist.');
    let checkedContext=null;
    if(context){checkedContext=checkedItem(context);if(checked[0].provider!=='spotify'||checkedContext.provider!=='spotify'||checkedContext.kind!=='playlist')throw new Error('O contexto da fila precisa ser uma playlist do Spotify.');}
    available();destroy();queue={items:checked,index,name:typeof queueName==='string'?queueName.slice(0,200):'',provider:checked[0].provider,context:checkedContext,positionKnown:true};emitQueue();
    await start(checked[index],{autoplay:true});return getQueueState();
  }
  async function moveQueue(direction,automatic=false){
    if(!queue)return false;
    const index=queue.index+direction;if(index<0||index>=queue.items.length)return false;
    if(automatic&&obscured())return false;
    available();queue.index=index;queue.positionKnown=true;pendingSpotifyIndex=null;emitQueue();transport(ready,true);
    await start(queue.items[index],{autoplay:true,reuseSpotify:!!queue.context&&!!spotify});return true;
  }
  const command=async action=>{
    const current=generation,currentQueue=queue;
    try{
      if((action==='next'||action==='previous')&&nativeContext()){
        if(!ready||(action==='next'?!hasNext():!hasPrevious()))return false;
        pendingSpotifyIndex=null;queue.positionKnown=false;emitQueue();setStatus('Mudando faixa do Spotify…'+queueHint(),true);
        await spotify[action]();return true;
      }
      if((action==='next'||action==='previous')&&queue)return await moveQueue(action==='next'?1:-1);
      if(!ready){if(action==='toggle'&&queue){available();await start(queue.items[queue.index],{autoplay:true});}return;}
      if(spotify){await spotify[action]();return;}
      if(action==='toggle'){if(youtube.getPlayerState()===1)youtube.pauseVideo();else youtube.playVideo();}
      if(action==='next')youtube.nextVideo();if(action==='previous')youtube.previousVideo();
    }catch(error){if(current===generation||(currentQueue&&queue===currentQueue))setStatus(error.message||'Não foi possível usar este controle.');}
  };
  $('[data-music-toggle]').onclick=()=>command('toggle');
  $('[data-music-previous]').onclick=()=>command('previous');$('[data-music-next]').onclick=()=>command('next');
  $('[data-music-seek]').onchange=async event=>{
    const current=generation;
    try{if(!ready)return;const ms=Number(event.target.value);if(spotify)await spotify.seek(ms);else youtube.seekTo(ms/1000,true);}catch(error){if(current===generation)setStatus(error.message);}
  };
  $('[data-music-volume]').onchange=async event=>{
    const current=generation;
    try{if(!ready)return;const percent=Number(event.target.value);if(spotify)await spotify.setVolume(percent/100);else youtube.setVolume(percent);}catch(error){if(current===generation)setStatus(error.message);}
  };
  $('[data-music-close]').onclick=close;
  window.addEventListener('resize',()=>{if(media&&!fits())close();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  new MutationObserver(()=>{const open=!!document.querySelector('dialog[open]:not(#operation-loading)');const justOpened=open&&!modalOpen;modalOpen=open;if(justOpened)pause();}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  return {load,loadQueue,getQueueState,next:()=>command('next'),previous:()=>command('previous'),openAccount,setMessage:setStatus,close};
}
