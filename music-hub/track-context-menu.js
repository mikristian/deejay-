/* Rekordbox-inspired track right-click actions, scoped to Music Hub's verified APIs. */
(() => {
  'use strict';
  if (window.MusicHubTrackContextMenu) return;
  const numeric = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
  const root = document.createElement('section');
  root.id = 'music-hub-track-menu';
  root.className = 'music-hub-track-menu';
  root.setAttribute('role','menu');
  root.setAttribute('aria-label','Track actions');
  root.hidden = true;
  const headline = document.createElement('div');
  headline.className = 'music-hub-track-menu-head';
  const caption = document.createElement('small');
  caption.className = 'music-hub-track-menu-caption';
  caption.textContent = 'MUSIC HUB · REKORDBOX LIBRARY READ-ONLY';
  const feedback = document.createElement('div');
  feedback.className = 'music-hub-track-menu-feedback';
  feedback.setAttribute('role','status');
  const list = document.createElement('div');
  list.className = 'music-hub-track-menu-list';
  root.append(headline, caption, list, feedback);
  let selectedRow = null;
  let selectedId = null;
  let openedFrom = null;

  const rowId = row => row?.dataset?.id;
  const rowButton = action => selectedRow?.querySelector?.(`[data-action="${action}"]`);
  const choose = action => {
    const item = rowButton(action);
    if (!item?.isConnected) {
      feedback.textContent = 'The song scrolled out of view. Right-click it again to continue.';
      return false;
    }
    close();
    item.click();
    return true;
  };
  const inspect = ({markerType=null,load=false}={}) => {
    if (!selectedRow?.isConnected || selectedId !== rowId(selectedRow)) {
      feedback.textContent = 'Right-click this song again to inspect it.';
      return;
    }
    const row = selectedRow;
    close();
    row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
    const drawer=document.getElementById('detail-drawer');
    if (markerType) {
      const type = document.getElementById('marker-type');
      if (type) {
        type.value = markerType;
        const section=document.getElementById('marker-editor');
        section?.scrollIntoView?.({block:'nearest'});
        document.getElementById('marker-time')?.focus?.();
      }
    } else if(load) {
      drawer?.querySelector('.detail-load')?.scrollIntoView?.({block:'nearest'});
    } else {
      drawer?.querySelector('.wave-section')?.scrollIntoView?.({block:'nearest'});
    }
  };
  const explain = message => {
    feedback.textContent=message;
  };
  const sections=[
    {title:'PREVIEW & ANALYSIS',actions:[
      {id:'preview',label:'Preview waveform',hint:'Local audio · does not affect playing decks',key:'P'},
      {id:'analysis',label:'Analyze Track · view existing',hint:'Inspect Rekordbox waveform, BPM, beat grid and cue data'},
      {id:'info',label:'Track information',hint:'Read-only metadata and details'}]},
    {title:'ORGANIZE',actions:[
      {id:'playlist',label:'Add to Playlist…',hint:'Your saved Music Hub playlists'},
      {id:'queue',label:'Add to Next Up',hint:'Music Hub queue · separate from Rekordbox Automix'},
      {id:'favorite',label:'Toggle Favorite',hint:'Saved in Music Hub'}]},
    {title:'DECKS & CUES',actions:[
      {id:'stage-a',label:'Stage preview on Deck A',hint:'Local preparation · not native Rekordbox load'},
      {id:'stage-b',label:'Stage preview on Deck B',hint:'Local preparation · not native Rekordbox load'},
      {id:'load',label:'Load to Rekordbox…',hint:'Opens guarded deck loading controls; never autoplays'},
      {id:'hotcue',label:'Set Hot Cue…',hint:'Music Hub marker · original Rekordbox cues unchanged'},
      {id:'memory',label:'Set Memory Cue…',hint:'Music Hub cue marker · original Rekordbox unchanged'}]},
    {title:'REKORDBOX-ONLY SETTINGS',actions:[
      {id:'track-type',label:'Track Type…',hint:'Change within Rekordbox'},
      {id:'autoload',label:'Auto Load Hot Cue…',hint:'Change within Rekordbox; CDJ/device behavior'},
      {id:'reanalyze',label:'Re-analyze Track…',hint:'Runs only in Rekordbox, not via Music Hub'}]}
  ];
  function close({restoreFocus=false}={}) {
    const previous=openedFrom;
    root.hidden=true;
    selectedRow=null;
    selectedId=null;
    openedFrom=null;
    feedback.textContent='';
    if (restoreFocus&&previous?.isConnected) previous.focus?.();
  }
  function execute(id) {
    if (!numeric(selectedId)) return;
    if (id==='preview') {
      const button=rowButton('markers');
      if (!button?.isConnected) return explain('Right-click the song again to preview it.');
      close();button.click();return;
    }
    if(id==='analysis'||id==='info') return inspect();
    if(id==='playlist'||id==='queue'||id==='favorite') return choose(id);
    if(id==='hotcue'||id==='memory') return inspect({markerType:id==='hotcue'?'hotcue':'cue'});
    if(id==='load') return inspect({load:true});
    if(id==='stage-a'||id==='stage-b') {
      const which=id==='stage-a'?'1':'2';
      const row=selectedRow;
      if(!row?.isConnected) return explain('Right-click the song again to stage it.');
      close();
      row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
      // The detail panel's existing stage handler is guarded, creates a local
      // preview only, and does not call Rekordbox's native load/MIDI transport.
      document.querySelector(`[data-stage="${which}"]`)?.click();
      return;
    }
    if(id==='track-type') return explain('Track Type is a Rekordbox setting. Open the same song in Rekordbox, right-click it, and choose Track Type. Music Hub cannot write this attribute.');
    if(id==='autoload') return explain('Auto Load Hot Cue is configured in Rekordbox for compatible DJ players. Music Hub does not alter that CDJ setting.');
    if(id==='reanalyze') return explain('For new analysis data, right-click the track in Rekordbox and select Analyze Track or Add New Analysis Data. Music Hub only reads existing analysis.');
  }
  for(const group of sections){
    const heading=document.createElement('div');
    heading.className='music-hub-track-menu-section';
    heading.textContent=group.title;
    list.append(heading);
    for(const action of group.actions){
      const button=document.createElement('button');
      button.type='button';
      button.className='music-hub-track-menu-action';
      button.dataset.trackMenuAction=action.id;
      button.setAttribute('role','menuitem');
      button.title=action.hint;
      const name=document.createElement('span');name.textContent=action.label;
      const subtitle=document.createElement('small');subtitle.textContent=action.hint;
      button.append(name,subtitle);
      button.addEventListener('click',event=>{event.stopPropagation();execute(action.id);});
      list.append(button);
    }
  }
  function show(row,event){
    if(!numeric(rowId(row)))return;
    selectedRow=row;selectedId=rowId(row);openedFrom=row;
    feedback.textContent='';
    headline.textContent=row.querySelector('.track-title')?.textContent?.trim()||
      row.querySelector('.track-name')?.textContent?.trim()||`Track ${selectedId}`;
    root.hidden=false;
    root.style.visibility='hidden';
    root.style.left='0px';root.style.top='0px';
    const box=root.getBoundingClientRect();
    root.style.left=`${Math.max(8,Math.min(event.clientX||0,window.innerWidth-(box.width||295)-10))}px`;
    root.style.top=`${Math.max(8,Math.min(event.clientY||0,window.innerHeight-(box.height||470)-10))}px`;
    root.style.visibility='visible';
    list.querySelector('button')?.focus({preventScroll:true});
  }
  const init=()=>{
    if(!document.body)return;
    document.body.append(root);
    document.addEventListener('contextmenu',event=>{
      const row=event.target instanceof Element ? event.target.closest('#scroller .track-row[data-id]') : null;
      if(!row)return;
      event.preventDefault();event.stopPropagation();
      show(row,event);
    },true);
    document.addEventListener('pointerdown',event=>{if(!root.hidden&&!root.contains(event.target))close();},true);
    document.addEventListener('scroll',event=>{if(!root.hidden&&!root.contains(event.target))close();},true);
    window.addEventListener('resize',()=>{if(!root.hidden)close();});
    document.addEventListener('keydown',event=>{
      if(root.hidden)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close({restoreFocus:true});return;}
      const actions=[...list.querySelectorAll('button:not([disabled])')];
      const index=actions.indexOf(document.activeElement);
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();event.stopPropagation();
        actions[(index+(event.key==='ArrowDown'?1:-1)+actions.length)%actions.length]?.focus();
      }
    },true);
  };
  window.MusicHubTrackContextMenu={close, get element(){return root;}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
