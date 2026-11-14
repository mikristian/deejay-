/* Companion UI: local-first Music Hub metadata and explicit, verified actions. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const asList = value => Array.isArray(value) ? value : [];
  const str = value => value == null ? '' : String(value);
  const escape = value => str(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const localOrigin = ['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname);
  // The LAN bridge is a distinct origin, with authenticated intent-only actions.
  const remote = !localOrigin || location.port==='18770';
  // The opt-in remote bridge serves mobile assets only; ./index.html exists on the laptop's local Hub.
  $('desktop-link').hidden=remote;
  $('desktop-remote-label').hidden=!remote;
  const TOKEN_KEY='music-hub-remote-token';
  let pairingToken='';
  try {if(remote)pairingToken=sessionStorage.getItem(TOKEN_KEY)||'';}catch{}
  let devicePaired=false, pendingPair=null, pairTimer=null, pairPolling=false, connecting=false;
  const authenticated=()=>!!pairingToken||devicePaired;
  async function pairingRequest(path,{method='GET',body}={}){
    const headers={};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(pairingToken&&path.endsWith('/enroll'))headers.Authorization='Bearer '+pairingToken;
    const response=await fetch(path,{method,headers,credentials:'same-origin',cache:'no-store',
      redirect:'error',...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    if(!response.ok||data?.error)throw Error(str(data.error||'Laptop pairing error'));
    return data;
  }
  function cancelPairing(){
    if(pairTimer){clearInterval(pairTimer);pairTimer=null;}
    pendingPair=null;
    $('connect-approval').hidden=true;
    connecting=false;
    renderConnection();
  }
  async function pollPair(){
    if(!pendingPair||pairPolling)return;
    pairPolling=true;
    const request=pendingPair;
    try{
      const result=await pairingRequest('/api/remote/v1/pair/status',
        {method:'POST',body:{requestId:request.requestId,secret:request.secret}});
      if(pendingPair!==request)return;
      if(result.state==='connected'){
        devicePaired=true;pairingToken='';
        try{sessionStorage.removeItem(TOKEN_KEY);}catch{}
        cancelPairing();await refresh();notify('Connected to your laptop.');
      }else if(result.state==='expired'){
        cancelPairing();notify('Pairing expired. Tap Connect to Laptop again.',true);
      }
    }catch(error){
      if(pendingPair===request){cancelPairing();notify('Pairing failed: '+error.message,true);}
    }finally{pairPolling=false;}
  }
  async function connectLaptop(){
    if(!remote)return;
    if(connecting)return;
    connecting=true;renderConnection();
    try{
      if(!devicePaired){
        const check=await pairingRequest('/api/remote/v1/pair/me');
        devicePaired=check.connected===true;
      }
      if(!devicePaired&&pairingToken){
        // Upgrade the existing phone's previously entered token to a durable,
        // HttpOnly HTTPS-only device cookie. Never show or put it in the URL.
        const enrollment=await pairingRequest('/api/remote/v1/pair/enroll',{method:'POST',body:{}});
        if(enrollment.connected){devicePaired=true;pairingToken='';try{sessionStorage.removeItem(TOKEN_KEY);}catch{}}
      }
      if(devicePaired){
        await refresh();
        notify(state.hubReady?'Laptop connected.':'Your phone is paired; check the laptop is open.',!state.hubReady);
        return;
      }
      const request=await pairingRequest('/api/remote/v1/pair/start',
        {method:'POST',body:{label:'iPhone Music Hub'}});
      pendingPair={requestId:request.requestId,secret:request.secret};
      $('connect-code').textContent=request.code;
      $('connect-approval').hidden=false;
      pairTimer=setInterval(()=>void pollPair(),1900);
      notify('Approve the matching code on your laptop.');
      void pollPair();
    }catch(error){
      notify('Connection unavailable: '+error.message,true);
    }finally{connecting=false;renderConnection();}
  }
  async function recoverPhoneLogin(){
    if(!remote){refresh();return;}
    try{
      const check=await pairingRequest('/api/remote/v1/pair/me');
      devicePaired=check.connected===true;
    }catch{devicePaired=false;}
    await refresh();
  }
  const state = {tracks:[],byId:new Map(),nativePlaylists:[],nativeCache:new Map(),hub:{queue:[],playlists:[],favorites:[]},remoteQueue:{revision:0,items:[]},capabilities:{},preview:null,filter:'all',tab:'browse',detail:null,detailQuery:'',detailLimit:80,detailError:'',limit:80,selected:null,hubReady:false,libraryReady:false,decksVerified:false,decks:{},busy:false,localCommandPending:false};
  let notificationTimer, searchTimer, pairingOpen=false;
  function notify(message,error=false) {
    const target=$('toast');target.textContent=message;target.classList.toggle('error',error);target.classList.add('visible');
    clearTimeout(notificationTimer);notificationTimer=setTimeout(()=>target.classList.remove('visible'),3800);
  }
  async function get(path,opts={}) {
    const headers={...(opts.headers||{})};
    if(remote){
      if(!authenticated())throw Error('Connect this phone to your laptop to continue');
      if(!(['/api/library','/api/music-hub/state','/api/music-hub/decks','/api/music-hub/action'].includes(path)||path.startsWith('/api/remote/v1/')))throw Error('Remote API path unavailable');
      if(pairingToken)headers.Authorization='Bearer '+pairingToken;
    }
    const response=await fetch(path,{cache:'no-store',credentials:'same-origin',...opts,headers});
    const body=await response.text();let data;
    try {data=JSON.parse(body);} catch {throw Error('Server returned an unexpected response');}
    if(!response.ok||data?.error||data?.ok===false)throw Error(str(data?.error||data?.message||'HTTP '+response.status));
    return data;
  }
  const canWrite = () => (!remote && localOrigin && state.hubReady && !state.busy) || (remote && state.hubReady && !state.busy && authenticated() && state.capabilities.queue===true);
  const canTarget=()=>remote&&canWrite()&&asList(state.capabilities.deckTargets).length>0;
  const localAudioActive=()=>remote&&authenticated()&&state.hubReady&&state.capabilities.localPreviewRemote===true;
  const selectedLocalId=()=>/^\d{1,20}$/.test(str(state.selected))&&track(state.selected)?str(state.selected):null;
  const stageAwaiting={};
  const track = id => state.byId.get(str(id));
  const has = id => !!$(id);
  const matches = (t,q) => [t.title,t.artist,t.album,t.bpm,t.camelot].some(value=>str(value).toLowerCase().includes(q));
  const numericId = id => /^[0-9]{1,20}$/.test(str(id));
  const playlistEntries = () => [
    ...state.nativePlaylists.filter(p=>p.kind==='playlist').map(p=>({id:str(p.id),name:str(p.name),count:p.count,type:'native'})),
    ...state.hub.playlists.map(p=>({id:str(p.id),name:str(p.name),count:asList(p.trackIds).length,type:'hub'}))
  ];
  const deckLabel = deck => deck==='1'?'A':'B';
  function deckActions(t){
    if(!/^[0-9]{1,20}$/.test(str(t.id)))return '';
    const available=canTarget()&&!state.busy;
    const canStage=localAudioActive()&&!state.localCommandPending;
    return '<div class="track-gesture-actions" aria-label="Deck actions for '+escape(t.title||'track')+'">'
      +[1,2].map(n=>'<button type="button" data-swipe-deck="'+n+'" data-track-id="'+escape(t.id)+'" '+(!(remote?available:canWrite()&&state.decksVerified)||remote&&!asList(state.capabilities.deckTargets).includes(str(n))?'disabled':'')+' aria-label="'+(remote?'Queue':'Load')+' '+escape(t.title||'track')+' for Deck '+deckLabel(str(n))+'">'+(remote?'Queue ':'Load ')+deckLabel(str(n))+'</button>').join('')
      +(remote?[1,2].map(n=>'<button type="button" data-swipe-stage="'+n+'" data-track-id="'+escape(t.id)+'" '+(!canStage?'disabled':'')+' aria-label="Stage '+escape(t.title||'track')+' on laptop Deck '+deckLabel(str(n))+'">Stage '+deckLabel(str(n))+'</button>').join(''):'')
      +'</div>';
  }
  const art = t => str(t?.artwork).startsWith('/artwork/') ? '<img class="art" loading="lazy" alt="" src="'+escape(t.artwork)+'">' : '<span class="art" aria-hidden="true">♫</span>';
  const meta = t => [t?.artist||'Unknown artist',t?.album,Number(t?.bpm)>0?Math.round(Number(t.bpm))+' BPM':null,t?.camelot].filter(Boolean).join(' · ');
  function row(t,mode='library',index=-1) {
    const selected=state.selected===t.id;
    const action=mode==='queue' ? '<button class="remove" data-remove="'+escape(t.id)+'" data-index="'+index+'" aria-label="Remove '+escape(t.title||'track')+' from queue">×</button>' : '<button class="add" data-add="'+escape(t.id)+'" aria-label="Add '+escape(t.title||'track')+' to Next Up" '+(!canWrite()?'disabled':'')+'>＋</button>';
    return '<div class="track'+(selected?' selected':'')+'" data-track="'+escape(t.id)+'">'+art(t)+'<button class="meta" data-select="'+escape(t.id)+'"><strong>'+escape(t.title||'Untitled track')+'</strong><small>'+escape(meta(t))+'</small></button>'+(mode==='queue'?'<button class="shift" data-shift="-1" data-index="'+index+'" aria-label="Move up" '+(index===0||!canWrite()?'disabled':'')+'>↑</button><button class="shift" data-shift="1" data-index="'+index+'" aria-label="Move down" '+(index===state.hub.queue.length-1||!canWrite()?'disabled':'')+'>↓</button>':'')+action+deckActions(t)+'</div>';
  }
  function renderList(target,tracks,mode='library') {
    $(target).innerHTML=tracks.length?tracks.map((t,i)=>row(t,mode,i)).join(''):'<p class="empty">No songs here yet.</p>';
  }
  function filtered() {
    if(state.filter==='favorites')return state.hub.favorites.map(track).filter(Boolean);
    return state.tracks;
  }
  function activeDetail(){
    if(!state.detail)return null;
    if(state.detail.kind==='playlist'){
      const item=state.hub.playlists.find(p=>str(p.id)===state.detail.id);
      return item?{title:str(item.name),rows:asList(item.trackIds).map(track).filter(Boolean),kind:'playlist'}:null;
    }
    if(state.detail.kind==='native'){
      const item=state.nativePlaylists.find(p=>str(p.id)===state.detail.id&&p.kind==='playlist');
      if(!item)return null;
      const cached=state.nativeCache.get(state.detail.id);
      const ids=asList(cached?.trackIds);
      const rows=ids.map(track).filter(Boolean);
      return {title:str(cached?.name||item.name),rows,count:Number.isSafeInteger(cached?.count)?cached.count:item.count,kind:'native',loading:!cached};
    }
    if(state.detail.kind==='album'){
      const item=albumGroups().find(group=>group.id===state.detail.id);
      return item?{title:item.name,rows:item.tracks,kind:'album'}:null;
    }
    if(state.detail.kind==='genre'){
      return {title:state.detail.title,rows:state.tracks.filter(t=>str(t.genre).toLowerCase()===state.detail.id),kind:'genre'};
    }
    return null;
  }
  function renderDetail(){
    if(!has('playlist-detail'))return;
    const detail=activeDetail();
    if(state.detail&&!detail){state.detail=null;state.detailQuery='';}
    $('playlist-detail').hidden=!detail;
    const spotlight=document.querySelector('.spotlight');
    if(spotlight)spotlight.hidden=!!detail;
    document.querySelectorAll('#browse-panel .browse-title,#browse-panel .chips').forEach(node=>node.hidden=!!detail);
    if(!detail)return;
    $('show-more').hidden=true;
    $('playlist-detail-title').textContent=detail.title;
    const query=state.detailQuery.trim().toLowerCase();
    const rows=query?detail.rows.filter(t=>matches(t,query)):detail.rows;
    const total=detail.kind==='native'?detail.count:detail.rows.length;
    $('playlist-detail-count').textContent=total.toLocaleString()+' songs'+(query?' · '+rows.length+' matches':'')+(detail.loading?' · Loading…':'')+(state.detailError?' · Load failed':'');
    const input=$('playlist-detail-search');
    if(input&&input.value!==state.detailQuery)input.value=state.detailQuery;
    if(state.detailError){$('browse-content').innerHTML='<p class="empty">'+escape(state.detailError)+'</p>';return;}
    if(detail.loading){$('browse-content').innerHTML='<p class="empty">Loading native Rekordbox songs…</p>';return;}
    renderList('browse-content',rows.slice(0,state.detailLimit));
    $('show-more').hidden=state.detailLimit>=rows.length;
    $('show-more').textContent='Show more songs · '+Math.min(state.detailLimit,rows.length).toLocaleString()+' of '+rows.length.toLocaleString();
  }
  function openDetail(kind,id,title=''){
    state.detail={kind,id:str(id),title};state.detailQuery='';state.detailLimit=80;state.detailError='';state.tab='browse';
    tab('browse');renderBrowse();
    if(has('playlist-detail'))$('playlist-detail').scrollIntoView({block:'start',behavior:'auto'});
    if(kind==='native')void fetchNativePlaylist(str(id));
  }
  function closeDetail(){state.detail=null;state.detailQuery='';state.detailError='';state.detailLimit=80;if(has('playlist-detail-search'))$('playlist-detail-search').value='';renderBrowse();}
  async function fetchNativePlaylist(id){
    if(state.nativeCache.has(id)){renderDetail();return;}
    if(!numericId(id))return;
    const item=state.nativePlaylists.find(p=>str(p.id)===id&&p.kind==='playlist');
    if(!item)return;
    try{
      const data=await get(remote?'/api/remote/v1/native-playlist?id='+encodeURIComponent(id):'/api/playlist?id='+encodeURIComponent(id)+'&limit=10000');
      if(str(data.id)!==id)throw Error('Playlist ID mismatch');
      if(data.error)throw Error(str(data.error));
      const raw=remote?data.trackIds:Array.isArray(data.tracks)?data.tracks.map(t=>t?.id):null;
      if(!Array.isArray(raw))throw Error('Playlist tracks unavailable');
      // The native response is already in Rekordbox order. Preserve duplicates and positions.
      const ids=raw.map(str).filter(numericId);
      const total=Number.isSafeInteger(data.count)&&data.count>=0?data.count:ids.length;
      state.nativeCache.set(id,{id,name:str(data.name||item.name),count:total,trackIds:ids});
      if(state.detail?.kind==='native'&&state.detail.id===id){state.detailError='';renderDetail();}
    }catch(error){
      if(state.detail?.kind==='native'&&state.detail.id===id){state.detailError='Could not load this Rekordbox playlist: '+error.message;renderDetail();}
    }
  }
  function renderBrowse() {
    if(state.detail){renderDetail();return;}
    if(state.filter==='albums'){
      const groups=albumGroups();
      $('browse-content').innerHTML=groups.slice(0,state.limit).map(group=>'<div class="track">'+art(group.cover)+'<button class="meta" data-album="'+escape(group.id)+'"><strong>'+escape(group.name)+'</strong><small>'+escape(group.artist)+' · '+group.tracks.length+' songs</small></button></div>').join('')||'<p class="empty">No album metadata available.</p>';
    } else if(state.filter==='playlists'){
      const lists=playlistEntries();
      $('browse-content').innerHTML=lists.length?lists.map(p=>{
        const ids=p.type==='native'?asList(state.nativeCache.get(p.id)?.trackIds):asList(state.hub.playlists.find(item=>str(item.id)===p.id)?.trackIds);
        const rows=ids.map(track).filter(Boolean);
        const cover=rows.find(t=>str(t.artwork).startsWith('/artwork/'))||rows[0];
        return '<div class="track">'+art(cover)+'<button class="meta" data-playlist="'+escape(p.id)+'" data-playlist-type="'+p.type+'"><strong>'+escape(p.name)+'</strong><small>'+p.count.toLocaleString()+' songs · '+(p.type==='native'?'Rekordbox · Read-only':'Music Hub')+'</small></button></div>';
      }).join(''):'<p class="empty">No Music Hub or Rekordbox playlists found.</p>';
    } else {
      const rows=filtered();renderList('browse-content',rows.slice(0,state.limit));
    }
    const count=state.filter==='playlists'?playlistEntries().length:state.filter==='albums'?albumGroups().length:filtered().length;
    $('library-count').textContent=count.toLocaleString()+(state.filter==='playlists'?' playlists':state.filter==='albums'?' albums':' songs');
    $('show-more').hidden=state.filter==='playlists'||state.limit>=count;
    renderDetail();
  }
  function albumGroups(){
    const map=new Map();
    for(const t of state.tracks){
      if(!str(t.album).trim())continue;
      const name=str(t.album),artist=str(t.albumArtist||t.artist||'Unknown artist'),id=name.toLowerCase()+'\u0000'+artist.toLowerCase();
      if(!map.has(id))map.set(id,{id,name,artist,tracks:[],cover:t});
      const group=map.get(id);group.tracks.push(t);
      if(!str(group.cover?.artwork).startsWith('/artwork/')&&str(t.artwork).startsWith('/artwork/'))group.cover=t;
    }
    return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
  }
  function renderSearch(){
    const q=$('search').value.trim().toLowerCase();
    if(!q){$('search-content').innerHTML='<p class="empty">Search songs, artists, albums or BPM.</p>';return;}
    const found=state.tracks.filter(t=>[t.title,t.artist,t.album,t.bpm,t.camelot].some(value=>str(value).toLowerCase().includes(q))).slice(0,100);
    renderList('search-content',found);
  }
  function renderQueue(){
    const ids=state.hub.queue;
    // Preserve original indices in action buttons, including missing library entries.
    $('queue-content').innerHTML=ids.length?ids.map((id,i)=>{const t=track(id);return t?row(t,'queue',i):'<div class="track"><div class="meta">Unavailable local track '+escape(id)+'</div></div>';}).join(''):'<p class="empty">Your Next Up queue is empty. Add songs from your library.</p>';
    $('queue-count').textContent=ids.length+' tracks';$('hero-count').textContent=ids.length;
    $('queue-subtitle').textContent=remote?'Saved Next Up · use Decks to send load intentions':'Your saved Music Hub queue';
    $('clear-queue').hidden=false;
    $('clear-queue').disabled=!canWrite()||!ids.length;
    $('smart-order').hidden=remote?state.capabilities.smartReorder!==true: false;
    $('smart-order').disabled=!canWrite()||ids.length<2;
    $('auto-transition').hidden=!remote||state.capabilities.autoTransition!==true||!/^\/api\/remote\/v1\/[a-z0-9/_-]+$/.test(str(state.capabilities.autoTransitionEndpoint));
    $('auto-transition').disabled=!canWrite()||ids.length<2;
  }
  function renderDecks(){
    $('deck-status').textContent=state.decksVerified?'Verified laptop feedback':'Feedback unavailable';
    for(const [n,id] of [[1,'deck-a'],[2,'deck-b']]){
      const slot=state.decks?.[str(n)]||{};const loaded=slot.loaded||slot.trackId;
      const t=loaded&&typeof loaded==='object'?track(loaded.id):track(loaded);
      $(id).textContent=state.decksVerified?(t?.title||'No verified track'):'Live state unverified';
    }
    const selected=track(state.selected);
    $('selected-track').textContent=selected?'Selected: '+selected.title+' · '+(selected.artist||'Unknown artist'):'Choose a song in Browse or Search.';
    $('deck-status').textContent=remote?'Remote deck intention only':$('deck-status').textContent;
    for(const n of [1,2])if(remote) $('deck-'+(n===1?'a':'b')).textContent='Select a track to queue for Deck '+(n===1?'A':'B');
    document.querySelectorAll('[data-deck]').forEach(button=>{
      button.textContent=remote?'Queue selected for '+(button.dataset.deck==='1'?'A':'B'):'Load selected to '+(button.dataset.deck==='1'?'A':'B');
      button.disabled=remote?(!canTarget()||!selected||!asList(state.capabilities.deckTargets).includes(button.dataset.deck)):(!canWrite()||!state.decksVerified||!selected);
    });
    renderLocalAudio();
  }
  const PREVIEW_FIELDS=['deckA','deckB','playingA','playingB','positionA','positionB','durationA','durationB','crossfade','autoFading'];
  function validPreview(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==PREVIEW_FIELDS.length||!PREVIEW_FIELDS.every(key=>Object.hasOwn(value,key)))return null;
    if(!['deckA','deckB'].every(key=>value[key]===null||(typeof value[key]==='string'&&/^\d{1,20}$/.test(value[key]))))return null;
    if(!['playingA','playingB','autoFading'].every(key=>typeof value[key]==='boolean'))return null;
    if(!['positionA','positionB','durationA','durationB'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0&&value[key]<=86400))return null;
    if(typeof value.crossfade!=='number'||!Number.isFinite(value.crossfade)||value.crossfade<0||value.crossfade>1)return null;
    return value;
  }
  function localTime(seconds){
    const sec=Math.floor(seconds);
    const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;
    return h? h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0');
  }
  function renderLivePreview(){
    const preview=localAudioActive()?state.preview:null;
    for(const side of ['A','B']){
      const node=$('local-live-'+side.toLowerCase());
      node.replaceChildren();
      node.classList.remove('playing');
      if(!preview){node.textContent='LOCAL · No fresh preview data';continue;}
      const loaded=preview['deck'+side]!==null,playing=preview['playing'+side],duration=preview['duration'+side],position=preview['position'+side];
      const phase=!loaded?'No local track':playing?'Playing':'Paused / stopped';
      node.classList.toggle('playing',loaded&&playing);
      node.append(document.createTextNode('LOCAL · '+phase));
      if(loaded){
        const t=document.createElement('span');
        t.className='live-time';
        t.textContent=localTime(position)+' / '+localTime(duration);
        node.append(t);
      }
    }
    renderMiniDecks();
  }
  function renderMiniDecks(){
    if(!has('mini-decks'))return;
    $('mini-decks-status').textContent=localAudioActive()&&state.preview?'Laptop local preview · analysis when available':state.decksVerified?'Verified laptop deck feedback':'Waiting for laptop preview';
    const preview=localAudioActive()?state.preview:null;
    for(const side of ['a','b']){
      const upper=side.toUpperCase();
      const id=preview?.['deck'+upper];
      const passive=state.decksVerified?state.decks?.[side==='a'?'1':'2']:null;
      const passiveId=passive?.loaded||passive?.trackId;
      const passiveTrack=passiveId&&typeof passiveId==='object'?track(passiveId.id):track(passiveId);
      const title=preview?(id?(track(id)?.title||'Local track '+id):'No local track'):(passiveTrack?.title||'Deck '+upper+' · No verified track');
      const position=preview?.['position'+upper],duration=preview?.['duration'+upper];
      const hasTiming=preview&&id!==null&&duration>0;
      const playing=!!preview?.['playing'+upper];
      $('mini-deck-title-'+side).textContent=title;
      $('mini-state-'+side).textContent=preview?(id===null?'Empty':playing?'Playing locally':'Paused / stopped'):(state.decksVerified?'Verified laptop feedback':'Status unavailable');
      $('mini-deck-time-'+side).textContent=preview&&id!==null?localTime(position)+' / '+localTime(duration):'— / —';
      const line=$('mini-deck-progress-'+side);
      line.hidden=!hasTiming;
      if(hasTiming)line.style.left=Math.min(100,Math.max(0,position/duration*100))+'%';
      updateWaveform(side,preview&&id!==null?id:null);
    }
  }
  const waveState={a:{id:null,heights:[],serial:0},b:{id:null,heights:[],serial:0}};
  function drawWaveform(side){
    const canvas=$('mini-deck-wave-'+side),wrap=$('mini-wave-'+side),stateForSide=waveState[side];
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const width=canvas.width,height=canvas.height;
    ctx.clearRect(0,0,width,height);
    const values=stateForSide.heights;
    wrap.classList.toggle('has-data',values.length>0);
    canvas.setAttribute('aria-label',values.length?'Measured '+(side==='a'?'Deck A':'Deck B')+' track waveform':'No analyzed waveform data');
    if(!values.length){
      ctx.fillStyle='#5d6861';ctx.fillRect(0,height/2,width,1);
      return;
    }
    const step=width/values.length;
    ctx.fillStyle=side==='a'?'#89dfb1':'#b7adfb';
    for(let i=0;i<values.length;i++){
      const barHeight=Math.max(1,values[i]*height*0.92);
      ctx.fillRect(Math.floor(i*step),Math.floor((height-barHeight)/2),Math.max(1,Math.ceil(step)-1),barHeight);
    }
  }
  function updateWaveform(side,id){
    const wave=waveState[side];
    if(wave.id===id)return;
    wave.id=id;wave.heights=[];const serial=++wave.serial;
    drawWaveform(side);
    if(!id||!remote||!authenticated())return;
    void get('/api/remote/v1/waveform?id='+encodeURIComponent(id)).then(data=>{
      if(wave.serial!==serial||wave.id!==id)return;
      if(str(data?.id)!==id||!Array.isArray(data?.heights)||data.heights.length>192)return;
      if(!data.heights.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1))return;
      wave.heights=data.heights;
      drawWaveform(side);
    }).catch(()=>{if(wave.serial!==serial)return;drawWaveform(side);});
  }
  function renderLocalAudio(){
    const active=localAudioActive();
    $('local-audio').hidden=!active;
    $('local-audio-presence').textContent=active?'Laptop preview controller online':'Laptop preview unavailable';
    $('local-audio').querySelectorAll('button,input').forEach(control=>control.disabled=!active||state.localCommandPending);
    $('local-audio').querySelectorAll('[data-local-stage]').forEach(button=>{
      button.disabled=!active||state.localCommandPending||!selectedLocalId();
    });
    renderLivePreview();
  }
  function checkStagedPreview(){
    if(!localAudioActive()||!state.preview)return;
    for(const deck of ['1','2']){
      const pending=stageAwaiting[deck];
      if(pending&&pending.before!==pending.trackId&&state.preview[deck==='1'?'deckA':'deckB']===pending.trackId){
        delete stageAwaiting[deck];
        $('local-audio-feedback').textContent='Laptop LOCAL AUDIO preview now reports track '+pending.trackId+' staged on Deck '+(deck==='1'?'A':'B')+'. Playback state is shown above.';
      }
    }
  }
  async function refreshRemoteStatus(){
    if(!remote||!authenticated())return false;
    try{
      const status=await get('/api/remote/v1/status');
      state.capabilities=status.capabilities||{};
      if(status.queue)state.remoteQueue=status.queue;
      state.preview=state.capabilities.localPreviewRemote===true?validPreview(status.preview):null;
      checkStagedPreview();
      renderConnection();
      renderLocalAudio();
      renderQueue();
      renderDecks();
      return true;
    }catch(error){
      state.capabilities={};
      state.preview=null;
      renderConnection();
      renderLocalAudio();
      renderDecks();
      return false;
    }
  }
  async function queueLocalCommand(payload,label){
    if(!remote||state.localCommandPending||!state.hubReady)return false;
    // Check for a fresh laptop heartbeat immediately before every command.
    if(!await refreshRemoteStatus()||!localAudioActive()){
      $('local-audio-feedback').textContent='Laptop preview heartbeat is unavailable. No command was sent.';
      notify('Local preview controller offline. Refresh after reopening desktop.',true);
      return false;
    }
    state.localCommandPending=true;renderLocalAudio();
    try{
      const response=await get('/api/remote/v1/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(response.accepted!==true)throw Error('Laptop did not accept the command');
      $('local-audio-feedback').textContent=label+' queued for laptop local audio. Execution and playback are not verified.';
      notify(label+' queued (local audio only).');
      return true;
    }catch(error){
      $('local-audio-feedback').textContent=label+' was not queued: '+error.message;
      notify('Local audio command failed: '+error.message,true);
      return false;
    }finally{
      state.localCommandPending=false;
      await refreshRemoteStatus();
      renderLocalAudio();
    }
  }
  function renderConnection(){
    const available=state.libraryReady&&state.hubReady;
    $('pairing').hidden=!remote||!pairingOpen;
    $('edit-pairing').hidden=!remote;
    $('edit-pairing').setAttribute('aria-expanded',String(available&&pairingOpen));
    $('connection').classList.toggle('ready',available);
    const live=localAudioActive();
    $('connection-title').textContent=available?(remote?(live?'Connected · laptop audio live':'Connected · laptop preview offline'):'Connected to laptop Music Hub'):(remote?(authenticated()?'Reconnecting to laptop':'Laptop connection required'):'Laptop connection required');
    $('connection-detail').textContent=available?(remote?(live?'Play, pause and browse music on the laptop from this phone.':'Your phone is paired; open Music Hub on the Mac to enable live audio.'):'Local queue controls are available.'):(remote?'Tap Connect to Laptop below. Your Mac approves the first connection.':'Open Music Hub on your laptop.');
    $('quick-connect').hidden=!remote;
    $('quick-connect').classList.toggle('connected',available&&live);
    $('connect-laptop').textContent=connecting?'Connecting…':available&&live?'Connected · Reconnect':devicePaired?'Reconnect to Laptop':'Connect to Laptop';
    $('connect-laptop').disabled=connecting||!!pendingPair;
    $('connect-hint').textContent=available&&live?'Music Hub on your Mac is ready to receive phone commands.':pendingPair?'Match the approval code displayed below with your Mac.':devicePaired?'This phone is already approved. Tap to reconnect.':'First time only: approve the matching number on your Mac.';
  }
  function render(){renderConnection();renderBrowse();renderSearch();renderQueue();renderDecks();}
  function tab(which){
    state.tab=which;
    for(const id of ['browse','search','queue','decks']) {
      $(id+'-panel').hidden=id!==which;
      document.querySelectorAll('[data-tab="'+id+'"]').forEach(button=>{
        button.classList.toggle('active',id===which);
        if(button.getAttribute('role')==='tab')button.setAttribute('aria-selected',String(id===which));
      });
    }
    if(which==='search')$('search').focus({preventScroll:true});
    if(which==='decks')refreshDecks();
  }
  async function refreshHub(){try{
    const data=await get('/api/music-hub/state');state.hub={queue:asList(data.queue).map(str),favorites:asList(data.favorites).map(str),playlists:asList(data.playlists)};
    state.hubReady=true;
  }catch(error){state.hubReady=false;notify('Music Hub: '+error.message,true);}}
  async function refreshDecks(){
    if(remote){state.decksVerified=false;state.decks={};renderDecks();return;}
    try {
      const data=await get('/api/music-hub/decks');
      state.decksVerified=data.connected===true&&data.verified===true;state.decks=data.decks||{};
    } catch {state.decksVerified=false;state.decks={};}
    renderDecks();
  }
  async function refresh(){
    if(remote){
      if(!authenticated()){state.libraryReady=false;state.hubReady=false;render();return;}
      try{
        const status=await get('/api/remote/v1/status');
        state.capabilities=status.capabilities||{};
        state.remoteQueue=status.queue||{revision:0,items:[]};
        state.preview=state.capabilities.localPreviewRemote===true?validPreview(status.preview):null;
        checkStagedPreview();
      }catch(error){state.hubReady=false;state.libraryReady=false;state.capabilities={};state.preview=null;render();notify('Pairing failed: '+error.message,true);return;}
    }
    try {const data=await get('/api/library');state.tracks=asList(data.collection).filter(t=>t?.id!=null).map(t=>({...t,id:str(t.id)}));state.byId=new Map(state.tracks.map(t=>[t.id,t]));state.nativePlaylists=asList(remote?data.nativePlaylists:data.playlists).filter(p=>numericId(p?.id)&&p.kind==='playlist').map(p=>({id:str(p.id),name:str(p.name||'Playlist'),kind:p.kind,count:Number.isSafeInteger(p.count)&&p.count>=0?p.count:0}));state.libraryReady=true;}
    catch(error){state.libraryReady=false;state.tracks=[];state.byId=new Map();notify('Library: '+error.message,true);}
    await Promise.all([refreshHub(),refreshDecks()]);render();
  }
  async function action(name,values={}){
    if(!canWrite())return notify('Local/laptop pairing is required to change your queue.',true);
    state.busy=true;render();
    try {await get('/api/music-hub/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:name,...values})});await refreshHub();render();return true;}
    catch(error){notify(error.message,true);await refreshHub();render();return false;}
    finally{state.busy=false;render();}
  }
  function wheel(t){
    const key=str(t?.camelot).toUpperCase().match(/^(1[0-2]|[1-9])([AB])$/);
    return key?{n:Number(key[1]),mode:key[2]}:null;
  }
  function distance(a,b){
    const x=wheel(a),y=wheel(b);
    if(!x||!y)return 100;
    const diff=Math.abs(x.n-y.n),steps=Math.min(diff,12-diff);
    return steps===0?(x.mode===y.mode?0:1):x.mode===y.mode?steps*2:steps*2+3;
  }
  function harmonicOrder(ids){
    const remaining=ids.map((id,index)=>({id,index})),result=[remaining.shift()];
    while(remaining.length){
      const from=track(result[result.length-1].id);let best=0,score=Infinity;
      remaining.forEach((entry,index)=>{
        const d=distance(from,track(entry.id));
        if(d<score){best=index;score=d;}
      });
      result.push(remaining.splice(best,1)[0]);
    }
    return result.map(row=>row.id);
  }
  async function reorderSmart(){
    if(!canWrite()||state.hub.queue.length<2||(remote&&state.capabilities.smartReorder!==true))return;
    const original=state.hub.queue.slice(),target=harmonicOrder(original);
    if(original.every((id,i)=>id===target[i]))return notify('Queue is already in harmonic order.');
    state.busy=true;render();
    try{
      const working=original.slice();
      for(let i=0;i<target.length;i++){
        const from=working.indexOf(target[i],i);
        if(from<0)throw Error('Queue changed while arranging; refresh and try again');
        if(from===i)continue;
        await get('/api/music-hub/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'queue.reorder',from,to:i})});
        working.splice(i,0,working.splice(from,1)[0]);
      }
      notify('Next Up saved in harmonic order.');
    }catch(error){notify('Reorder stopped: '+error.message,true);}
    finally{state.busy=false;await refreshHub();render();}
  }
  async function loadDeck(n,chosenId=state.selected){
    if(remote){
      if(!canTarget()||!track(chosenId)||!asList(state.capabilities.deckTargets).includes(str(n)))return notify('Pair your laptop and choose a valid local song.',true);
      state.busy=true;renderDecks();
      try{
        const response=await get('/api/remote/v1/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.remoteQueue.revision,action:'enqueue',trackId:chosenId,deck:str(n)})});
        state.remoteQueue=response;
        $('deck-message').textContent='Sent Deck '+(n===1?'A':'B')+' intent to laptop queue. Playback is not started.';
        notify('Deck '+(n===1?'A':'B')+' intention queued.');
      }catch(error){notify('Deck intention: '+error.message,true);try{state.remoteQueue=await get('/api/remote/v1/queue');}catch{}}
      finally{state.busy=false;renderDecks();}
      return;
    }
    if(!canWrite()||!state.decksVerified||!track(chosenId))return notify('Verified laptop deck feedback and local control are required.',true);
    const selected=chosenId;state.busy=true;renderDecks();
    try{
      const response=await get('/api/music-hub/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deck:n,trackId:selected,dryRun:false})});
      const verified=response.verified===true||response.load_verified===true||['load_verified','verified','loaded'].includes(response.status)||(response.status==='already_loaded'&&response.verified===true);
      $('deck-message').textContent=verified?'Deck '+(n===1?'A':'B')+' load verified. Playback has not started.':str(response.reason||response.message||response.status||'Load not verified');
      notify(verified?'Verified deck load; playback remains on laptop.':'Deck load not verified.',!verified);
    }catch(error){$('deck-message').textContent='Load failed: '+error.message;notify(error.message,true);}
    finally{state.busy=false;await refreshDecks();}
  }
  async function stageTrack(deck,id){
    if(!track(id)||!/^[0-9]{1,20}$/.test(str(id))||!localAudioActive())return notify('Connect laptop local audio and select a valid local song.',true);
    const before=state.preview?.[deck==='1'?'deckA':'deckB']??null;
    const accepted=await queueLocalCommand({action:'local.stage',deck,trackId:str(id)},'Stage track '+id+' on laptop Deck '+deckLabel(deck));
    if(accepted){stageAwaiting[deck]={trackId:str(id),before};await refreshRemoteStatus();}
  }
  function showGesture(row,deck){
    document.querySelectorAll('.track.gesture-open').forEach(item=>{if(item!==row){item.classList.remove('gesture-open');delete item.dataset.gestureDeck;}});
    row.classList.add('gesture-open');row.dataset.gestureDeck=deck;
    const group=row.querySelector('.track-gesture-actions');
    if(group){group.hidden=false;group.querySelectorAll('[data-swipe-deck],[data-swipe-stage]').forEach(button=>button.classList.toggle('gesture-emphasis',button.dataset.swipeDeck===deck||button.dataset.swipeStage===deck));}
  }
  let touchStart=null;
  let lastAutoSwipe={id:'',deck:'',at:-Infinity};
  document.addEventListener('touchstart',event=>{
    const row=event.target.closest('.track[data-track]');
    if(!row||event.touches.length!==1||event.target.closest('button:not(.meta),input')){touchStart=null;return;}
    const point=event.touches[0];touchStart={row,id:row.dataset.track,touchId:point.identifier,x:point.clientX,y:point.clientY,cancelled:false};
  },{passive:true});
  document.addEventListener('touchmove',event=>{
    if(!touchStart||event.touches.length!==1){touchStart=null;return;}
    const point=event.touches[0];
    if(point.identifier!==touchStart.touchId){touchStart=null;return;}
    const dx=point.clientX-touchStart.x,dy=point.clientY-touchStart.y;
    // Once the user is scrolling vertically, the gesture must never trigger a deck action.
    if(Math.abs(dy)>18&&Math.abs(dy)>Math.abs(dx)*0.7)touchStart.cancelled=true;
  },{passive:true});
  document.addEventListener('touchend',event=>{
    const start=touchStart;touchStart=null;
    if(!start||start.cancelled||!start.row.isConnected||event.touches.length||!event.changedTouches.length)return;
    const point=[...event.changedTouches].find(t=>t.identifier===start.touchId);
    if(!point)return;
    const dx=point.clientX-start.x,dy=point.clientY-start.y;
    if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.35||!track(start.id))return;
    // Left swipe queues Deck A; right swipe queues Deck B on the paired remote bridge.
    const deck=dx<0?'1':'2';
    showGesture(start.row,deck);
    if(!remote){notify('Deck '+deckLabel(deck)+' selected · tap Load to send from this laptop.');return;}
    if(!canTarget()||!asList(state.capabilities.deckTargets).includes(deck)){
      notify('Deck '+deckLabel(deck)+' queue unavailable. Pair your laptop or use the visible deck buttons.',true);
      return;
    }
    // A quick repeated touch on the same row/deck must not enqueue the same intent twice.
    if(lastAutoSwipe.id===start.id&&lastAutoSwipe.deck===deck&&event.timeStamp-lastAutoSwipe.at<1200)return;
    lastAutoSwipe={id:start.id,deck,at:event.timeStamp};
    void loadDeck(Number(deck),start.id);
  },{passive:true});
  document.addEventListener('touchcancel',()=>{touchStart=null;},{passive:true});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.tab)return tab(button.dataset.tab);
    if(button.dataset.filter){state.filter=button.dataset.filter;state.detail=null;state.detailQuery='';state.limit=80;document.querySelectorAll('[data-filter]').forEach(node=>node.classList.toggle('active',node===button));return renderBrowse();}
    if(button.dataset.select){state.selected=button.dataset.select;renderDecks();document.querySelectorAll('.track.selected').forEach(node=>node.classList.remove('selected'));document.querySelectorAll('.track[data-track]').forEach(node=>node.classList.toggle('selected',node.dataset.track===state.selected));return notify('Selected for Deck A or B.');}
    if(button.dataset.swipeDeck)return loadDeck(Number(button.dataset.swipeDeck),button.dataset.trackId);
    if(button.dataset.swipeStage)return stageTrack(button.dataset.swipeStage,button.dataset.trackId);
    if(button.id==='playlist-back')return closeDetail();
    if(button.dataset.add)return action('queue.add',{trackId:button.dataset.add});
    if(button.dataset.remove)return action('queue.remove',{trackId:button.dataset.remove,index:Number(button.dataset.index)});
    if(button.dataset.shift)return action('queue.reorder',{from:Number(button.dataset.index),to:Number(button.dataset.index)+Number(button.dataset.shift)});
    if(button.dataset.album)return openDetail('album',button.dataset.album);
    if(button.dataset.playlist)return openDetail(button.dataset.playlistType==='native'?'native':'playlist',button.dataset.playlist);
    if(button.dataset.genre)return openDetail('genre',button.dataset.genre,button.textContent.trim());
    if(button.dataset.deck)return loadDeck(Number(button.dataset.deck));
    if(button.id==='connect-laptop')return connectLaptop();
    if(button.id==='connect-cancel')return cancelPairing();
    if(button.id==='edit-pairing'){
      pairingOpen=!pairingOpen;
      renderConnection();
      if(pairingOpen)$('pair-token').focus();
      return;
    }
    if(button.id==='refresh')return refresh();
    if(button.id==='show-more'){if(state.detail){state.detailLimit+=80;return renderDetail();}state.limit+=80;return renderBrowse();}
    if(button.id==='clear-queue'){if(state.hub.queue.length&&confirm('Clear all tracks from Next Up?'))return action('queue.clear');}
    if(button.id==='smart-order')return reorderSmart();
    if(button.dataset.localStage){
      const deck=button.dataset.localStage,trackId=selectedLocalId();
      if(!trackId)return notify('Select a valid local track.',true);
      // A fresh preview heartbeat, not the command response, confirms staging.
      return stageTrack(deck,trackId);
    }
    if(button.dataset.localPlay){
      const deck=button.dataset.localPlay;
      return queueLocalCommand({action:'local.play',deck},'Deck '+(deck==='1'?'A':'B')+' play');
    }
    if(button.dataset.localSeek){
      const deck=button.dataset.localSeek,control=$('local-seek-'+deck);
      const sec=Number(control.value);
      if(!control.value.trim()||!Number.isFinite(sec)||sec<0||sec>86400)return notify('Seek must be between 0 and 86400 seconds.',true);
      return queueLocalCommand({action:'local.seek',deck,positionSec:sec},'Deck '+(deck==='1'?'A':'B')+' seek to '+sec+'s');
    }
    if(button.id==='local-fade-send'){
      const target=Number($('local-fade-target').value)/100;
      const input=$('local-fade-duration'),durationMs=Number(input.value);
      if(!Number.isFinite(target)||target<0||target>1||!input.value.trim()||!Number.isInteger(durationMs)||durationMs<100||durationMs>30000)return notify('Fade duration must be 100–30000 ms.',true);
      return queueLocalCommand({action:'local.fade',target,durationMs},'Local crossfade to '+Math.round(target*100)+'% over '+durationMs+'ms');
    }
    if(button.id==='local-automix-start')return queueLocalCommand({action:'local.autoMixStart'},'Local auto-mix start');
    if(button.id==='local-automix-stop')return queueLocalCommand({action:'local.autoMixStop'},'Local auto-mix stop');
    if(button.id==='forget-token'){
      if(devicePaired)try{await pairingRequest('/api/remote/v1/pair/revoke',{method:'POST',body:{}});}catch{}
      cancelPairing();devicePaired=false;pairingToken='';pairingOpen=false;
      try{sessionStorage.removeItem(TOKEN_KEY);}catch{}
      $('pair-token').value='';state.hubReady=false;state.libraryReady=false;state.capabilities={};state.preview=null;
      delete stageAwaiting['1'];delete stageAwaiting['2'];state.tracks=[];state.byId.clear();
      state.nativePlaylists=[];state.nativeCache.clear();state.detail=null;
      state.hub={queue:[],playlists:[],favorites:[]};
      $('local-audio-feedback').textContent='Disconnected from local preview controller.';
      render();return;
    }
    if(button.id==='auto-transition'){
      if(!remote||state.capabilities.autoTransition!==true)return;
      const endpoint=state.capabilities.autoTransitionEndpoint;
      if(typeof endpoint!=='string'||!endpoint.startsWith('/api/remote/v1/')||!/^\/api\/remote\/v1\/[a-z0-9/_-]+$/.test(endpoint))return notify('Auto-transition command is not available on this bridge.',true);
      if(!confirm('Request auto-transition from the laptop engine?'))return;
      state.busy=true;render();
      try{await get(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});notify('Auto-transition request accepted by laptop.');}
      catch(error){notify('Auto-transition unavailable: '+error.message,true);}
      finally{state.busy=false;render();}
    }
  });
  $('pairing').addEventListener('submit',async event=>{
    event.preventDefault();
    const token=$('pair-token').value.trim();
    if(token.length<32)return notify('Enter the complete bridge token.',true);
    pairingToken=token;state.hubReady=false;state.libraryReady=false;
    try{sessionStorage.setItem(TOKEN_KEY,token);}catch{}
    $('pair-token').value='';
    await refresh();
    if(state.hubReady&&state.libraryReady){
      pairingOpen=false;renderConnection();
      try{
        const upgraded=await pairingRequest('/api/remote/v1/pair/enroll',{method:'POST',body:{}});
        if(upgraded.connected){devicePaired=true;pairingToken='';try{sessionStorage.removeItem(TOKEN_KEY);}catch{}}
      }catch{}
      notify('Phone connected to laptop.');
    }
  });
  $('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderSearch,140);});
  $('playlist-detail-search').addEventListener('input',()=>{state.detailQuery=$('playlist-detail-search').value;state.detailLimit=80;clearTimeout(searchTimer);searchTimer=setTimeout(renderDetail,140);});
  $('local-fade-target').addEventListener('input',()=>{$('local-fade-value').textContent=$('local-fade-target').value+'%';});
  // Heartbeats expire after 10 seconds, so keep visible controls in sync.
  setInterval(()=>{if(remote&&authenticated()&&document.visibilityState==='visible')void refreshRemoteStatus();},5000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void recoverPhoneLogin();});
  tab('browse');void recoverPhoneLogin();
})();
