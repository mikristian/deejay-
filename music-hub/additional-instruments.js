/* User-built Mac instrument launcher. Running does not imply Ableton/rekordbox routing. */
(() => {
  'use strict';
  if (window.MusicHubAdditionalInstruments) return;
  const CATALOG = [
    {id:'vintage-sampler',name:'Vintage Sampler Lab',glyph:'▦'},
    {id:'maschine-lab',name:'MASCHINE LAB',glyph:'▤'},
    {id:'asr10-sampler',name:'ASR-10 Sampler Lab',glyph:'▥'},
    {id:'flx4-flat',name:'FLX4 Flat 2D',glyph:'◫'},
    {id:'flx4-live',name:'FLX4 Live 2D',glyph:'◈'}
  ];
  const endpoint='/api/music-hub/instruments';
  let busy=null,latest=[],shell,details,list,status,count,refreshButton;
  const text=(node,string)=>{node.textContent=String(string??'');};
  const get=async()=>{
    const response=await fetch(endpoint,{cache:'no-store',credentials:'same-origin'});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||`Instrument service ${response.status}`);
    if(!Array.isArray(data.items))throw Error('Invalid instrument inventory');
    return data.items;
  };
  const listRow = (entry,slot) => {
    const row=document.createElement('div');
    row.className='additional-instrument-item';
    const ico=document.createElement('span');ico.className='additional-instrument-icon';ico.textContent=slot.glyph;
    const info=document.createElement('div');info.className='additional-instrument-info';
    const name=document.createElement('strong');text(name,slot.name);
    const state=document.createElement('small');
    const running=Boolean(entry?.running),installed=Boolean(entry?.installed);
    state.className=running?'is-running':'';
    text(state,installed?(running?'Running on this Mac':'Installed · not open'):'Not installed / unavailable');
    const route=document.createElement('small');route.className='additional-instrument-route';
    const ableton=entry?.connection?.ableton||'not_configured';
    const rekordbox=entry?.connection?.rekordbox||'not_configured';
    const a=ableton==='midi_output_available'?`MIDI CH ${entry.midiChannel||'?'}`:
      ableton==='connected'?'Ableton linked':'MIDI setup needed';
    const b=rekordbox==='bridge_connected'?'RB bridge':'RB unverified';
    text(route,`${a} · ${b}`);
    route.title=`Ableton: ${ableton}. Rekordbox: ${rekordbox}. ${entry?.setupGuidance||''}`;
    info.append(name,state,route);
    const open=document.createElement('button');open.type='button';
    open.className='additional-instrument-open';open.dataset.openInstrument=slot.id;
    open.disabled=!installed||busy!==null;
    text(open,installed?(busy===slot.id?'Opening…':running?'Show':'Open'):'—');
    open.title=installed?`Open ${slot.name} on the Mac; routing still requires setup`:`${slot.name} is not verified as installed`;
    row.append(ico,info,open);
    return row;
  };
  const render=()=>{
    if(!list)return;
    const byId=new Map(latest.map(x=>[x.id,x]));
    list.replaceChildren(...CATALOG.map(slot=>listRow(byId.get(slot.id),slot)));
    text(count,latest.length?`${latest.filter(x=>x.running).length} active`:'');
    shell.classList.toggle('instruments-expanded',details.open);
  };
  const refresh=async()=>{
    if(!list)return;
    try{
      latest=await get();
      const midi=latest.find(x=>x.connection?.ableton==='midi_output_available');
      text(status,midi?`Virtual MIDI port: ${midi.midiPort||'FLX4 Live 2D to Ableton'}. Enable Track input and monitor the correct channel in Live; audio output is separate.`:
        'Launching an app does not automatically connect MIDI, audio or Ableton Link.');
    }catch{
      latest=[];
      text(status,'Launcher service unavailable. Restart Music Hub to enable app opening.');
    }
    render();
  };
  const launch=async id=>{
    if(busy||!CATALOG.some(x=>x.id===id))return;
    if(!latest.find(x=>x.id===id)?.installed)return;
    busy=id;render();
    text(status,'Requesting macOS app launch…');
    try {
      const response=await fetch(endpoint+'/launch',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||`Launch returned ${response.status}`);
      text(status,`${result.name||'Instrument'}: macOS accepted the open request. Check Ableton's MIDI Track input and monitoring before playing.`);
    }catch(error){text(status,`App could not be opened: ${error.message}`);}
    finally{busy=null;await refresh();}
  };
  const init=()=>{
    const sidebar=document.getElementById('sidebar');
    const bottom=sidebar?.querySelector('.sidebar-bottom');
    if(!sidebar||!bottom||document.getElementById('additional-instruments'))return;
    shell=sidebar;
    details=document.createElement('details');details.className='additional-instruments';details.id='additional-instruments';
    const summary=document.createElement('summary');summary.className='additional-instruments-heading';
    const symbol=document.createElement('span');symbol.className='nav-glyph';symbol.textContent='♬';
    const label=document.createElement('strong');label.textContent='Additional instruments';
    summary.title='Additional instruments · launch Mac sampler apps and view Ableton/Rekordbox routing';
    count=document.createElement('small');count.className='additional-instruments-count';
    summary.append(symbol,label,count);
    const panel=document.createElement('div');panel.className='additional-instruments-panel';
    const intro=document.createElement('p');intro.textContent='Your Mac sampler and controller apps';
    list=document.createElement('div');list.className='additional-instruments-list';
    const actions=document.createElement('div');actions.className='additional-instruments-actions';
    refreshButton=document.createElement('button');refreshButton.type='button';
    refreshButton.textContent='↻ Check apps';refreshButton.addEventListener('click',refresh);
    const help=document.createElement('button');help.type='button';help.textContent='Ableton routing';
    help.title='Show the verified virtual MIDI setup required in Ableton';
    const guidance=document.createElement('div');guidance.className='additional-instruments-guidance';
    guidance.hidden=true;
    guidance.textContent='In Ableton Live 12: Settings → Link, Tempo & MIDI → enable Track input for “FLX4 Live 2D to Ableton”. Add MIDI tracks with your MASCHINE LAB, Vintage Sampler, or ASR-10 AU/VST3 plugin. Select the same port with MIDI channels 1, 2, and 3 respectively. Set Monitor to In, or Auto and arm the MIDI track. The FLX4 Live 2D app already has a Sampler Apps / Ableton routing selector. Standalone audio output and Rekordbox remain separate until routed.';
    help.addEventListener('click',()=>{guidance.hidden=!guidance.hidden;help.setAttribute('aria-expanded',String(!guidance.hidden));});
    actions.append(help,refreshButton);
    status=document.createElement('p');status.className='additional-instruments-status';
    status.setAttribute('role','status');status.textContent='Checking installed instruments…';
    panel.append(intro,list,actions,guidance,status);
    details.append(summary,panel);
    bottom.before(details);
    details.addEventListener('toggle',()=>{shell.classList.toggle('instruments-expanded',details.open);if(details.open)refresh();});
    list.addEventListener('click',event=>{
      const button=event.target.closest('button[data-open-instrument]');
      if(button)launch(button.dataset.openInstrument);
    });
    window.addEventListener('focus',()=>{if(details.open)refresh();});
    refresh();
  };
  window.MusicHubAdditionalInstruments={refresh, get items(){return latest.slice()}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
