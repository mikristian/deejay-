/* Music Hub Studio: lyrics, timed karaoke, Camelot discovery and visual cue planning.
 * Source tracks/verified deck feedback come from app.js. Nothing here starts Rekordbox playback.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const asArray = value => Array.isArray(value) ? value : [];
  const camelot = track => /^([1-9]|1[0-2])[AB]$/i.test(String(track?.camelot || '')) ? String(track.camelot).toUpperCase() : '';
  const fmt = seconds => { const v=Math.max(0,Math.floor(Number(seconds)||0)); return `${Math.floor(v/60)}:${String(v%60).padStart(2,'0')}`; };
  const ownKey = track => String(track?.id ?? '');
  const OPTIONS = ['lyrics','karaoke','harmonic','autoqueue','visuals'];
  const EFFECTS = [['rings','Monochrome rings'],['cathedral','Cathedral tracery'],['signal','Signal bars'],['embers','Quiet particles'],['off','No visuals']];
  const moods = {smooth:'Smooth blend',lift:'Lift the energy',deep:'Ease the tempo',explore:'Explore related keys'};
  const state = {tab:'lyrics',source:'selected',mode:'reader',sync:'preview',time:0,offset:0,trackId:'',lyrics:{available:false,format:null,text:''},parsed:[],activeLine:-1,editor:false,onlineAt:0,onlineBlockedUntil:0,lookupAttempted:new Set(),onlineCache:new Map(),lookupId:null,lookupUrl:'',wheelKey:'',mood:'smooth',follow:false,lastFollowId:'',visualTarget:'',visuals:{},request:0};
  let bridge = null, mounted = false, rendering = false;

  function currentDeck(slot) {
    const decks = bridge?.getDecks?.() || {};
    return slot === 'a' ? (decks.a || decks.stagedA || null) : (decks.b || decks.stagedB || null);
  }
  function sourceTrack() {
    if(state.source==='a'||state.source==='b')return currentDeck(state.source);
    return bridge?.getSelected?.() || null;
  }
  function selectedLabel() {
    const track=sourceTrack();
    return track ? `${track.title||'Untitled'} · ${track.artist||'Unknown artist'}` : 'Select a track or stage one in Deck A/B';
  }
  function updateLauncher() {
    const current=bridge?.getSelected?.();
    if($('studio-launcher-status'))$('studio-launcher-status').textContent=current?`${current.title||'Untitled'} · ${current.artist||'Unknown artist'}`:'Select a track to begin';
  }
  function open(tab='lyrics') {
    if(!mounted)return;
    state.tab=OPTIONS.includes(tab)?tab:'lyrics';
    $('studio-panel').hidden=false;
    drawTab();
    if(['lyrics','karaoke'].includes(state.tab))loadLyrics();
    if(['harmonic','autoqueue'].includes(state.tab))renderHarmonic();
    if(state.tab==='visuals')renderVisuals();
  }
  function close() { if(!$('studio-panel'))return; $('studio-panel').hidden=true;$('studio-panel').classList.remove('studio-theater'); }
  function drawTab() {
    $('studio-heading').textContent=({lyrics:'Lyrics library',karaoke:'Karaoke stage',harmonic:'Camelot harmonic wheel',autoqueue:'Assisted Auto Queue',visuals:'Visual effects / TouchDesigner'})[state.tab];
    $('studio-subtitle').textContent=state.tab==='autoqueue'?'Prepare suggestions from actual keys, tempo and tagged genre. No automatic deck loading.':state.tab==='visuals'?'Assign visual cues to a song or Music Hub playlist. TouchDesigner export is a future bridge.':selectedLabel();
    document.querySelectorAll('[data-studio-page]').forEach(section=>section.hidden=section.dataset.studioPage!==state.tab);
    document.querySelectorAll('[data-studio-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.studioTab===state.tab)));
    document.querySelectorAll('[data-studio-open]').forEach(button=>button.classList.toggle('active',button.dataset.studioOpen===state.tab));
    $('studio-source').value=state.source;
    $('studio-source-wrap').hidden=state.tab==='visuals';
    $('studio-theater-toggle').hidden=!['lyrics','karaoke','visuals'].includes(state.tab);
    $('studio-harmonic-source').textContent='Reference: '+selectedLabel();
    if(['lyrics','karaoke'].includes(state.tab))renderLyrics();
  }
  const secondsFor = (mm, ss, frac='') => Number(mm)*60+Number(ss)+(frac ? Number('0.'+frac.padEnd(3,'0').slice(0,3)) : 0);
  function parseLyrics(raw) {
    const results=[];
    for(const original of String(raw||'').replace(/\r/g,'').split('\n')) {
      const starts=[...original.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
      const noLineTags=original.replace(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g,'').trim();
      if(/^\[(ar|ti|al|by|offset|length):/i.test(original))continue;
      if(!starts.length){if(original.trim())results.push({time:null,text:original.trim(),words:[]});continue;}
      const wordMarkers=[...noLineTags.matchAll(/<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>/g)];
      const words=[];
      if(wordMarkers.length){
        for(let i=0;i<wordMarkers.length;i++){
          const hit=wordMarkers[i],next=wordMarkers[i+1];
          const segment=noLineTags.slice(hit.index+hit[0].length,next?next.index:undefined);
          if(segment)words.push({time:secondsFor(hit[1],hit[2],hit[3]),text:segment});
        }
      }
      const clean=noLineTags.replace(/<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>/g,'').trim();
      for(const stamp of starts)results.push({time:secondsFor(stamp[1],stamp[2],stamp[3]),text:clean,words});
    }
    const timed=results.filter(x=>x.time!==null);
    if(timed.length)results.sort((a,b)=>(a.time===null?Infinity:a.time)-(b.time===null?Infinity:b.time));
    return results.slice(0,1000);
  }
  function setStatus(message,warning=false) {
    for(const id of ['studio-lyric-status','studio-karaoke-status']){
      const el=$(id);if(el){el.textContent=message;el.classList.toggle('studio-warning',warning);}
    }
  }
  async function loadLyrics() {
    const song=sourceTrack(),id=ownKey(song),token=++state.request;
    state.trackId=id;
    if(!id){state.lyrics={available:false,text:'',format:null};state.parsed=[];setStatus('Choose a track to display or import lyrics.');renderLyrics();return;}
    setStatus('Loading saved lyrics…');
    try {
      const response=await fetch('/api/music-hub/lyrics?trackId='+encodeURIComponent(id),{cache:'no-store'});
      if(!response.ok)throw new Error(`Lyrics endpoint returned HTTP ${response.status}`);
      const data=await response.json();if(token!==state.request||id!==state.trackId)return;
      const cached=state.onlineCache.get(id);
      state.lyrics=data.available?{available:true,format:data.format||'plain',text:data.text||'',source:data.source||'user'}:
        cached?{...cached,available:true}:{available:false,format:'plain',text:'',source:null};
      state.parsed=parseLyrics(state.lyrics.text);
      state.activeLine=-1;
      setStatus(data.available?'Saved lyrics · '+(data.format==='plain'?'reading view':data.format==='elrc'?'word timing':'line timing'):
        cached?'Showing the previously matched LRCLIB lyrics. Edit → Save for offline access.':'Lyrics not yet available for this track. Search LRCLIB or import your own LRC/text file.');
    }catch(error) {
      if(token!==state.request)return;
      state.lyrics={available:false,text:'',format:'plain'};state.parsed=[];
      setStatus('Lyrics storage unavailable: '+error.message,true);
    }
    renderLyrics();
    // On-demand, once per track per session: viewing the lyrics panel can
    // retrieve a matching record. Never crawl the 12k-song library in bulk.
    if(!state.lyrics.available && song?.title && song?.artist &&
       !state.lookupAttempted.has(id) && Date.now()-state.onlineAt>=3000 &&
       Date.now()>=state.onlineBlockedUntil){
      state.lookupAttempted.add(id);
      onlineLyrics(true);
    }
  }
  function lyricTime() {
    const audio=$('preview-audio');
    const track=sourceTrack();
    if(state.sync==='preview' && audio && track && audio.getAttribute('data-track')===ownKey(track)&&Number.isFinite(audio.currentTime))return Math.max(0,audio.currentTime+state.offset);
    return Math.max(0,state.time+state.offset);
  }
  function isAudioSync() {
    const t=sourceTrack(),audio=$('preview-audio');
    return !!(state.sync==='preview'&&t&&audio?.getAttribute('data-track')===ownKey(t)&&audio.readyState>=1);
  }
  function lyricsMarkup(mode) {
    if(!state.parsed.length)return `<div class="studio-lyrics-empty"><strong>No lyrics saved for this song</strong><p>Search for a matching record, import .lrc/.txt, or paste your own lyrics. Timed karaoke requires timestamped lyrics.</p></div>`;
    const timed=state.parsed.some(x=>x.time!==null);
    const animated=mode==='karaoke';
    return state.parsed.map((line,i)=>{
      const words=animated&&line.words?.length?line.words.map((word,j)=>`<span class="studio-karaoke-word" data-word="${j}">${esc(word.text)}</span>`).join(''):esc(line.text||'♪');
      return `<div class="studio-lyric-line${timed?' timed':''}" data-line="${i}" tabindex="${timed?'0':'-1'}" ${line.time!==null?`title="${fmt(line.time)} · click to seek"`:''}><span class="studio-line-text">${words}</span>${line.time!==null&&mode==='reader'?`<small>${fmt(line.time)}</small>`:''}</div>`;
    }).join('');
  }
  function renderLyrics() {
    if(!$('studio-lyrics-view'))return;
    $('studio-song-name').textContent=selectedLabel();
    $('studio-karaoke-song').textContent=selectedLabel();
    $('studio-lyrics-view').innerHTML=lyricsMarkup('reader');
    $('studio-karaoke-view').innerHTML=lyricsMarkup('karaoke');
    $('studio-lyric-format').textContent=state.lyrics.available?(state.lyrics.format||'plain').toUpperCase():'NO LYRICS';
    $('studio-lyrics-editor').value=state.lyrics.text||'';
    $('studio-lyrics-format').value=['plain','lrc','elrc'].includes(state.lyrics.format)?state.lyrics.format:'plain';
    $('studio-source').value=state.source;
    $('studio-sync').value=state.sync;
    $('studio-editor').hidden=!state.editor;
    $('studio-lyric-time').textContent=fmt(lyricTime());
    const t=sourceTrack(),secs=Number(t?.length??t?.duration)||0;
    $('studio-manual-seek').max=String(Math.max(60,Math.ceil(secs)||240));
    $('studio-manual-seek').value=String(Math.min(Number($('studio-manual-seek').max),state.time));
    $('studio-manual-box').hidden=state.sync!=='manual';
    $('studio-audio-sync-note').textContent=state.parsed.length&&!state.parsed.some(line=>line.time!==null)?'This file has no timestamps. Add [mm:ss.xx] markers for synced lines or enhanced word timings for karaoke.':state.sync==='preview'?(isAudioSync()?'Following the local audio preview clock.':'Start Local Preview below to synchronize; otherwise select Manual rehearsal.'):'Manual rehearsal clock · drag the timeline. No audio is started.';
    applyKaraokeVisual();
    updateLyricFrame(true);
  }
  function updateLyricFrame(force=false) {
    if(!$('studio-panel')||$('studio-panel').hidden||!['lyrics','karaoke'].includes(state.tab))return;
    if(!state.parsed.length)return;
    const current=lyricTime(),withTime=state.parsed.filter(line=>line.time!==null);
    const active=withTime.length?state.parsed.reduce((idx,line,i)=>line.time!==null&&line.time<=current+0.02?i:idx,-1):-1;
    const activeChanged=active!==state.activeLine;state.activeLine=active;
    for(const id of ['studio-lyrics-view','studio-karaoke-view']){
      const root=$(id);if(!root)continue;
      if(activeChanged||force){root.querySelectorAll('[data-line]').forEach(row=>{const i=Number(row.dataset.line);row.classList.toggle('current',i===active);row.classList.toggle('past',active>=0&&i<active);});}
      const line=active>=0?state.parsed[active]:null;
      if(id==='studio-karaoke-view'&&line){
        const next=state.parsed.slice(active+1).find(x=>x.time!==null)?.time ?? current+5;
        const start=line.time??current,end=Math.max(start+.25,next);
        const percent=Math.max(0,Math.min(100,(current-start)/(end-start)*100));
        const row=root.querySelector(`[data-line="${active}"]`);if(row)row.style.setProperty('--line-progress',percent+'%');
        row?.querySelectorAll('.studio-karaoke-word').forEach((node,j)=>{
          const word=line.words[j],wordStart=word?.time??start,wordEnd=line.words[j+1]?.time??end;
          node.style.setProperty('--word-progress',Math.max(0,Math.min(100,(current-wordStart)/Math.max(.1,wordEnd-wordStart)*100))+'%');
        });
      }
      if(activeChanged&&active>=0)root.querySelector(`[data-line="${active}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});
    }
    $('studio-lyric-time').textContent=fmt(current);
    if(state.sync==='manual')$('studio-manual-seek').value=String(Math.min(Number($('studio-manual-seek').max),Math.max(0,state.time)));
  }
  async function saveLyrics() {
    if(!sourceTrack()){setStatus('Select a song first.',true);return;}
    const format=$('studio-lyrics-format').value,text=$('studio-lyrics-editor').value;
    if(new TextEncoder().encode(text).length>16384){setStatus('Lyrics must be 16 KiB or smaller per track.',true);return;}
    $('studio-save-lyrics').disabled=true;setStatus('Saving lyrics to your Music Hub…');
    try {
      const response=await fetch('/api/music-hub/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'lyrics.set',trackId:state.trackId,format,text})});
      const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'Save failed');
      state.lyrics={available:!!text.trim(),text,format,source:'user'};state.parsed=parseLyrics(text);state.editor=false;
      if(!text.trim())state.onlineCache.delete(state.trackId);
      setStatus(text.trim()?'Lyrics saved in Music Hub.':'Lyrics cleared for this track.');renderLyrics();bridge?.onHubChange?.();
    }catch(error){setStatus('Could not save lyrics: '+error.message,true);}
    finally{$('studio-save-lyrics').disabled=false;}
  }
  async function onlineLyrics(automatic=false) {
    const t=sourceTrack();if(!t?.title||!t?.artist){setStatus('A track with a title and artist is needed for exact lookup.',true);return;}
    const now=Date.now();
    if(now<state.onlineBlockedUntil){setStatus('LRCLIB requested a pause. Please retry in '+Math.ceil((state.onlineBlockedUntil-now)/1000)+' seconds.',true);return;}
    if(now-state.onlineAt<3000){if(!automatic)setStatus('Please allow a few seconds between online lookups.',true);return;}
    state.onlineAt=now;
    $('studio-find-lyrics').disabled=true;setStatus('Checking LRCLIB for a matching title, artist and duration…');
    const params=new URLSearchParams({track_name:t.title,artist_name:t.artist});
    if(t.album)params.set('album_name',t.album);
    if(Number(t.length)>1&&Number(t.length)<3600)params.set('duration',String(Math.round(Number(t.length))));
    const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),9000);
    try {
      const response=await fetch('https://lrclib.net/api/get?'+params,{signal:abort.signal,headers:{'Lrclib-Client':'MusicHub/1.0 (personal local DJ library)'}});
      if(response.status===404){setStatus('No matching lyrics found in LRCLIB. You can import your own file.');return;}
      if(response.status===429||response.status===503){
        const delay=Math.min(3600,Math.max(1,Number(response.headers.get('Retry-After'))||60));
        state.onlineBlockedUntil=Date.now()+delay*1000;
        setStatus('LRCLIB asked clients to retry after '+delay+' seconds. Lookup paused.',true);return;
      }
      if(!response.ok)throw new Error('LRCLIB HTTP '+response.status);
      const data=await response.json();
      if(data.instrumental){setStatus('LRCLIB marks this track as instrumental.');return;}
      if(ownKey(t)!==state.trackId)return;
      const found=String(data.syncedLyrics||data.plainLyrics||'');if(!found.trim())throw new Error('No lyric text in this record');
      if(new TextEncoder().encode(found).length>16384)throw new Error('Provider lyrics exceed the local 16 KiB limit');
      if(state.onlineCache.size>=100)state.onlineCache.delete(state.onlineCache.keys().next().value);
      state.onlineCache.set(state.trackId,{format:data.syncedLyrics?'lrc':'plain',text:found,source:'lrclib-preview'});
      state.lyrics={available:true,format:data.syncedLyrics?'lrc':'plain',text:found,source:'lrclib-preview'};
      state.parsed=parseLyrics(found);state.activeLine=-1;
      state.editor=false;
      renderLyrics();
      state.lookupId=data.id;state.lookupUrl=data.id?'https://lrclib.net/api/get/'+encodeURIComponent(data.id):'https://lrclib.net';
      setStatus('Showing LRCLIB match: '+(data.trackName||t.title)+' · '+(data.artistName||t.artist)+'. Use Edit lyrics → Save for offline access.');
    }catch(error){setStatus('Online lookup unavailable: '+(error.name==='AbortError'?'request timed out':error.message),true);}
    finally{clearTimeout(timeout);$('studio-find-lyrics').disabled=false;}
  }
  function keyNum(value){return Number(String(value).slice(0,-1));}
  function compatibleKey(a,b){
    if(!a||!b)return '';
    const x=keyNum(a),y=keyNum(b),ma=a.slice(-1),mb=b.slice(-1);
    if(a===b)return 'Same key';
    if(x===y&&ma!==mb)return 'Relative major/minor';
    if(ma===mb&&((x-y+12)%12===1||(y-x+12)%12===1))return 'Adjacent Camelot';
    return '';
  }
  function baseReference(){
    const source=sourceTrack();
    return source || bridge?.getSelected?.() || bridge?.getHub?.()?.queue?.map(id=>bridge.getTrack(id)).find(Boolean) || null;
  }
  function pickCandidates(limit=15,reference=null) {
    const ref=reference||baseReference(),hub=bridge?.getHub?.()||{},excluded=new Set(asArray(hub.queue).map(String));
    // Automatic follow always matches the *playing* source's actual key; a
    // manually selected wheel segment only affects manual exploration.
    const requested=reference?camelot(reference):(state.wheelKey||camelot(ref)),tempo=Number(ref?.bpm)||0,genre=String(ref?.genre||'').toLowerCase();
    if(!requested)return [];
    const scoring=[];
    for(const t of bridge?.getTracks?.()||[]){
      if(ownKey(t)===ownKey(ref)||excluded.has(ownKey(t)))continue;
      const match=compatibleKey(requested,camelot(t));if(!match)continue;
      const target=Number(t.bpm)||0,delta=tempo&&target?target-tempo:0;
      const percent=tempo&&target?Math.abs(delta)/tempo*100:null;
      const sameGenre=Boolean(genre&&String(t.genre||'').toLowerCase()===genre);
      let score=match==='Same key'?76:match==='Relative major/minor'?72:68;
      if(percent!==null)score+=Math.max(-25,20-percent*1.8);
      if(sameGenre)score+=6;
      if(state.mood==='lift'&&delta>0&&delta<15)score+=9;
      if(state.mood==='deep'&&delta<0&&delta>-15)score+=9;
      if(state.mood==='explore'&&match!=='Same key')score+=11;
      if(state.mood==='smooth'&&percent!==null&&percent<3)score+=9;
      score+=Math.min(5,Number(hub.ratings?.[ownKey(t)]||0));
      scoring.push({track:t,match,delta:tempo&&target?delta:null,percent,score});
    }
    return scoring.sort((a,b)=>b.score-a.score||(Number(a.percent??Infinity)-Number(b.percent??Infinity))||String(a.track.title).localeCompare(String(b.track.title))).slice(0,limit);
  }
  function makeWheel() {
    const items=[];
    for(let i=1;i<=12;i++)for(const ring of ['B','A']){
      const angle=((i-1)*30-90)*Math.PI/180,radius=ring==='B'?151:106,x=190+Math.cos(angle)*radius,y=190+Math.sin(angle)*radius;
      const key=i+ring,hue=(i-1)*30,active=key===state.wheelKey,related=compatibleKey(state.wheelKey,key);
      items.push(`<g class="studio-wheel-node${active?' selected':''}${related&&!active?' related':''}" data-wheel-key="${key}" role="button" tabindex="0" aria-label="Filter ${key}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="20" fill="hsl(${hue} 22% ${ring==='B'?25:17}%)" stroke="${active?'#f6f8fb':related?'#879cac':'#4c555e'}" stroke-width="${active?3:1.2}"/><text x="${x.toFixed(1)}" y="${(y+4).toFixed(1)}" text-anchor="middle" fill="#f2f5f7">${key}</text></g>`);
    }
    return `<svg viewBox="0 0 380 380" role="group" aria-label="Interactive Camelot harmonic wheel"><circle cx="190" cy="190" r="181" fill="#101317" stroke="#313940" stroke-width="2"/><circle cx="190" cy="190" r="128" fill="#161b20" stroke="#323b44"/><circle cx="190" cy="190" r="75" fill="#0c0f12" stroke="#35404a"/><text x="190" y="181" text-anchor="middle" fill="#f1f3f5" font-size="15" font-weight="700">CAMELOT</text><text x="190" y="203" text-anchor="middle" fill="#8d99a3" font-size="11">${esc(state.wheelKey||'SELECT KEY')}</text>${items.join('')}</svg>`;
  }
  function renderHarmonic(){
    for(const id of ['studio-wheel','studio-autowheel']){const el=$(id);if(el)el.innerHTML=makeWheel();}
    for(const id of ['studio-wheel-current','studio-autowheel-current']){if($(id))$(id).textContent=state.wheelKey||camelot(baseReference())||'Choose a key';}
    $('studio-mood').value=state.mood;
    $('studio-follow').checked=state.follow;
    const ref=baseReference(),matches=pickCandidates();
    const list=matches.length?matches.map((item,i)=>{
      const t=item.track,delta=item.delta===null?'Tempo unknown':`${item.delta>=0?'+':''}${item.delta.toFixed(1)} BPM`;
      return `<article class="studio-match"><span class="studio-match-index">${i+1}</span><div><strong>${esc(t.title||'Untitled')}</strong><small>${esc(t.artist||'Unknown artist')} · ${esc(camelot(t))} · ${Number(t.bpm)||'—'} BPM</small><span>${esc(item.match)} · ${esc(delta)}${t.genre?' · '+esc(t.genre):''}</span></div><button type="button" data-studio-queue="${esc(ownKey(t))}" title="Add to Music Hub Next Up">+ Queue</button></article>`;
    }).join(''):'<p class="studio-empty">Select a track with a valid Camelot key, or click a wheel key, to see matches in your real collection.</p>';
    $('studio-harmonic-matches').innerHTML=list;
    $('studio-auto-matches').innerHTML=list;
    const stats=matches.length?`${matches.length} candidate tracks found · reference ${camelot(ref)||state.wheelKey||'unknown'} · ${state.mood} metadata preference`:'No compatible candidates in the current filter';
    $('studio-match-status').textContent=stats;
    if(!state.follow||!$('studio-auto-status').dataset.eventMessage){
      $('studio-auto-status').textContent=state.follow?'Follow armed for verified playing deck changes or local preview playback. Only Music Hub Next Up changes.':'Auto Queue is manual until Follow is enabled. Matching uses metadata, not measured energy.';
    }
  }
  async function queueTracks(count=1,reference=null){
    const matches=pickCandidates(count,reference);if(!matches.length){$('studio-auto-status').textContent='No compatible tracks to queue.';return;}
    let added=0;
    for(const match of matches){if(await bridge?.enqueue?.(ownKey(match.track)))added++;else break;}
    $('studio-auto-status').dataset.eventMessage='true';
    $('studio-auto-status').textContent=`Added ${added} of ${matches.length} suggested tracks to Music Hub Next Up. Playback is unchanged.`;
    renderHarmonic();
  }
  async function onDeckChange(){
    if(['a','b'].includes(state.source)&&!$('studio-panel').hidden){if(['lyrics','karaoke'].includes(state.tab)){if(ownKey(sourceTrack())!==state.trackId)loadLyrics();}else renderHarmonic();}
    if(!state.follow)return;
    const deck=bridge?.getDecks?.()||{};
    const playing=[deck.a,deck.b].find(t=>t&&t.playing===true&&t.verified===true);
    if(!playing)return;
    const id=ownKey(playing);if(!id||state.lastFollowId===id)return;
    state.lastFollowId=id;
    await queueTracks(1,playing);
  }
  async function onLocalPreviewPlay(){
    if(!state.follow||!mounted)return;
    const id=$('preview-audio')?.getAttribute('data-track');
    const playing=id?bridge?.getTrack?.(id):null;
    if(!playing||state.lastFollowId===ownKey(playing))return;
    state.lastFollowId=ownKey(playing);
    await queueTracks(1,playing);
  }
  function loadVisuals(){try {const data=JSON.parse(localStorage.getItem('music-hub-studio-visuals-v1')||'{}');return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}}
  function saveVisuals(){try{localStorage.setItem('music-hub-studio-visuals-v1',JSON.stringify(state.visuals));return true;}catch{return false;}}
  function visualTargets() {
    const t=bridge?.getSelected?.(),hub=bridge?.getHub?.()||{},items=[];
    if(t)items.push({value:'track:'+ownKey(t),label:'Track: '+(t.title||'Untitled')});
    for(const p of asArray(hub.playlists))items.push({value:'playlist:'+p.id,label:'Playlist: '+p.name});
    if(['native','local'].includes(bridge?.getContext?.()?.view||'')){
      const c=bridge.getContext();items.push({value:c.view+':'+c.playlistId,label:'Current '+c.view+' playlist'});
    }
    return items;
  }
  function resolvedVisualBinding(track){
    if(!track)return null;
    const id=ownKey(track),direct=state.visuals['track:'+id];
    if(direct)return direct;
    const context=bridge?.getContext?.()||{};
    const ref=context.playlistId&&['local','native'].includes(context.view)?state.visuals[context.view+':'+context.playlistId]||state.visuals['playlist:'+context.playlistId]:null;
    if(ref)return ref;
    const membership=asArray(bridge?.getHub?.()?.playlists).find(p=>asArray(p.trackIds).map(String).includes(id)&&state.visuals['playlist:'+p.id]);
    return membership?state.visuals['playlist:'+membership.id]:null;
  }
  function applyKaraokeVisual(){
    const stage=$('studio-karaoke-view');if(!stage)return;
    const binding=resolvedVisualBinding(sourceTrack());
    stage.dataset.effect=binding?.effect||'off';
    const bpm=Number(sourceTrack()?.bpm)||120;
    stage.style.setProperty('--beat-seconds',Math.max(.25,Math.min(2,60/bpm))+'s');
    stage.style.setProperty('--visual-intensity',Math.min(1,Math.max(0,Number(binding?.intensity??60)/100)).toFixed(2));
  }
  function visualCue(){
    const t=sourceTrack()||bridge?.getSelected?.(),assignment=state.visuals[state.visualTarget]||{};
    const matching=t&&state.visuals['track:'+ownKey(t)];
    const selected=matching||resolvedVisualBinding(t)||assignment;
    return {schema:'music-hub.visual-cue.v1',target:state.visualTarget||null,trackId:t?ownKey(t):null,title:t?.title||null,artist:t?.artist||null,bpm:Number(t?.bpm)||null,camelot:camelot(t)||null,genre:t?.genre||null,effect:selected.effect||'rings',scene:selected.scene||'',intensity:Number(selected.intensity??60),source:'Music Hub cue preview',playbackVerified:false};
  }
  function applyVisual(){
    const cue=visualCue(),stage=$('studio-visual-stage');if(!stage)return;
    stage.dataset.effect=cue.effect;
    stage.style.setProperty('--beat-seconds',Math.max(.25,Math.min(2,60/(cue.bpm||120)))+'s');
    stage.style.setProperty('--visual-intensity',(cue.intensity/100).toFixed(2));
    $('studio-visual-cue').textContent=`${cue.effect.toUpperCase()} · ${cue.bpm||'—'} BPM · ${cue.camelot||'KEY UNKNOWN'} · ${cue.scene||'No TouchDesigner scene assigned'}`;
  }
  function renderVisuals(){
    const select=$('studio-visual-target'),opts=visualTargets();
    if(!opts.some(x=>x.value===state.visualTarget))state.visualTarget=opts[0]?.value||'';
    select.innerHTML=opts.length?opts.map(x=>`<option value="${esc(x.value)}">${esc(x.label)}</option>`).join(''):'<option value="">Select a track or create a Music Hub playlist</option>';
    select.value=state.visualTarget;
    const entry=state.visuals[state.visualTarget]||{};
    $('studio-effect').value=entry.effect||'rings';
    $('studio-scene').value=entry.scene||'';
    $('studio-intensity').value=String(entry.intensity??60);
    $('studio-intensity-label').textContent=$('studio-intensity').value+'%';
    applyVisual();
  }
  function saveVisualCue(){
    if(!state.visualTarget){$('studio-visual-status').textContent='Select a track or playlist first.';return;}
    if(Object.keys(state.visuals).length>=1000 && !state.visuals[state.visualTarget]){$('studio-visual-status').textContent='1000 visual bindings already saved.';return;}
    state.visuals[state.visualTarget]={effect:$('studio-effect').value,scene:$('studio-scene').value.trim().slice(0,160),intensity:Number($('studio-intensity').value)};
    $('studio-visual-status').textContent=saveVisuals()?'Saved this visual cue on this device.':'Local device storage unavailable.';
    applyVisual();
  }
  function exportCue(){
    const cue=visualCue();const json=JSON.stringify(cue,null,2);
    const blob=new Blob([json],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='music-hub-visual-cue.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    window.dispatchEvent(new CustomEvent('music-hub:visual-cue',{detail:cue}));
    $('studio-visual-status').textContent='Exported cue JSON and dispatched a local studio cue event. No TouchDesigner connection was started.';
  }
  function renderShell(){
    $('studio-panel').innerHTML=`<div class="studio-panel-head"><div><span class="studio-eyebrow">MUSIC HUB STUDIO</span><h2 id="studio-heading">Lyrics library</h2><p id="studio-subtitle">Choose a song.</p></div><div class="studio-head-actions"><button id="studio-theater-toggle" title="Expand the studio">Expand</button><button id="studio-close" aria-label="Close studio">×</button></div></div>
    <div class="studio-subnav" role="tablist" aria-label="Studio tools"><button data-studio-tab="lyrics">Reader</button><button data-studio-tab="karaoke">Animated karaoke</button><button data-studio-tab="harmonic">Harmonic wheel</button><button data-studio-tab="autoqueue">Auto Queue</button><button data-studio-tab="visuals">Visuals</button></div>
    <div class="studio-source-row"><label id="studio-source-wrap">LYRICS / MIX SOURCE<select id="studio-source"><option value="selected">Selected track</option><option value="a">Deck A · loaded or staged</option><option value="b">Deck B · loaded or staged</option></select></label><span class="studio-source-caveat">Deck previews are preparation only. Actual playback remains in Rekordbox.</span></div>
    <div data-studio-page="lyrics"><div class="studio-lyric-controls"><strong id="studio-song-name"></strong><span id="studio-lyric-format"></span><button id="studio-find-lyrics">Find on LRCLIB</button><button id="studio-import-trigger">Import LRC / TXT</button><button id="studio-edit-toggle">Edit lyrics</button><input type="file" accept=".lrc,.txt,text/plain" id="studio-lyric-file" hidden></div><div id="studio-lyric-status" class="studio-status" role="status"></div><div id="studio-lyrics-view" class="studio-lyrics-reader"></div>
      <div id="studio-editor" class="studio-editor" hidden><label>LYRIC FORMAT<select id="studio-lyrics-format"><option value="plain">Plain / unsynced</option><option value="lrc">LRC · timed lines</option><option value="elrc">Enhanced LRC · word timing</option></select></label><textarea id="studio-lyrics-editor" rows="7" maxlength="16384" placeholder="Paste lyrics, [00:12.40] line timestamps, or enhanced &lt;00:12.40&gt;word timing"></textarea><div class="studio-editor-actions"><button id="studio-save-lyrics" class="studio-primary">Save lyrics</button><button id="studio-editor-cancel">Cancel</button><span>User-managed lyrics · saved separately from Rekordbox</span></div></div></div>
    <div data-studio-page="karaoke" hidden><div class="studio-karaoke-bar"><strong id="studio-karaoke-song"></strong><label>SYNC<select id="studio-sync"><option value="preview">Local audio preview</option><option value="manual">Manual rehearsal</option></select></label><label>OFFSET <input id="studio-lyric-offset" type="number" step="0.1" min="-30" max="30" value="0" aria-label="Lyric offset in seconds"> s</label><span id="studio-lyric-time">0:00</span></div><p id="studio-audio-sync-note" class="studio-caption"></p><div id="studio-karaoke-view" class="studio-karaoke-view"></div><div id="studio-manual-box" class="studio-manual"><label for="studio-manual-seek">Rehearsal timeline</label><input type="range" id="studio-manual-seek" min="0" max="240" value="0" step="0.05"></div><div id="studio-karaoke-status" class="studio-status"></div></div>
    <div data-studio-page="harmonic" hidden><div class="studio-harmonic-layout"><div class="studio-wheel-wrap"><span>CLICK A KEY TO FILTER RECOMMENDATIONS</span><div id="studio-wheel" class="studio-wheel"></div><strong id="studio-wheel-current"></strong><button data-wheel-reset="true">Use selected song key</button></div><div class="studio-harmonic-results"><p id="studio-harmonic-source"></p><p id="studio-match-status"></p><div id="studio-harmonic-matches" class="studio-match-list"></div></div></div></div>
    <div data-studio-page="autoqueue" hidden><div class="studio-auto-header"><div><h3>Choose the next tracks by harmonic fit and vibe</h3><p>Uses real Camelot key, BPM, genre when tagged, and your personal stars. No audio energy analysis is inferred.</p></div><label>VIBE <select id="studio-mood"><option value="smooth">Smooth blend</option><option value="lift">Faster tempo</option><option value="deep">Ease the tempo</option><option value="explore">Explore related keys</option></select></label></div><div class="studio-auto-actions"><button id="studio-auto-one" class="studio-primary">Add best next song</button><button id="studio-auto-three">Build 3-song queue</button><label class="studio-follow"><input id="studio-follow" type="checkbox"> Follow verified playing deck or local preview</label></div><div id="studio-auto-status" class="studio-status"></div><div class="studio-auto-layout"><div><div id="studio-autowheel" class="studio-wheel studio-small-wheel"></div><strong id="studio-autowheel-current"></strong></div><div id="studio-auto-matches" class="studio-match-list"></div></div></div>
    <div data-studio-page="visuals" hidden><div class="studio-visual-layout"><div class="studio-visual-controls"><h3>Assign a visual cue</h3><p>Bind a local visual preset or future TouchDesigner scene identifier to a song or playlist.</p><label>TARGET<select id="studio-visual-target"></select></label><label>EFFECT<select id="studio-effect">${EFFECTS.map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></label><label>TOUCHDESIGNER SCENE / OPERATOR NAME<input id="studio-scene" maxlength="160" placeholder="e.g. /project1/lyrics_comp"></label><label>INTENSITY <span id="studio-intensity-label">60%</span><input id="studio-intensity" type="range" min="0" max="100" value="60" step="5"></label><div class="studio-auto-actions"><button id="studio-save-visual" class="studio-primary">Save binding</button><button id="studio-export-cue">Export cue JSON</button></div><div id="studio-visual-status" class="studio-status"></div><p class="studio-caption">TouchDesigner is not connected. This stores a cue contract for a future local OSC/WebSocket bridge.</p></div><div id="studio-visual-stage" data-effect="rings" class="studio-visual-stage"><div class="studio-visual-rings"></div><div class="studio-visual-tracery"></div><div class="studio-visual-bars"></div><div class="studio-visual-particles"></div><div class="studio-visual-overlay"><span>STUDIO VISUAL PREVIEW</span><strong>LIVE CUE DESIGNER</strong><small id="studio-visual-cue"></small></div></div></div></div>`;
    $('studio-close').addEventListener('click',close);
    $('studio-theater-toggle').addEventListener('click',()=>{const value=$('studio-panel').classList.toggle('studio-theater');$('studio-theater-toggle').textContent=value?'Minimize':'Expand';});
    $('studio-panel').addEventListener('click',event=>{
      const tab=event.target.closest('[data-studio-tab]');if(tab){open(tab.dataset.studioTab);return;}
      const keyButton=event.target.closest('[data-wheel-key]');if(keyButton){state.wheelKey=keyButton.dataset.wheelKey;renderHarmonic();return;}
      if(event.target.closest('[data-wheel-reset]')){state.wheelKey='';renderHarmonic();return;}
      const queue=event.target.closest('[data-studio-queue]');if(queue){bridge?.enqueue?.(queue.dataset.studioQueue).then(()=>renderHarmonic());return;}
      const line=event.target.closest('.studio-lyric-line[data-line]');if(line){const n=Number(line.dataset.line),time=state.parsed[n]?.time;if(time!==null&&time!==undefined){if(isAudioSync())$('preview-audio').currentTime=time;else state.time=time;updateLyricFrame(true);}}
    });
    $('studio-panel').addEventListener('keydown',event=>{const key=event.target.closest('[data-wheel-key]');if(key&&(event.key==='Enter'||event.key===' ')){event.preventDefault();state.wheelKey=key.dataset.wheelKey;renderHarmonic();}});
    $('studio-source').addEventListener('change',event=>{state.source=event.target.value;state.wheelKey='';if(['lyrics','karaoke'].includes(state.tab))loadLyrics();else if(['harmonic','autoqueue'].includes(state.tab))renderHarmonic();else renderVisuals();drawTab();});
    $('studio-sync').addEventListener('change',event=>{state.sync=event.target.value;renderLyrics();});
    $('studio-manual-seek').addEventListener('input',event=>{state.time=Number(event.target.value);updateLyricFrame(true);});
    $('studio-lyric-offset').addEventListener('input',event=>{state.offset=Math.max(-30,Math.min(30,Number(event.target.value)||0));updateLyricFrame(true);});
    $('studio-edit-toggle').addEventListener('click',()=>{state.editor=!state.editor;renderLyrics();});
    $('studio-editor-cancel').addEventListener('click',()=>{state.editor=false;renderLyrics();});
    $('studio-save-lyrics').addEventListener('click',saveLyrics);
    $('studio-find-lyrics').addEventListener('click',()=>onlineLyrics(false));
    $('studio-import-trigger').addEventListener('click',()=>$('studio-lyric-file').click());
    $('studio-lyric-file').addEventListener('change',async e=>{
      const file=e.target.files?.[0];if(!file)return;
      if(file.size>16384){setStatus('File exceeds 16 KiB lyric limit.',true);e.target.value='';return;}
      state.editor=true;$('studio-lyrics-editor').value=await file.text();$('studio-lyrics-format').value=file.name.toLowerCase().endsWith('.lrc')?'lrc':'plain';$('studio-editor').hidden=false;
      setStatus('Imported '+file.name+'. Review and Save to associate it with this track.');e.target.value='';
    });
    $('studio-mood').addEventListener('change',e=>{state.mood=e.target.value;renderHarmonic();});
    $('studio-auto-one').addEventListener('click',()=>queueTracks(1));$('studio-auto-three').addEventListener('click',()=>queueTracks(3));
    $('studio-follow').addEventListener('change',e=>{state.follow=e.target.checked;state.lastFollowId='';delete $('studio-auto-status').dataset.eventMessage;renderHarmonic();});
    $('studio-visual-target').addEventListener('change',e=>{state.visualTarget=e.target.value;renderVisuals();});
    for(const id of ['studio-effect','studio-scene','studio-intensity'])$(id).addEventListener('input',()=>{
      $('studio-intensity-label').textContent=$('studio-intensity').value+'%';
      const stage=$('studio-visual-stage');stage.dataset.effect=$('studio-effect').value;
      stage.style.setProperty('--visual-intensity',(Number($('studio-intensity').value)/100).toFixed(2));
    });
    $('studio-save-visual').addEventListener('click',saveVisualCue);$('studio-export-cue').addEventListener('click',exportCue);
  }
  function init(api) {
    if(mounted)return;
    bridge=api;mounted=true;state.visuals=loadVisuals();renderShell();
    document.querySelector('.studio-launcher')?.addEventListener('click',event=>{const button=event.target.closest('[data-studio-open]');if(button)open(button.dataset.studioOpen);});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('studio-panel').hidden){if($('studio-panel').classList.contains('studio-theater'))$('studio-panel').classList.remove('studio-theater');else close();}});
    $('preview-audio')?.addEventListener('play',onLocalPreviewPlay);
    updateLauncher();
    const frame=()=>{if(!document.hidden&&mounted)updateLyricFrame();requestAnimationFrame(frame);};
    requestAnimationFrame(frame);
  }
  function onSelectionChange(){updateLauncher();if(!mounted||$('studio-panel').hidden)return;if(['lyrics','karaoke'].includes(state.tab)){if(state.source==='selected')loadLyrics();}else if(['harmonic','autoqueue'].includes(state.tab)){state.wheelKey='';renderHarmonic();}else renderVisuals();drawTab();}
  function onHubChange(){if(!mounted||$('studio-panel').hidden)return;if(['autoqueue','harmonic'].includes(state.tab))renderHarmonic();if(state.tab==='visuals')renderVisuals();}
  window.MusicHubStudio={init,open,onSelectionChange,onHubChange,onDeckChange,parseLyrics,compatibleKey,pickCandidates};
})();
