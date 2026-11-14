/* Opt-in local four-stem generation; does not control rekordbox/djay decks. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const parts = ['vocals', 'drums', 'bass', 'other'];
  let selected = '', selectedTitle = '', status = null, timer = null;
  const players = new Map(), nodes = {};
  const fmt = n => Number(n || 0).toLocaleString();
  const size = n => Number.isFinite(Number(n)) && Number(n) > 0 ?
    (Number(n) / (1024 ** 4)).toFixed(2) + ' TiB' : 'not reported';
  async function api(url, body) {
    const res = await fetch('/api/music-hub/stems/' + url,
      body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {cache:'no-store'});
    const data = await res.json();
    if (!res.ok || data.error) throw Error(data.error || 'HTTP ' + res.status);
    return data;
  }
  function pauseAll() {
    for (const audio of players.values()) {audio.pause();audio.removeAttribute('src');audio.load();}
    players.clear();
    if (nodes.play) nodes.play.textContent = '▶ Preview stems';
  }
  function setSelected(id, title) {
    id = String(id || '');
    if (!/^\d{1,20}$/.test(id)) return;
    if (selected !== id) { selected = id; selectedTitle = title || ''; pauseAll(); nodes.mix.hidden = true; }
    if (nodes.dialog?.open) refresh();
  }
  function render() {
    if (!status) return;
    const job = status.job || {};
    nodes.summary.textContent = fmt(status.stemReadyTracks)+' / '+fmt(status.localTracks)+
      ' playable library entries prepared · '+fmt(status.uniquePlayableSources)+
      ' distinct audio files · '+fmt(status.relinkedLegacyEntries)+
      ' recovered old-drive references · '+fmt(status.notLocalTracks)+' still unavailable';
    const estimate = size(status.estimatedStemBytes);
    const free = size(status.expansionFreeBytes);
    nodes.storage.textContent = 'Expansion free: '+free+' · Estimated four-stem WAV library: '+estimate+
      ' · Output: '+status.destination;
    const blockers = [];
    if (!status.destinationReady) blockers.push(status.destinationIssue);
    if (!status.engineInstalled) blockers.push('Demucs deep-stem engine not installed');
    if (!status.decoderInstalled) blockers.push('ffmpeg and ffprobe not installed');
    nodes.setup.textContent = blockers.length ? blockers.join(' · ') : 'Storage and separation engine ready · htdemucs 4-stem WAV output';
    nodes.setup.classList.toggle('blocked', blockers.length > 0);
    nodes.all.disabled = blockers.length > 0 || job.running;
    nodes.one.disabled = blockers.length > 0 || job.running || !selected || status.selected?.status !== 'not_processed';
    nodes.stop.disabled = !job.running;
    nodes.exportButton.disabled = !status.stemReadyTracks;
    nodes.progress.max = Math.max(1, Number(job.total) || 1);
    nodes.progress.value = (Number(job.completed)||0) + (Number(job.skipped)||0) + (Number(job.failed)||0);
    nodes.job.textContent = job.running ? (job.stopping?'Stopping…':'Preparing '+(job.current||'next song'))+' · '+fmt(job.completed)+' complete · '+fmt(job.skipped)+' skipped · '+fmt(job.failed)+' failed'
      : 'Idle · last run: '+fmt(job.completed)+' completed, '+fmt(job.failed)+' failed';
    if (status.batchResume?.enabled) nodes.job.textContent += ' · Auto-resume on server restart enabled';
    if (job.error) nodes.job.textContent += ' · '+job.error;
    nodes.song.textContent = selected ? (selectedTitle || 'Selected song') + ' · '+selected : 'Select a song in the library first';
    nodes.songStatus.textContent = status.selected?.status === 'ready' ? 'Four WAV stems ready · '+status.destination+'/tracks/'+selected :
      status.selected?.status === 'unavailable' ? 'Local file not available for separation' :
      selected ? 'Not processed yet' : 'No selection';
    const ready = status.selected?.status === 'ready';
    if (ready && (nodes.mix.hidden || nodes.mix.dataset.id !== selected)) {
      pauseAll();
      nodes.mix.hidden = false;
      nodes.mix.dataset.id = selected;
      for (const part of parts) {
        const audio = new Audio('/api/music-hub/stems/audio?id='+encodeURIComponent(selected)+'&stem='+part);
        audio.preload = 'metadata';
        audio.volume = Number(nodes.mix.querySelector('[data-part="'+part+'"]').value)/100;
        players.set(part, audio);
      }
    } else if (!ready && !nodes.mix.hidden) {pauseAll();nodes.mix.hidden = true;}
  }
  async function refresh() {
    try {status = await api('status'+(selected?'?id='+encodeURIComponent(selected):''));render();}
    catch(err) {nodes.setup.textContent = 'Stem service unavailable: '+err.message;}
  }
  async function action(cmd, scope) {
    if (cmd === 'start' && scope === 'all' && !confirm('Prepare every local recording? Hundreds of GB may be required on Expansion storage. You can stop and resume.')) return;
    try {
      const reply = await api('action',{action:cmd,scope,trackId:selected});
      nodes.notice.textContent = reply.message || 'Command received';
      await refresh();
    } catch(err) {nodes.notice.textContent = err.message;}
  }
  function togglePreview() {
    if (!players.size) return;
    if ([...players.values()].every(audio=>audio.paused)) {
      const offset = players.get('vocals').currentTime || 0;
      for (const audio of players.values()) {
        audio.currentTime = offset;
        audio.play().catch(()=>{nodes.notice.textContent='Unable to play local stem files';});
      }
      nodes.play.textContent = 'Ⅱ Pause stems';
    } else {
      for (const audio of players.values()) audio.pause();
      nodes.play.textContent = '▶ Preview stems';
    }
  }
  function init() {
    const bar = document.querySelector('.toolbar-actions');
    if (!bar || $('stems-open')) return;
    const trigger = document.createElement('button');
    trigger.id = 'stems-open';trigger.className='toolbar-chip';trigger.type='button';trigger.textContent='◈ Stems';
    trigger.title='Prepare local vocals, drums, bass and other on Expansion drive';
    bar.insertBefore(trigger, $('selected-player-toggle'));
    const dialog=document.createElement('dialog');
    dialog.id='stems-dialog';dialog.className='stems-dialog';
    dialog.innerHTML = `<header><div><small>LOCAL MUSIC HUB · EXPANSION DRIVE</small><h2>Deep Stems</h2><p>Prepare vocals, drums, bass and other instruments across your locally playable library. Original recordings are untouched.</p></div><button class="stems-close" type="button" aria-label="Close">×</button></header>
    <section class="stems-count"><strong id="stems-summary">Checking coverage…</strong><small id="stems-storage"></small></section>
    <p id="stems-setup" class="stems-setup">Checking prerequisites…</p>
    <div class="stems-actions"><button id="stems-all" class="primary-button" disabled>Generate entire library</button><button id="stems-one" class="subtle-button" disabled>Generate selected song</button><button id="stems-stop" class="subtle-button" disabled>Stop</button></div>
    <progress id="stems-progress" max="1" value="0"></progress><p id="stems-job" class="stems-info">Checking batch job…</p>
    <div class="stems-export"><label>REKORDBOX PLAYLIST
      <select id="stems-export-part" aria-label="Select stem type to export"><option value="all">All available stems</option><option value="vocals">Vocals only</option><option value="drums">Drums only</option><option value="bass">Bass only</option><option value="other">Other instruments only</option></select>
    </label><button id="stems-export-button" class="subtle-button" disabled>Export ready stems (.m3u8)</button></div>
    <p class="stems-info">Import the downloaded playlist in rekordbox via File → Import → Import Playlist. For djay, add the Expansion stems/tracks folder to My Files. Neither option duplicates the WAVs.</p>
    <section class="stems-preview"><h3>Selected track</h3><strong id="stems-song"></strong><small id="stems-song-status"></small>
      <div id="stems-mix" hidden><p>Mix preview (local audio only, no DJ deck or BPM synchronization)</p>
      <div class="stems-sliders"><label>Vocals<input data-part="vocals" type="range" min="0" max="100" value="100"></label><label>Drums<input data-part="drums" type="range" min="0" max="100" value="100"></label><label>Bass<input data-part="bass" type="range" min="0" max="100" value="100"></label><label>Other<input data-part="other" type="range" min="0" max="100" value="100"></label></div>
      <button id="stems-play" class="subtle-button">▶ Preview stems</button></div></section>
    <p id="stems-notice" role="status" aria-live="polite"></p><p class="stems-info">Import generated WAV files into rekordbox or djay to mix on their real DJ decks. This tool does not write directly into either application's library or extract streaming-only tracks.</p>`;
    document.body.append(dialog);
    Object.assign(nodes,{dialog,summary:$('stems-summary'),storage:$('stems-storage'),setup:$('stems-setup'),
      all:$('stems-all'),one:$('stems-one'),stop:$('stems-stop'),progress:$('stems-progress'),
      job:$('stems-job'),song:$('stems-song'),songStatus:$('stems-song-status'),
      mix:$('stems-mix'),play:$('stems-play'),notice:$('stems-notice'),
      exportPart:$('stems-export-part'),exportButton:$('stems-export-button')});
    const close = () => {clearInterval(timer);timer=null;pauseAll();dialog.close();};
    trigger.addEventListener('click',()=>{dialog.showModal();refresh();clearInterval(timer);timer=setInterval(refresh,7000);});
    dialog.querySelector('.stems-close').addEventListener('click',close);
    dialog.addEventListener('cancel',()=>{clearInterval(timer);timer=null;pauseAll();});
    dialog.addEventListener('click',ev=>{if(ev.target===dialog)close();});
    nodes.all.addEventListener('click',()=>action('start','all'));
    nodes.one.addEventListener('click',()=>action('start','track'));
    nodes.stop.addEventListener('click',()=>action('stop'));
    nodes.exportButton.addEventListener('click',()=>{
      if(nodes.exportButton.disabled)return;
      const type=nodes.exportPart.value;
      if(!['all','vocals','drums','bass','other'].includes(type))return;
      window.location.assign('/api/music-hub/stems/export.m3u8?part='+encodeURIComponent(type));
    });
    nodes.play.addEventListener('click',togglePreview);
    nodes.mix.addEventListener('input',ev=>{
      const part = ev.target.closest('[data-part]')?.dataset.part;
      if(part && players.has(part))players.get(part).volume=Number(ev.target.value)/100;
    });
    document.addEventListener('click',ev=>{
      const row=ev.target.closest('.track-row[data-id]');
      if(row)setSelected(row.dataset.id,row.querySelector('.track-title')?.textContent);
    },true);
    window.MusicHubStems={setSelected,refresh};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
