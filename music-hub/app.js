/* Music Hub: same-origin, read-only Rekordbox metadata + explicitly requested Hub actions. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const model = { tracks: [], byId: new Map(), nativePlaylists: [], hub: { queue: [], playlists: [], favorites: [], setlists: [], ratings: {} }, hubAvailable: false, view: 'all', groupId: null, playlistId: null, playlistTracks: [], selected: null, candidates: [], sorted: [], grid: false, pending: false, currentDetail: null, candidateToken: 0, detailToken: 0 };
  const ROW_HEIGHT = 50;
  let browseIndex=new Map(),browseIndexRows=null,browseHeavyTimer=null;
  const camelotHue = k => {const n=Number(text(k).slice(0,-1));return n>=1&&n<=12?Math.round((n-1)*30):null;};
  const keyStyle = t => {const hue=camelotHue(key(t));return hue===null?'':`style="--key-hue:${hue};--key-color:hsl(${hue} 77% 69%)"`;};
  let searchTimer, toastTimer, dialogReturnFocus = null, assignedTrackId = null;
  const text = (v) => v == null ? '' : String(v);
  const escapeHtml = (v) => text(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toId = (v) => text(v);
  const asArray = (v) => Array.isArray(v) ? v : [];
  const uniqueIds = (v) => asArray(v).map(toId);
  const duration = (seconds) => { if (!Number.isFinite(Number(seconds))) return '—'; const s = Math.round(Number(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2,'0')}`; };
  const bpm = (t) => Number(t?.bpm) > 0 ? Number(t.bpm).toFixed(Number(t.bpm) % 1 ? 1 : 0) : '—';
  const key = (t) => /^\d{1,2}[AB]$/i.test(text(t?.camelot)) ? text(t.camelot).toUpperCase() : '';
  const track = (id) => model.byId.get(toId(id));
  const notify = (message, error = false) => { const node = $('toast'); node.textContent = message; node.classList.toggle('error',error); node.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'), 4200); };
  const api = async (path, options = {}) => { const response = await fetch(path, {cache: 'no-store', ...options}); const raw = await response.text(); let data; try { data = raw ? JSON.parse(raw) : {}; } catch { throw Error(`API returned a non-JSON response (${response.status})`); } if (!response.ok || data?.error || data?.ok === false || data?.success === false) throw Error(text(data?.error || data?.message || `HTTP ${response.status}`)); return data; };
  const post = (path, data) => api(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  let savedProviderLinks=[];
  let spotifyVerified=false, spotifyMode='playlists', spotifyListToken=0;
  let appleLocalReady=false,appleLocalToken=0,appleLocalPlaylistId='',appleLocalOffset=0,appleLocalHasMore=false,appleLocalPlaylists=[];
  let soundcloudToken=0,soundcloudConnected=false,soundcloudMode='playlists';
  let soundcloudCollectionCursor='',soundcloudPlaylistCursor='',soundcloudPlaylistId='',soundcloudCollectionCount=0,soundcloudPlaylistCount=0;
  const providerCopy={spotify:{name:'',id:'',rows:[],checked:0,total:null,complete:false,pending:false,saved:false},'apple-local':{name:'',id:'',rows:[],checked:0,total:null,complete:false,pending:false,saved:false},'soundcloud-likes':{name:'',id:'',rows:[],checked:0,total:null,complete:false,pending:false,saved:false},'soundcloud-playlist':{name:'',id:'',rows:[],checked:0,total:null,complete:false,pending:false,saved:false}};
  const MATCH_CAP=250;
  function matchedTrackIds(rows) {
    const seen=new Set(),ids=[];
    for(const item of rows.slice(0,MATCH_CAP)) {
      const match=item?.localMatch||item?.local_match;
      const id=text(match?.trackId);
      if(match?.status==='matched'&&/^[0-9]+$/.test(id)&&id!=='0'&&!seen.has(id)){
        seen.add(id);ids.push(id);
      }
    }
    return ids;
  }
  function resetProviderCopy(provider,name='',id='') {
    const state=providerCopy[provider];
    state.name=name;state.id=id;state.rows=[];state.checked=0;state.total=null;state.complete=false;state.pending=false;state.saved=false;state.savedCount=0;
    const panel=$(provider+'-copy-panel');panel.hidden=!id;
    renderProviderCopy(provider);
  }
  function renderProviderCopy(provider){
    const state=providerCopy[provider],button=$(provider+'-copy-matched'),count=$(provider+'-copy-count'),limit=$(provider+'-copy-limit');
    if(!state||!button)return;
    const ids=matchedTrackIds(state.rows),examined=Math.min(state.checked,MATCH_CAP);
    if(provider.startsWith('soundcloud-')){
      const eligible=ids.filter(id=>Boolean(track(id)));
      const moreAvailable=provider==='soundcloud-likes'?Boolean(soundcloudCollectionCursor):Boolean(soundcloudPlaylistCursor);
      count.textContent=state.saved?'Copied '+state.savedCount+' verified local songs into a Music Hub playlist.':state.pending?'Copying verified local songs…':eligible.length+' locally matched song'+(eligible.length===1?'':'s')+' in '+examined+' loaded songs (duplicates removed).';
      limit.textContent=state.checked>=MATCH_CAP?'First 250 loaded songs checked. Further pages can be browsed but will not be copied.':moreAvailable?'Only loaded songs are checked; more SoundCloud pages are available. First 250 maximum.':'Only verified local Rekordbox IDs from loaded songs are copied (first 250 maximum).';
      button.disabled=!soundcloudConnected||!state.id||state.pending||state.saved||!eligible.length||!model.hubAvailable;
      button.textContent=state.saved?'Copied to Music Hub':state.pending?'Copying…':'Copy matched tracks from loaded songs ('+eligible.length+')';
      button.title=button.disabled?(state.saved?'Already copied this loaded selection':!model.hubAvailable?'Music Hub storage unavailable':!ids.length?'No verified local Rekordbox matches among loaded songs':'SoundCloud account disconnected'):ids.length+' existing local Rekordbox songs will be copied from the loaded SoundCloud songs';
      return;
    }
    const total=Number.isFinite(Number(state.total))&&state.total!==null?Number(state.total):null;
    const covered=total===null?examined:Math.min(total,MATCH_CAP);
    const pending=!state.complete;
    count.textContent=pending?'Checking verified Rekordbox matches…':state.saved?'Saved '+ids.length+' verified local songs as a Music Hub playlist.':ids.length?ids.length+' locally matched song'+(ids.length===1?'':'s')+' in '+examined+' checked (duplicates removed).':'0 locally matched songs in '+examined+' checked. Nothing to copy.';
    limit.textContent=total> MATCH_CAP?'Only the first 250 of '+total+' provider songs were checked.':'Only locally matched Rekordbox song IDs will be copied.';
    if(provider==='spotify'&&total===null&&examined===MATCH_CAP)limit.textContent='Spotify returns up to 250 songs. More songs may exist; only the first 250 were checked.';
    if(!pending&&total!==null&&examined<covered)limit.textContent='Only '+examined+' of '+covered+' provider songs could be checked. Copy is unavailable.';
    button.disabled=pending||state.pending||state.saved||!ids.length||!model.hubAvailable||(total!==null&&examined<covered);
    button.textContent=state.saved?'Copied to Music Hub':state.pending?'Copying…':'Copy locally matched songs';
    button.title=button.disabled?(state.saved?'This provider playlist was already copied in this view':pending?'Matching tracks…':!ids.length?'No verified local Rekordbox matches available':'Music Hub storage unavailable or incomplete scan'):ids.length+' local songs will be added to a new Music Hub playlist';
  }
  async function copyProviderMatches(provider){
    const state=providerCopy[provider],ids=matchedTrackIds(state.rows);
    const isSoundCloud=provider.startsWith('soundcloud-');
    if((!isSoundCloud&&!state.complete)||(isSoundCloud&&!soundcloudConnected)||state.pending||state.saved||!state.id||!ids.length||!model.hubAvailable)return;
    const selectedId=state.id,selectedRows=state.rows;
    const copyIds=isSoundCloud?ids.filter(id=>Boolean(track(id))):ids;
    if(!copyIds.length)return;
    state.pending=true;renderProviderCopy(provider);
    const name=(isSoundCloud?'SoundCloud · ':provider==='spotify'?'Spotify · ':'Apple Music · ')+state.name;
    // User action creates one Music Hub playlist from existing Rekordbox track IDs.
    const success=await hubAction('playlist.create',{name:name.slice(0,100),trackIds:copyIds});
    if(state.id!==selectedId||state.rows!==selectedRows)return;
    state.pending=false;renderProviderCopy(provider);
    if(success){state.saved=true;state.savedCount=copyIds.length;renderProviderCopy(provider);notify('Copied '+copyIds.length+' locally matched songs to “'+name.slice(0,100)+'”');}
  }
  const localMatchBadge=(match)=>match?.status==='matched'&&/^\d+$/.test(text(match.trackId))?'<span class="provider-match">Already in Rekordbox ✓</span>':match?.status==='ambiguous'?'<span class="provider-match provider-match-ambiguous">Multiple local copies</span>':'';
  function localDjActions(match) {
    const id=text(match?.trackId);
    if(match?.status!=='matched'||!/^\d+$/.test(id)||!track(id))return '';
    const safe=escapeHtml(id);
    return '<div class="provider-catalog-actions provider-local-actions" aria-label="Existing local Rekordbox file actions">'+
      '<button type="button" data-local-queue="'+safe+'" title="Add this existing local file to Music Hub Next Up">＋ Queue</button>'+
      '<button type="button" data-local-stage="1" data-local-track="'+safe+'" title="Stage the existing local file on Deck A without playing it">A</button>'+
      '<button type="button" data-local-stage="2" data-local-track="'+safe+'" title="Stage the existing local file on Deck B without playing it">B</button></div>';
  }
  const appleLocalRows=response=>Array.isArray(response)?response:asArray(response?.items||response?.playlists||response?.tracks);
  function renderAppleLocalTracks(items,{append=false}={}) {
    const target=$('apple-local-playlist-tracks');
    const markup=items.map(item=>{
      const title=text(item.title||item.name||'Untitled track');
      const artist=text(item.artist||item.artistName||'Unknown artist');
      const match=item.localMatch||item.local_match;
      const badge=localMatchBadge(match);
      return '<article class="provider-catalog-item"><div class="provider-catalog-icon" aria-hidden="true">♪</div><div class="provider-catalog-copy"><strong>'+escapeHtml(title)+'</strong><small>'+escapeHtml(artist)+' · Mac Music '+badge+'</small></div>'+localDjActions(match)+'</article>';
    }).join('');
    if(append)target.insertAdjacentHTML('beforeend',markup);
    else target.innerHTML=markup||'<p class="provider-empty">This playlist has no tracks.</p>';
  }
  async function refreshAppleLocalStatus(){
    const token=++appleLocalToken;appleLocalReady=false;$('apple-local-library').hidden=true;resetProviderCopy('apple-local');
    $('apple-local-status-pill').textContent='Checking';$('apple-local-status-message').textContent='Checking access to the Mac Music library…';
    try{
      const status=await api('/api/music-hub/apple-local/status');if(token!==appleLocalToken)return;
      if(status.running===false||status.available===false||status.accessible===false||status.error||status.permission==='denied'||status.authorized===false){throw Error(text(status.message||status.error||'Music automation access is unavailable'));}
      appleLocalReady=true;$('apple-local-status-pill').textContent='Mac Music';
      $('apple-local-status-message').textContent='Mac Music library is available'+(Number.isFinite(Number(status.libraryTrackCount))?' · '+Number(status.libraryTrackCount).toLocaleString()+' tracks':'')+'. Browse playlists and verified Rekordbox matches.';
      $('apple-local-library').hidden=false;await loadAppleLocalPlaylists();
    }catch(error){if(token!==appleLocalToken)return;$('apple-local-status-pill').textContent='Unavailable';$('apple-local-status-message').textContent='Could not read Mac Music: '+error.message+'. Allow Music automation access for this app in macOS Privacy & Security if prompted.';}
  }
  async function loadAppleLocalPlaylists(){
    if(!appleLocalReady)return;const token=++appleLocalToken,target=$('apple-local-playlists');
    resetProviderCopy('apple-local');$('apple-local-playlist-detail').hidden=true;target.hidden=false;target.textContent='Loading Mac Music playlists…';
    try{
      const response=await api('/api/music-hub/apple-local/playlists');if(token!==appleLocalToken||!appleLocalReady)return;
      if(response.running===false)throw Error('The Music app has closed. Reopen Music and refresh.');
      const playlists=appleLocalRows(response);
      $('apple-local-summary').textContent=playlists.length+' Music playlists · read-only';
      appleLocalPlaylists=playlists;renderApplePlaylistChoices();
      /* The list is filtered locally so typing never triggers another Music.app request. */
    }catch(error){if(token===appleLocalToken)target.textContent='Could not list Mac Music playlists: '+error.message;}
  }
  function renderApplePlaylistChoices(){
    const target=$('apple-local-playlists');
    const term=$('apple-local-search').value.trim().toLocaleLowerCase();
    const matches=appleLocalPlaylists.filter(p=>text(p.name||p.title||'').toLocaleLowerCase().includes(term));
    $('apple-local-visible').textContent=term?matches.length+' of '+appleLocalPlaylists.length:'';
    target.innerHTML=matches.length?matches.map(p=>{
      const id=text(p.id||p.playlistId);if(!/^[a-f0-9]{16}$/i.test(id))return '';
      const name=text(p.name||p.title||'Untitled playlist');
      const count=p.trackCount??p.track_count??p.count;
      return '<article class="provider-catalog-item provider-playlist-row"><div class="provider-catalog-icon" aria-hidden="true">≡</div><div class="provider-catalog-copy"><strong>'+escapeHtml(name)+'</strong><small>Mac Music'+(Number.isFinite(Number(count))?' · '+escapeHtml(count)+' tracks':'')+'</small></div><button type="button" data-apple-local-playlist="'+escapeHtml(id)+'" data-apple-local-name="'+escapeHtml(name)+'">View tracks</button></article>';
    }).join(''):'<p class="provider-empty">'+(term?'No playlists match your search.':'No accessible Mac Music playlists were returned.')+'</p>';
  }
  async function loadAppleLocalPlaylist(id,name,{more=false}={}){
    if(!appleLocalReady||!/^[a-f0-9]{16}$/i.test(id))return;
    const token=++appleLocalToken,offset=more?appleLocalOffset:0,target=$('apple-local-playlist-tracks');
    const limit=100;
    if(!more){appleLocalPlaylistId=id;resetProviderCopy('apple-local',name,id);target.textContent='Loading playlist tracks and checking the first 250 for local matches. Large playlists may take a few seconds…';$('apple-local-playlist-name').textContent=name;$('apple-local-playlist-detail').hidden=false;$('apple-local-playlists').hidden=true;}
    $('apple-local-more').hidden=true;
    try{
      const result=await api('/api/music-hub/apple-local/playlist-items?id='+encodeURIComponent(id)+'&offset='+offset+'&limit='+limit);
      if(token!==appleLocalToken||!appleLocalReady)return;
      if(result.running===false)throw Error('The Music app has closed. Reopen Music and refresh.');
      const items=appleLocalRows(result);renderAppleLocalTracks(items,{append:more});
      const state=providerCopy['apple-local'];
      if(state.id===id){
        if(!more)state.rows=[];
        if(!state.complete){
          state.rows.push(...items.slice(0,Math.max(0,MATCH_CAP-state.rows.length)));
          state.checked=state.rows.length;
          state.total=Number.isFinite(Number(result.total))&&result.total!=null?Number(result.total):null;
          state.complete=!result.hasMore||state.checked>=MATCH_CAP;
          renderProviderCopy('apple-local');
        }
      }
      appleLocalOffset=offset+items.length;
      appleLocalHasMore=items.length>0&&(result.hasMore===true||(result.nextOffset!=null&&Number(result.nextOffset)>appleLocalOffset)||(result.total!=null&&Number(result.total)>appleLocalOffset));
      $('apple-local-more').hidden=!appleLocalHasMore;
      $('apple-local-more').textContent='Load 100 more tracks';
      if(!state.complete&&state.checked<MATCH_CAP&&appleLocalHasMore&&items.length){
        await loadAppleLocalPlaylist(id,name,{more:true});
      }else if(!state.complete){
        $('apple-local-copy-count').textContent='Playlist matching stopped before all requested songs could be checked.';
      }
    }catch(error){if(token===appleLocalToken){providerCopy['apple-local'].complete=false;renderProviderCopy('apple-local');if(more)notify('Could not load additional Mac Music tracks: '+error.message,true);else target.textContent='Could not load Mac Music playlist: '+error.message;}}
  }
  const safeSpotifyOpenUrl=(value)=>{try{const url=new URL(text(value));return url.protocol==='https:'&&url.hostname==='open.spotify.com'&&/^\/(?:playlist|track|album|artist)\/[A-Za-z0-9]+\/?$/.test(url.pathname)?url.href:null;}catch{return null;}};
  const spotifyLink=(value,label='Open on Spotify')=>{const safe=safeSpotifyOpenUrl(value);return safe?'<a href="'+escapeHtml(safe)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(label)+'</a>':'';};
  function showProviderTab(tab,{focus=false}={}) {
    if(!['links','spotify','apple_music','soundcloud'].includes(tab))tab='links';
    document.querySelectorAll('[data-provider-tab]').forEach(button=>{const selected=button.dataset.providerTab===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;if(selected&&focus)button.focus();});
    document.querySelectorAll('.provider-panel').forEach(panel=>{panel.hidden=panel.id!=='provider-panel-'+tab;});
    if(tab==='spotify')refreshSpotifyStatus();
    if(tab==='apple_music')refreshAppleLocalStatus();
    if(tab==='soundcloud')refreshSoundCloudStatus();
    if(tab!=='links')refreshProviderSetup(tab);
  }
  const providerNames={spotify:'Spotify',apple_music:'Apple Music',soundcloud:'SoundCloud'};
  const providerGuideUrls={spotify:'https://developer.spotify.com/dashboard',apple_music:'https://developer.apple.com/documentation/musickit',soundcloud:'https://developers.soundcloud.com/docs/api/guide'};
  function ensureProviderSearchPanels(){
    for(const [id,name] of Object.entries(providerNames)){
      const panel=$('provider-panel-'+id);if(!panel||panel.querySelector('.provider-connect-setup'))continue;
      if(id==='apple_music'){
        const button=document.createElement('button');button.type='button';button.id='apple-cloud-connect';
        button.className='primary-button';button.disabled=true;
        button.textContent='Sign in to Apple Music · setup required';
        button.title='A signed MusicKit developer token and authorized Music User Token are required to connect the Apple Music cloud account';
        panel.querySelector('.provider-connect-actions')?.prepend(button);
      }
      const section=document.createElement('section');section.className='provider-connect-setup';section.dataset.providerSetup=id;
      section.innerHTML='<div class="provider-setup-header"><strong>ACCOUNT CONNECTION</strong><span class="provider-setup-badge" data-setup-status="'+id+'">Checking</span></div><p class="provider-setup-description" data-setup-message="'+id+'">Checking developer configuration…</p><div class="provider-connect-guide"><a target="_blank" rel="noopener noreferrer" href="'+providerGuideUrls[id]+'">Developer setup instructions</a><span data-setup-hint="'+id+'">Secure provider authorization required to sync your account</span></div><form class="provider-catalog-search" data-provider-search="'+id+'"><label for="provider-query-'+id+'">Search '+name+'</label><div><input id="provider-query-'+id+'" name="query" type="search" placeholder="Artists, titles, playlists…" maxlength="150" required autocomplete="off"><button type="submit">Search '+name+'</button></div></form><div class="provider-search-results" data-search-results="'+id+'" aria-live="polite"></div>';
      panel.querySelector('.provider-service-head')?.after(section);
      section.querySelector('form').addEventListener('submit',async event=>{
        event.preventDefault();const q=section.querySelector('input').value.trim();if(!q)return;
        const results=section.querySelector('.provider-search-results');results.textContent='Checking the official '+name+' catalog…';
        try{
          const data=await api('/api/music-hub/providers/search?provider='+encodeURIComponent(id)+'&q='+encodeURIComponent(q));
          const link=text(data.externalSearchUrl),safe=(()=>{try{const u=new URL(link);return u.protocol==='https:'&&({spotify:'open.spotify.com',apple_music:'music.apple.com',soundcloud:'soundcloud.com'})[id]===u.hostname?u.href:null;}catch{return null;}})();
          const items=asArray(data.items);
          if(data.source==='official_api'){
            results.innerHTML='<p class="provider-search-notice">'+items.length+' result'+(items.length===1?'':'s')+' from Spotify’s authorized API. Streaming stays with Spotify.</p>'+items.map(item=>{
              const artists=asArray(item.artists).map(a=>text(a?.name||a)).filter(Boolean).join(', ')||text(item.artist||'Unknown artist');
              const match=item.localMatch||item.local_match;
              return '<div class="provider-catalog-item"><div class="provider-catalog-icon">♪</div><div class="provider-catalog-copy"><strong>'+escapeHtml(item.name||item.title||'Untitled')+'</strong><small>'+escapeHtml(artists)+(match?.status==='matched'?' · Local match':'')+'</small></div>'+localDjActions(match)+spotifyLink(item.external_urls?.spotify||item.externalUrl||item.url)+'</div>';
            }).join('');
          }else{
            results.innerHTML='<p class="provider-search-notice">'+escapeHtml(data.message||'Sign-in is not configured for in-app search.')+'</p>'+(safe?'<a class="provider-external-search" href="'+escapeHtml(safe)+'" target="_blank" rel="noopener noreferrer">Search directly on '+name+'</a>':'');
          }
        }catch(error){results.textContent='Search unavailable: '+error.message;}
      });
    }
  }
  async function refreshProviderSetup(provider){
    const badge=document.querySelector('[data-setup-status="'+provider+'"]'),message=document.querySelector('[data-setup-message="'+provider+'"]'),hint=document.querySelector('[data-setup-hint="'+provider+'"]');
    if(!badge||!message)return;
    try{const data=await api('/api/music-hub/providers/setup'),info=data.providers?.[provider];if(!info)throw Error('Provider status missing');
      badge.textContent=info.connected?'Connected':info.configured?'Ready to sign in':'Setup required';
      message.textContent=text(info.message||(info.connected?'Account access is enabled.':'Developer configuration is required before account sign-in.'));
      hint.textContent=info.connected?'Authorized metadata access ready':info.configured?'Use Connect '+providerNames[provider]+' above to authorize your library':'Configure developer app authorization to enable account sign-in and library sync';
    }catch(error){badge.textContent='Setup unavailable';message.textContent='Connection setup could not be checked: '+error.message;}
  }
  const soundcloudEntries=(response)=>Array.isArray(response)?response:asArray(response?.items||response?.playlists||response?.tracks||response?.likes||response?.collection);
  const soundcloudSafeUrl=value=>{try{const url=new URL(text(value));return url.protocol==='https:'&&['soundcloud.com','www.soundcloud.com','on.soundcloud.com'].includes(url.hostname)?url.href:null;}catch{return null;}};
  function renderSoundCloudTracks(items,target,{append=false}={}){
    const markup=items.map(entry=>{
      const t=entry?.track||entry;const name=text(t?.title||t?.name||'Untitled track');
      const artist=text(t?.user?.username||t?.artists||t?.artist||t?.publisher_metadata?.artist||'SoundCloud');
      const safe=soundcloudSafeUrl(t?.permalink_url||t?.permalinkUrl||t?.url);
      const creatorDownloadPage=t?.creatorDownloadEnabled===true?soundcloudSafeUrl(t?.url):null;
      const match=t?.localMatch||t?.local_match;
      return '<article class="provider-catalog-item"><div class="provider-catalog-icon" aria-hidden="true">♪</div><div class="provider-catalog-copy"><strong>'+escapeHtml(name)+'</strong><small>'+escapeHtml(artist)+' · SoundCloud '+localMatchBadge(match)+'</small></div>'+localDjActions(match)+(safe?'<a href="'+escapeHtml(safe)+'" target="_blank" rel="noopener noreferrer">Open</a>':'')+(creatorDownloadPage?'<a href="'+escapeHtml(creatorDownloadPage)+'" target="_blank" rel="noopener noreferrer" title="Check Download file on SoundCloud; original uploaded format, not necessarily MP3">Creator download ↗</a>':'')+'</article>';
    }).join('');
    if(append)target.insertAdjacentHTML('beforeend',markup);
    else target.innerHTML=markup||'<p class="provider-empty">No tracks returned.</p>';
  }
  async function refreshSoundCloudStatus(){
    const token=++soundcloudToken; soundcloudConnected=false;
    resetProviderCopy('soundcloud-likes');resetProviderCopy('soundcloud-playlist');
    $('soundcloud-library').hidden=true;$('soundcloud-connect').hidden=false;$('soundcloud-connect').disabled=true;$('soundcloud-connect').textContent='Checking sign-in…';$('soundcloud-disconnect').hidden=true;
    $('soundcloud-status-pill').textContent='Checking';$('soundcloud-status-message').textContent='Checking SoundCloud account setup…';
    try{
      const data=await api('/api/music-hub/soundcloud/status');if(token!==soundcloudToken)return;
      soundcloudConnected=data.connected===true||data?.status?.connected===true;
      const configured=data.configured===true||data?.status?.configured===true;
      $('soundcloud-status-pill').textContent=soundcloudConnected?'Connected':configured?'Ready to connect':'Setup required';
      $('soundcloud-status-message').textContent=soundcloudConnected?'SoundCloud account connected. Browse your playlists and liked tracks.':text(data.message||data.reason||(configured?'Sign in to authorize your SoundCloud library.':'Configure the SoundCloud developer app to enable sign-in.'));
      $('soundcloud-connect').hidden=soundcloudConnected;
      $('soundcloud-connect').disabled=!configured;
      $('soundcloud-connect').textContent=configured?'Sign in with SoundCloud':'Sign in unavailable · setup required';
      $('soundcloud-disconnect').hidden=!soundcloudConnected;
      $('soundcloud-library').hidden=!soundcloudConnected;
      if(soundcloudConnected)loadSoundCloudCollection(soundcloudMode);
    }catch(error){if(token!==soundcloudToken)return;$('soundcloud-connect').disabled=true;$('soundcloud-connect').textContent='Sign in unavailable · setup required';$('soundcloud-status-pill').textContent='Setup required';$('soundcloud-status-message').textContent='SoundCloud account integration is not available on this server yet. You can still save public SoundCloud links.';}
  }
  async function loadSoundCloudCollection(mode,{more=false}={}){
    if(!soundcloudConnected)return;
    if(more&&(!soundcloudCollectionCursor||mode!==soundcloudMode))return;
    soundcloudMode=mode;const token=++soundcloudToken;
    $('soundcloud-show-playlists').setAttribute('aria-pressed',String(mode==='playlists'));
    $('soundcloud-show-likes').setAttribute('aria-pressed',String(mode==='likes'));
    $('soundcloud-playlist-detail').hidden=true;$('soundcloud-library-list').hidden=false;
    const target=$('soundcloud-library-list'),button=$('soundcloud-more');
    if(!more){soundcloudCollectionCursor='';soundcloudCollectionCount=0;resetProviderCopy('soundcloud-likes',mode==='likes'?'Liked tracks':'',mode==='likes'?'likes':'');target.textContent='Loading '+(mode==='likes'?'liked tracks':'playlists')+'…';}
    button.hidden=true;
    try{
      const path='/api/music-hub/soundcloud/'+mode+'?limit=100'+(more?'&cursor='+encodeURIComponent(soundcloudCollectionCursor):'');
      const result=await api(path);if(token!==soundcloudToken||!soundcloudConnected)return;
      const items=soundcloudEntries(result);
      soundcloudCollectionCount+=items.length;
      soundcloudCollectionCursor=text(result.nextHref);
      button.hidden=!soundcloudCollectionCursor;
      button.textContent='Load more '+(mode==='likes'?'liked tracks':'playlists')+' ('+soundcloudCollectionCount+' shown)';
      if(mode==='likes'){
        const copy=providerCopy['soundcloud-likes'];
        copy.rows.push(...items.slice(0,Math.max(0,MATCH_CAP-copy.rows.length)));
        copy.checked=copy.rows.length;copy.complete=true;
        renderSoundCloudTracks(items,target,{append:more});renderProviderCopy('soundcloud-likes');return;
      }
      const markup=items.map(p=>{
        const id=text(p?.id);const name=text(p?.title||p?.name||'Untitled playlist');
        const safe=soundcloudSafeUrl(p?.permalink_url||p?.permalinkUrl||p?.url);
        const count=p.trackCount??p.track_count;
        return '<article class="provider-catalog-item"><div class="provider-catalog-icon">≡</div><div class="provider-catalog-copy"><strong>'+escapeHtml(name)+'</strong><small>SoundCloud playlist'+(count!=null&&Number.isFinite(Number(count))?' · '+escapeHtml(count)+' tracks':'')+'</small></div><div class="provider-catalog-actions">'+(safe?'<a href="'+escapeHtml(safe)+'" target="_blank" rel="noopener noreferrer">Open</a>':'')+(/^[0-9]+$/.test(id)?'<button type="button" data-soundcloud-playlist="'+escapeHtml(id)+'" data-soundcloud-name="'+escapeHtml(name)+'">View tracks</button>':'')+'</div></article>';
      }).join('');
      if(more)target.insertAdjacentHTML('beforeend',markup);
      else target.innerHTML=markup||'<p class="provider-empty">No playlists returned.</p>';
    }catch(error){if(token===soundcloudToken){button.hidden=!soundcloudCollectionCursor;if(more)notify('Could not load more SoundCloud '+mode+': '+error.message,true);else target.textContent='Could not load SoundCloud '+mode+': '+error.message;}}
  }
  async function openSoundCloudPlaylist(id,name,{more=false}={}){
    if(!soundcloudConnected||!/^[0-9]+$/.test(id))return;
    if(more&&(!soundcloudPlaylistCursor||soundcloudPlaylistId!==id))return;
    const token=++soundcloudToken;const target=$('soundcloud-playlist-tracks');
    const button=$('soundcloud-playlist-more');
    if(!more){soundcloudPlaylistId=id;soundcloudPlaylistCursor='';soundcloudPlaylistCount=0;resetProviderCopy('soundcloud-playlist',name,id);$('soundcloud-playlist-name').textContent=name;$('soundcloud-playlist-detail').hidden=false;$('soundcloud-library-list').hidden=true;target.textContent='Loading playlist tracks…';}
    button.hidden=true;
    try{
      const result=await api('/api/music-hub/soundcloud/playlist-items?id='+encodeURIComponent(id)+'&limit=100'+(more?'&cursor='+encodeURIComponent(soundcloudPlaylistCursor):''));
      if(token!==soundcloudToken||!soundcloudConnected)return;
      const items=soundcloudEntries(result);
      soundcloudPlaylistCount+=items.length;soundcloudPlaylistCursor=text(result.nextHref);
      const copy=providerCopy['soundcloud-playlist'];
      if(copy.id===id){copy.rows.push(...items.slice(0,Math.max(0,MATCH_CAP-copy.rows.length)));copy.checked=copy.rows.length;copy.complete=true;renderProviderCopy('soundcloud-playlist');}
      renderSoundCloudTracks(items,target,{append:more});
      button.hidden=!soundcloudPlaylistCursor;button.textContent='Load more tracks ('+soundcloudPlaylistCount+' shown)';
    }catch(error){if(token===soundcloudToken){button.hidden=!soundcloudPlaylistCursor;if(more)notify('Could not load more SoundCloud tracks: '+error.message,true);else target.textContent='Could not load SoundCloud playlist: '+error.message;}}
  }
  function spotifyConnectedStatus(data) {
    // A server-confirmed, connected account is required before fetching any private catalog endpoints.
    return data?.connected===true || data?.status?.connected===true || data?.spotify?.connected===true;
  }
  async function refreshSpotifyStatus() {
    const message=$('spotify-status-message'),pill=$('spotify-status-pill'),connect=$('spotify-connect');
    const token=++spotifyListToken;spotifyVerified=false;$('spotify-library').hidden=true;connect.hidden=false;connect.disabled=true;connect.textContent='Checking sign-in…';$('spotify-disconnect').hidden=true;resetProviderCopy('spotify');
    message.textContent='Checking Spotify account status…';pill.textContent='Checking';
    try{
      const data=await api('/api/music-hub/spotify/status');if(token!==spotifyListToken)return;
      spotifyVerified=spotifyConnectedStatus(data);
      const configured=data.configured===true||data?.status?.configured===true||data?.spotify?.configured===true;
      pill.textContent=spotifyVerified?'Connected':configured?'Ready to connect':'Setup required';
      message.textContent=spotifyVerified?'Connected as '+text(data.account?.displayName||data.account?.id||'Spotify user')+'. Browse your playlists and liked tracks below.':text(data.message||data.reason||(configured?'Connect your Spotify account to browse its playlists and liked tracks.':'Set MUSIC_HUB_SPOTIFY_CLIENT_ID in the Music Hub server environment, then register http://127.0.0.1:18769/api/music-hub/spotify/callback as the app redirect URI in Spotify developer settings.'));
      connect.hidden=spotifyVerified;
      connect.disabled=!configured;
      connect.textContent=configured?'Sign in with Spotify':'Sign in unavailable · setup required';
      $('spotify-disconnect').hidden=!spotifyVerified;
      $('spotify-library').hidden=!spotifyVerified;
      if(spotifyVerified)await loadSpotifyCollection(spotifyMode);
    }catch(error){if(token!==spotifyListToken)return;connect.disabled=true;connect.textContent='Sign in unavailable · setup required';pill.textContent='Unavailable';message.textContent='Spotify account status could not be verified: '+error.message+'. Public bookmarks remain available.';}
  }
  const spotifyCollection=(response,keys)=>{for(const k of keys){const value=response?.[k];if(Array.isArray(value))return value;if(Array.isArray(value?.items))return value.items;}return asArray(response?.items);};
  const spotifyTrack=(entry)=>entry?.track&&typeof entry.track==='object'?entry.track:entry;
  function renderSpotifyTracks(items,target) {
    target.innerHTML=items.length?items.map(entry=>{
      const t=spotifyTrack(entry);if(!t||typeof t!=='object')return '';
      const name=text(t.name||t.title||'Untitled track');
      const artists=asArray(t.artists).map(a=>text(a?.name||a)).filter(Boolean).join(', ')||text(t.artist||'Spotify');
      const url=t.external_urls?.spotify||t.externalUrl||t.url||t.spotifyUrl;
      const match=t.localMatch||t.local_match;
      const badge=match?.status==='matched'&&/^\d+$/.test(text(match.trackId))?'<span class="provider-match">Local ✓</span>':match?.status==='ambiguous'?'<span class="provider-match provider-match-ambiguous">Multiple local copies</span>':'';
      return '<article class="provider-catalog-item"><div class="provider-catalog-icon" aria-hidden="true">♪</div><div class="provider-catalog-copy"><strong>'+escapeHtml(name)+'</strong><small>'+escapeHtml(artists)+' · Spotify '+badge+'</small></div>'+localDjActions(match)+spotifyLink(url)+'</article>';
    }).join(''):'<p class="provider-empty">No tracks were returned for this view.</p>';
  }
  async function loadSpotifyCollection(mode) {
    if(!spotifyVerified)return;
    spotifyMode=mode;const token=++spotifyListToken;
    resetProviderCopy('spotify');
    $('spotify-show-playlists').setAttribute('aria-pressed',String(mode==='playlists'));
    $('spotify-show-saved').setAttribute('aria-pressed',String(mode==='saved'));
    $('spotify-playlist-detail').hidden=true;$('spotify-library-list').hidden=false;
    const target=$('spotify-library-list');target.textContent='Loading '+(mode==='saved'?'liked songs':'playlists')+'…';
    try{
      const response=await api('/api/music-hub/spotify/'+(mode==='saved'?'saved':'playlists'));
      if(token!==spotifyListToken||!spotifyVerified)return;
      if(mode==='saved')renderSpotifyTracks(spotifyCollection(response,['tracks','saved','songs']),target);
      else {
        const items=spotifyCollection(response,['playlists']);
        target.innerHTML=items.length?items.map(p=>{
          const id=text(p?.id),url=p?.external_urls?.spotify||p?.externalUrl||p?.url;
          const count=p?.tracks?.total??p?.items?.total??p?.trackCount;
          return '<article class="provider-catalog-item"><div class="provider-catalog-icon" aria-hidden="true">≡</div><div class="provider-catalog-copy"><strong>'+escapeHtml(p?.name||'Untitled playlist')+'</strong><small>Spotify playlist'+(Number.isFinite(Number(count))?' · '+escapeHtml(count)+' tracks':'')+'</small></div><div class="provider-catalog-actions">'+spotifyLink(url)+'<button type="button" data-spotify-playlist="'+escapeHtml(id)+'" data-spotify-playlist-name="'+escapeHtml(p?.name||'Playlist')+'">View tracks</button></div></article>';
        }).join(''):'<p class="provider-empty">No Spotify playlists were returned for this account.</p>';
      }
    }catch(error){if(token===spotifyListToken)target.textContent='Could not load Spotify '+(mode==='saved'?'liked songs':'playlists')+': '+error.message;}
  }
  async function openSpotifyPlaylist(id,name) {
    if(!spotifyVerified||!/^[A-Za-z0-9]{22}$/.test(id))return;
    const token=++spotifyListToken,target=$('spotify-playlist-tracks');
    resetProviderCopy('spotify',name,id);
    $('spotify-playlist-detail').hidden=false;$('spotify-library-list').hidden=true;$('spotify-playlist-name').textContent=name;
    target.textContent='Loading playlist tracks…';
    try{
      const data=await api('/api/music-hub/spotify/playlist-items?id='+encodeURIComponent(id));
      if(token!==spotifyListToken||!spotifyVerified)return;
      const items=spotifyCollection(data,['tracks','items']);
      renderSpotifyTracks(items,target);
      const state=providerCopy.spotify;
      if(state.id===id){
        state.rows=items.slice(0,MATCH_CAP).map(spotifyTrack);
        state.checked=state.rows.length;
        state.total=Number.isFinite(Number(data.total))&&data.total!=null?Number(data.total):null;
        state.complete=true;
        renderProviderCopy('spotify');
      }
    }catch(error){if(token===spotifyListToken)target.textContent='Could not load playlist tracks: '+error.message;}
  }
  function trustedProviderUrl(link) {
    try {const u=new URL(link.sourceUrl);return u.protocol==='https:'&&({
      spotify:'open.spotify.com',apple_music:'music.apple.com',soundcloud:'soundcloud.com'
    })[link.provider]===u.hostname ? u.href : null;}catch{return null;}
  }
  function renderProviderLinks() {
    const target=$('provider-link-list');if(!target)return;
    $('provider-count').textContent=savedProviderLinks.length+' saved music link'+(savedProviderLinks.length===1?'':'s');
    target.innerHTML=savedProviderLinks.length?savedProviderLinks.map(link=>{
      const safe=trustedProviderUrl(link);if(!safe)return '';
      const name={spotify:'Spotify',apple_music:'Apple Music',soundcloud:'SoundCloud'}[link.provider]||'Music';
      return '<article class="provider-link"><div><strong>'+escapeHtml(link.title||link.externalId||'Music link')+'</strong><small>'+name+' · '+escapeHtml(link.type||'link')+' · '+(link.status==='public_metadata_verified'?'public metadata verified':'link saved; contents not synced')+'</small></div><div class="provider-link-actions"><a href="'+escapeHtml(safe)+'" target="_blank" rel="noopener noreferrer">'+(link.provider==='soundcloud'&&link.type==='track'?'Open / check creator download':'Open service')+'</a><button type="button" data-provider-preview="'+escapeHtml(link.id)+'">Play / preview</button><button type="button" data-provider-refresh="'+escapeHtml(link.id)+'" title="Refresh public metadata" aria-label="Refresh public metadata for '+escapeHtml(link.title||link.externalId||'music link')+'">↻</button><button type="button" data-provider-remove="'+escapeHtml(link.id)+'" aria-label="Remove saved link">×</button></div></article>';
    }).join(''):'<p class="provider-empty">No music links saved yet. Paste a public playlist, album or track URL above.</p>';
  }
  async function refreshProviderLinks() {
    try{const response=await api('/api/music-hub/providers/links');savedProviderLinks=asArray(response.links);renderProviderLinks();}
    catch{$('provider-count').textContent='Link service unavailable';$('provider-link-list').textContent='Link storage is unavailable. Refresh after the provider service starts.';}
  }
  function providerPreview(link) {
    const safe=trustedProviderUrl(link),container=$('provider-embed-container');if(!safe)return;
    const u=new URL(safe);
    let source;
    if(link.provider==='spotify')source='https://open.spotify.com/embed'+u.pathname;
    else if(link.provider==='apple_music')source='https://embed.music.apple.com'+u.pathname;
    else source='https://w.soundcloud.com/player/?url='+encodeURIComponent(safe)+'&auto_play=false&download=true&show_artwork=true';
    container.replaceChildren();
    const frame=document.createElement('iframe');
    frame.src=source;frame.title='Official '+link.provider.replace('_',' ')+' player · '+text(link.title);
    frame.loading='lazy';frame.referrerPolicy='strict-origin-when-cross-origin';frame.allow='autoplay; encrypted-media; clipboard-write';
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-forms');
    container.append(frame);container.hidden=false;
  }
  function openProviderDialog(provider='') {
    const dialog=$('provider-dialog');if(!dialog)return;
    $('provider-url').placeholder=({spotify:'https://open.spotify.com/playlist/…',apple_music:'https://music.apple.com/us/playlist/…',soundcloud:'https://soundcloud.com/artist/sets/…'})[provider]||'Paste a Spotify, Apple Music, or SoundCloud URL';
    if(!dialog.open)dialog.showModal();showProviderTab(provider||'links');refreshProviderLinks();
    if(!provider)$('provider-url').focus();
  }
  function bindProviders() {
    ensureProviderSearchPanels();
    $('provider-dialog').addEventListener('click',async event=>{
      const queue=event.target.closest('[data-local-queue]');
      const stage=event.target.closest('[data-local-stage][data-local-track]');
      if(!queue&&!stage)return;
      const id=text(queue?.dataset.localQueue||stage?.dataset.localTrack);
      // Never queue or stage provider-only metadata: it must point to a
      // verified, already-loaded Rekordbox collection ID.
      if(!/^\d+$/.test(id)||!track(id)){
        notify('Only an existing local Rekordbox song can be queued or staged.',true);return;
      }
      if(queue){if(await hubAction('queue.add',{trackId:id}))notify('Added existing local song to Music Hub Next Up.');}
      else stageDeck(Number(stage.dataset.localStage),id);
    });
    $('provider-open').addEventListener('click',event=>{event.stopPropagation();openProviderDialog('apple_music');});
    document.querySelectorAll('[data-provider-open]').forEach(button=>{
      if(button.closest('#sidebar'))return;
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openProviderDialog(button.dataset.providerOpen==='links'?'apple_music':button.dataset.providerOpen);});
    });
    $('provider-close').addEventListener('click',()=>$('provider-dialog').close());
    $('provider-dialog').addEventListener('close',()=>{++spotifyListToken;++appleLocalToken;++soundcloudToken;resetProviderCopy('spotify');resetProviderCopy('apple-local');resetProviderCopy('soundcloud-likes');resetProviderCopy('soundcloud-playlist');$('provider-embed-container').replaceChildren();$('provider-embed-container').hidden=true;});
    $('provider-dialog').addEventListener('click',event=>{if(event.target===$('provider-dialog'))$('provider-dialog').close();});
    document.querySelectorAll('[data-provider-tab]').forEach(button=>{
      button.addEventListener('click',()=>showProviderTab(button.dataset.providerTab));
      button.addEventListener('keydown',event=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const tabs=['links','spotify','apple_music','soundcloud'],current=tabs.indexOf(button.dataset.providerTab);const next=event.key==='Home'?0:event.key==='End'?3:(current+(event.key==='ArrowRight'?1:3))%4;showProviderTab(tabs[next],{focus:true});});
    });
    document.querySelectorAll('[data-provider-fallback]').forEach(button=>button.addEventListener('click',()=>{const provider=button.dataset.providerFallback;showProviderTab('links');$('provider-url').placeholder=({spotify:'https://open.spotify.com/playlist/…',apple_music:'https://music.apple.com/us/playlist/…',soundcloud:'https://soundcloud.com/artist/sets/…'})[provider];$('provider-url').focus();}));
    $('spotify-recheck').addEventListener('click',refreshSpotifyStatus);
    $('spotify-disconnect').addEventListener('click',async()=>{const button=$('spotify-disconnect');button.disabled=true;try{await post('/api/music-hub/spotify/disconnect',{});++spotifyListToken;spotifyVerified=false;resetProviderCopy('spotify');await refreshSpotifyStatus();notify('Spotify disconnected from Music Hub.');}catch(error){notify('Could not disconnect Spotify: '+error.message,true);}finally{button.disabled=false;}});
    $('spotify-connect').addEventListener('click',async()=>{
      const button=$('spotify-connect');button.disabled=true;
      try{const data=await api('/api/music-hub/spotify/connect');const url=new URL(text(data.authUrl||data.auth_url));if(url.protocol!=='https:'||url.hostname!=='accounts.spotify.com')throw Error('Invalid Spotify authorization URL');window.open(url.href,'_blank','noopener,noreferrer');$('spotify-status-message').textContent='Complete authorization in your browser, then choose Refresh status.';}
      catch(error){notify('Spotify connection unavailable: '+error.message,true);}
      finally{button.disabled=false;}
    });
    $('spotify-show-playlists').addEventListener('click',()=>loadSpotifyCollection('playlists'));
    $('spotify-show-saved').addEventListener('click',()=>loadSpotifyCollection('saved'));
    $('spotify-library-list').addEventListener('click',event=>{const button=event.target.closest('[data-spotify-playlist]');if(button)openSpotifyPlaylist(button.dataset.spotifyPlaylist,button.dataset.spotifyPlaylistName);});
    $('spotify-playlist-back').addEventListener('click',()=>{++spotifyListToken;resetProviderCopy('spotify');$('spotify-playlist-detail').hidden=true;$('spotify-library-list').hidden=false;});
    $('spotify-copy-matched').addEventListener('click',()=>copyProviderMatches('spotify'));
    $('apple-local-recheck').addEventListener('click',refreshAppleLocalStatus);
    $('apple-local-search').addEventListener('input',renderApplePlaylistChoices);
    $('soundcloud-recheck').addEventListener('click',refreshSoundCloudStatus);
    $('soundcloud-disconnect').addEventListener('click',async()=>{const button=$('soundcloud-disconnect');button.disabled=true;try{await post('/api/music-hub/soundcloud/disconnect',{});++soundcloudToken;soundcloudConnected=false;await refreshSoundCloudStatus();notify('SoundCloud disconnected from Music Hub.');}catch(error){notify('Could not disconnect SoundCloud: '+error.message,true);}finally{button.disabled=false;}});
    $('soundcloud-connect').addEventListener('click',async()=>{const button=$('soundcloud-connect');button.disabled=true;try{const response=await api('/api/music-hub/soundcloud/connect');const url=new URL(text(response.authUrl||response.auth_url));if(url.protocol!=='https:'||url.hostname!=='secure.soundcloud.com')throw Error('Invalid authorization URL');window.open(url.href,'_blank','noopener,noreferrer');$('soundcloud-status-message').textContent='Finish signing in through SoundCloud, then refresh account status.';}catch(error){notify('SoundCloud connection unavailable: '+error.message,true);}finally{button.disabled=false;}});
    $('soundcloud-show-playlists').addEventListener('click',()=>loadSoundCloudCollection('playlists'));
    $('soundcloud-show-likes').addEventListener('click',()=>loadSoundCloudCollection('likes'));
    $('soundcloud-more').addEventListener('click',()=>loadSoundCloudCollection(soundcloudMode,{more:true}));
    $('soundcloud-likes-copy-matched').addEventListener('click',()=>copyProviderMatches('soundcloud-likes'));
    $('soundcloud-playlist-copy-matched').addEventListener('click',()=>copyProviderMatches('soundcloud-playlist'));
    $('soundcloud-playlist-more').addEventListener('click',()=>{if(soundcloudPlaylistId)openSoundCloudPlaylist(soundcloudPlaylistId,$('soundcloud-playlist-name').textContent,{more:true});});
    $('soundcloud-library-list').addEventListener('click',event=>{const button=event.target.closest('[data-soundcloud-playlist]');if(button)openSoundCloudPlaylist(button.dataset.soundcloudPlaylist,button.dataset.soundcloudName);});
    $('soundcloud-playlist-back').addEventListener('click',()=>{++soundcloudToken;$('soundcloud-playlist-detail').hidden=true;$('soundcloud-library-list').hidden=false;renderProviderCopy('soundcloud-likes');});
    $('apple-local-playlists').addEventListener('click',event=>{const button=event.target.closest('[data-apple-local-playlist]');if(button)loadAppleLocalPlaylist(button.dataset.appleLocalPlaylist,button.dataset.appleLocalName);});
    $('apple-local-playlist-back').addEventListener('click',()=>{++appleLocalToken;resetProviderCopy('apple-local');$('apple-local-playlist-detail').hidden=true;$('apple-local-playlists').hidden=false;});
    $('apple-local-more').addEventListener('click',()=>{if(appleLocalHasMore&&appleLocalPlaylistId)loadAppleLocalPlaylist(appleLocalPlaylistId,$('apple-local-playlist-name').textContent,{more:true});});
    $('apple-local-copy-matched').addEventListener('click',()=>copyProviderMatches('apple-local'));
    $('provider-link-form').addEventListener('submit',async event=>{
      event.preventDefault();const url=$('provider-url').value.trim(),button=$('provider-save');if(!url)return;
      button.disabled=true;
      try{const result=await post('/api/music-hub/providers/links',{action:'link',url});savedProviderLinks=asArray(result.links);renderProviderLinks();$('provider-url').value='';notify('Saved provider bookmark');}
      catch(error){notify('Could not save music link: '+error.message,true);}
      finally{button.disabled=false;}
    });
    $('provider-link-list').addEventListener('click',async event=>{
      const preview=event.target.closest('[data-provider-preview]');
      if(preview){const link=savedProviderLinks.find(item=>item.id===preview.dataset.providerPreview);if(link)providerPreview(link);return;}
      const refresh=event.target.closest('[data-provider-refresh]');
      if(refresh){
        refresh.disabled=true;
        try{
          const result=await post('/api/music-hub/providers/links',{action:'refresh',id:refresh.dataset.providerRefresh});
          savedProviderLinks=asArray(result.links);renderProviderLinks();
          notify(result.link?.status==='public_metadata_verified'?'Verified public provider title':'Link saved, but public metadata could not be verified');
        }catch(error){notify('Provider metadata refresh unavailable: '+error.message,true);refresh.disabled=false;}
        return;
      }
      const remove=event.target.closest('[data-provider-remove]');if(!remove)return;
      try{const result=await post('/api/music-hub/providers/links',{action:'unlink',id:remove.dataset.providerRemove});savedProviderLinks=asArray(result.links);renderProviderLinks();$('provider-embed-container').replaceChildren();$('provider-embed-container').hidden=true;}
      catch(error){notify('Could not remove link: '+error.message,true);}
    });
    refreshProviderLinks();
  }
  function art(t, extra = '') { const src = text(t?.artwork); return src.startsWith('/artwork/') ? `<img class="artwork ${extra}" loading="lazy" alt="" src="${escapeHtml(src)}">` : `<div class="artwork art-placeholder ${extra}" aria-hidden="true">♫</div>`; }
  const normalizeHub = (v) => ({queue:uniqueIds(v?.queue), favorites:uniqueIds(v?.favorites),playlists:asArray(v?.playlists).map(p => ({id:toId(p.id),name:text(p.name),trackIds:uniqueIds(p.trackIds)})),folders:asArray(v?.folders),setlists:asArray(v?.setlists).map(p=>({id:toId(p.id),name:text(p.name),trackIds:uniqueIds(p.trackIds)})),ratings:Object.fromEntries(Object.entries(v?.ratings||{}).filter(([id,r])=>/^\d+$/.test(id)&&Number.isInteger(r)&&r>=1&&r<=5))});
  const ownRating = (id) => Number(model.hub.ratings[toId(id)])||0;
  function ratingMarkup(t) {
    const current=ownRating(t.id);
    return '<span class="track-rating" role="group" aria-label="My rating for '+escapeHtml(t.title||'track')+'">'+[1,2,3,4,5].map(n=>'<button type="button" data-rating="'+(current===n?0:n)+'" aria-label="'+(current===n?'Clear rating': 'Rate '+n+' stars')+'" aria-pressed="'+(current===n)+'" title="'+n+' star'+(n===1?'':'s')+'">'+(n<=current?'★':'☆')+'</button>').join('')+'</span>';
  }
  async function refreshHub(silent = false) {
    try { model.hub = normalizeHub(await api('/api/music-hub/state')); model.hubAvailable = true; $('hub-dot').className = 'status-dot ok'; $('hub-status').textContent = 'Your queue and playlists are saved'; }
    catch (error) { model.hubAvailable = false; $('hub-dot').className = 'status-dot error'; $('hub-status').textContent = 'Music Hub actions unavailable'; if (!silent) notify(`Music Hub state unavailable: ${error.message}`, true); }
    renderSidebar(); renderQueue(); renderResults(); renderDetailFavorite(); renderSavedSets(); updateSelectedPlayer(); renderGallery();
    window.MusicHubStudio?.onHubChange();
  }
  async function hubAction(action, data = {}) {
    if (!model.hubAvailable) { notify('Music Hub storage is unavailable; try Refresh after the server is updated.', true); return false; }
    try { await post('/api/music-hub/action', {action,...data}); await refreshHub(true); return true; }
    catch (error) { notify(`${action}: ${error.message}`, true); await refreshHub(true); return false; }
  }
  function harmonic(a,b) {
    const x=key(a),y=key(b); if (!x || !y) return '';
    const n=Number(x.slice(0,-1)),m=Number(y.slice(0,-1)); const mode=x.slice(-1),mode2=y.slice(-1);
    if (x===y) return 'Same key'; if (n===m && mode!==mode2) return 'Relative key'; if (mode===mode2 && (Math.abs(n-m)===1 || Math.abs(n-m)===11)) return 'Adjacent key'; return '';
  }
  const activeReference = () => track(model.selected) || track(model.hub.queue.at(-1));
  let railReferenceId = '', railRequest = 0, railCollapsed = false;
  function setHarmonicRailCollapsed(shouldCollapse, persist = true) {
    railCollapsed = Boolean(shouldCollapse);
    const rail = $('harmonic-rail'), button = $('harmonic-rail-toggle'), list = $('harmonic-rail-scroll');
    if (!rail || !button || !list) return;
    rail.classList.toggle('is-collapsed', railCollapsed);
    button.textContent = railCollapsed ? '›' : '⌄';
    button.setAttribute('aria-expanded', String(!railCollapsed));
    button.setAttribute('aria-label', railCollapsed ? 'Expand Up Next suggestions' : 'Collapse Up Next suggestions');
    button.title = railCollapsed ? 'Show harmonic song suggestions' : 'Hide harmonic suggestions to show more library rows';
    list.setAttribute('aria-hidden', String(railCollapsed));
    list.tabIndex = railCollapsed ? -1 : 0;
    list.inert = railCollapsed;
    if (persist) try { localStorage.setItem('music-hub-up-next-collapsed-v1', String(railCollapsed)); } catch {}
  }
  function harmonicReference() {
    for(const n of [1,2])if(verifiedDeckSlots[n]?.id && track(verifiedDeckSlots[n].id))return {item:track(verifiedDeckSlots[n].id),label:'Verified Rekordbox Deck '+(n===1?'A':'B')+' · playback unconfirmed'};
    for(const n of [1,2])if(track(stagedDeckIds[n]))return {item:track(stagedDeckIds[n]),label:'Staged Deck '+(n===1?'A':'B')+' · not loaded'};
    const id=player()?.getAttribute('data-track');
    if(id && !player().paused && track(id))return {item:track(id),label:'Playing local preview'};
    if(track(model.selected))return {item:track(model.selected),label:'Selected library track · preview'};
    return null;
  }
  function renderHarmonicRail(rows,reference) {
    const rail=$('harmonic-rail'),list=$('harmonic-rail-scroll');
    const unique=new Set([toId(reference.item.id)]);
    const items=rows.filter(({track:t})=>{const id=toId(t?.id);if(!id||unique.has(id))return false;unique.add(id);return true;}).slice(0,8);
    rail.hidden=!items.length;
    $('harmonic-rail-source').textContent=reference.label+' · '+text(reference.item.title);
    list.innerHTML=items.map(({track:t,transition})=>{
      const confidence=transitionSummary(transition).badges[0]||harmonic(reference.item,t)||'Analyzed match';
      return '<div class="harmonic-pick" data-id="'+escapeHtml(t.id)+'" draggable="true" title="'+escapeHtml(t.title)+' · '+escapeHtml(t.artist)+'">'+art(t,'harmonic-art')+
        '<div class="harmonic-pick-copy"><strong>'+escapeHtml(t.title||'Untitled')+'</strong><small>'+escapeHtml(t.artist||'Unknown artist')+'</small><span>'+bpm(t)+' BPM · '+escapeHtml(key(t)||'Key —')+'</span><em>'+escapeHtml(confidence)+'</em></div>'+
        '<div class="harmonic-actions"><button type="button" data-rail-stage="'+escapeHtml(t.id)+'" aria-label="Stage '+escapeHtml(t.title)+' on Deck B">↗</button><button type="button" data-rail-queue="'+escapeHtml(t.id)+'" aria-label="Queue '+escapeHtml(t.title)+'">＋</button></div></div>';
    }).join('');
  }
  async function updateHarmonicRail(force=false) {
    const reference=harmonicReference();
    if(!reference){railReferenceId='';$('harmonic-rail').hidden=true;return;}
    const id=toId(reference.item.id);
    if(!force && railReferenceId===id){$('harmonic-rail-source').textContent=reference.label+' · '+text(reference.item.title);return;}
    railReferenceId=id;
    const token=++railRequest;
    try{
      const response=await api('/api/transition-candidates?id='+encodeURIComponent(id)+'&limit=8');
      if(token!==railRequest || harmonicReference()?.item.id!==id)return;
      renderHarmonicRail(asArray(response.tracks).map(row=>({track:track((row.track||row).id)||(row.track||row),transition:row._transition||(row.track||row)._transition})),reference);
    }catch{if(token===railRequest)$('harmonic-rail').hidden=true;}
  }
  let albums=[],artists=[], historyStack=[],historyPointer=-1, browserInitialized=false, theme='dark';
  let displayMode='list', collectionMode='gallery', nativePlaylistTree=[];
  let expandedGroups={}, deckExpanded=false;
  const MUSIC_GENRES=[
    {id:'hip-hop',name:'Hip-Hop',words:/\b(hip[ -]?hop|rap|trap|drill|jersey club|plugg|rage)\b/i},
    {id:'house',name:'House',words:/\b(house|deep house|tech house|afro house|bass house|progressive house|disco house)\b/i},
    {id:'underground',name:'Underground',words:/\b(underground|alt[ -]?rap|hyperpop|experimental|cloud rap|opium)\b/i},
    {id:'techno',name:'Techno',words:/\b(techno|hard techno|minimal techno)\b/i},
    {id:'electronic',name:'Electronic / EDM',words:/\b(edm|electronic|dance|dubstep|electro|future bass)\b/i},
    {id:'rnb',name:'R&B / Soul',words:/\b(r[& ]?b|soul|neo soul)\b/i},
    {id:'afrobeats',name:'Afrobeats',words:/\b(afrobeat|afrobeats|amapiano|afroswing)\b/i},
    {id:'latin',name:'Latin',words:/\b(reggaeton|latin|dembow|bachata|salsa)\b/i},
    {id:'pop',name:'Pop',words:/\b(pop|indie pop|synthpop)\b/i},
    {id:'drum-bass',name:'Drum & Bass',words:/\b(drum[ &n]+bass|dnb|jungle|breakbeat)\b/i},
    {id:'rock',name:'Rock / Alternative',words:/\b(rock|alternative|punk|metal|indie rock)\b/i},
    {id:'ambient',name:'Ambient / Downtempo',words:/\b(ambient|lo[ -]?fi|downtempo|chillout)\b/i}
  ];
  const genreById=id=>MUSIC_GENRES.find(g=>g.id===id);
  const genresFromLabel=value=>MUSIC_GENRES.filter(g=>g.words.test(text(value))).map(g=>g.id);
  const nativeGenreEvidence=new Map();
  let nativeGenreScan=0;
  function genreFolderData(){
    const buckets=new Map(MUSIC_GENRES.map(g=>[g.id,{...g,playlists:[],songCount:0}]));
    for(const t of model.tracks){for(const id of genresFromLabel(genreValue(t))){const group=buckets.get(id);if(group)group.songCount++;}}
    const assigned=new Map();
    for(const f of asArray(model.hub.folders))for(const ref of asArray(f.playlistIds)){
      if(!assigned.has(ref))assigned.set(ref,new Set());
      for(const tag of genresFromLabel(f.name))assigned.get(ref).add(tag);
    }
    const all=[...model.hub.playlists.map(p=>({...p,type:'local'})),...model.nativePlaylists.map(p=>({...p,id:toId(p.id),type:'native'}))];
    for(const p of all){
      const ref=(p.type==='native'?'native:':'')+p.id;
      const genres=new Set([...genresFromLabel(p.name),...(assigned.get(ref)||[])]);
      const ids=p.type==='local'?asArray(p.trackIds):asArray(nativeGenreEvidence.get(ref));
      if(ids.length){
        const counts=new Map();let annotated=0;
        for(const id of ids){const t=track(id);if(!t||!genreValue(t))continue;annotated++;for(const tag of genresFromLabel(genreValue(t)))counts.set(tag,(counts.get(tag)||0)+1);}
        for(const [tag,count] of counts)if(count>=2&&count>=Math.max(2,Math.floor(annotated*.22)))genres.add(tag);
      }
      for(const tag of genres){const bucket=buckets.get(tag);if(bucket&&!bucket.playlists.some(x=>x.id===p.id&&x.type===p.type))bucket.playlists.push(p);}
    }
    for(const bucket of buckets.values())bucket.playlists.sort((a,b)=>a.name.localeCompare(b.name));
    // Keep standard genre folders available even before playlists have been
    // tagged, so users can grow categories such as Underground over time.
    return [...buckets.values()];
  }
  async function scanNativePlaylistGenres(){
    const token=++nativeGenreScan;
    const pending=model.nativePlaylists.filter(p=>!nativeGenreEvidence.has('native:'+p.id)&&Number(p.count)>0).slice(0,40);
    let cursor=0;
    async function check(){while(cursor<pending.length&&token===nativeGenreScan){const p=pending[cursor++];try{const response=await api('/api/playlist?id='+encodeURIComponent(p.id)+'&limit=200');const ids=asArray(response.tracks).map(t=>toId(typeof t==='object'?t.id:t)).filter(id=>track(id));nativeGenreEvidence.set('native:'+p.id,ids);}catch{nativeGenreEvidence.set('native:'+p.id,[]);}if(cursor%3===0&&token===nativeGenreScan){renderGroupNavigation();if(['genres','genre-group','playlists'].includes(model.view))renderGallery();}}}
    await Promise.all([check(),check(),check()]);
    if(token===nativeGenreScan){renderGroupNavigation();if(['genres','genre-group','playlists'].includes(model.view))renderGallery();}
  }
  function playlistButton(p,type,indent=0){const miniCover=playlistCover({...p,id:toId(p.id),type}).replace('class="playlist-art"','class="playlist-art playlist-sidebar-art"');const button='<button class="nav-item '+(model.view===type&&model.playlistId===toId(p.id)?'active':'')+'" data-view="'+type+'" data-id="'+escapeHtml(p.id)+'" style="--folder-depth:'+Math.min(indent,5)+'" title="'+escapeHtml(p.name)+(type==='local'?' · Drop a track to add it':' · Rekordbox read-only')+'">'+miniCover+'<span class="nav-copy">'+escapeHtml(p.name||'Untitled')+'</span><em>'+Number(p.count??p.trackIds?.length??0)+'</em></button>';return type==='native'?'<div class="playlist-organize">'+button+'<button class="playlist-assign" data-organize="native:'+escapeHtml(p.id)+'" title="Assign genre / vibe" aria-label="Organize '+escapeHtml(p.name)+'">⋮</button></div>':button;}
  function treeMarkup(nodes,depth=0){return asArray(nodes).map((node,i)=>{const id=toId(node.id??node.playlistId??'');const children=asArray(node.children??node.playlists);const isFolder=Boolean(node.kind==='folder'||node.type==='folder'||node.isFolder||node.folder||children.length);if(isFolder){const folderKey='native:'+id+':'+depth+':'+i;return '<details class="playlist-folder" '+(expandedGroups[folderKey]?'open':'')+' data-folder-key="'+escapeHtml(folderKey)+'"><summary style="--folder-depth:'+Math.min(depth,5)+'"><span class="folder-chevron" aria-hidden="true">▸</span> '+escapeHtml(node.name||'Folder')+'</summary>'+treeMarkup(children,depth+1)+'</details>';}const original=model.nativePlaylists.find(p=>toId(p.id)===id)||node;return playlistButton(original,'native',depth);}).join('');}
  function renderGroupNavigation(){
    const target=$('genre-vibe-groups');if(!target)return;
    const categories=genreFolderData();
    const built=categories.map(b=>{
      const key='genre:'+b.id;
      const contents=b.playlists.length?b.playlists.map(p=>playlistButton(p,p.type,1)).join(''):'<small class="genre-folder-empty">No tagged playlists yet</small>';
      return '<details class="playlist-folder genre-category" '+(expandedGroups[key]?'open':'')+' data-folder-key="'+escapeHtml(key)+'"><summary data-genre-group="'+escapeHtml(b.id)+'" title="Explore '+escapeHtml(b.name)+' playlists"><span class="folder-chevron" aria-hidden="true">▸</span><span class="genre-folder-name">'+escapeHtml(b.name)+'</span><small>'+b.playlists.length+'</small></summary><div class="genre-folder-playlists">'+contents+'</div></details>';
    }).join('');
    const folders=asArray(model.hub.folders);
    const visit=(parent,depth=0,seen=new Set())=>folders.filter(f=>toId(f.parentId||'')===parent&&!seen.has(f.id)).map(f=>{const next=new Set(seen);next.add(f.id);const members=asArray(f.playlistIds).map(ref=>{const native=ref.startsWith('native:');const id=native?ref.slice(7):ref;const p=native?model.nativePlaylists.find(p=>toId(p.id)===id):model.hub.playlists.find(p=>p.id===id);return p?playlistButton(p,native?'native':'local',depth+1):'';}).join('');return '<details class="playlist-folder" '+(expandedGroups['group:'+f.id]?'open':'')+' data-folder-key="'+escapeHtml('group:'+f.id)+'"><summary style="--folder-depth:'+Math.min(depth,5)+'"><span class="folder-chevron" aria-hidden="true">▸</span> '+escapeHtml(f.name)+' <small>'+asArray(f.playlistIds).length+'</small><button type="button" class="folder-options" data-folder-options="'+escapeHtml(f.id)+'" aria-label="Manage folder '+escapeHtml(f.name)+'">⋯</button></summary>'+members+visit(f.id,depth+1,next)+'</details>';}).join('');
    target.innerHTML=built+(folders.length?'<div class="genre-custom-heading">CUSTOM FOLDERS</div>'+visit(''):'')+'<button class="nav-item new-group" data-new-group>＋ New genre / vibe group</button>';
  }
  let glassStrength=24, accentChoice='default';
  const accentColors=Object.fromEntries((window.MusicHubThemePreview?.accents||[]).filter(item=>item.color).map(item=>[item.id,item.color]));
  function applyAppearance(rerenderSettings=true){
    document.documentElement.style.setProperty('--glass-blur',glassStrength+'px');
    if(accentColors[accentChoice])document.documentElement.style.setProperty('--accent',accentColors[accentChoice]);
    else document.documentElement.style.removeProperty('--accent');
    if(rerenderSettings&&model.view==='settings')renderGallery();
  }
  const genreValue = (t) => text(t?.genre).trim();
  function refreshGenreOptions() {
    const select=$('genre-filter');if(!select)return;
    const previous=select.value;
    const counts=new Map();for(const t of model.tracks){const genre=genreValue(t);if(genre)counts.set(genre,(counts.get(genre)||0)+1);}
    const options=[...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([genre,count])=>'<option value="'+escapeHtml(genre)+'">'+escapeHtml(genre)+' ('+count+')</option>');
    select.innerHTML='<option value="all">All genres</option><option value="untagged">Untagged</option>'+options.join('');
    if([...select.options].some(option=>option.value===previous))select.value=previous;
  }
  const player = () => $('preview-audio');
  // The fixed-playhead expanded waveform may follow ONLY a genuine playing
  // local audio preview. This is not a Rekordbox/FLX4 transport position.
  let previewWaveAnimation=0,previewWaveLastFrame=0;
  function syncLocalWaveform(reset=false){
    const audio=player(),id=toId(audio?.getAttribute('data-track'));
    if(!/^\d+$/.test(id)||!track(id))return;
    const seconds=Number(audio.currentTime);
    window.MusicHubTopDecks?.syncLocalPreview?.({trackId:id,positionSeconds:Number.isFinite(seconds)?Math.max(0,seconds):0,playing:!audio.paused&&!audio.ended,reset});
  }
  function stopLocalWaveAnimation(reset=false){
    if(previewWaveAnimation){cancelAnimationFrame(previewWaveAnimation);previewWaveAnimation=0;}
    previewWaveLastFrame=0;
    syncLocalWaveform(reset);
  }
  function advanceLocalWaveAnimation(timestamp){
    previewWaveAnimation=0;
    const audio=player();
    if(!audio||audio.paused||audio.ended)return;
    if(timestamp-previewWaveLastFrame>=42){previewWaveLastFrame=timestamp;syncLocalWaveform();}
    previewWaveAnimation=requestAnimationFrame(advanceLocalWaveAnimation);
  }
  function startLocalWaveAnimation(){
    syncLocalWaveform();
    if(!previewWaveAnimation)previewWaveAnimation=requestAnimationFrame(advanceLocalWaveAnimation);
  }
  function buildCollections() {
    const a=new Map(),b=new Map();
    for(const t of model.tracks){
      const album=text(t.album).trim(), artist=text(t.artist).trim();
      if(album) {
        const groupKey=album+'\u241f'+artist;
        if(!a.has(groupKey))a.set(groupKey,{id:groupKey,name:album,artist,tracks:[],artwork:''});
        const group=a.get(groupKey);group.tracks.push(t);if(!group.artwork&&t.artwork)group.artwork=t.artwork;
      }
      if(artist) {
        if(!b.has(artist))b.set(artist,{id:artist,name:artist,artist,tracks:[],artwork:''});
        const group=b.get(artist);group.tracks.push(t);if(!group.artwork&&t.artwork)group.artwork=t.artwork;
      }
    }
    albums=[...a.values()].sort((x,y)=>y.tracks.length-x.tracks.length||x.name.localeCompare(y.name));
    artists=[...b.values()].sort((x,y)=>y.tracks.length-x.tracks.length||x.name.localeCompare(y.name));
    renderPinned();
  }
  function renderPinned() {
    const picks=albums.filter(x=>x.artwork).slice(0,5);
    $('sidebar-pinned').innerHTML=picks.length?picks.map(g=>'<button class="pinned-item" data-group="album" data-group-id="'+escapeHtml(g.id)+'">'+art(g.tracks[0])+'<span><strong>'+escapeHtml(g.name)+'</strong><small>'+escapeHtml(g.artist||'Local album')+'</small></span></button>').join(''):'<span class="pinned-empty">Album artwork appears when available in Rekordbox.</span>';
  }
  function renderSidebar() {
    $('all-count').textContent=model.tracks.length.toLocaleString(); $('favorites-count').textContent=model.hub.favorites.length||'';$('queue-count').textContent=model.hub.queue.length||'';
    $('local-playlists').innerHTML=model.hub.playlists.length?model.hub.playlists.map(p=>'<div class="playlist-organize">'+playlistButton(p,'local')+'<button class="playlist-assign" data-organize="'+escapeHtml(p.id)+'" title="Assign a genre / vibe group" aria-label="Organize '+escapeHtml(p.name)+'">⋮</button></div>').join(''):'<p class="sidebar-empty">Your playlists will appear here.</p>';
    $('native-playlists').innerHTML=nativePlaylistTree.length?treeMarkup(nativePlaylistTree):model.nativePlaylists.map(p=>playlistButton(p,'native')).join('');
    renderGroupNavigation();
    for(const [kind,count] of [['local',model.hub.playlists.length],['native',model.nativePlaylists.length],['groups',asArray(model.hub.folders).length]]){
      const summary=document.querySelector('[data-tree-root="'+kind+'"]>summary');
      if(summary){let badge=summary.querySelector('.tree-count');if(!badge){badge=document.createElement('small');badge.className='tree-count';summary.append(badge);}badge.textContent=count.toLocaleString();}
    }
    document.querySelectorAll('.sidebar [data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===model.view||(el.dataset.view==='all'&&['album','artist'].includes(model.view))||(el.dataset.view==='genres'&&['genre-group','genre-tracks'].includes(model.view))));
  }
  function rememberPage(view,id=null) {
    if(!browserInitialized){browserInitialized=true;historyStack=[{view,id}];historyPointer=0;return;}
    const prev=historyStack[historyPointer];if(prev?.view===view&&prev?.id===id)return;
    historyStack=historyStack.slice(0,historyPointer+1);historyStack.push({view,id});historyPointer=historyStack.length-1;
  }
  function navigateHistory(delta) {
    const next=historyPointer+delta;if(next<0||next>=historyStack.length)return;
    historyPointer=next;const dest=historyStack[next];selectView(dest.view,dest.id,false);
  }
  async function selectView(view,id=null,remember=true) {
    if(view==='sets'){model.view='sets';$('sidebar').classList.remove('open');switchWorkspace('setlist');if(remember)rememberPage(view,id);renderSidebar();return;}
    if(view==='health'){
      $('sidebar').classList.remove('open');
      model.view='health';switchWorkspace('health');
      if(remember)rememberPage(view,id);
      renderSidebar();await loadHealth();return;
    }
    if(workspaceMode!=='library')switchWorkspace('library');
    // Searches inside a playlist are scoped to that playlist. Entering a
    // different playlist must not carry over an unrelated hidden filter.
    if(['native','local'].includes(view)&&(model.view!==view||model.playlistId!==id))$('search-input').value='';
    model.view=view;model.playlistId=id;model.groupId=id;model.playlistTracks=[];$('sidebar').classList.remove('open');
    if(view==='search') {$('search-input').focus();view='all';model.view='all';}
    if(view==='native') {
      try{const payload=await api('/api/playlist?id='+encodeURIComponent(id));model.playlistTracks=asArray(payload.tracks).map(x=>toId(typeof x==='object'?x.id:x));}
      catch(e){notify('Playlist could not load: '+e.message,true);}
    }
    if(remember)rememberPage(view,id);
    const item=view==='native'?model.nativePlaylists.find(p=>toId(p.id)===id):model.hub.playlists.find(p=>p.id===id);
    const group=view==='album'?albums.find(g=>g.id===id):view==='artist'?artists.find(g=>g.id===id):null;
    const titles={home:'Home',all:'Songs',recent:'Recent imports',favorites:'Favorites',review:'Needs analysis',queue:'Next up',local:item?.name||'Playlist',native:item?.name||'Rekordbox playlist',albums:'Albums',artists:'Artists',genres:'Genres & Vibes','genre-group':genreById(id)?.name||'Genre playlists','genre-tracks':genreById(id)?.name||'Genre tracks',playlists:'Playlists',album:group?.name||'Album',artist:group?.name||'Artist',history:'History',settings:'Settings'};
    const subtitle={home:'Your local music, organized for your next set.',all:'Every track in your Rekordbox collection.',recent:'Recently imported Rekordbox tracks by library date.',favorites:'Your personally saved favorite tracks.',albums:'Albums found in your Rekordbox metadata.',artists:'Artists in your local collection.',playlists:'Your saved Music Hub and Rekordbox playlists.',history:'Listening history is not recorded by Music Hub.',settings:'Customize your Music Hub appearance and workspace.',queue:'Your saved Next Up queue, separate from Rekordbox playback.',native:'Read-only Rekordbox playlist. Add tracks to your Music Hub queue.',local:'Your personal Music Hub playlist.'};
    $('view-title').textContent=titles[view]||'Music Library';
    $('section-title').textContent=['album','artist','home'].includes(view)?'Songs':view==='genre-tracks'?(titles[view]+' · tracks'):titles[view]||'Tracks';
    $('export-playlist').hidden=view!=='local';$('delete-playlist').hidden=view!=='local';
    $('view-subtitle').textContent=group?(view==='album'?group.artist+' · '+group.tracks.length+' songs':group.tracks.length+' songs in your collection'):(subtitle[view]||'Explore and organize your local collection.');
    $('search-input').placeholder=['native','local'].includes(view)?'Search this playlist…':['albums','artists'].includes(view)?'Search albums or artists…':'Search songs, artists, albums, playlists…';
    $('search-input').setAttribute('aria-label',['native','local'].includes(view)?'Search tracks within this playlist':'Search music library');
    renderSidebar();renderGallery();renderResults(true);
  }
  function browseCard(g,type) {
    const cover=g.tracks?.find(t=>t.artwork)||g.tracks?.[0];
    const count=g.tracks?.length||0;
    const subtitle=type==='album'?(g.artist||'Unknown artist'):(count.toLocaleString()+' tracks');
    return '<button type="button" class="browse-card" data-group="'+type+'" data-group-id="'+escapeHtml(g.id)+'" draggable="'+Boolean(cover?.id)+'" data-id="'+escapeHtml(cover?.id||'')+'">'+art(cover,'browse-cover')+'<strong>'+escapeHtml(g.name||'Untitled')+'</strong><span>'+escapeHtml(subtitle)+'</span><small class="browse-card-count">'+count.toLocaleString()+' tracks</small></button>';
  }
  const harmonicOrders=new Map();
  const playlistScope=()=>model.view+':'+model.playlistId;
  function playlistCover(g){
    const ids=g.type==='native'?nativeGenreEvidence.get('native:'+g.id):(model.hub.playlists.find(p=>p.id===g.id)?.trackIds);
    const cover=asArray(ids).map(track).find(t=>text(t?.artwork).startsWith('/artwork/'));
    const suppliedArtwork=text(g.artwork);
    const artwork=suppliedArtwork.startsWith('/artwork/')?suppliedArtwork:text(cover?.artwork);
    const hue=[...String(g.id)].reduce((a,c)=>a+c.charCodeAt(0),0)%360;
    const initials=String(g.name||'Playlist').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();
    return '<span class="playlist-art" style="--cover-hue:'+hue+'">'+(artwork.startsWith('/artwork/')?'<img loading="lazy" alt="Playlist artwork" src="'+escapeHtml(artwork)+'">':escapeHtml(initials))+'</span>';
  }
  function syncSmartControls(){
    const active=['native','local'].includes(model.view),main=document.querySelector('.main');main.classList.toggle('playlist-active',active);
    let controls=$('smart-order-controls');
    if(!controls){controls=document.createElement('div');controls.id='smart-order-controls';controls.className='smart-order-controls';controls.innerHTML='<button id="smart-reorder" type="button">✧ Smart reorder</button><button id="smart-save" type="button" hidden>Save as new playlist</button><span id="smart-order-info" class="smart-order-info" role="status" hidden></span>';
      document.querySelector('.filters').append(controls);
      $('smart-reorder').addEventListener('click',()=>{
        const scope=playlistScope();if(harmonicOrders.has(scope))harmonicOrders.delete(scope);
        else {const source=getSource();harmonicOrders.set(scope,window.MusicHubHarmonicOrder(source).map(t=>t.id));}
        syncSmartControls();renderResults(true);
        notify(harmonicOrders.has(scope)?'Harmonic order preview · full playlist · unknown keys last · original unchanged':'Original playlist order restored');
      });
      $('smart-save').addEventListener('click',async()=>{const ids=harmonicOrders.get(playlistScope());if(!ids||ids.length>6000)return;const name=($('section-title').textContent+' · Harmonic').slice(0,100);$('smart-save').disabled=true;try{if(await hubAction('playlist.create',{name,trackIds:ids.slice()}))notify('Saved all '+ids.length.toLocaleString()+' harmonically ordered songs as a Music Hub playlist. Original Rekordbox playlist unchanged.');}finally{syncSmartControls();}});
    }
    controls.hidden=!active;const arranged=harmonicOrders.has(playlistScope()),ids=harmonicOrders.get(playlistScope())||[];$('smart-reorder').textContent=arranged?'↶ Original order':'✧ Smart reorder';$('smart-reorder').setAttribute('aria-pressed',String(arranged));$('smart-reorder').disabled=active&&getSource().length<2;$('smart-save').hidden=!active||!arranged;$('smart-save').disabled=!model.hubAvailable||ids.length>6000;$('smart-save').textContent='Save '+ids.length.toLocaleString()+'-track Music Hub copy';$('smart-save').title=ids.length>6000?'Playlist exceeds the 6,000 track local Music Hub safety limit':'Save all tracks in an independent Music Hub playlist; Rekordbox is never modified.';$('smart-order-info').hidden=!active||!arranged;$('smart-order-info').textContent=arranged?'Full '+ids.length.toLocaleString()+'-track harmonic preview · original playlist unchanged':'';
  }
  function renderGallery() {
    syncSmartControls();
    const view=model.view, gallery=$('browse-gallery'), hero=document.querySelector('.hero'),work=document.querySelector('.work-area');
    const outerShell=document.querySelector('.shell');
    outerShell?.classList.toggle('settings-focus',view==='settings');
    if(view!=='settings')outerShell?.classList.remove('settings-show-performance');
    const overview=['home','albums','artists','genres','genre-group','playlists','history','settings'].includes(view);
    const group=['album','artist'].includes(view);
    const searchContainer=$('search-input').closest('.search');
    const groupSearch=['albums','artists','genres','genre-group','playlists'].includes(view);
    const searchDestination=groupSearch?gallery.querySelector('.browse-heading'):document.querySelector('.filters');
    if(searchContainer.parentElement!==searchDestination)searchDestination.append(searchContainer);
    searchContainer.classList.toggle('collection-search',groupSearch);
    gallery.hidden=workspaceMode!=='library'||!(overview||group);
    hero.hidden=true;
    work.hidden=['albums','artists','genres','genre-group','playlists','history','settings'].includes(view)||workspaceMode!=='library';
    if(!overview&&!group)return;
    $('browse-all').hidden=!['home','album','artist'].includes(view);
    $('browse-kicker').textContent=view==='home'?'GOOD TO SEE YOU':view==='settings'?'PREFERENCES':view==='history'?'YOUR ACTIVITY':'YOUR LIBRARY';
    const heading=view==='home'?'Your music, beautifully organized.':view==='albums'?'Albums':view==='artists'?'Artists':view==='genres'?'Genres & vibes':view==='genre-group'?(genreById(model.groupId)?.name||'Genre')+' playlists':view==='playlists'?'Your playlists':view==='settings'?'Settings':view==='history'?'History':view==='album'?'Album':'Artist';
    $('browse-title').textContent=heading;
    $('browse-description').textContent=view==='home'?model.tracks.length.toLocaleString()+' local tracks · '+model.nativePlaylists.length+' Rekordbox playlists':view==='history'?'Music Hub does not collect a playback history.':'Everything displayed comes from your local collection.';
    const grid=$('browse-grid');grid.classList.toggle('browse-details',group);
    for(const mode of ['gallery','tiles','rows','compact','table'])grid.classList.toggle('collection-'+mode,collectionMode===mode);
    document.querySelectorAll('[data-collection-mode]').forEach(button=>{button.classList.toggle('active',button.dataset.collectionMode===collectionMode);button.setAttribute('aria-pressed',String(button.dataset.collectionMode===collectionMode));});
    if(view==='home') {
      const featured=albums.filter(g=>g.artwork).slice(0,8);
      const top=featured.length?featured:albums.slice(0,8);
      grid.innerHTML='<div class="gallery-subheading">Albums in your collection <span>'+albums.length.toLocaleString()+' albums · open Albums or Artists to explore more</span></div>'+top.map(g=>browseCard(g,'album')).join('');
    } else if(view==='albums'||view==='artists') {
      const groups=view==='albums'?albums:artists;
      const query=$('search-input').value.trim().toLowerCase();
      const filtered=query?groups.filter(g=>(g.name+' '+g.artist).toLowerCase().includes(query)):groups;
      grid.innerHTML='<div class="gallery-subheading">'+filtered.length.toLocaleString()+' '+view+' <span>Search above to filter all '+groups.length.toLocaleString()+' groups</span></div>'+filtered.slice(0,180).map(g=>browseCard(g,view==='albums'?'album':'artist')).join('')+(filtered.length>180?'<p class="gallery-limit">Showing 180 of '+filtered.length.toLocaleString()+' groups. Refine the search to explore more.</p>':'');
    } else if(view==='genres') {
      const query=$('search-input').value.trim().toLowerCase();
      const categories=genreFolderData().filter(g=>!query||g.name.toLowerCase().includes(query));
      grid.innerHTML='<div class="gallery-subheading">'+categories.length+' genre folders <span>Open a genre to browse its grouped playlists</span></div>'+categories.map(g=>'<button type="button" class="browse-card genre-card" data-genre-group="'+escapeHtml(g.id)+'"><span class="playlist-cover">▱</span><strong>'+escapeHtml(g.name)+'</strong><span>'+g.playlists.length+' playlists · '+g.songCount.toLocaleString()+' tagged tracks</span></button>').join('');
    } else if(view==='genre-group') {
      const group=genreFolderData().find(g=>g.id===model.groupId);
      const query=$('search-input').value.trim().toLowerCase();
      const playlists=asArray(group?.playlists).filter(p=>!query||p.name.toLowerCase().includes(query));
      grid.innerHTML='<div class="gallery-subheading">'+playlists.length+' '+escapeHtml(group?.name||'Genre')+' playlists <span>Tagged names, assigned groups, and Rekordbox track genres</span></div>'+
        '<button type="button" class="browse-card genre-all-tracks" data-genre-tracks="'+escapeHtml(model.groupId)+'"><span class="playlist-cover">♪</span><strong>All '+escapeHtml(group?.name||'genre')+' tracks</strong><span>'+Number(group?.songCount||0).toLocaleString()+' tagged songs</span></button>'+
        playlists.map(p=>'<button type="button" class="browse-card playlist-card" data-view="'+p.type+'" data-id="'+escapeHtml(p.id)+'">'+playlistCover(p)+'<strong>'+escapeHtml(p.name)+'</strong><span>'+escapeHtml(p.type==='native'?'Rekordbox':'Music Hub')+' · '+(p.count??p.trackIds?.length??0)+' songs</span></button>').join('')+
        (playlists.length?'':'<p class="genre-folder-empty-note">No playlist in this category yet. Assign playlists with ⋮ in the sidebar to organize them here.</p>');
    } else if(view==='playlists') {
      const ours=model.hub.playlists.map(g=>({id:g.id,name:g.name,artist:'Music Hub · '+g.trackIds.length+' songs',type:'local'}));
      const native=model.nativePlaylists.map(g=>({id:toId(g.id),name:g.name,artwork:g.artwork,artist:'Rekordbox · '+(g.count||0)+' songs',type:'native'}));
      const query=$('search-input').value.trim().toLowerCase();
      const filtered=[...ours,...native].filter(g=>!query||(g.name+' '+g.artist).toLowerCase().includes(query));
      grid.innerHTML='<div class="gallery-subheading">'+filtered.length+' Music Hub and Rekordbox playlists</div>'+filtered.map(g=>'<button class="browse-card playlist-card" data-view="'+g.type+'" data-id="'+escapeHtml(g.id)+'">'+playlistCover(g)+'<strong>'+escapeHtml(g.name)+'</strong><span>'+escapeHtml(g.artist)+'</span></button>').join('')+'<button class="browse-card playlist-card new-playlist" data-create-playlist><span class="playlist-cover">＋</span><strong>Create playlist</strong><span>Music Hub collection</span></button>';
    } else if(group) {
      const g=view==='album'?albums.find(g=>g.id===model.groupId):artists.find(g=>g.id===model.groupId);
      grid.innerHTML=g?'<div class="collection-spotlight">'+art(g.tracks.find(t=>t.artwork)||g.tracks[0])+'<div><span class="eyebrow">'+(view==='album'?'ALBUM':'ARTIST')+'</span><h1>'+escapeHtml(g.name)+'</h1><p>'+escapeHtml(g.artist||'Local collection')+' · '+g.tracks.length+' tracks</p><button data-group-queue="'+escapeHtml(g.id)+'" class="primary-button">＋ Add tracks to queue</button></div></div>':'<p>Collection is unavailable.</p>';
    } else if(view==='history') {
      grid.innerHTML='<div class="gallery-message"><span class="message-icon">◷</span><h3>No listening history recorded</h3><p>Rekordbox import dates and play counts remain available in Songs and Recent imports. Music Hub does not infer when you listened.</p><button data-view="recent" class="subtle-button">Browse recent imports</button></div>';
    } else if(view==='settings') {
      grid.innerHTML='<div class="mh-settings-page"><div class="mh-settings-heading"><div><h2>Music Hub settings</h2><p>Personalize your workspace, check Rekordbox library access, and securely pair your iPhone companion.</p></div></div><div id="music-hub-theme-mount"></div><div class="mh-settings-heading"><div><h2>Connections & devices</h2><p>Rekordbox and phone connections use the existing Music Hub services. Status is checked, never assumed.</p></div></div><div id="music-hub-connections-mount" class="mh-connection-settings"></div></div>';
      window.MusicHubThemePreview?.mount($('music-hub-theme-mount'),{
        theme,accent:accentChoice,blur:glassStrength,
        onTheme:next=>applyTheme(next,true,false),
        onAccent:next=>{accentChoice=next;try{localStorage.setItem('music-hub-accent',next);}catch{}applyAppearance(false);},
        onBlur:next=>{glassStrength=next;try{localStorage.setItem('music-hub-glass-blur',String(next));}catch{}applyAppearance(false);}
      });
      window.MusicHubConnectionSettings?.mount($('music-hub-connections-mount'),{
        trackCount:model.tracks.length,
        getTrackCount:()=>model.tracks.length,
        onRefreshLibrary:()=>refreshAll(true),
        onOpenDecks:()=>{outerShell?.classList.add('settings-show-performance');togglePerformance(true);$('performance-panel')?.scrollIntoView({block:'start',behavior:'smooth'});}
      });
    }
  }
  function getSource() {
    switch(model.view) {
      case 'genre-tracks': return model.tracks.filter(t=>genresFromLabel(genreValue(t)).includes(model.groupId));
      case 'album': return albums.find(g=>g.id===model.groupId)?.tracks||[];
      case 'artist': return artists.find(g=>g.id===model.groupId)?.tracks||[];
      case 'favorites': return model.hub.favorites.map(track).filter(Boolean);
      case 'queue': return model.hub.queue.map(track).filter(Boolean);
      case 'local': return (model.hub.playlists.find(p=>p.id===model.playlistId)?.trackIds||[]).map(track).filter(Boolean);
      case 'native': return model.playlistTracks.map(track).filter(Boolean);
      case 'review': return model.tracks.filter(t=>!t.bpm||!key(t));
      case 'recent': return [...model.tracks].sort((a,b)=>text(b.date).localeCompare(text(a.date))).slice(0,600);
      default: return model.tracks;
    }
  }
  function computeResults() {
    const query=$('search-input').value.trim().toLowerCase(); const terms=query.split(/\s+/).filter(Boolean); const range=$('bpm-filter').value; const k=$('key-filter').value; const genre=$('genre-filter').value; const rating=$('rating-filter').value; const compatible=$('compatible-filter').checked; const reference=activeReference();
    const result=getSource().filter(t=>{
      const haystack=`${t.title||''} ${t.artist||''} ${t.album||''} ${t.genre||''} ${t.camelot||''} ${t.key||''} ${t.bpm||''}`.toLowerCase();
      if (terms.some(term=>!haystack.includes(term))) return false;
      const tempo=Number(t.bpm)||0;
      if (range==='low'&&!(tempo>0&&tempo<100)) return false;
      if (range==='mid'&&!(tempo>=100&&tempo<120)) return false;
      if (range==='club'&&!(tempo>=120&&tempo<130)) return false;
      if (range==='fast'&&!(tempo>=130&&tempo<150)) return false;
      if (range==='high'&&!(tempo>=150)) return false;
      if (k!=='all' && (k==='A'||k==='B' ? !key(t).endsWith(k) : key(t)!==k)) return false;
      if (genre==='untagged' && genreValue(t)) return false;
      if (genre!=='all' && genre!=='untagged' && genreValue(t)!==genre) return false;
      if (rating!=='all' && ownRating(t.id)<Number(rating)) return false;
      if (compatible&&(!reference || toId(reference.id)===toId(t.id) || !harmonic(reference,t))) return false;
      return true;
    });
    if (!['queue','local','native','album','artist'].includes(model.view)) {
      const sorting=$('sort').value; result.sort((a,b)=>sorting==='rating'?ownRating(b.id)-ownRating(a.id):sorting==='genre'?genreValue(a).localeCompare(genreValue(b)):sorting==='key'?key(a).localeCompare(key(b),undefined,{numeric:true}):sorting==='length'?(Number(a.length)||0)-(Number(b.length)||0):sorting==='bpm'?((Number(a.bpm)||Infinity)-(Number(b.bpm)||Infinity)):sorting==='bpm-desc'?((Number(b.bpm)||0)-(Number(a.bpm)||0)):sorting==='date'?text(b.date).localeCompare(text(a.date)):sorting==='plays'?((Number(b.plays)||0)-(Number(a.plays)||0)):text(a[sorting]||'').localeCompare(text(b[sorting]||''),undefined,{sensitivity:'base',numeric:true}));
    }
    const proposed=harmonicOrders.get(playlistScope());
    if(['native','local'].includes(model.view)&&proposed){const rank=new Map(proposed.map((id,i)=>[id,i]));result.sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));}
    model.sorted=result;
    // FLX4 physical browser wheel should never scan/sort 12k tracks per tick.
    browseIndexRows=result;
    browseIndex=new Map(result.map((item,index)=>[toId(item.id),index]));
    $('result-count').textContent=`${result.length.toLocaleString()} tracks · ${model.tracks.length.toLocaleString()} in collection`;
    $('hero-summary').textContent=`${model.tracks.length.toLocaleString()} tracks · ${model.nativePlaylists.length} Rekordbox playlists`;
    $('empty').hidden=result.length!==0;
  }
  function rowMarkup(t,i) {
    const id=escapeHtml(t.id),match=harmonic(activeReference(),t); const isFavorite=model.hub.favorites.includes(toId(t.id));
    const title=escapeHtml(t.title||'Untitled'),artist=escapeHtml(t.artist||'Unknown artist');
    return `<div class="track-row ${model.selected===toId(t.id)?'selected':''}" ${keyStyle(t)} draggable="true" data-id="${id}" data-index="${i}" tabindex="0" role="group" aria-label="${title} by ${artist}"><div class="track-index">${i+1}</div><div class="track-main">${art(t)}<div class="track-name"><span class="track-title">${title}</span><span class="track-artist">${artist}${match&&model.selected!==toId(t.id)?` · ${escapeHtml(match)}`:''}</span></div></div><span class="track-artist-column" title="${artist}">${artist}</span><span class="track-album" title="${escapeHtml(t.album||'Album unknown')}">${escapeHtml(t.album||'—')}</span><span class="track-genre" title="${escapeHtml(genreValue(t)||'Not tagged')}">${escapeHtml(genreValue(t)||'—')}</span><span class="number">${bpm(t)}</span><span class="key-cell">${key(t)?`<span class="key-pill">${key(t)}</span>`:'—'}</span><span class="track-duration">${duration(t.length??t.duration)}</span><button type="button" class="row-wave-button" data-action="markers" title="Click to preview song; drag to scrub; Shift-click for cue markers" aria-label="Preview waveform for ${title}; Shift-click to edit cue markers"><canvas width="180" height="32" data-wave-track="${id}" aria-hidden="true"></canvas></button>${ratingMarkup(t)}<div class="row-actions"><button data-action="playlist" title="Add to playlist" aria-label="Add to playlist">▤</button><button data-action="favorite" title="${isFavorite?'Remove favorite':'Favorite'}" class="${isFavorite?'favorited':''}" aria-label="Toggle favorite">${isFavorite?'♥':'♡'}</button><button data-action="queue" title="Add to next up" aria-label="Add to next up">＋</button></div></div>`;
  }
  const rowWaveCache=new Map(),rowWavePending=new Set(),rowWaveQueue=[];
  const markerCache=new Map();
  let activeWaveRequests=0;
  let editingMarkerId=null,activeMarkerRequests=0;
  const markerPending=new Set(),markerQueue=[];
  function redrawTrackMarkers(id){
    const key=toId(id),data=rowWaveCache.get(key),marks=asArray(markerCache.get(key)?.markers);
    if(toId(model.currentDetail?.id)===key&&$('waveform'))renderInlineWave($('waveform'),data,marks);
    document.querySelectorAll('#virtual-items canvas[data-wave-track]').forEach(canvas=>{if(canvas.dataset.waveTrack===key)renderInlineWave(canvas,data,marks);});
  }
  function resetMarkerEditor(){
    editingMarkerId=null;if(!$('marker-form'))return;
    $('marker-type').value='cue';$('marker-label').value='';$('marker-color').value='#8b5cf6';
    $('marker-save').textContent='＋ Add marker';$('marker-cancel').hidden=true;
  }
  function renderMarkerList(id){
    const container=$('marker-list');if(!container)return;
    const data=markerCache.get(toId(id)),markers=asArray(data?.markers);
    const count=markers.filter(m=>m.source==='user').length;
    $('marker-status').textContent=data?count+' Music Hub · '+(markers.length-count)+' Rekordbox':'Loading cue markers…';
    container.innerHTML=markers.length?markers.map(marker=>{
      const own=marker.source==='user',name=text(marker.label||marker.name||(marker.type==='hotcue'?'Hot cue':marker.type==='loop'?'Loop start':'Cue'));
      const color=own&&/^#[0-9a-f]{6}$/i.test(text(marker.color))?marker.color:'#f9af5e';
      return '<div class="marker-item"><span class="marker-color" style="background:'+color+'"></span><div class="marker-copy"><strong>'+escapeHtml(name)+'</strong><small>'+duration(Number(marker.timeMs)/1000)+' · '+escapeHtml(marker.type)+' · '+(own?'Saved in Music Hub':'Rekordbox · read-only')+'</small></div><div>'+(own?'<button type="button" data-marker-edit="'+escapeHtml(marker.id)+'">Edit</button><button type="button" data-marker-remove="'+escapeHtml(marker.id)+'">Delete</button>':'<small>RB</small>')+'</div></div>';
    }).join(''):'<p class="marker-empty">No markers yet. Click the waveform to choose a position.</p>';
  }
  async function refreshTrackMarkers(id,token){
    try{const result=await api('/api/music-hub/markers?trackId='+encodeURIComponent(id));markerCache.set(toId(id),result);
      if(markerCache.size>220)markerCache.delete(markerCache.keys().next().value);
      redrawTrackMarkers(id);
      if(token===model.detailToken&&toId(model.currentDetail?.id)===toId(id))renderMarkerList(id);
    }catch(error){if(token===model.detailToken)$('marker-status').textContent='Cue data unavailable: '+error.message;}
  }
  function queueVisibleMarkers(){
    if(model.grid)return;
    for(const canvas of document.querySelectorAll('#virtual-items canvas[data-wave-track]')){
      const id=canvas.dataset.waveTrack;
      if(markerCache.has(id)||markerPending.has(id))continue;
      if(markerQueue.length>=40)break;
      markerPending.add(id);markerQueue.push(id);
    }
    while(activeMarkerRequests<2&&markerQueue.length){
      const id=markerQueue.shift();activeMarkerRequests++;
      api('/api/music-hub/markers?trackId='+encodeURIComponent(id)).then(result=>{
        markerCache.set(id,result);if(markerCache.size>220)markerCache.delete(markerCache.keys().next().value);
        redrawTrackMarkers(id);
      }).catch(()=>{markerCache.set(id,{trackId:id,markers:[],unavailable:true});})
        .finally(()=>{activeMarkerRequests--;markerPending.delete(id);queueVisibleMarkers();});
    }
  }
  function ensureMarkerEditor(){
    if($('marker-editor'))return;
    const editor=document.createElement('section');editor.id='marker-editor';editor.className='marker-editor';
    editor.innerHTML='<strong>Saved cues & hot cue markers</strong><p>Click the waveform to choose a position. Existing Rekordbox cues are read-only; your edits are saved in Music Hub.</p><form id="marker-form"><div class="marker-form"><label>Time (seconds)<input type="number" id="marker-time" min="0" max="86400" step="0.001" value="0" required></label><label>Type<select id="marker-type"><option value="cue">Cue</option><option value="hotcue">Hot cue</option><option value="loop">Loop start</option></select></label><label>Label<input id="marker-label" type="text" maxlength="80" placeholder="Intro, drop, outro"></label><label>Color<input id="marker-color" type="color" value="#8b5cf6" aria-label="Cue color"></label></div><div class="marker-controls"><button id="marker-save" type="submit" class="primary-button">＋ Add marker</button><button type="button" id="marker-at-playhead">Use preview time</button><button type="button" id="marker-cancel" hidden>Cancel edit</button><span id="marker-status" class="marker-status" role="status"></span></div></form><div id="marker-list" class="marker-list" aria-live="polite"></div>';
    $('waveform').closest('.wave-section').append(editor);
    $('waveform').style.cursor='crosshair';$('waveform').title='Click to position a cue marker';
    $('waveform').addEventListener('click',event=>{
      const seconds=Number(model.currentDetail?.length);if(!(seconds>0))return;
      const rect=event.currentTarget.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));
      $('marker-time').value=String(Math.round(seconds*ratio*1000)/1000);
      $('marker-status').textContent='Position '+duration(seconds*ratio)+' selected';
    });
    $('marker-at-playhead').addEventListener('click',()=>{
      const id=toId(model.currentDetail?.id),seconds=Number(model.currentDetail?.length)||0;
      const current=player().getAttribute('data-track')===id?Number(player().currentTime)||0:0;
      $('marker-time').value=String(Math.round(Math.min(seconds,Math.max(0,current))*1000)/1000);
    });
    $('marker-cancel').addEventListener('click',resetMarkerEditor);
    $('marker-form').addEventListener('submit',async event=>{
      event.preventDefault();const id=toId(model.currentDetail?.id),song=track(id),sec=Number($('marker-time').value);
      if(!song||!Number.isFinite(sec)||sec<0||sec>Number(song.length))return void notify('Cue position must fit within this song.',true);
      const payload={action:editingMarkerId?'update':'add',trackId:id,timeMs:Math.round(sec*1000),type:$('marker-type').value,label:$('marker-label').value.trim(),color:$('marker-color').value};
      if(editingMarkerId)payload.id=editingMarkerId;
      const button=$('marker-save');button.disabled=true;
      try{const result=await post('/api/music-hub/markers',payload);markerCache.set(id,result);resetMarkerEditor();renderMarkerList(id);redrawTrackMarkers(id);window.dispatchEvent(new CustomEvent('music-hub:markers',{detail:{id,markers:asArray(result.markers)}}));notify('Marker saved in Music Hub');}
      catch(error){notify('Unable to save cue: '+error.message,true);}finally{button.disabled=false;}
    });
    $('marker-list').addEventListener('click',async event=>{
      const edit=event.target.closest('[data-marker-edit]'),remove=event.target.closest('[data-marker-remove]');if(!edit&&!remove)return;
      const id=toId(model.currentDetail?.id),key=edit?.dataset.markerEdit||remove?.dataset.markerRemove;
      const marker=asArray(markerCache.get(id)?.markers).find(m=>m.id===key&&m.source==='user');if(!marker)return;
      if(edit){editingMarkerId=marker.id;$('marker-time').value=String(marker.timeMs/1000);$('marker-type').value=marker.type;$('marker-label').value=marker.label||'';$('marker-color').value=marker.color;$('marker-save').textContent='Save changes';$('marker-cancel').hidden=false;$('marker-time').focus();return;}
      if(!confirm('Remove this saved Music Hub cue?'))return;
      try{const result=await post('/api/music-hub/markers',{action:'remove',trackId:id,id:marker.id});markerCache.set(id,result);resetMarkerEditor();renderMarkerList(id);redrawTrackMarkers(id);window.dispatchEvent(new CustomEvent('music-hub:markers',{detail:{id,markers:asArray(result.markers)}}));notify('Marker removed');}
      catch(error){notify('Unable to remove cue: '+error.message,true);}
    });
  }
  function renderInlineWave(canvas,data,markers=[]){
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const w=canvas.width,h=canvas.height,heights=asArray(data?.waveform?.heights),colors=asArray(data?.waveform?.colors);
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#05070c';ctx.fillRect(0,0,w,h);
    ctx.fillStyle='#31435b';ctx.fillRect(0,h-2,w,1);
    if(!heights.length){ctx.fillStyle='#708295';ctx.font='10px sans-serif';ctx.fillText('waveform unavailable',4,Math.ceil(h/2)-3);return;}
    const samples=heights.map(v=>Math.max(0,...(Array.isArray(v)?v:[v]).map(x=>Number(x)||0)));
    const sorted=samples.filter(v=>v>0).sort((a,b)=>a-b);
    const p95=sorted[Math.floor(sorted.length*.95)]||1;
    const gain=Math.min(12,.85/p95),base=h-3;
    // Peak bins retain real transients at thumbnail resolution. Colors are
    // layered amplitude styling, not claims about frequency/stem separation.
    for(let x=0;x<w;x++){
      const first=Math.floor(x*samples.length/w),last=Math.max(first+1,Math.floor((x+1)*samples.length/w));
      let peak=0;for(let i=first;i<Math.min(last,samples.length);i++)peak=Math.max(peak,samples[i]);
      const size=Math.min(1,peak*gain)*(h-9);
      for(const [ratio,color] of [[1,'#297deb'],[.67,'#f0ae4d'],[.28,'#fff0cd']]){
        ctx.fillStyle=color;ctx.fillRect(x,base-size*ratio,1,size*ratio);
      }
    }
    const seconds=Number(track(canvas.dataset.waveTrack)?.length);
    if(!Number.isFinite(seconds)||seconds<=0)return;
    const originals=asArray(data?.cues?.cues).map(c=>({timeMs:c.in_ms,color:'#f7be6e'}));
    for(const marker of [...originals,...markers.filter(m=>m.source==='user')]){
      const ms=Number(marker.timeMs);if(!Number.isFinite(ms)||ms<0||ms>seconds*1000)continue;
      const x=Math.min(w-1,Math.round(ms/(seconds*1000)*w));ctx.fillStyle=marker.source==='user'&&/^#[0-9a-fA-F]{6}$/.test(marker.color)?marker.color:'#f7be6e';ctx.fillRect(x,0,2,h);
    }
  }
  function queueVisibleRowWaves(){
    if(model.grid)return;
    const canvases=[...document.querySelectorAll('#virtual-items canvas[data-wave-track]')];
    for(const canvas of canvases){
      const id=canvas.dataset.waveTrack;
      if(rowWaveCache.has(id)){renderInlineWave(canvas,rowWaveCache.get(id),asArray(markerCache.get(id)?.markers));continue;}
      renderInlineWave(canvas,null);
      if(rowWavePending.has(id))continue;
      if(rowWaveQueue.length>=45)rowWavePending.delete(rowWaveQueue.shift());
      rowWaveQueue.push(id);rowWavePending.add(id);
    }
    flushRowWaveQueue();
    queueVisibleMarkers();
  }
  function flushRowWaveQueue(){
    while(activeWaveRequests<3&&rowWaveQueue.length){
      const id=rowWaveQueue.shift();activeWaveRequests++;
      api('/api/track-detail?id='+encodeURIComponent(id)+'&points=130').then(detail=>{
        rowWaveCache.delete(id);rowWaveCache.set(id,detail);
        if(rowWaveCache.size>180)rowWaveCache.delete(rowWaveCache.keys().next().value);
        document.querySelectorAll('#virtual-items canvas[data-wave-track]').forEach(canvas=>{if(canvas.dataset.waveTrack===id)renderInlineWave(canvas,detail,asArray(markerCache.get(id)?.markers));});
      }).catch(()=>{rowWaveCache.set(id,null);}).finally(()=>{rowWavePending.delete(id);activeWaveRequests--;flushRowWaveQueue();});
    }
  }
  let lastRowWindow='';
  function renderRows(force=true) {
    const scroll=$('scroller'),content=$('virtual-items'),space=$('virtual-space');
    if (model.grid) { const square=displayMode==='square',cardWidth=square?132:168,height=square?222:268,columns=Math.max(1,Math.floor((scroll.clientWidth-16)/(cardWidth+8))),startRow=Math.max(0,Math.floor(scroll.scrollTop/height)-2),endRow=Math.min(Math.ceil(model.sorted.length/columns),Math.ceil((scroll.scrollTop+scroll.clientHeight)/height)+3);space.style.height=`${Math.ceil(model.sorted.length/columns)*height}px`;content.style.position='absolute';content.style.transform=`translateY(${startRow*height}px)`;content.style.gridTemplateColumns=`repeat(${columns},minmax(0,1fr))`;content.innerHTML=model.sorted.slice(startRow*columns,endRow*columns).map((t,i)=>rowMarkup(t,startRow*columns+i)).join('');return; }
    const height=displayMode==='micro'?28:displayMode==='compact'?36:ROW_HEIGHT;
    const start=Math.max(0,Math.floor(scroll.scrollTop/height)-7),end=Math.min(model.sorted.length,Math.ceil((scroll.scrollTop+scroll.clientHeight)/height)+9);
    const rowWindow=[start,end,height,scroll.clientWidth].join(':');
    if(!force&&rowWindow===lastRowWindow)return;
    lastRowWindow=rowWindow;
    content.style.position='absolute';space.style.height=`${model.sorted.length*height}px`;
    content.style.transform=`translateY(${start*height}px)`;
    content.innerHTML=model.sorted.slice(start,end).map((t,i)=>rowMarkup(t,start+i)).join('');
    queueVisibleRowWaves();
  }
  function renderResults(reset=false) { computeResults(); if(reset) $('scroller').scrollTop=0; renderRows(); }
  function renderQueue() {
    $('queue-title-count').textContent=model.hub.queue.length; $('queue-count').textContent=model.hub.queue.length||'';
    $('queue-items').innerHTML=model.hub.queue.length?model.hub.queue.map((id,i)=>{const t=track(id);return `<div class="queue-item" draggable="${model.hubAvailable}" data-index="${i}" data-id="${escapeHtml(id)}"><span class="drag-handle" title="Drag to reorder">⠿</span>${art(t)}<div class="item-content"><strong>${escapeHtml(t?.title||`Missing track ${id}`)}</strong><small>${escapeHtml(t?.artist||'Unavailable in library')} · ${bpm(t)} BPM</small></div><button data-remove="${escapeHtml(id)}" data-remove-index="${i}" title="Remove from queue" aria-label="Remove from queue">×</button></div>`;}).join(''):'<div class="queue-placeholder">Your queue is empty. Add a track with ＋ to prepare your set.</div>';
  }
  async function openTrack(id) {
    const t=track(id);if(!t)return notify('Track no longer exists in the loaded library.',true);
    if(player().getAttribute('data-track')&&player().getAttribute('data-track')!==toId(id))stopPreview();
    model.selected=toId(id); $('detail-drawer').hidden=false; model.currentDetail=t;updateSelectedPlayer();window.MusicHubStudio?.onSelectionChange();
    ensureMarkerEditor();resetMarkerEditor();
    $('detail-title').textContent=t.title||'Untitled';$('detail-artist').textContent=t.artist||'Unknown artist';$('detail-art').innerHTML=art(t);
    $('detail-tags').innerHTML=`<span class="key-pill">${escapeHtml(key(t)||'Key unavailable')}</span><span class="key-pill">${bpm(t)} BPM</span><span class="key-pill">${duration(t.length)}</span>`;
    $('detail-metrics').innerHTML=[['ALBUM',t.album||'—'],['GENRE',t.genre||'—'],['PLAYS',t.plays??'—'],['KEY',t.key||'—'],['REKORDBOX RATING',t.rating??'—'],['ENERGY','Not measured']].map(([name,value])=>`<div class="metric"><small>${escapeHtml(name)}</small><strong>${escapeHtml(value)}</strong></div>`).join('');
    $('load-status').textContent='';$('transition-plan').textContent='Select another track from Next up for a comparison.';
    renderDetailFavorite();renderResults();
    const detailToken=++model.detailToken;
    renderMarkerList(toId(id));refreshTrackMarkers(toId(id),detailToken);
    $('waveform').dataset.waveTrack=toId(id);
    $('wave-status').textContent='Retrieving analyzed waveform…';drawWave([]);
    try {const d=await api(`/api/track-detail?id=${encodeURIComponent(id)}&points=320`);if(detailToken!==model.detailToken)return; const heights=asArray(d?.waveform?.heights);rowWaveCache.set(id,d);renderInlineWave($('waveform'),d,asArray(markerCache.get(id)?.markers));$('wave-status').textContent=heights.length?'Actual Rekordbox waveform · click a point to position your cue':'No analyzed waveform available';}catch(e){if(detailToken===model.detailToken)$('wave-status').textContent=`Waveform unavailable: ${e.message}`;}
    await loadCandidates(id);
    const adjacent=model.hub.queue.find(x=>x!==toId(id));if(adjacent)loadTransition(id,adjacent);
  }
  function drawWave(heights) { const canvas=$('waveform'),ctx=canvas.getContext('2d');if(!ctx)return;const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#292632';ctx.fillRect(0,0,w,h);ctx.fillStyle='#c3a8fa'; const n=heights.length; if(!n){ctx.fillStyle='#858192';ctx.font='14px sans-serif';ctx.fillText('No waveform available',16,h/2);return;}const column=w/n;heights.forEach((v,i)=>{const height=Math.max(2,Math.min(h*.94,Number(v)*h*.8));ctx.fillRect(i*column,(h-height)/2,Math.max(1,column-.6),height);}); }
  function renderDetailFavorite(){if(!model.currentDetail)return;$('detail-favorite').textContent=model.hub.favorites.includes(toId(model.currentDetail.id))?'♥ Favorited':'♡ Favorite';}
  function transitionSummary(metadata) {
    if (!metadata || typeof metadata !== 'object') return {badges:[],details:[]};
    const badges=[], details=[];
    if (['high','medium','low'].includes(metadata.confidence)) badges.push(`${metadata.confidence} confidence`);
    const adjustment=Number(metadata.incoming_tempo_percent_to_match);
    if (metadata.incoming_tempo_percent_to_match!=null && Number.isFinite(adjustment)) {
      details.push(`Tempo ${adjustment>=0?'+':''}${adjustment.toFixed(2)}%`);
      if (Number(metadata.tempo_multiplier)===2) details.push('2× tempo');
      if (Number(metadata.tempo_multiplier)===0.5) details.push('½ tempo');
    }
    const cue=metadata.suggestion;
    if (cue && typeof cue==='object') {
      const from=Number(cue.from_start_sec),to=Number(cue.to_start_sec);
      if (Number.isFinite(from) && Number.isFinite(to) && cue.from_start_sec!=null && cue.to_start_sec!=null) details.push(`Phrase ${duration(from)} → ${duration(to)}`);
      const bars=Number(cue.to_bars);
      if (cue.to_bars!=null && Number.isFinite(bars) && bars>0) details.push(`${bars} incoming bars`);
    }
    return {badges,details};
  }
  async function loadCandidates(id) {
    const token=++model.candidateToken; $('suggestion-context').textContent=`Suggested transitions from ${track(id)?.title||'selected track'}`;$('suggestions').innerHTML='<div class="queue-placeholder">Finding compatible tracks…</div>';
    try {const d=await api(`/api/transition-candidates?id=${encodeURIComponent(id)}&limit=12`);if(token!==model.candidateToken)return;
      model.candidates=asArray(d.tracks).map(row=>{const t=row.track||row;return {track:track(t.id)||t,reason:text(row.reason||row.explanation||''),score:row.score,transition:row._transition||t._transition};}).filter(r=>r.track?.id);
      $('suggestions').innerHTML=model.candidates.length?model.candidates.map(({track:t,reason,transition})=>{const info=transitionSummary(transition),fit=harmonic(track(id),t);return `<div class="suggestion" data-id="${escapeHtml(t.id)}">${art(t)}<div class="item-content"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.artist)} · ${bpm(t)} BPM · ${escapeHtml(key(t)||'Key unknown')}</small><div class="suggestion-badges">${fit?`<span class="match-pill">${escapeHtml(fit)}</span>`:''}${info.badges.map(b=>`<span class="confidence-pill">${escapeHtml(b)}</span>`).join('')}</div>${info.details.length?`<small class="suggestion-metrics">${info.details.map(escapeHtml).join(' · ')}</small>`:reason?`<small>${escapeHtml(reason)}</small>`:''}</div><button data-suggest-add="${escapeHtml(t.id)}" aria-label="Add suggested track to queue" title="Add to queue">＋</button></div>`;}).join(''):'<div class="queue-placeholder">No analyzed suggestions found for this track.</div>';
    }catch(e){if(token===model.candidateToken)$('suggestions').innerHTML=`<div class="queue-placeholder">Suggestions unavailable: ${escapeHtml(e.message)}</div>`;}
  }
  async function loadTransition(from,to) {try {const d=await api(`/api/transition-plan?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);if(model.selected!==from)return; const parts=[];for(const [label,value] of Object.entries(d)){if(['source','target','from','to','track','tracks'].includes(label)||typeof value==='object'||value==null)continue;parts.push(`${label.replace(/_/g,' ')}: ${value}`);} $('transition-plan').textContent=parts.length?parts.slice(0,8).join(' · '):`Transition details available for ${track(to)?.title||'next track'}, but no text recommendation was provided.`;}catch(e){$('transition-plan').textContent=`Transition plan unavailable: ${e.message}`;}}
  async function loadDeck(deck,requestedId=null) {
    const id=toId(requestedId??model.currentDetail?.id);if(!track(id)||model.pending)return;
    if(requestedId && !verifiedDeckFeedback){notify('Live Rekordbox feedback is required before loading a staged deck.',true);return;}
    model.pending=true;document.querySelectorAll('[data-load]').forEach(x=>x.disabled=true);
    $('load-status').textContent=`Checking safe load for Deck ${deck}…`;
    try {const data=await post('/api/music-hub/load',{deck:Number(deck),trackId:toId(id),dryRun:false});const verified=Boolean(data.verified===true||data.load_verified===true||data.status==='load_verified'||data.status==='verified'||data.status==='loaded'||(data.status==='already_loaded'&&data.verified===true));if(verified){$('load-status').textContent=`Verified load to Deck ${deck}. Playback has not been started.`;notify(`Deck ${deck}: load verified`);}else{$('load-status').textContent=`Deck ${deck}: ${text(data.reason||data.message||data.status||'No verified load feedback received')}. Check Rekordbox before continuing.`;notify('Load has not been verified',true);}}
    catch(e){$('load-status').textContent=`Load failed: ${e.message}`;notify(`Load failed: ${e.message}`,true);}finally{model.pending=false;document.querySelectorAll('[data-load]').forEach(x=>x.disabled=false);}
  }
  function closeDetail(){$('detail-drawer').hidden=true;model.detailToken++;}
  function openPlaylistDialog(mode, id=null) {
    if(!model.hubAvailable){notify('Music Hub storage unavailable.',true);return;}
    const dialog=$('playlist-dialog');dialogReturnFocus=document.activeElement;
    assignedTrackId=id;
    const create=mode==='create';
    $('playlist-create-form').hidden=!create;$('playlist-assign-panel').hidden=create;
    $('playlist-dialog-title').textContent=create?'New playlist':'Add to playlists';
    $('playlist-dialog-description').textContent=create?'Give your collection a name.':'Select any playlist to add or remove this track.';
    if(create){$('playlist-name').value='';}
    else {
      const t=track(id);
      $('playlist-dialog-track').innerHTML=`${art(t)}<div><strong>${escapeHtml(t?.title||'Unknown track')}</strong><small>${escapeHtml(t?.artist||'Unknown artist')}</small></div>`;
      renderPlaylistChoices();
    }
    dialog.showModal();
    if(create)$('playlist-name').focus();
    else $('playlist-dialog-playlists').querySelector('button')?.focus();
  }
  function renderPlaylistChoices() {
    $('playlist-dialog-playlists').innerHTML=model.hub.playlists.length?model.hub.playlists.map(p=>{
      const assigned=p.trackIds.includes(assignedTrackId);
      return `<button type="button" class="playlist-choice ${assigned?'assigned':''}" data-playlist-id="${escapeHtml(p.id)}" aria-pressed="${assigned}" aria-label="${assigned?'Remove from':'Add to'} ${escapeHtml(p.name)}"><span class="playlist-choice-icon">♫</span><span class="playlist-choice-name"><strong>${escapeHtml(p.name)}</strong><small>${p.trackIds.length} tracks</small></span><span class="playlist-choice-state">${assigned?'✓ Added':'＋ Add'}</span></button>`;
    }).join(''):'<div class="queue-placeholder">No playlists yet. Create a playlist first.</div>';
  }
  function closePlaylistDialog(){const dialog=$('playlist-dialog');if(dialog.open)dialog.close();}
  // Performance status comes only from the verified native deck endpoint.
  let workspaceMode='library', setlist=[], setlistTransitions=[], savedSetlistId=null, setlistBusy=false, deckRequest=0, verifiedDeckFeedback=false;
  const stagedDeckIds={1:null,2:null};
  let verifiedDeckSlots={1:null,2:null};
  function persistStagedDecks(){try{localStorage.setItem('music-hub-staged-previews',JSON.stringify(stagedDeckIds));}catch{}}
  function updateDeckPreviewButtons(){
    const playingId=toId(player()?.getAttribute('data-track'));
    for(const n of [1,2]){
      const button=$('deck-preview-'+n);if(!button)continue;
      const deckTrack=verifiedDeckSlots[n]||track(stagedDeckIds[n]);
      const localTrack=track(deckTrack?.id);
      const playing=Boolean(localTrack&&playingId===toId(localTrack.id)&&!player().paused&&!player().ended);
      button.disabled=!localTrack;
      button.textContent=playing?'Ⅱ Pause preview':'▶ Local preview';
      button.classList.toggle('playing',playing);
      button.setAttribute('aria-label',(playing?'Pause':'Play')+' local audio preview of Deck '+(n===1?'A':'B'));
      button.setAttribute('aria-pressed',String(playing));
    }
  }
  async function toggleDeckPreview(n){
    const deckTrack=verifiedDeckSlots[n]||track(stagedDeckIds[n]);
    const local=track(deckTrack?.id);
    if(!local)return void notify('Stage a local library track on this deck to preview it.',true);
    if(toId(model.selected)!==toId(local.id))selectFooterTrack(local.id);
    await togglePreview();
    updateDeckPreviewButtons();
  }
  function stageDeck(deck,trackId=null){
    const id=toId(trackId??model.currentDetail?.id);
    if(!track(id))return notify('Select a library track before staging.',true);
    if(verifiedDeckSlots[deck])return notify('Deck '+deck+' is showing verified live feedback. Its actual track takes priority.',true);
    stagedDeckIds[deck]=id;
    persistStagedDecks();
    deckSlot(deck,null,false);
    window.MusicHubTopDecks?.preloadDeck?.(deck);
    updateDeckRelationship();
    togglePerformance(true);
    window.MusicHubStudio?.onDeckChange();
    updateHarmonicRail();
    notify('Staged preview on Deck '+(deck===1?'A':'B')+' — Rekordbox was not loaded.');
  }
  function updateDeckRelationship(one=verifiedDeckSlots[1]||track(stagedDeckIds[1]),two=verifiedDeckSlots[2]||track(stagedDeckIds[2])){
    $('deck-relationship').textContent=one&&two?[
      harmonic(one,two)||'Key match unknown',
      Number(one.bpm)>0&&Number(two.bpm)>0?Math.abs(Number(one.bpm)-Number(two.bpm)).toFixed(1)+' BPM apart':null
    ].filter(Boolean).join(' · '):'Stage two tracks to compare';
  }
  function switchWorkspace(mode) {
    workspaceMode=mode;
    const making=mode==='setlist';
    const checking=mode==='health';
    $('setlist-workspace').hidden=!making;
    $('health-workspace').hidden=!checking;
    $('browse-gallery').hidden=making||checking;
    document.querySelector('.hero').hidden=making||checking;
    document.querySelector('.work-area').hidden=making||checking;
    document.querySelector('.inspector').classList.toggle('setlist-inspector',making||checking);
    $('mode-library').classList.toggle('active',!making&&!checking);
    $('mode-setlist').classList.toggle('active',making);
    $('mode-library').setAttribute('aria-pressed',String(!making&&!checking));
    $('mode-setlist').setAttribute('aria-pressed',String(making));
    if(making) {$('setlist-find').focus();renderSetlistSearch();}
    else if(!checking){renderGallery();renderResults();}
  }
  // Keep each deck card's small full-track Rekordbox RGB overview. The shared
  // 190px performance waveform above these cards owns the beat-zoomed view.
  function renderDeckWave(canvasId,detail=null,seconds=0) {
    const canvas=$(canvasId),ctx=canvas?.getContext('2d');if(!ctx)return;
    const width=canvas.width,height=canvas.height,heights=asArray(detail?.waveform?.heights);
    const colors=asArray(detail?.waveform?.colors),durationSeconds=Number(seconds);
    const accent=canvasId.startsWith('deck-one')?'#39bafa':'#f0a15e';
    ctx.clearRect(0,0,width,height);ctx.fillStyle='#05070b';ctx.fillRect(0,0,width,height);
    ctx.fillStyle='#23354c';ctx.fillRect(0,height-4,width,1);
    ctx.strokeStyle='#293643';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,height/2+.5);ctx.lineTo(width,height/2+.5);ctx.stroke();
    if(!heights.length){ctx.font='12px sans-serif';ctx.fillStyle='#627181';ctx.fillText('NO ANALYZED WAVEFORM',14,height/2-7);return;}
    const fallback=canvasId.startsWith('deck-one')?[44,157,219]:[229,143,79];
    const channel=value=>Math.max(0,Math.min(255,Math.round(Number(value)||0)));
    const normalizedSamples=heights.map(v=>Math.max(0,...(Array.isArray(v)?v:[v]).map(x=>Number(x)||0)));
    const sortedPeaks=normalizedSamples.filter(v=>v>0).sort((a,b)=>a-b);
    const p95=sortedPeaks[Math.max(0,Math.floor(sortedPeaks.length*.95)-1)]||0;
    const gain=p95>0?Math.min(12,.72/p95):1;
    // Reference-style layered amplitude envelope, not a spectral analysis.
    // Peak-bin aggregation preserves transients when many samples share a pixel.
    const baseline=height-7,available=height-20;
    for(let x=0;x<width;x++){
      const lo=Math.floor(x*heights.length/width),hi=Math.max(lo+1,Math.floor((x+1)*heights.length/width));
      let peak=0;
      for(let i=lo;i<Math.min(hi,heights.length);i++)peak=Math.max(peak,normalizedSamples[i]);
      const amplitude=Math.min(1,peak*gain),h=amplitude*available;
      if(h<=0)continue;
      ctx.fillStyle='#2879e9';ctx.fillRect(x,baseline-h,1,h);
      ctx.fillStyle='#efaa43';ctx.fillRect(x,baseline-h*.66,1,h*.66);
      ctx.fillStyle='#fff0cc';ctx.fillRect(x,baseline-h*.29,1,h*.29);
    }
    if(!(durationSeconds>0))return;
    const at=time=>Number.isFinite(Number(time))&&Number(time)>=0&&Number(time)<=durationSeconds?Number(time)/durationSeconds*width:null;
    const downbeats=asArray(detail?.analysis?.beats).filter(beat=>Number(beat.beat)===1);
    const stride=Math.max(1,Math.ceil(downbeats.length/70));
    ctx.lineWidth=1;
    downbeats.forEach((beat,index)=>{
      if(index%stride!==0)return;
      const x=at(beat.time);if(x===null)return;
      ctx.strokeStyle='rgba(233,240,248,.27)';ctx.beginPath();ctx.moveTo(x+.5,5);ctx.lineTo(x+.5,12);ctx.stroke();
    });
    asArray(detail?.analysis?.phrases).forEach(phrase=>{
      const x=at(phrase.start_sec);if(x===null)return;
      ctx.fillStyle='rgba(240,247,255,.8)';ctx.fillRect(x,2,1.5,12);
    });
    asArray(detail?.cues?.cues).forEach(cue=>{
      const ms=Number(cue.in_ms);if(!Number.isFinite(ms)||ms<0)return;
      const x=at(ms/1000);if(x===null)return;
      const label=String(cue.hot_cue||'');
      const palette=['#ff646b','#55b9ff','#8bd657','#b18bff','#45d9c0','#ffa04e','#748bff','#e4dc5a'];
      const slot=/^[1-8]$/.test(label)?Number(label)-1:'ABCDEFGH'.indexOf(label.toUpperCase());
      ctx.fillStyle=slot>=0?palette[slot]:'#a6e6d7';
      ctx.fillRect(x,12,1,height-19);
      if(slot>=0){const left=Math.max(0,Math.min(width-14,x));ctx.fillRect(left,0,14,12);ctx.fillStyle='#080b11';ctx.font='bold 10px sans-serif';ctx.fillText('ABCDEFGH'[slot],left+3,10);}
      else {ctx.beginPath();ctx.moveTo(x-3,2);ctx.lineTo(x+3,2);ctx.lineTo(x,8);ctx.fill();}
    });
  }
  function deckSlot(n,data,verified) {
    const prefix=n===1?'deck-one':'deck-two';
    const id=toId(data?.trackId??data?.id??'');
    const loaded=data?.loaded;const loadedId=toId(loaded?.trackId??loaded?.id??id);const loadedTrack=track(loadedId);const t=verified && data?.verified===true && loaded ? {...loadedTrack,...loaded,id:loadedId} : null;
    verifiedDeckSlots[n]=t;
    const staged=t?null:track(stagedDeckIds[n]), display=t||staged;
    $(prefix+'-status').textContent=t?'VERIFIED DECK':staged?'STAGED PREVIEW':'UNVERIFIED';
    $(prefix+'-title').textContent=display?text(display.title||'Untitled'):'No verified track';
    $(prefix+'-artist').textContent=display?text(display.artist||'Unknown artist'):'Waiting for Rekordbox feedback';
    $(prefix+'-bpm').textContent=display?bpm(display):'—';
    $(prefix+'-key').textContent=display?key(display)||'—':'—';
    $(prefix+'-time').textContent=display?('— / '+duration(display.length??display.duration)):'— / —';
    $(prefix+'-source').textContent=t?'VERIFIED REKORDBOX DECK · PLAY STATE UNKNOWN':staged?'STAGED PREVIEW — NOT LOADED':'NO LIVE FEEDBACK';
    $(prefix+'-art').innerHTML=display?art(display):'♫';
    const loadButton=$('deck-load-'+n);if(loadButton){loadButton.disabled=!staged||!verifiedDeckFeedback||model.pending;loadButton.hidden=!staged;}
    updateDeckPreviewButtons();
    renderDeckWave(prefix+'-wave');
    window.MusicHubPerformanceChrome?.sync(n,{track:display,verified:!!t,positionSeconds:t&&loaded?.positionSeconds!=null?Number(loaded.positionSeconds):null});
    window.MusicHubTopDecks?.setDeck(n,{
      track:display,verified:!!t,
      positionSeconds:t&&loaded?.positionSeconds!=null&&Number.isFinite(Number(loaded.positionSeconds))?Number(loaded.positionSeconds):null
    });
    if(display?.id) {
      const token=deckRequest;
      const displayId=toId(display.id);
      api('/api/track-detail?id='+encodeURIComponent(displayId)+'&points=600')
        .then(detail=>{if(token===deckRequest && toId((verifiedDeckSlots[n]||track(stagedDeckIds[n]))?.id)===displayId){
          renderDeckWave(prefix+'-wave',detail,display.length??display.duration);
          window.MusicHubPerformanceChrome?.sync(n,{track:display,detail,verified:!!t,positionSeconds:t&&loaded?.positionSeconds!=null?Number(loaded.positionSeconds):null});
          window.MusicHubTopDecks?.setDeck(n,{
            track:display,detail,verified:!!t,
            positionSeconds:t&&loaded?.positionSeconds!=null&&Number.isFinite(Number(loaded.positionSeconds))?Number(loaded.positionSeconds):null
          });
        }})
        .catch(()=>{});
    }
    return t;
  }
  async function refreshDecks() {
    const token=++deckRequest;
    $('deck-connection').textContent='CHECKING FEEDBACK';
    try {
      const result=await api('/api/music-hub/decks');
      if(token!==deckRequest)return;
      const verified=result.verified===true && result.connected===true;
      verifiedDeckFeedback=verified;
      const one=deckSlot(1,result.decks?.['1'],verified);
      const two=deckSlot(2,result.decks?.['2'],verified);
      for(const n of [1,2]){
        if(stagedDeckIds[n]&&!verifiedDeckSlots[n])window.MusicHubTopDecks?.preloadDeck?.(n);
      }
      $('deck-connection').textContent=verified?'CONNECTED · VERIFIED':'NO LIVE FEEDBACK';
      $('deck-note').textContent='Staged previews are preparation only; verified Rekordbox feedback always takes priority. '+text(result.note||'');
      updateDeckRelationship();
    } catch {
      verifiedDeckFeedback=false;
      if(token!==deckRequest)return;
      deckSlot(1,null,false);deckSlot(2,null,false);
      // When the separate Rekordbox telemetry API is unverified it carries
      // an error field, so refreshDecks takes this catch path. Our local
      // staged MP3s are still valid: prime both local audio graphs here too.
      // Otherwise PLAY suffers the slow first-time WebKit decoder start.
      for(const n of [1,2]){
        if(stagedDeckIds[n])window.MusicHubTopDecks?.preloadDeck?.(n);
      }
      $('deck-connection').textContent='NO LIVE FEEDBACK';
      $('deck-note').textContent='Rekordbox deck telemetry is unavailable. Library, recommendations and the queue remain usable as preparation tools.';
      updateDeckRelationship();
    }
    window.MusicHubStudio?.onDeckChange();
    updateHarmonicRail();
  }
  function setlistOption(t) {
    return '<button type="button" data-seed="'+escapeHtml(t.id)+'">'+art(t)+'<span><strong>'+escapeHtml(t.title||'Untitled')+'</strong><small>'+escapeHtml(t.artist||'Unknown artist')+' · '+bpm(t)+' BPM · '+escapeHtml(key(t)||'Key unknown')+'</small></span></button>';
  }
  function renderSetlistSearch() {
    const q=$('setlist-find').value.trim().toLowerCase();
    const matches=q?model.tracks.filter(t=>[t.title,t.artist,t.album,t.bpm].some(v=>text(v).toLowerCase().includes(q))).slice(0,15):model.tracks.slice(0,12);
    $('setlist-search-results').innerHTML=matches.map(setlistOption).join('')||'<p>No matching tracks.</p>';
    const selected=$('setlist-source').value;
    $('setlist-source').innerHTML='<option value="">Choose a starting track</option>'+matches.map(t=>'<option value="'+escapeHtml(t.id)+'">'+escapeHtml(t.title)+' — '+escapeHtml(t.artist)+'</option>').join('')+(selected&&!matches.some(t=>t.id===selected)&&track(selected)?'<option value="'+escapeHtml(selected)+'">'+escapeHtml(track(selected).title)+'</option>':'');
    if(selected)$('setlist-source').value=selected;
  }
  function transitionFor(a,b) {
    return setlistTransitions.find(t=>toId(t.from_id)===a&&toId(t.to_id)===b)?.plan;
  }
  function renderSetlist() {
    $('setlist-count').textContent=setlist.length+' tracks';
    for(const id of ['setlist-queue','setlist-save'])$(id).disabled=!setlist.length||setlistBusy||!model.hubAvailable;
    $('setlist-export').disabled=!savedSetlistId || setlist.join('|')!==model.hub.setlists.find(p=>p.id===savedSetlistId)?.trackIds.join('|');
    renderSavedSets();
    $('setlist-rows').innerHTML=setlist.length?setlist.map((id,i)=>{
      const t=track(id),previous=i>0?transitionFor(setlist[i-1],id):null,summary=transitionSummary(previous);
      const badges=summary.badges.map(v=>'<span class="confidence-pill">'+escapeHtml(v)+'</span>').join('');
      const note=i===0?'OPENING TRACK':previous?(summary.details.join(' · ')||'Transition analyzed; detailed phrase timing unavailable'):'MANUALLY ORDERED · TRANSITION NOT ANALYZED';
      return '<div class="setlist-row" data-index="'+i+'"><span class="setlist-position">'+String(i+1).padStart(2,'0')+'</span>'+art(t)+'<div class="setlist-track"><strong>'+escapeHtml(t?.title||'Missing track')+'</strong><span>'+escapeHtml(t?.artist||'Unavailable')+' · '+bpm(t)+' BPM · '+escapeHtml(key(t)||'Key unknown')+'</span><small>'+escapeHtml(note)+'</small></div><div class="setlist-confidence">'+badges+'</div><div class="setlist-row-actions"><button data-move="-1" '+(i===0?'disabled':'')+' aria-label="Move earlier">↑</button><button data-move="1" '+(i===setlist.length-1?'disabled':'')+' aria-label="Move later">↓</button><button data-drop="true" aria-label="Remove from set">×</button></div></div>';
    }).join(''):'<div class="setlist-empty">Choose a starting track and build a set to see the running order.</div>';
  }
  async function buildSetlist() {
    const id=$('setlist-source').value;if(!id)return notify('Select a starting track first.',true);
    setlistBusy=true;savedSetlistId=null;renderSetlist();
    $('setlist-status').textContent='Analyzing transitions and building sequence…';
    try {
      const payload=await api('/api/set-plan?id='+encodeURIComponent(id)+'&length='+encodeURIComponent($('setlist-length').value));
      const rows=asArray(payload.tracks).map(t=>toId(t.id)).filter(id=>track(id));
      if(!rows.length)throw Error('No available source tracks for this set');
      setlist=rows;setlistTransitions=asArray(payload.transitions);
      $('setlist-status').textContent=rows.length+' suggested tracks · '+(payload.stopped_reason?'Stopped: '+text(payload.stopped_reason):'Ready to edit');
    }catch(e){$('setlist-status').textContent='Set generation failed: '+e.message;notify('Set generation failed: '+e.message,true);}
    finally{setlistBusy=false;renderSetlist();}
  }
  async function appendSetlist() {
    if(!model.hubAvailable||!setlist.length)return;
    $('setlist-queue').disabled=true;
    let added=0;
    for(const id of setlist) {
      try {await post('/api/music-hub/action',{action:'queue.add',trackId:id});added++;}
      catch(e){notify('Queue stopped after '+added+' tracks: '+e.message,true);break;}
    }
    await refreshHub(true);renderSetlist();
    if(added)notify('Added '+added+' tracks to Next up');
  }
  function renderSavedSets() {
    const items=model.hub.setlists||[];
    $('saved-set-count').textContent=items.length+' saved';
    $('saved-set-list').innerHTML=items.length?items.map(p=>'<div class="saved-set-item"><button data-open-set="'+escapeHtml(p.id)+'"><strong>'+escapeHtml(p.name)+'</strong><small>'+p.trackIds.length+' tracks</small></button><button class="saved-delete" data-delete-set="'+escapeHtml(p.id)+'" title="Delete saved set" aria-label="Delete '+escapeHtml(p.name)+'">×</button></div>').join(''):'<span>No saved sets yet. Save a sequence to access it here.</span>';
  }
  async function saveSetlist(name) {
    if(!model.hubAvailable||!setlist.length)return;
    const trimmed=name.trim().slice(0,100);if(!trimmed)return notify('Enter a set name.',true);
    $('setlist-save').disabled=true;
    try {
      const action=savedSetlistId?'setlist.replace':'setlist.create';
      const payload=savedSetlistId?{action,setlistId:savedSetlistId,trackIds:setlist}:{action,name:trimmed,trackIds:setlist};
      const result=await post('/api/music-hub/action',payload);
      if(!savedSetlistId) {
        const candidate=asArray(result.setlists).find(p=>p.name===trimmed&&p.trackIds?.join('|')===setlist.join('|'));
        savedSetlistId=candidate?.id||null;
      }
      await refreshHub(true);
      if(!savedSetlistId) savedSetlistId=model.hub.setlists.find(p=>p.name===trimmed&&p.trackIds.join('|')===setlist.join('|'))?.id||null;
      $('setlist-status').textContent='Saved “'+trimmed+'” · '+setlist.length+' tracks';
      notify('Saved set list “'+trimmed+'”');
    }catch(e){notify('Could not save set: '+e.message,true);}
    finally{renderSetlist();}
  }
  function exportSetlist() {
    if(!savedSetlistId)return;
    const link=document.createElement('a');link.href='/api/music-hub/export?setlistId='+encodeURIComponent(savedSetlistId);
    link.download='';document.body.append(link);link.click();link.remove();
    notify('XML download requested for manual Rekordbox XML Bridge import.');
  }
  function togglePerformance(visible) {
    $('performance-panel').hidden=!visible;
    $('performance-toggle').setAttribute('aria-expanded',String(visible));
    $('performance-toggle').classList.toggle('active',visible);
    if(visible)refreshDecks();
  }
  function selectFooterTrack(id,{fast=false}={}) {
    const t=track(id);if(!t)return;
    model.selected=toId(id);model.currentDetail=t;
    // Do not call HTMLAudioElement.load() on every hardware browse tick when
    // the footer player is empty: that unnecessarily resets the decoder.
    const currentFooterTrack=player().getAttribute('data-track');
    if(currentFooterTrack&&currentFooterTrack!==t.id)stopPreview();
    if(!verifiedDeckSlots[1]&&!stagedDeckIds[1]){
      stagedDeckIds[1]=t.id;persistStagedDecks();deckSlot(1,null,false);updateDeckRelationship();
    }
    updateSelectedPlayer();updateDeckPreviewButtons();
    if(fast){
      // A native MIDI turn may issue dozens of messages each second. Repaint
      // only the two selected visible rows rather than re-running 12k-track
      // filtering/sorting, waveform queries and transition calculations.
      document.querySelectorAll('#virtual-items .track-row.selected').forEach(row=>row.classList.remove('selected'));
      for(const row of document.querySelectorAll('#virtual-items .track-row[data-id]')){
        if(row.dataset.id===model.selected)row.classList.add('selected');
      }
      clearTimeout(browseHeavyTimer);
      browseHeavyTimer=setTimeout(()=>{
        if(model.selected!==toId(id))return;
        if(!$('detail-drawer')?.hidden)loadCandidates(t.id);
        updateHarmonicRail();
        window.MusicHubStudio?.onSelectionChange();
      },240);
    }else{
      clearTimeout(browseHeavyTimer);
      renderResults();loadCandidates(t.id);updateHarmonicRail();window.MusicHubStudio?.onSelectionChange();
    }
  }
  function updateSelectedPlayer() {
    const t=track(model.selected);
    $('selected-art').innerHTML=t?art(t):'♫';
    $('selected-title').textContent=t?text(t.title||'Untitled'):'Select a track';
    $('selected-artist').textContent=t?text(t.artist||'Unknown artist')+' · '+bpm(t)+' BPM · '+(key(t)||'Key unknown'):'Your Rekordbox music library';
    for(const id of ['selected-favorite','selected-queue','selected-playlist','selected-inspect','selected-deck','selected-lyrics','preview-toggle']){const button=$(id);if(button)button.disabled=!t;}
    $('selected-favorite').textContent=t&&model.hub.favorites.includes(t.id)?'♥':'♡';
    $('preview-previous').disabled=!t||!model.hub.queue.length;
    $('preview-next').disabled=!t||!model.hub.queue.length;
  }
  function stopPreview() {
    const a=player();stopLocalWaveAnimation(true);a.pause();a.removeAttribute('src');a.removeAttribute('data-track');a.load();
    $('preview-status').textContent='No audio playing';$('preview-toggle').textContent='▶';$('preview-seek').value='0';
    $('preview-current').textContent='0:00';$('preview-duration').textContent='0:00';$('preview-seek').disabled=true;
    updateDeckPreviewButtons();
  }
  async function togglePreview() {
    const t=track(model.selected);if(!t)return;
    const a=player();
    if(a.getAttribute('data-track')===t.id&&!a.paused){a.pause();return;}
    if(a.getAttribute('data-track')!==t.id){
      stopPreview();a.src='/api/music-hub/audio?id='+encodeURIComponent(t.id);a.setAttribute('data-track',t.id);
      $('preview-status').textContent='Loading local audio…';
    }
    try{await a.play();}catch{$('preview-status').textContent='Audio preview unavailable';$('preview-toggle').textContent='▶';notify('This track cannot be previewed locally.',true);}
  }
  function jumpPreview(delta) {
    const queue=model.hub.queue;if(!queue.length)return;
    const i=queue.indexOf(model.selected),next=i<0?(delta<0?queue.length-1:0):(i+delta+queue.length)%queue.length;
    selectFooterTrack(queue[next]);togglePreview();
  }
  function applyTheme(choice,persist=true,rerenderSettings=true) {
    theme=['dark','light','glass-dark','glass-light'].includes(choice)?choice:'dark';document.documentElement.dataset.theme=theme;
    if(persist)try{localStorage.setItem('music-hub-theme-v2',theme);}catch{}
    if(rerenderSettings&&model.view==='settings')renderGallery();
  }
  const health = {mode:'duplicates',offset:0,limit:35,groups:[],totalGroups:0,summary:null,selected:null,quality:new Map(),request:0,loaded:false};
  let healthSearchTimer;
  function healthNum(n){return Number(n||0).toLocaleString();}
  function renderHealthStats(){
    const s=health.summary||{};
    const labels=[
      ['TRACKS IN LIBRARY',s.tracksScanned],
      ['POSSIBLE DUPLICATE GROUPS',s.duplicateCandidateGroups],
      ['TRACKS TO REVIEW',s.tracksInCandidateGroups],
      ['ALTERNATE VERSION FAMILIES',s.versionFamilies]
    ];
    $('health-stats').innerHTML=labels.map(([label,value])=>'<div class="health-stat"><small>'+escapeHtml(label)+'</small><strong>'+healthNum(value)+'</strong></div>').join('');
  }
  async function loadHealth(){
    const ticket=++health.request;
    const mode=health.mode==='formats'?'duplicates':health.mode;
    const params=new URLSearchParams({mode,search:$('health-search').value.trim().slice(0,120),offset:String(health.offset),limit:String(health.limit)});
    $('health-results-count').textContent='Analyzing Rekordbox collection…';
    $('health-groups').innerHTML='<div class="health-empty">Reviewing track names and version tags…</div>';
    try {
      const data=await api('/api/music-hub/library-health?'+params.toString());
      if(ticket!==health.request)return;
      health.summary=data.summary;health.groups=asArray(data.groups);health.totalGroups=Number(data.totalGroups)||0;health.loaded=true;
      if(!health.groups.some(g=>g.id===health.selected))health.selected=health.groups[0]?.id||null;
      renderHealth();
    }catch(error){
      if(ticket!==health.request)return;
      health.loaded=false;
      $('health-groups').innerHTML='<div class="health-empty"><strong>Library health unavailable</strong><p>'+escapeHtml(error.message)+'</p><p>Refresh Music Hub after the updated local server is running.</p></div>';
      $('health-results-count').textContent='Could not load results';
      $('health-detail').innerHTML='<p class="health-empty">No health data available.</p>';
    }
  }
  function renderHealth(){
    if(!health.loaded)return;
    const current=health.mode;
    document.querySelectorAll('[data-health-mode]').forEach(b=>{
      const active=b.dataset.healthMode===current;
      b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));
    });
    $('health-search').disabled=current==='formats';
    $('health-search').placeholder=current==='versions'?'Filter mix or remix titles…':'Find a title or artist…';
    renderHealthStats();
    if(current==='formats'){
      const formats=Object.entries(health.summary.formats||{});
      $('health-results-count').textContent='File formats referenced in Rekordbox';
      $('health-page-label').textContent=healthNum(health.summary.tracksScanned)+' tracks';
      $('health-groups').innerHTML=formats.length?formats.map(([name,count])=>{
        const pct=health.summary.tracksScanned?Math.round(count/health.summary.tracksScanned*100):0;
        return '<div class="health-format-item"><div><strong>'+escapeHtml(name)+'</strong><span>'+healthNum(count)+' tracks</span></div><div class="health-format-bar"><span style="width:'+pct+'%"></span></div><small>'+pct+'%</small></div>';
      }).join(''):'<p class="health-empty">No file-format information in your library.</p>';
      $('health-detail').innerHTML='<div class="health-detail-placeholder"><span>◉</span><h2>Format inventory</h2><p>Formats are inferred from Rekordbox file extensions. MP3, M4A, WAV and other extensions are counted. File encoding and bitrate need a separate check.</p><p>Open Potential duplicates and choose a group to compare accessible files and estimated average bitrate.</p></div>';
      $('health-prev').disabled=true;$('health-next').disabled=true;return;
    }
    const first=health.totalGroups?health.offset+1:0;
    const last=Math.min(health.totalGroups,health.offset+health.limit);
    $('health-results-count').textContent=healthNum(health.totalGroups)+(current==='versions'?' alternate-version families':' candidate groups');
    $('health-page-label').textContent=healthNum(first)+'–'+healthNum(last)+' shown';
    $('health-prev').disabled=health.offset===0;
    $('health-next').disabled=health.offset+health.limit>=health.totalGroups;
    $('health-groups').innerHTML=health.groups.length?health.groups.map((group)=>{
      const active=group.id===health.selected;
      const detail=current==='versions'?healthNum(group.versionCount)+' different versions':healthNum(group.count)+' Rekordbox entries';
      const context=group.note||'Metadata comparison';
      return '<button class="health-group'+(active?' active':'')+'" data-health-group="'+escapeHtml(group.id)+'" aria-pressed="'+String(active)+'"><span class="health-group-icon">'+(current==='versions'?'♫':'≋')+'</span><span class="health-group-main"><strong>'+escapeHtml(group.title||'Untitled')+'</strong><small>'+escapeHtml(group.artist||'Unknown artist')+'</small><span>'+escapeHtml(context)+'</span></span><span class="health-group-count">'+escapeHtml(detail)+'</span></button>';
    }).join(''):'<div class="health-empty">No matching candidate groups. Try a different search.</div>';
    renderHealthDetail();
  }
  function renderHealthDetail(){
    const g=health.groups.find(item=>item.id===health.selected);
    if(!g){
      $('health-detail').innerHTML='<div class="health-detail-placeholder"><span>◎</span><h2>Select a group</h2><p>Track metadata comparisons appear here.</p></div>';
      return;
    }
    const ids=asArray(g.trackIds);
    const rows=ids.slice(0,24).map(id=>{
      const t=track(id);
      if(!t)return '';
      const q=health.quality.get(id);
      const ext=(text(t.path).split('/').at(-1)||'').split('.').at(-1);
      const info=q?(q.available?escapeHtml(q.format)+' · '+(q.estimatedKbps!=null?healthNum(q.estimatedKbps)+' estimated kbps':'Duration unknown')+' · '+(q.sizeBytes/1048576).toFixed(1)+' MB':'File unavailable'):escapeHtml(ext.toUpperCase()||'Unknown format');
      return '<div class="health-track" data-health-track="'+escapeHtml(id)+'">'+art(t)+'<div class="health-track-name"><strong>'+escapeHtml(t.title||'Untitled')+'</strong><small>'+escapeHtml(t.artist||'Unknown artist')+' · '+duration(t.length)+'</small><small class="'+(q?.available?'quality-available':'')+'">'+info+'</small></div><button type="button" data-health-inspect="'+escapeHtml(id)+'" class="health-track-action">Inspect</button></div>';
    }).join('');
    const qualityAvailable=ids.some(id=>health.quality.has(id));
    const versions=asArray(g.versions);
    $('health-detail').innerHTML=
      '<span class="eyebrow">'+(health.mode==='versions'?'ALTERNATE VERSIONS':'POTENTIAL DUPLICATE GROUP')+'</span>'+
      '<h2>'+escapeHtml(g.title||'Untitled')+'</h2><p class="health-detail-artist">'+escapeHtml(g.artist||'Unknown artist')+'</p>'+
      '<div class="health-detail-facts"><span>'+healthNum(g.count)+' entries</span>'+(g.durationSpreadSeconds!=null?'<span>Duration spread '+g.durationSpreadSeconds+' sec</span>':'')+'</div>'+
      '<p class="health-detail-note">'+escapeHtml(g.note||'Review each file')+'</p>'+
      (versions.length?'<div class="health-version-tags">'+versions.map(v=>'<span>'+escapeHtml(v.name)+' ('+healthNum(v.count)+')</span>').join('')+'</div>':'')+
      '<div class="health-detail-tools"><button id="health-quality" class="primary-button" data-health-quality>◎ '+(qualityAvailable?'Refresh file comparison':'Compare file quality')+'</button></div>'+
      '<p class="health-quality-note">Quality estimates come from actual file size divided by Rekordbox duration. They are not codec measurements, and a higher value does not guarantee a better master.</p>'+
      '<div class="health-track-list">'+rows+'</div>'+
      (ids.length>24?'<p class="health-quality-note">Showing the first 24 entries. '+(ids.length-24)+' more are included in this metadata group.</p>':'');
  }
  async function inspectHealthQuality(){
    const g=health.groups.find(item=>item.id===health.selected);
    if(!g)return;
    const ids=asArray(g.trackIds).slice(0,24);
    const button=$('health-quality');if(button){button.disabled=true;button.textContent='Checking accessible files…';}
    const existingId=g.id;
    try {
      const result=await api('/api/music-hub/library-health/quality?ids='+encodeURIComponent(ids.join(',')));
      for(const row of asArray(result.results))health.quality.set(toId(row.id),row);
      if(health.selected===existingId)renderHealthDetail();
      notify('Checked '+ids.length+' local file references. No files changed.');
    }catch(e){notify('Quality check unavailable: '+e.message,true);renderHealthDetail();}
  }
  function exportHealthCsv(){
    if(!health.loaded)return;
    let records;
    if(health.mode==='formats'){
      records=[['Format','Tracks'],...Object.entries(health.summary.formats||{})];
    }else{
      records=[['Artist','Title','Version','Count','Track IDs','Note']];
      for(const g of health.groups)records.push([g.artist,g.title,g.version||asArray(g.versions).map(v=>v.name).join(' / '),g.count,asArray(g.trackIds).join(' | '),g.note]);
    }
    const csv=records.map(row=>row.map(v=>'"'+text(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='music-hub-'+health.mode+'-visible.csv';document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),3000);
    notify('Exported '+(records.length-1)+' visible rows as CSV.');
  }
  function bind() {
    $('health-refresh').addEventListener('click',()=>loadHealth());
    $('health-search').addEventListener('input',()=>{
      clearTimeout(healthSearchTimer);
      healthSearchTimer=setTimeout(()=>{health.offset=0;health.selected=null;loadHealth();},220);
    });
    document.querySelector('.health-tabs').addEventListener('click',event=>{
      const button=event.target.closest('[data-health-mode]');
      if(!button)return;
      health.mode=button.dataset.healthMode;health.offset=0;health.selected=null;
      if(health.mode==='formats'&&health.loaded)renderHealth();
      else loadHealth();
    });
    $('health-groups').addEventListener('click',event=>{
      const button=event.target.closest('[data-health-group]');
      if(!button)return;
      health.selected=button.dataset.healthGroup;renderHealth();
    });
    $('health-detail').addEventListener('click',event=>{
      if(event.target.closest('[data-health-quality]'))return void inspectHealthQuality();
      const inspect=event.target.closest('[data-health-inspect]');
      if(inspect)openTrack(inspect.dataset.healthInspect);
    });
    $('health-prev').addEventListener('click',()=>{
      if(health.offset===0)return;health.offset=Math.max(0,health.offset-health.limit);health.selected=null;loadHealth();
    });
    $('health-next').addEventListener('click',()=>{
      if(health.offset+health.limit>=health.totalGroups)return;
      health.offset+=health.limit;health.selected=null;loadHealth();
    });
    $('health-export').addEventListener('click',exportHealthCsv);
    try{theme=localStorage.getItem('music-hub-theme-v2')||'dark';displayMode=localStorage.getItem('music-hub-display-v2')||'list';if(!['list','compact','micro','gallery','square'].includes(displayMode))displayMode='list';model.grid=['gallery','square'].includes(displayMode);collectionMode=localStorage.getItem('music-hub-collection-view')||'gallery';if(!['gallery','tiles','rows','compact','table'].includes(collectionMode))collectionMode='gallery';expandedGroups=JSON.parse(localStorage.getItem('music-hub-expanded-folders')||'{}');const priorDecks=JSON.parse(localStorage.getItem('music-hub-staged-previews')||'{}');for(const n of [1,2])if(/^\d{1,20}$/.test(toId(priorDecks[n])))stagedDeckIds[n]=toId(priorDecks[n]);const savedBlur=localStorage.getItem('music-hub-glass-blur');glassStrength=savedBlur===null?24:Math.max(0,Math.min(40,Number(savedBlur)||0));accentChoice=localStorage.getItem('music-hub-accent')||'default';}catch{}
    applyTheme(theme,false);
    applyAppearance();
    // Deck header belongs to the window, above both the lower sidebar and song browser.
    const shell=document.querySelector('.shell'),performance=$('performance-panel');
    shell.insertBefore(performance,shell.firstElementChild);
    shell.insertBefore($('harmonic-rail'),performance.nextSibling);
    performance.hidden=false;
    let rememberedRailCollapse = false;
    try { rememberedRailCollapse = localStorage.getItem('music-hub-up-next-collapsed-v1') === 'true'; } catch {}
    setHarmonicRailCollapsed(rememberedRailCollapse, false);
    $('harmonic-rail-toggle').addEventListener('click', () => setHarmonicRailCollapsed(!railCollapsed));
    window.MusicHubTopDecks?.init();
    performance.querySelectorAll('.deck').forEach((deck,i)=>{
      const n=i+1;deck.dataset.deck=String(n);deck.setAttribute('aria-label','Drop track on Deck '+(n===1?'A':'B')+' to stage a preview');deck.querySelector('.deck-number').textContent=n===1?'DECK A':'DECK B';
      const actions=document.createElement('div');actions.className='deck-actions';actions.innerHTML='<span class="deck-drop-label">DROP OR STAGE A TRACK</span><div class="deck-control-group"><button type="button" id="deck-preview-'+n+'" class="deck-preview-button" title="Play/pause this local file in Music Hub; Rekordbox transport is separate" aria-label="Play local preview on Deck '+(n===1?'A':'B')+'" disabled>▶ Preview</button><button type="button" id="deck-load-'+n+'" class="deck-load-button" hidden disabled>Load to Rekordbox</button></div>';deck.append(actions);
      actions.querySelector('#deck-load-'+n).addEventListener('click',()=>loadDeck(n,stagedDeckIds[n]));
      actions.querySelector('#deck-preview-'+n).addEventListener('click',()=>toggleDeckPreview(n));
      deck.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('text/plain'))deck.classList.add('deck-drag-over');});
      deck.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('text/plain')){e.preventDefault();e.dataTransfer.dropEffect='copy';deck.classList.add('deck-drag-over');}});
      deck.addEventListener('dragleave',e=>{if(!deck.contains(e.relatedTarget))deck.classList.remove('deck-drag-over');});
      deck.addEventListener('drop',e=>{e.preventDefault();deck.classList.remove('deck-drag-over');const id=toId(e.dataTransfer.getData('application/x-music-hub-track')||e.dataTransfer.getData('text/plain'));if(track(id))stageDeck(n,id);else notify('Track could not be found in the loaded collection.',true);});
    });
    window.MusicHubPerformanceChrome?.init();
    const expand=document.createElement('button');expand.type='button';expand.className='deck-expand';expand.textContent='EXPAND DECKS';expand.setAttribute('aria-expanded','false');performance.querySelector('.performance-top').append(expand);
    const scrollHint=document.createElement('small');scrollHint.className='performance-scroll-hint';scrollHint.textContent='SCROLL ↓ FOR JOGS + HOT CUES';performance.querySelector('.performance-top').insertBefore(scrollHint,expand);
    expand.addEventListener('click',()=>{deckExpanded=!deckExpanded;performance.classList.toggle('expanded',deckExpanded);expand.textContent=deckExpanded?'COMPACT DECKS':'EXPAND DECKS';expand.setAttribute('aria-expanded',String(deckExpanded));expand.title=deckExpanded?'Collapse detailed FX and deck previews to restore library space':'Show detailed FX, dual decks, hot cues and mixer previews';});
    const groupHeader=document.createElement('div');groupHeader.className='section-head sidebar-list-head';groupHeader.innerHTML='<span>GENRES / VIBES</span>';const groupNav=document.createElement('nav');groupNav.id='genre-vibe-groups';groupNav.className='sidebar-playlists';$('local-playlists').before(groupHeader,groupNav);$('library-nav').querySelector('[data-view="playlists"]').insertAdjacentHTML('afterend','<button class="nav-item" data-view="genres"><span class="nav-glyph">♬</span>Genres / Vibes</button>');
    // A single collapsible library tree keeps local playlists, Rekordbox folders,
    // and custom genre/vibe subgroups together, with independent nested arrows.
    const myHeading=$('create-playlist').closest('.section-head');
    const rekordboxHeading=$('native-playlists').previousElementSibling;
    const collections=document.createElement('section');collections.id='sidebar-collections';collections.className='sidebar-collections';
    const treeHeading=document.createElement('div');treeHeading.className='section-head sidebar-list-head collection-tree-title';treeHeading.innerHTML='<span>PLAYLIST COLLECTIONS</span>';treeHeading.append($('create-playlist'));collections.append(treeHeading);
    const groupsContainer=document.createElement('div');groupsContainer.className='collection-tree-groups';collections.append(groupsContainer);
    for(const [label,key,nav] of [['My playlists','local',$('local-playlists')],['Rekordbox playlists','native',$('native-playlists')],['Genres & vibes','groups',groupNav]]){
      const folder=document.createElement('details');folder.className='collection-tree-root';folder.dataset.treeRoot=key;
      folder.open=expandedGroups['tree:'+key]!==false;
      const summary=document.createElement('summary');summary.innerHTML='<span class="folder-chevron" aria-hidden="true">▸</span> '+label;
      folder.append(summary,nav);groupsContainer.append(folder);
      folder.addEventListener('toggle',()=>{expandedGroups['tree:'+key]=folder.open;try{localStorage.setItem('music-hub-expanded-folders',JSON.stringify(expandedGroups));}catch{}});
    }
    myHeading.remove();rekordboxHeading.remove();groupHeader.remove();
    const studioLauncher=document.querySelector('.studio-launcher');
    studioLauncher.classList.add('sidebar-studio');$('library-nav').after(studioLauncher);
    const historyNavigation=document.querySelector('.navigation-arrows');
    historyNavigation.classList.add('sidebar-history');$('library-nav').before(historyNavigation);
    const studioControls=document.createElement('nav');studioControls.className='sidebar-tools';studioControls.setAttribute('aria-label','Workspace tools');studioLauncher.after(studioControls);
    for(const [id,label] of [['performance-toggle','◈ Deck monitor'],['queue-toggle','☷ Next up panel'],['refresh','↻ Refresh library']]){
      const control=$(id);control.className='nav-item sidebar-tool';control.textContent=label;studioControls.append(control);
    }
    const secondaryNav=document.createElement('nav');secondaryNav.className='sidebar-secondary';secondaryNav.id='sidebar-secondary';secondaryNav.setAttribute('aria-label','Local music and settings');
    const localMusicHeading=[...$('library-nav').querySelectorAll('.nav-group-title')].find(node=>node.textContent.trim()==='LOCAL MUSIC');
    if(localMusicHeading){for(let node=localMusicHeading;node;){const next=node.nextElementSibling;secondaryNav.append(node);node=next;}}
    studioControls.after(secondaryNav);
    $('library-nav').after(collections);
    const iconRail=document.createElement('nav');iconRail.className='sidebar-icon-rail';iconRail.id='sidebar-icon-rail';iconRail.setAttribute('aria-label','Collapsed music navigation');
    const primaryRail=[['home','⌂','Home'],['search','⌕','Search'],['all','▤','All music'],['favorites','♡','Favorites'],['albums','▧','Albums'],['artists','♬','Artists'],['playlists','☷','Playlists'],['genres','♢','Genres & vibes']];
    const secondaryRail=[['queue','☰','Next up'],['sets','♧','Set List Creator'],['health','◇','Library Health'],['settings','⚙','Settings']];
    const railItem=([view,glyph,label])=>'<button type="button" class="sidebar-rail-icon" data-view="'+view+'" title="'+label+'" aria-label="'+label+'"><span aria-hidden="true">'+glyph+'</span></button>';
    iconRail.innerHTML=primaryRail.map(railItem).join('')+'<div class="sidebar-rail-divider" aria-hidden="true"></div>'+
      '<button type="button" class="sidebar-rail-icon" data-rail-provider="links" aria-label="Connected Music" title="Connected Music / sign in"><span aria-hidden="true">◉</span></button>'+
      '<button type="button" class="sidebar-rail-icon" data-rail-studio="lyrics" aria-label="Lyrics and Karaoke" title="Lyrics and Karaoke"><span aria-hidden="true">♫</span></button>'+
      '<button type="button" class="sidebar-rail-icon" data-rail-studio="harmonic" aria-label="Camelot harmonic wheel" title="Harmonic wheel"><span aria-hidden="true">◎</span></button>'+
      '<div class="sidebar-rail-divider" aria-hidden="true"></div>'+secondaryRail.map(railItem).join('');
    $('sidebar').querySelector('.brand').after(iconRail);
    document.body.append($('mobile-menu'));
    const modeToggle=document.querySelector('.layout-toggle');
    // Column order is shared by the header and track rows, like Rekordbox's browser.
    $('table-head').innerHTML='<span>#</span><span>TITLE</span><span>ARTIST</span><span>ALBUM</span><span>GENRE</span><span>BPM</span><span>KEY</span><span>TIME</span><span>PREVIEW</span><span>RATING</span><span></span>';
    $('list-mode').textContent='Rows';$('grid-mode').textContent='Cards';
    modeToggle.insertAdjacentHTML('beforeend','<button id="compact-mode" type="button" title="Compact rows" aria-label="Compact row view">Dense</button><button id="micro-mode" type="button" title="Extra dense rows" aria-label="Mini row view">Mini</button><button id="square-mode" type="button" title="Dense artwork grid" aria-label="Dense artwork grid">Covers</button>');
    const collectionToggle=document.createElement('div');collectionToggle.className='collection-view-modes';collectionToggle.setAttribute('role','group');collectionToggle.setAttribute('aria-label','Collection layout');
    collectionToggle.innerHTML=[['gallery','Covers'],['tiles','Tiles'],['rows','Rows'],['compact','Compact'],['table','Details']].map(([mode,label])=>'<button type="button" data-collection-mode="'+mode+'" aria-pressed="false">'+label+'</button>').join('');
    $('browse-gallery').querySelector('.browse-heading').append(collectionToggle);
    collectionToggle.addEventListener('click',event=>{const button=event.target.closest('[data-collection-mode]');if(!button)return;collectionMode=button.dataset.collectionMode;try{localStorage.setItem('music-hub-collection-view',collectionMode);}catch{}renderGallery();});
    let libraryDrag=null;
    const draggedId=e=>{const value=toId(e.dataTransfer?.getData('application/x-music-hub-track')||e.dataTransfer?.getData('text/plain'));return /^\d+$/.test(value)&&track(value)?value:null;};
    const hasDraggedTrack=e=>e.dataTransfer&&[...e.dataTransfer.types].some(t=>t==='application/x-music-hub-track'||t==='text/plain');
    document.addEventListener('dragstart',e=>{const item=e.target.closest('.track-row[data-id],.queue-item[data-id],.browse-card[data-id]');if(!item||!track(item.dataset.id))return;e.dataTransfer.setData('application/x-music-hub-track',item.dataset.id);e.dataTransfer.setData('text/plain',item.dataset.id);e.dataTransfer.effectAllowed='copyMove';libraryDrag=model.view==='local'&&item.matches('.track-row')&&!harmonicOrders.has(playlistScope())?{trackId:item.dataset.id,playlistId:model.playlistId}:null;});
    // A native Rekordbox track can be dropped into either staged deck. Track
    // moves inside a *Music Hub* playlist use a separate, atomic Hub action;
    // the native Rekordbox playlist structure is never modified.
    $('scroller').addEventListener('dragover',e=>{const row=e.target.closest('.track-row[data-id]');if(!row||model.view!=='local'||!libraryDrag||libraryDrag.playlistId!==model.playlistId||!model.hubAvailable)return;e.preventDefault();e.dataTransfer.dropEffect='move';document.querySelectorAll('#virtual-items .track-drop-target').forEach(el=>el.classList.remove('track-drop-target'));row.classList.add('track-drop-target');const bounds=$('scroller').getBoundingClientRect();if(e.clientY>bounds.bottom-35)$('scroller').scrollTop+=16;else if(e.clientY<bounds.top+35)$('scroller').scrollTop-=16;});
    $('scroller').addEventListener('drop',async e=>{const row=e.target.closest('.track-row[data-id]');if(!row||model.view!=='local'||!libraryDrag||libraryDrag.playlistId!==model.playlistId)return;const source=libraryDrag;const playlist=model.hub.playlists.find(p=>p.id===source.playlistId);if(!playlist)return;const from=playlist.trackIds.indexOf(source.trackId),to=playlist.trackIds.indexOf(row.dataset.id);if(from<0||to<0)return;e.preventDefault();libraryDrag=null;document.querySelectorAll('#virtual-items .track-drop-target').forEach(el=>el.classList.remove('track-drop-target'));if(from!==to&&await hubAction('playlist.reorder',{playlistId:playlist.id,from,to}))notify('Reordered Music Hub playlist · original Rekordbox music unchanged');});
    $('sidebar').addEventListener('dragover',e=>{const target=e.target.closest('.nav-item[data-view="local"][data-id],.nav-item[data-view="native"][data-id]');if(!target||!hasDraggedTrack(e)||!model.hubAvailable)return;e.preventDefault();e.dataTransfer.dropEffect=target.dataset.view==='local'?'copy':'none';$('sidebar').querySelectorAll('.playlist-drop-target').forEach(el=>el.classList.remove('playlist-drop-target'));target.classList.add('playlist-drop-target');});
    $('sidebar').addEventListener('drop',async e=>{const target=e.target.closest('.nav-item[data-view="local"][data-id],.nav-item[data-view="native"][data-id]');if(!target)return;const id=draggedId(e);$('sidebar').querySelectorAll('.playlist-drop-target').forEach(el=>el.classList.remove('playlist-drop-target'));if(!id)return;e.preventDefault();if(target.dataset.view==='native'){notify('Rekordbox playlists are read-only here. Drop into My playlists to save a Music Hub copy.',true);return;}const playlist=model.hub.playlists.find(p=>p.id===target.dataset.id);if(!playlist)return;if(playlist.trackIds.includes(id)){notify('This track is already in that Music Hub playlist.');return;}if(await hubAction('playlist.add',{playlistId:playlist.id,trackId:id}))notify('Added track to “'+playlist.name+'”');});
    $('harmonic-rail-scroll').addEventListener('click',e=>{const queue=e.target.closest('[data-rail-queue]');if(queue)return void hubAction('queue.add',{trackId:queue.dataset.railQueue});const stage=e.target.closest('[data-rail-stage]');if(stage)return void stageDeck(verifiedDeckSlots[2]?1:2,stage.dataset.railStage);const pick=e.target.closest('[data-id]');if(pick)stageDeck(verifiedDeckSlots[2]?1:2,pick.dataset.id);});
    $('harmonic-rail-scroll').addEventListener('dragstart',e=>{const pick=e.target.closest('[data-id]');if(!pick||!track(pick.dataset.id))return;e.dataTransfer.setData('application/x-music-hub-track',pick.dataset.id);e.dataTransfer.setData('text/plain',pick.dataset.id);e.dataTransfer.effectAllowed='copy';});
    document.addEventListener('dragend',()=>{libraryDrag=null;performance.querySelectorAll('.deck').forEach(d=>d.classList.remove('deck-drag-over'));document.querySelectorAll('.track-drop-target,.playlist-drop-target').forEach(d=>d.classList.remove('track-drop-target','playlist-drop-target'));});
    $('sidebar').addEventListener('toggle',e=>{const folder=e.target.closest?.('[data-folder-key]');if(folder){expandedGroups[folder.dataset.folderKey]=folder.open;try{localStorage.setItem('music-hub-expanded-folders',JSON.stringify(expandedGroups));}catch{}}},true);
    const updateDeckHeight=()=>shell.style.setProperty('--deck-header-height',Math.ceil(performance.getBoundingClientRect().height+$('harmonic-rail').getBoundingClientRect().height)+'px');
    updateDeckHeight();
    if(typeof ResizeObserver!=='undefined'){
      const deckResizeObserver=new ResizeObserver(updateDeckHeight);
      deckResizeObserver.observe(performance);
      deckResizeObserver.observe($('harmonic-rail'));
    } else window.addEventListener('resize',updateDeckHeight);
    $('performance-toggle').setAttribute('aria-expanded','true');
    $('performance-toggle').classList.add('active');
    const filters=document.querySelector('.filters');
    const genreWrapper=document.createElement('label');
    genreWrapper.className='select-wrap';
    genreWrapper.innerHTML='<span>Genre</span><select id="genre-filter" aria-label="Filter genre"><option value="all">All genres</option><option value="untagged">Untagged</option></select>';
    filters.insertBefore(genreWrapper,$('compatible-filter').closest('label'));
    const ratingWrapper=document.createElement('label');
    ratingWrapper.className='select-wrap';
    ratingWrapper.innerHTML='<span>Rating</span><select id="rating-filter" aria-label="Minimum personal rating"><option value="all">Any rating</option><option value="1">1+ stars</option><option value="2">2+ stars</option><option value="3">3+ stars</option><option value="4">4+ stars</option><option value="5">5 stars</option></select>';
    filters.insertBefore(ratingWrapper,$('compatible-filter').closest('label'));
    $('sort').insertAdjacentHTML('beforeend','<option value="album">Album A–Z</option><option value="genre">Genre A–Z</option><option value="key">Key A–Z</option><option value="length">Duration shortest</option><option value="rating">My rating highest</option>');
    $('table-head').innerHTML='<span aria-label="Track number">#</span><span>TRACK</span><span class="col-artist">ARTIST</span><span class="col-album">ALBUM</span><span class="col-genre">GENRE</span><span>BPM</span><span>KEY</span><span>TIME</span><span>PREVIEW</span><span class="col-rating">RATING</span><span class="col-actions" aria-label="Actions"></span>';
    const advanced=document.createElement('div');advanced.id='advanced-filters';advanced.className='advanced-filters';advanced.hidden=true;
    for(const control of [genreWrapper,ratingWrapper,$('compatible-filter').closest('label'),$('reset-filters')])advanced.append(control);
    const more=document.createElement('button');more.type='button';more.id='more-filters';more.className='more-filters';more.textContent='More filters ▾';more.setAttribute('aria-expanded','false');
    filters.append(more,document.querySelector('.topbar .search'),advanced);
    more.addEventListener('click',()=>{advanced.hidden=!advanced.hidden;more.setAttribute('aria-expanded',String(!advanced.hidden));more.textContent=advanced.hidden?'More filters ▾':'Fewer filters ▴';});
    $('table-head').innerHTML='<span class="col-index">#</span><span class="col-title">TITLE</span><span class="col-artist">ARTIST</span><span class="col-album">ALBUM</span><span class="col-genre">GENRE</span><span class="col-bpm">BPM</span><span class="col-key">KEY</span><span class="col-duration">TIME</span><span class="col-wave">PREVIEW</span><span class="col-rating">RATING</span><span class="col-actions" aria-label="Track actions"></span>';
    setDisplayMode(displayMode);
    $('browse-gallery').addEventListener('click',e=>{
      const category=e.target.closest('[data-genre-group]');if(category)return void selectView('genre-group',category.dataset.genreGroup);
      const genreTracks=e.target.closest('[data-genre-tracks]');if(genreTracks)return void selectView('genre-tracks',genreTracks.dataset.genreTracks);
      const genreButton=e.target.closest('[data-genre]');if(genreButton){$('genre-filter').value=genreButton.dataset.genre==='Untagged'?'untagged':genreButton.dataset.genre;selectView('all');return;}
      const group=e.target.closest('[data-group]');
      if(group)return void selectView(group.dataset.group,group.dataset.groupId);
      const nav=e.target.closest('[data-view]');
      if(nav)return void selectView(nav.dataset.view,nav.dataset.id||null);
      if(e.target.closest('[data-create-playlist]'))return void openPlaylistDialog('create');
      const themeButton=e.target.closest('[data-theme]');
      if(themeButton)return void applyTheme(themeButton.dataset.theme);
      const accent=e.target.closest('[data-accent]');
      if(accent){accentChoice=accent.dataset.accent;try{localStorage.setItem('music-hub-accent',accentChoice);}catch{}applyAppearance();return;}
      if(e.target.closest('#settings-decks'))return void togglePerformance(true);
      const queueButton=e.target.closest('[data-group-queue]');
      if(queueButton){
        const group=albums.find(g=>g.id===queueButton.dataset.groupQueue)||artists.find(g=>g.id===queueButton.dataset.groupQueue);
        if(!group?.tracks.length)return;
        if(group.tracks.length>120)return void notify('Choose individual tracks from this collection to queue.',true);
        (async()=>{let added=0;for(const t of group.tracks){try{await post('/api/music-hub/action',{action:'queue.add',trackId:t.id});added++;}catch{break;}}await refreshHub(true);notify('Added '+added+' tracks to Next Up');})();
      }
    });
    $('browse-gallery').addEventListener('input',e=>{
      if(e.target.id!=='glass-strength')return;
      glassStrength=Number(e.target.value);
      document.documentElement.style.setProperty('--glass-blur',glassStrength+'px');
      $('blur-value').textContent=glassStrength+'px';
      try{localStorage.setItem('music-hub-glass-blur',String(glassStrength));}catch{}
    });
    $('browse-all').addEventListener('click',()=>selectView('all'));
    $('nav-back').addEventListener('click',()=>navigateHistory(-1));
    $('nav-forward').addEventListener('click',()=>navigateHistory(1));
    function updateSidebarCollapse(){
      const compact=shell.classList.contains('sidebar-compact'),button=$('sidebar-collapse');
      button.textContent=compact?'›':'‹';button.title=compact?'Expand library navigation':'Collapse navigation to icons';
      button.setAttribute('aria-label',button.title);
      button.setAttribute('aria-expanded',String(!compact));
      $('sidebar').classList.toggle('compact',compact);
      renderSidebar();
    }
    $('sidebar-collapse').addEventListener('click',()=>{
      if(window.innerWidth<=640){$('sidebar').classList.remove('open');return;}
      const compact=$('sidebar').classList.toggle('compact');
      document.querySelector('.shell').classList.toggle('sidebar-compact',compact);
      updateSidebarCollapse();
      try{localStorage.setItem('music-hub-sidebar-compact',String(compact));}catch{}
      requestAnimationFrame(renderRows);
    });
    const resize=document.createElement('div');resize.id='sidebar-resize';resize.className='sidebar-resize-grip';
    resize.tabIndex=0;resize.setAttribute('role','separator');resize.setAttribute('aria-label','Resize library sidebar');resize.setAttribute('aria-orientation','vertical');resize.setAttribute('aria-valuemin','132');resize.setAttribute('aria-valuemax','260');
    $('sidebar').append(resize);
    const applySidebarWidth=(width,persist=false)=>{
      const next=Math.max(132,Math.min(260,Math.round(Number(width)||155)));
      shell.style.setProperty('--hub-sidebar-width',next+'px');
      resize.setAttribute('aria-valuenow',String(next));
      if(persist)try{localStorage.setItem('music-hub-sidebar-width',String(next));}catch{}
      requestAnimationFrame(renderRows);
    };
    try{applySidebarWidth(localStorage.getItem('music-hub-sidebar-width')||155);}catch{applySidebarWidth(155);}
    resize.addEventListener('pointerdown',event=>{
      if(window.innerWidth<=640||shell.classList.contains('sidebar-compact'))return;
      event.preventDefault();resize.setPointerCapture(event.pointerId);shell.classList.add('sidebar-resizing');
    });
    resize.addEventListener('pointermove',event=>{
      if(!resize.hasPointerCapture(event.pointerId))return;
      applySidebarWidth(event.clientX-shell.getBoundingClientRect().left);
    });
    const finishResize=event=>{
      if(!resize.hasPointerCapture(event.pointerId))return;
      resize.releasePointerCapture(event.pointerId);shell.classList.remove('sidebar-resizing');
      applySidebarWidth(parseInt(resize.getAttribute('aria-valuenow'),10),true);
    };
    resize.addEventListener('pointerup',finishResize);resize.addEventListener('pointercancel',finishResize);
    resize.addEventListener('dblclick',()=>applySidebarWidth(155,true));
    resize.addEventListener('keydown',event=>{
      const delta=event.key==='ArrowRight'?8:event.key==='ArrowLeft'?-8:0;
      if(!delta&&!['Home','End'].includes(event.key))return;
      event.preventDefault();const width=Number(resize.getAttribute('aria-valuenow'));
      applySidebarWidth(event.key==='Home'?132:event.key==='End'?260:width+delta,true);
    });
    try{
      if(localStorage.getItem('music-hub-sidebar-compact')==='true' && window.innerWidth>640){
        $('sidebar').classList.add('compact');shell.classList.add('sidebar-compact');
      }
    }catch{}
    updateSidebarCollapse();
    $('performance-toggle').addEventListener('click',()=>togglePerformance($('performance-panel').hidden));
    $('queue-toggle').addEventListener('click',()=>{
      const panel=document.querySelector('.inspector');panel.classList.toggle('open');
      $('queue-toggle').setAttribute('aria-expanded',String(panel.classList.contains('open')));
    });
    // The selected-track player is intentionally collapsed on every load.
    // Expanding is a deliberate user action, never restored automatically.
    const playerToggle=$('selected-player-toggle');
    function toggleSelectedPlayer(expand){
      $('selected-player').hidden=!expand;
      shell.classList.toggle('player-collapsed',!expand);
      playerToggle.setAttribute('aria-expanded',String(expand));
      playerToggle.textContent=expand?'⌄ Hide player':'⌃ Player';
      playerToggle.setAttribute('aria-label',expand?'Collapse local preview player':'Expand local preview player');
    }
    toggleSelectedPlayer(false);
    playerToggle.addEventListener('click',()=>toggleSelectedPlayer(shell.classList.contains('player-collapsed')));
    $('selected-favorite').addEventListener('click',()=>model.selected&&hubAction('favorite.toggle',{trackId:model.selected}));
    $('selected-queue').addEventListener('click',()=>model.selected&&hubAction('queue.add',{trackId:model.selected}));
    $('selected-playlist').addEventListener('click',()=>model.selected&&choosePlaylist(model.selected));
    $('selected-inspect').addEventListener('click',()=>model.selected&&openTrack(model.selected));
    $('selected-deck').addEventListener('click',()=>{if(model.selected)openTrack(model.selected).then(()=>document.querySelector('.detail-load')?.scrollIntoView({block:'center',behavior:'smooth'}));});
    $('preview-toggle').addEventListener('click',togglePreview);
    $('preview-previous').addEventListener('click',()=>jumpPreview(-1));
    $('preview-next').addEventListener('click',()=>jumpPreview(1));
    $('preview-volume').addEventListener('input',e=>{player().volume=Number(e.target.value);});
    player().volume=.75;
    player().addEventListener('play',()=>{$('preview-toggle').textContent='Ⅱ';$('preview-status').textContent='Playing local preview';updateDeckPreviewButtons();updateHarmonicRail();startLocalWaveAnimation();});
    player().addEventListener('pause',()=>{$('preview-toggle').textContent='▶';if(player().getAttribute('src'))$('preview-status').textContent='Local preview paused';updateDeckPreviewButtons();updateHarmonicRail();stopLocalWaveAnimation();});
    player().addEventListener('ended',()=>{$('preview-toggle').textContent='▶';$('preview-status').textContent='Preview ended';updateDeckPreviewButtons();stopLocalWaveAnimation();});
    player().addEventListener('error',()=>{$('preview-toggle').textContent='▶';$('preview-status').textContent='Audio format unavailable';updateDeckPreviewButtons();stopLocalWaveAnimation();});
    player().addEventListener('loadedmetadata',()=>{$('preview-duration').textContent=duration(player().duration);$('preview-seek').disabled=!Number.isFinite(player().duration);});
    player().addEventListener('timeupdate',()=>{if(Number.isFinite(player().duration)&&player().duration>0){$('preview-current').textContent=duration(player().currentTime);$('preview-seek').value=String(player().currentTime/player().duration*100);syncLocalWaveform();}});
    $('preview-seek').addEventListener('input',e=>{if(Number.isFinite(player().duration)){player().currentTime=Number(e.target.value)/100*player().duration;syncLocalWaveform();}});
    $('mode-library').addEventListener('click',()=>selectView('home'));
    $('mode-setlist').addEventListener('click',()=>selectView('sets'));
    $('refresh-decks').addEventListener('click',refreshDecks);
    $('setlist-find').addEventListener('input',renderSetlistSearch);
    $('setlist-source').addEventListener('change',()=>{$('setlist-find').value=track($('setlist-source').value)?.title||'';});
    $('setlist-search-results').addEventListener('click',e=>{const seed=e.target.closest('[data-seed]');if(!seed)return;$('setlist-source').value=seed.dataset.seed;$('setlist-find').value=track(seed.dataset.seed)?.title||'';renderSetlistSearch();$('setlist-source').value=seed.dataset.seed;});
    $('setlist-build').addEventListener('click',buildSetlist);
    $('setlist-queue').addEventListener('click',async()=>{
      if(savedSetlistId && setlist.join('|')===model.hub.setlists.find(p=>p.id===savedSetlistId)?.trackIds.join('|')) {
        if(await hubAction('setlist.queue',{setlistId:savedSetlistId}))notify('Added saved set to Next up');
      } else await appendSetlist();
    });
    $('setlist-save').addEventListener('click',()=>{
      const existing=model.hub.setlists.find(p=>p.id===savedSetlistId);
      if(existing)return void saveSetlist(existing.name);
      $('setlist-name').value='';
      $('setlist-name-dialog').showModal();$('setlist-name').focus();
    });
    $('setlist-name-form').addEventListener('submit',e=>{if(e.submitter?.value!=='save')return;e.preventDefault();const name=$('setlist-name').value.trim();if(!name)return;$('setlist-name-dialog').close();saveSetlist(name);});
    $('saved-set-list').addEventListener('click',async e=>{
      const del=e.target.closest('[data-delete-set]');if(del) {
        const item=model.hub.setlists.find(p=>p.id===del.dataset.deleteSet);if(!item||!confirm('Delete saved set “'+item.name+'”?'))return;
        if(await hubAction('setlist.delete',{setlistId:item.id})){if(savedSetlistId===item.id){savedSetlistId=null;renderSetlist();}notify('Deleted set list');}return;
      }
      const open=e.target.closest('[data-open-set]');if(!open)return;
      const item=model.hub.setlists.find(p=>p.id===open.dataset.openSet);if(!item)return;
      setlist=item.trackIds.filter(id=>track(id));setlistTransitions=[];savedSetlistId=item.id;
      $('setlist-status').textContent='Editing saved set “'+item.name+'” · changes save with Save set list';
      renderSetlist();
    });
    $('setlist-export').addEventListener('click',exportSetlist);
    $('setlist-rows').addEventListener('click',e=>{const button=e.target.closest('[data-move],[data-drop]'),row=button?.closest('[data-index]');if(!button||!row)return;const i=Number(row.dataset.index);if(button.hasAttribute('data-drop'))setlist.splice(i,1);else{const j=i+Number(button.dataset.move);if(j<0||j>=setlist.length)return;[setlist[i],setlist[j]]=[setlist[j],setlist[i]];}renderSetlist();});
    $('search-input').addEventListener('input',()=>{
      if(['albums','artists','genres','playlists'].includes(model.view)){renderGallery();return;}
      if(['home','history','settings'].includes(model.view)&&$('search-input').value.trim())selectView('all');
      clearTimeout(searchTimer);searchTimer=setTimeout(()=>renderResults(true),120);
    });
    ['sort','bpm-filter','key-filter','genre-filter','rating-filter','compatible-filter'].forEach(id=>$(id).addEventListener('change',()=>renderResults(true)));
    $('reset-filters').addEventListener('click',()=>{$('search-input').value='';$('bpm-filter').value='all';$('key-filter').value='all';$('genre-filter').value='all';$('rating-filter').value='all';$('compatible-filter').checked=false;renderResults(true);});
    $('list-mode').addEventListener('click',()=>setDisplayMode('list'));$('grid-mode').addEventListener('click',()=>setDisplayMode('gallery'));
    $('compact-mode').addEventListener('click',()=>setDisplayMode('compact'));$('micro-mode').addEventListener('click',()=>setDisplayMode('micro'));$('square-mode').addEventListener('click',()=>setDisplayMode('square'));
    let rowFrame=0;
    $('scroller').addEventListener('scroll',()=>{if(rowFrame)return;rowFrame=requestAnimationFrame(()=>{rowFrame=0;renderRows(false);});},{passive:true});
    $('scroller').addEventListener('dblclick',e=>{const row=e.target.closest('[data-id]');if(row)openTrack(row.dataset.id);});
    $('scroller').addEventListener('click',(e)=>{const row=e.target.closest('[data-id]');if(!row)return;const id=row.dataset.id;const star=e.target.closest('[data-rating]');if(star)return void hubAction('rating.set',{trackId:id,rating:Number(star.dataset.rating)});const action=e.target.closest('[data-action]')?.dataset.action;if(action==='queue')return void hubAction('queue.add',{trackId:id});if(action==='favorite')return void hubAction('favorite.toggle',{trackId:id});if(action==='playlist')return void choosePlaylist(id);if(action==='markers')return void openTrack(id);selectFooterTrack(id);});
    $('scroller').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.closest('[data-id]')&&!e.target.closest('button')){if(e.shiftKey)openTrack(e.target.closest('[data-id]').dataset.id);else selectFooterTrack(e.target.closest('[data-id]').dataset.id);}});
    $('sidebar').addEventListener('click',e=>{
      const providerButton=e.target.closest('[data-provider-open]');
      if(providerButton){e.preventDefault();e.stopPropagation();openProviderDialog(providerButton.dataset.providerOpen==='links'?'apple_music':providerButton.dataset.providerOpen);return;}
      const category=e.target.closest('[data-genre-group]');
      if(category){const key=category.dataset.genreGroup;requestAnimationFrame(()=>{expandedGroups['genre:'+key]=category.closest('details')?.open??true;try{localStorage.setItem('music-hub-expanded-folders',JSON.stringify(expandedGroups));}catch{}});selectView('genre-group',key);return;}
      const quickStudio=e.target.closest('[data-rail-studio]');if(quickStudio){window.MusicHubStudio?.open(quickStudio.dataset.railStudio);return;}
      const quickProvider=e.target.closest('[data-rail-provider]');if(quickProvider){openProviderDialog(quickProvider.dataset.railProvider);return;}
      const quickExpand=e.target.closest('[data-rail-expand]');if(quickExpand){$('sidebar-collapse').click();return;}
      const options=e.target.closest('[data-folder-options]');if(options){e.preventDefault();e.stopPropagation();const f=model.hub.folders.find(f=>f.id===options.dataset.folderOptions);if(!f)return;const action=prompt('Manage '+f.name+': enter 1 for New subfolder, 2 for Rename, 3 for Move, 4 for Delete');if(action==='1'){const name=prompt('New subfolder name:');if(name?.trim())hubAction('folder.create',{name:name.trim().slice(0,100),parentId:f.id,kind:f.kind});}else if(action==='2'){const name=prompt('Rename group:',f.name);if(name?.trim())hubAction('folder.rename',{folderId:f.id,name:name.trim().slice(0,100)});}else if(action==='3'){const parents=model.hub.folders.filter(p=>p.id!==f.id);const selected=prompt('Move under folder (0 for top level):\n0. Top level\n'+parents.map((p,i)=>(i+1)+'. '+p.name).join('\n'));const n=Number(selected);if(selected!==null&&Number.isInteger(n)&&n>=0&&n<=parents.length)hubAction('folder.move',{folderId:f.id,parentId:n?parents[n-1].id:null});}else if(action==='4'&&confirm('Delete group '+f.name+'? Playlists stay in Music Hub.'))hubAction('folder.delete',{folderId:f.id});return;}
      const groupButton=e.target.closest('[data-organize]');if(groupButton){e.preventDefault();e.stopPropagation();const id=groupButton.dataset.organize;const folders=asArray(model.hub.folders);if(!folders.length){notify('Create a genre / vibe group first.');return;}const choice=prompt('Assign to a group by number (0 to ungroup):\n0. Ungroup\n'+folders.map((f,i)=>(i+1)+'. '+f.name).join('\n'));if(choice===null)return;const n=Number(choice);if(!Number.isInteger(n)||n<0||n>folders.length){notify('Choose an existing group number.',true);return;}const membership=folders.filter(f=>asArray(f.playlistIds).includes(id));(async()=>{for(const f of membership)await hubAction('folder.unassign',{folderId:f.id,playlistId:id});if(n)await hubAction('folder.assign',{folderId:folders[n-1].id,playlistId:id});})();return;}
      if(e.target.closest('[data-new-group]')){const name=prompt('Name a genre or vibe group (e.g. House / Deep House):');if(name?.trim())hubAction('folder.create',{name:name.trim().slice(0,100),kind:'vibe',parentId:null});return;}
      const group=e.target.closest('[data-group]');if(group)return void selectView(group.dataset.group,group.dataset.groupId);
      const nav=e.target.closest('[data-view]');if(nav)selectView(nav.dataset.view,nav.dataset.id||null);
    });
    $('create-playlist').addEventListener('click',()=>openPlaylistDialog('create'));
    $('playlist-dialog-close').addEventListener('click',closePlaylistDialog);
    $('playlist-dialog').querySelectorAll('[data-dialog-cancel]').forEach(btn=>btn.addEventListener('click',closePlaylistDialog));
    $('playlist-dialog').addEventListener('click',event=>{if(event.target===$('playlist-dialog'))closePlaylistDialog();});
    $('playlist-dialog').addEventListener('close',()=>{const el=dialogReturnFocus;dialogReturnFocus=null;assignedTrackId=null;if(el?.isConnected)el.focus();});
    $('playlist-create-form').addEventListener('submit',async event=>{
      event.preventDefault();const name=$('playlist-name').value.trim().slice(0,100);if(!name){$('playlist-name').focus();return;}
      const submit=$('playlist-create-submit');submit.disabled=true;
      try {if(await hubAction('playlist.create',{name})){closePlaylistDialog();notify(`Created “${name}”`);}}
      finally{submit.disabled=false;}
    });
    $('playlist-dialog-playlists').addEventListener('click',async event=>{
      const button=event.target.closest('[data-playlist-id]');if(!button||button.disabled||!assignedTrackId)return;
      const playlist=model.hub.playlists.find(p=>p.id===button.dataset.playlistId);if(!playlist)return;
      const exists=playlist.trackIds.includes(assignedTrackId),id=assignedTrackId,choiceIndex=model.hub.playlists.indexOf(playlist);
      button.disabled=true;
      try {if(await hubAction(exists?'playlist.remove':'playlist.add',{playlistId:playlist.id,trackId:id})){renderPlaylistChoices();$('playlist-dialog-playlists').querySelectorAll('button')[choiceIndex]?.focus();notify(exists?'Removed from playlist':'Added to playlist');}}
      finally{button.disabled=false;}
    });
    $('export-playlist').addEventListener('click',()=>{if(model.view!=='local'||!model.playlistId)return;const url=`/api/music-hub/export?playlistId=${encodeURIComponent(model.playlistId)}`;const link=document.createElement('a');link.href=url;link.download='';document.body.append(link);link.click();link.remove();notify('XML download requested. Review and manually import through Rekordbox XML Bridge.');});
    $('delete-playlist').addEventListener('click',async()=>{if(model.view!=='local'||!model.playlistId)return;const name=model.hub.playlists.find(p=>p.id===model.playlistId)?.name||'this playlist';if(!confirm(`Delete Music Hub playlist "${name}"?`))return;if(await hubAction('playlist.delete',{playlistId:model.playlistId}))selectView('all');});
    $('focus-queue').addEventListener('click',()=>selectView('queue'));$('clear-queue').addEventListener('click',()=>{if(model.hub.queue.length&&confirm('Clear the Music Hub Next Up queue?'))hubAction('queue.clear');});
    $('refresh').addEventListener('click',refreshAll);$('refresh-matches').addEventListener('click',()=>{const t=activeReference();if(t)loadCandidates(t.id);else notify('Select a track to find smart matches.');});
    $('mobile-menu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
    $('queue-items').addEventListener('click',e=>{const remove=e.target.closest('[data-remove]');if(remove){hubAction('queue.remove',{trackId:remove.dataset.remove,index:Number(remove.dataset.removeIndex)});return;}const row=e.target.closest('[data-id]');if(row)selectFooterTrack(row.dataset.id);});
    let dragging=-1;
    $('queue-items').addEventListener('dragstart',e=>{const row=e.target.closest('.queue-item');if(!row||!model.hubAvailable)return;dragging=Number(row.dataset.index);e.dataTransfer.effectAllowed='copyMove';e.dataTransfer.setData('application/x-music-hub-track',row.dataset.id);e.dataTransfer.setData('text/plain',row.dataset.id);row.classList.add('dragging');});
    $('queue-items').addEventListener('dragover',e=>{if(!model.hubAvailable||!hasDraggedTrack(e))return;e.preventDefault();e.dataTransfer.dropEffect=dragging>=0?'move':'copy';const row=e.target.closest('.queue-item');if(row)row.classList.add('drag-over');});
    $('queue-items').addEventListener('dragleave',e=>e.target.closest('.queue-item')?.classList.remove('drag-over'));
    $('queue-items').addEventListener('drop',e=>{const id=draggedId(e);if(!id||!model.hubAvailable)return;e.preventDefault();const row=e.target.closest('.queue-item'),to=row?Number(row.dataset.index):model.hub.queue.length,from=dragging;dragging=-1;document.querySelectorAll('.queue-item').forEach(el=>el.classList.remove('dragging','drag-over'));if(from>=0){if(row&&to!==from)hubAction('queue.reorder',{from,to});}else hubAction('queue.add',{trackId:id,index:to});});
    $('queue-items').addEventListener('dragend',()=>{dragging=-1;document.querySelectorAll('.queue-item').forEach(el=>el.classList.remove('dragging','drag-over'));});
    $('suggestions').addEventListener('click',e=>{const plus=e.target.closest('[data-suggest-add]');if(plus)return void hubAction('queue.add',{trackId:plus.dataset.suggestAdd});const row=e.target.closest('[data-id]');if(row)openTrack(row.dataset.id);});
    $('detail-close').addEventListener('click',closeDetail);document.querySelector('[data-close-detail]').addEventListener('click',closeDetail);
    $('detail-add').addEventListener('click',()=>model.currentDetail&&hubAction('queue.add',{trackId:toId(model.currentDetail.id)}));
    $('detail-favorite').addEventListener('click',()=>model.currentDetail&&hubAction('favorite.toggle',{trackId:toId(model.currentDetail.id)}));
    $('detail-playlist').addEventListener('click',()=>model.currentDetail&&choosePlaylist(toId(model.currentDetail.id)));
    document.querySelectorAll('[data-stage]').forEach(button=>button.addEventListener('click',()=>stageDeck(Number(button.dataset.stage))));
    document.querySelectorAll('[data-load]').forEach(button=>button.addEventListener('click',()=>loadDeck(button.dataset.load)));
    document.addEventListener('keydown',e=>{if($('playlist-dialog').open||$('setlist-name-dialog').open)return;const typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'');if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='m'){e.preventDefault();if($('provider-dialog').open)$('provider-dialog').close();else{openProviderDialog('apple_music');$('provider-tab-apple_music').focus();}return;}if(e.key==='Escape'){closeDetail();$('sidebar').classList.remove('open');document.querySelector('.inspector').classList.remove('open');}if((e.key==='/'&&!typing)||((e.metaKey||e.ctrlKey)&&e.key==='f')){e.preventDefault();$('search-input').focus();$('search-input').select();}if(!typing&&!e.metaKey&&!e.ctrlKey&&e.key.toLowerCase()==='q')selectView('queue');if(!typing&&!e.metaKey&&!e.ctrlKey&&e.key===' '&&model.selected){e.preventDefault();togglePreview();}});
  }
  async function choosePlaylist(id) {
    openPlaylistDialog('assign',id);
  }
  function setGrid(value) {setDisplayMode(value?'gallery':'list');}
  function setDisplayMode(mode){displayMode=mode;model.grid=['gallery','square'].includes(mode);for(const [id,value] of [['list-mode','list'],['compact-mode','compact'],['micro-mode','micro'],['grid-mode','gallery'],['square-mode','square']]){const el=$(id);if(!el)continue;el.classList.toggle('active',mode===value);el.setAttribute('aria-pressed',String(mode===value));}$('scroller').classList.toggle('grid-view',model.grid);$('scroller').dataset.density=mode;$('table-head').style.display=model.grid?'none':'';$('scroller').scrollTop=0;try{localStorage.setItem('music-hub-display-v2',mode);}catch{}renderRows();}
  async function refreshAll(forceRescan=false) {
    $('library-status').textContent='Loading collection…';
    const hub=refreshHub(true);
    try {const data=await api(forceRescan===true?'/api/library?force=1':'/api/library');model.tracks=asArray(data.collection).filter(t=>t?.id!=null).map(t=>({...t,id:toId(t.id)}));model.byId=new Map(model.tracks.map(t=>[t.id,t]));for(const n of [1,2])if(stagedDeckIds[n]&&!track(stagedDeckIds[n]))stagedDeckIds[n]=null;model.nativePlaylists=asArray(data.playlists);nativePlaylistTree=asArray(data.playlistTree);buildCollections();refreshGenreOptions();$('library-dot').className='status-dot ok';$('library-status').textContent=`${model.tracks.length.toLocaleString()} Rekordbox tracks`;renderSidebar();renderGallery();renderResults(true);scanNativePlaylistGenres();}catch(e){$('library-dot').className='status-dot error';$('library-status').textContent='Library connection unavailable';notify(`Library unavailable: ${e.message}`,true);}
    await hub;renderSetlistSearch();renderSetlist();updateSelectedPlayer();selectView(model.view,model.groupId,false);refreshDecks();updateHarmonicRail(true);
  }
  function initStudioBridge(){
    if(!window.MusicHubStudio)return;
    const footerButton=document.createElement('button');
    footerButton.id='selected-lyrics';footerButton.textContent='♪ Lyrics';footerButton.title='Open lyrics for selected track';footerButton.disabled=true;
    footerButton.addEventListener('click',()=>window.MusicHubStudio.open('lyrics'));
    $('selected-inspect')?.before(footerButton);
    const detailButton=document.createElement('button');
    detailButton.id='detail-lyrics';detailButton.textContent='♪ View lyrics / Karaoke';detailButton.className='subtle-button';
    detailButton.addEventListener('click',()=>{closeDetail();window.MusicHubStudio.open('lyrics');});
    document.querySelector('.detail-actions')?.append(detailButton);
    window.MusicHubStudio.init({
      getTracks:()=>model.tracks,
      getTrack:id=>track(id),
      getSelected:()=>track(model.selected),
      getHub:()=>model.hub,
      getContext:()=>({view:model.view,playlistId:model.playlistId}),
      getDecks:()=>({
        a:verifiedDeckSlots[1]?{...verifiedDeckSlots[1],verified:verifiedDeckFeedback,playing:verifiedDeckSlots[1].playing===true}:null,
        b:verifiedDeckSlots[2]?{...verifiedDeckSlots[2],verified:verifiedDeckFeedback,playing:verifiedDeckSlots[2].playing===true}:null,
        stagedA:track(stagedDeckIds[1]),stagedB:track(stagedDeckIds[2])
      }),
      enqueue:async id=>hubAction('queue.add',{trackId:toId(id)}),
      selectTrack:id=>selectFooterTrack(id),
      onHubChange:()=>refreshHub(true)
    });
  }
  // Refresh each row's cue ticks immediately after the standalone editor saves.
  window.addEventListener('music-hub:markers',event=>{
    const id=toId(event.detail?.id),markers=asArray(event.detail?.markers);
    if(!track(id))return;
    markerCache.set(id,{markers});
    redrawTrackMarkers(id);
  });
  // Local automix/companion-facing interface. This controls the staged HTML5
  // audio deck preview on this laptop. Hardware Rekordbox transports remain
  // under the verified native controller and are never changed here.
  window.MusicHubDesktopController={
    queue:()=>model.hub.queue.slice(),
    refreshQueue:()=>refreshHub(true),
    selectedId:()=>track(model.selected)?toId(model.selected):null,
    firstPlayableId:()=>toId(
      model.sorted.find(t=>Number(t.length??t.duration)>3&&/^\d{1,20}$/.test(toId(t.id)))?.id||
      model.tracks.find(t=>Number(t.length??t.duration)>3&&/^\d{1,20}$/.test(toId(t.id)))?.id||'')||null,
    libraryDiagnostics:()=>({tracks:model.tracks.length,sorted:model.sorted.length,
      view:model.view,selected:model.selected,libraryStatus:$('library-status')?.textContent||null}),
    browse:delta=>{
      if(!Number.isInteger(delta)||Math.abs(delta)>8||!delta)return false;
      const rows=(Array.isArray(model.sorted)&&model.sorted.length)?model.sorted:model.tracks;
      if(!rows.length)return false;
      const current=rows===browseIndexRows
        ?(browseIndex.get(toId(model.selected))??-1)
        :rows.findIndex(item=>toId(item.id)===toId(model.selected));
      const index=Math.max(0,Math.min(rows.length-1,
        current<0?(delta>0?0:rows.length-1):current+delta));
      selectFooterTrack(rows[index].id,{fast:true});
      const scroll=$('scroller');
      if(scroll&&!model.grid){
        const height=displayMode==='micro'?28:displayMode==='compact'?36:ROW_HEIGHT;
        const top=index*height;
        if(top<scroll.scrollTop||top+height>scroll.scrollTop+scroll.clientHeight){
          scroll.scrollTop=Math.max(0,top-scroll.clientHeight/3);
          renderRows();
        }
      }
      return true;
    },
    profileBrowse:(iterations=50)=>{
      const current=window.MusicHubTopDecks?.localStatus?.()||{};
      if(current.playingA||current.playingB)return {skipped:true,reason:'Do not benchmark while local music is playing'};
      const count=Math.max(1,Math.min(100,Number.isFinite(iterations)?Math.round(iterations):50));
      const original=model.selected;
      const runner=window.MusicHubDesktopController;
      const times=[];
      for(let i=0;i<count;i++){
        const direction=i%2===0?1:-1;
        const start=performance.now();
        runner.browse(direction);
        times.push(performance.now()-start);
      }
      clearTimeout(browseHeavyTimer);
      if(original&&track(original))selectFooterTrack(original,{fast:true});
      else{
        model.selected=null;model.currentDetail=null;
        updateSelectedPlayer();renderRows();
      }
      times.sort((a,b)=>a-b);
      const result={iterations:count,medianMs:Number(times[Math.floor(count/2)].toFixed(2)),
        p95Ms:Number(times[Math.min(count-1,Math.floor(count*.95))].toFixed(2)),
        maxMs:Number(times[count-1].toFixed(2)),
        averageMs:Number((times.reduce((a,b)=>a+b,0)/count).toFixed(2))};
      return result;
    },
    select:id=>{if(!track(toId(id)))return false;selectFooterTrack(toId(id));return true;},
    stage:(deck,trackId)=>{
      const n=Number(deck),id=toId(trackId);
      if(![1,2].includes(n)||!track(id)||verifiedDeckSlots[n])return false;
      stageDeck(n,id);
      return true;
    },
    clear:deck=>{
      const n=Number(deck);
      if(![1,2].includes(n)||verifiedDeckSlots[n])return false;
      stagedDeckIds[n]=null;persistStagedDecks();deckSlot(n,null,false);
      updateDeckRelationship();return true;
    },
    track:id=>track(toId(id))||null,
    verified:()=>({a:!!verifiedDeckSlots[1],b:!!verifiedDeckSlots[2]})
  };
  bind();bindProviders();initStudioBridge();refreshAll();
})();
