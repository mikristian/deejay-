/* Provider setup and official catalog search. No stream copying or credential fields. */
(() => {
  'use strict';
  const PROVIDERS={
    spotify:{name:'Spotify',site:'open.spotify.com'},
    apple_music:{name:'Apple Music',site:'music.apple.com'},
    soundcloud:{name:'SoundCloud',site:'soundcloud.com'}
  };
  const $=id=>document.getElementById(id);
  const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let setup=null,querySerial=0;
  const allowed=(value,provider)=>{
    try{const u=new URL(String(value));const host=PROVIDERS[provider]?.site;
      return u.protocol==='https:'&&(u.hostname===host||provider==='soundcloud'&&u.hostname==='www.soundcloud.com')?u.href:null;
    }catch{return null;}
  };
  const create=()=>{
    for(const [provider,info] of Object.entries(PROVIDERS)){
      const panel=$('provider-panel-'+provider);
      if(!panel||panel.querySelector('[data-provider-discovery]'))continue;
      const container=document.createElement('section');
      container.className='provider-discovery';container.dataset.providerDiscovery=provider;
      container.innerHTML=`
        <div class="provider-discovery-top"><div><strong>Connect & search ${info.name}</strong><small id="provider-setup-${provider}" role="status">Checking developer setup…</small></div><span class="provider-setup-pill" id="provider-setup-pill-${provider}">Checking</span></div>
        <form class="provider-search-form" data-provider-search-form="${provider}">
          <label for="provider-discovery-input-${provider}">Find songs, artists and playlists</label>
          <div class="provider-search-controls"><input id="provider-discovery-input-${provider}" type="search" required minlength="1" maxlength="150" autocomplete="off" placeholder="Search ${info.name}…"><button type="submit">Search</button></div>
        </form>
        <p class="provider-discovery-message" id="provider-search-message-${provider}" role="status">Search account metadata when connected, or open results on the provider site.</p>
        <div class="provider-discovery-results" id="provider-search-results-${provider}"></div>
        <a id="provider-search-external-${provider}" class="provider-search-external" href="https://${info.site}" target="_blank" rel="noopener noreferrer" hidden>Search on ${info.name}</a>`;
      const head=panel.querySelector('.provider-service-head');
      if(head)head.after(container);else panel.prepend(container);
      container.querySelector('form').addEventListener('submit',event=>{
        event.preventDefault();search(provider);
      });
    }
  };
  const renderSetup=data=>{
    setup=data;
    for(const [provider,info] of Object.entries(PROVIDERS)){
      const state=data?.providers?.[provider],message=$('provider-setup-'+provider),pill=$('provider-setup-pill-'+provider);
      if(!message||!pill)continue;
      if(!state){pill.textContent='Unavailable';message.textContent='Provider status unavailable';continue;}
      pill.textContent=state.connected?'Connected':state.configured?'Sign in available':'Setup required';
      pill.classList.toggle('ready',state.connected);
      message.textContent=state.message||'Developer setup required';
    }
  };
  const refresh=async()=>{
    try{const response=await fetch('/api/music-hub/providers/setup',{cache:'no-store'});
      const data=await response.json();
      if(!response.ok||data.error)throw Error(data.error||'Status could not be checked');
      renderSetup(data);
    }catch(error){
      for(const provider of Object.keys(PROVIDERS)){
        const p=$('provider-setup-'+provider),badge=$('provider-setup-pill-'+provider);
        if(p)p.textContent='Setup service unavailable: '+error.message;
        if(badge)badge.textContent='Check server';
      }
    }
  };
  async function search(provider){
    const query=$('provider-discovery-input-'+provider).value.trim();
    if(!query||query.length>150)return;
    const results=$('provider-search-results-'+provider);
    const message=$('provider-search-message-'+provider);
    const external=$('provider-search-external-'+provider);
    external.hidden=true;results.replaceChildren();message.textContent='Searching '+PROVIDERS[provider].name+'…';
    const serial=++querySerial;
    try{
      const response=await fetch('/api/music-hub/providers/search?provider='+encodeURIComponent(provider)+'&q='+encodeURIComponent(query),{cache:'no-store'});
      const data=await response.json();
      if(!response.ok||data.error)throw Error(data.error||'Search unavailable');
      if(serial!==querySerial)return;
      const url=allowed(data.externalSearchUrl,provider);
      if(url){external.href=url;external.hidden=false;external.textContent='Search '+PROVIDERS[provider].name+' on its website';}
      const items=Array.isArray(data.items)?data.items:[];
      message.textContent=data.source==='official_api'?(items.length+' authorized catalog results; provider audio stays with '+PROVIDERS[provider].name+'.'):(data.message||'Account authorization is required for in-app search. Open the official service search.');
      if(data.apiError)message.textContent='Provider API unavailable: '+data.apiError+'. Open official search below.';
      if(items.length){
        const fragment=document.createDocumentFragment();
        for(const item of items.slice(0,30)){
          const row=document.createElement('article');row.className='provider-discovery-result';
          const name=String(item?.name||item?.title||'Untitled');
          const artist=Array.isArray(item?.artists)?item.artists.map(a=>a?.name||a).join(', '):item?.artist||'';
          const itemUrl=allowed(item?.external_urls?.spotify||item?.externalUrl||item?.url||item?.spotifyUrl,provider);
          const localMatch=item?.localMatch?.status==='matched'?' · Local Rekordbox match':'';
          row.innerHTML='<div><strong>'+safe(name)+'</strong><small>'+safe(artist)+' · '+PROVIDERS[provider].name+localMatch+'</small></div>';
          if(itemUrl){const a=document.createElement('a');a.href=itemUrl;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open';row.append(a);}
          fragment.append(row);
        }
        results.append(fragment);
      }
    }catch(error){if(serial===querySerial)message.textContent='Search unavailable: '+error.message;}
  }
  const init=()=>{
    create();
    refresh();
    const dialog=$('provider-dialog');
    dialog?.addEventListener('click',event=>{
      if(event.target.closest('[data-provider-tab]'))refresh();
    });
    dialog?.addEventListener('close',()=>{querySerial++;});
    window.MusicHubProviderDiscovery={refresh};
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
