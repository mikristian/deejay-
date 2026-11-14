/* Compact, read-only DJ performance chrome. No transport or effect actions. */
(() => {
  'use strict';
  const panel = () => document.getElementById('performance-panel');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const disabled = (label, extra = '') => `<button type="button" disabled aria-disabled="true" title="UI preview only — Rekordbox controller unavailable" class="${extra}">${esc(label)}</button>`;
  const fx = side => `<div class="pc-fx-channel pc-fx-${side}"><div class="pc-fx-channel-heading"><span class="pc-fx-channel-name">FX${side}</span><small>UI PREVIEW ONLY</small></div>
    <div class="pc-fx-channel-content">
      <div class="pc-fx-assign"><span class="pc-fx-label">CHANNEL ASSIGN</span><div class="pc-fx-assign-grid">${['1','2','S','3','4','M'].map(x => disabled(x,'pc-fx-square'+(x===String(side)?' pc-fx-emphasis':''))).join('')}</div><div class="pc-fx-menu">${disabled('•••','pc-fx-menu-button')}${disabled('•','pc-fx-dot')}</div></div>
      <div class="pc-fx-slots"><div class="pc-fx-label">BEAT FX · DISPLAY ONLY</div>
        <div class="pc-fx-slot-row"><span>ECHO</span><b>3/4</b>${disabled('‹','pc-step')}${disabled('›','pc-step')}</div>
        <div class="pc-fx-slot-row"><span>ECHO</span><b>1</b>${disabled('‹','pc-step')}${disabled('›','pc-step')}</div>
        <div class="pc-fx-slot-row"><span>${side===1?'FILTER':'SPIRAL'}</span><b>${side===1?'4':'1'}</b>${disabled('‹','pc-step')}${disabled('›','pc-step')}</div>
        <div class="pc-fx-slot-row pc-fx-vinyl"><span>VINYL BRAKE</span><b>3/4</b>${disabled('‹','pc-step')}${disabled('›','pc-step')}</div>
        <div class="pc-fx-timing">${disabled('AUTO','pc-auto')}${disabled('TAP','pc-tap')}</div>
      </div>
    </div></div>`;
  const effectsMarkup = () => `<section class="pc-effects" aria-label="Effects preview; controls unavailable">
    <div class="pc-effects-top"><span>FX1 / FX2 · UI PREVIEW ONLY</span><span class="pc-readonly">READ ONLY · NO FX PROCESSING</span></div>
    <div class="pc-effects-main">${fx(1)}${fx(2)}</div>
    <div class="pc-cfx-row">
      <div class="pc-cfx"><div class="pc-cfx-heading"><strong>CFX</strong><small>PREVIEW</small></div>
        <div class="pc-cfx-controls"><div class="pc-cfx-mode">${disabled('DEFAULT')}${disabled('USER')}</div>
          ${disabled('FILTER','pc-cfx-filter')}
          <div class="pc-cfx-knobs">${['PARAM','S','3','1','2','4','M'].map(x=>`<div class="pc-cfx-knob"><span class="pc-cfx-knob-art" aria-hidden="true"></span><small>${x}</small></div>`).join('')}</div>
        </div>
      </div>
      <div class="pc-stems"><span>STEMS · UI PREVIEW</span><div>${disabled('INST','pc-inst')}${disabled('VOCAL','pc-vocal')}${disabled('DRUMS','pc-drums')}</div></div>
    </div>
  </section>`;
  const cuesMarkup = () => `<div class="pc-hotcue-head"><strong>HOT CUE</strong><span>READ ONLY</span></div><div class="pc-cue-grid">${'ABCDEFGH'.split('').map(letter => disabled(letter,'pc-cue')).join('')}</div>`;
  const deckMarkup = n => `<div class="pc-deck-extra" data-pc-deck="${n}" aria-label="Deck ${n} controls, read-only preview">
    <div class="pc-deck-sync"><span class="pc-sync-time">—:— / —:—</span><span class="pc-sync-position" title="Playback position not verified">POS —</span>${disabled('KEY SYNC','pc-sync-button')}${disabled('BEAT SYNC','pc-sync-button')}${disabled('MASTER','pc-sync-button')}</div>
    <div class="pc-deck-stage pc-deck-stage-${n}">
      <div class="pc-jog-unit"><div class="pc-jog-ring"><div class="pc-jog-inner"><strong class="pc-jog-bpm">—</strong><span class="pc-jog-key">—</span></div><span class="pc-jog-dot"></span></div></div>
      <div class="pc-deck-operations"><div class="pc-transport">${disabled('CUE','pc-transport-cue')}${disabled('▶','pc-transport-play')}</div><div class="pc-pad-panel">${cuesMarkup()}</div></div>
    </div>
    <div class="pc-stem-mutes"><span>MUTE</span>${disabled('DRUMS','pc-drums')}${disabled('VOCAL','pc-vocal')}${disabled('INST','pc-inst')}</div>
    <div class="pc-deck-utilities"><span>JUMP</span>${disabled(n===1?'4':'1/32','pc-jump-size')}${disabled('‹','pc-jump-step')}${disabled('›','pc-jump-step')}${disabled('AU','pc-beat-au')}${disabled('MA','pc-beat-ma')}<span class="pc-utilities-spacer"></span>${disabled('SLIP','pc-slip')}${disabled('Q','pc-q')}${disabled('MT','pc-mt')}</div>
    <div class="pc-deck-caption"><span class="pc-track-title">NO TRACK SELECTED</span><span class="pc-verified">PREVIEW · NO LIVE CONTROL</span></div>
  </div>`;
  const slider = (label, classname, at = 50) => `<div class="pc-mixer-control"><span>${label}</span><div class="${classname}"><i style="--pc-position:${at}%"></i></div></div>`;
  const formatTime = value => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 43200) return '—:—';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor(seconds * 10) % 10}`;
  };
  const mixerMarkup = () => `<div class="pc-mixer-extra" aria-label="Mixer layout read-only preview"><strong>MIX · PREVIEW</strong><div class="pc-mixer-columns">
    <div class="pc-mixer-column"><span>CH 1</span>${slider('TRIM','pc-knob',47)}${slider('HI','pc-knob',38)}${slider('MID','pc-knob',55)}${slider('LOW','pc-knob',65)}${slider('FADER','pc-fader',53)}<div class="pc-mixer-switches">${disabled('CUE','pc-mixer-cue')}${disabled('STEM','pc-mixer-stem')}</div></div>
    <div class="pc-mixer-column"><span>CH 2</span>${slider('TRIM','pc-knob',50)}${slider('HI','pc-knob',52)}${slider('MID','pc-knob',41)}${slider('LOW','pc-knob',58)}${slider('FADER','pc-fader',44)}<div class="pc-mixer-switches">${disabled('CUE','pc-mixer-cue')}${disabled('STEM','pc-mixer-stem')}</div></div></div></div>`;
  const assignGrid = side => `<div class="pc-head-assign pc-head-assign-${side}" aria-label="${side==='left'?'Left':'Right'} headphone channel assignment preview">${['1','2','3','4'].map(channel => disabled(channel, 'pc-assign'+((side==='left' ? ['1','3'] : ['2','4']).includes(channel) ? ' pc-assign-blue' : ''))).join('')}</div>`;
  const headphoneMarkup = () => `<div class="pc-headphone-bar" aria-label="Headphones and crossfader, read-only preview"><span>HP L</span>${assignGrid('left')}<span class="pc-headphones" aria-hidden="true">◉</span><span>ASSIGN</span><span class="pc-crossfader-label">CROSSFADER</span><div class="pc-crossfader"><i></i></div><span>HP R</span>${assignGrid('right')}<span class="pc-headphone-preview">PREVIEW ONLY</span></div>`;
  function init() {
    const root = panel();
    if (!root) return false;
    // If an earlier initialization was interrupted, the DOM itself is the
    // reliable sentinel. Never duplicate chrome before app startup proceeds.
    if (root.dataset.pcReady === 'true' || root.querySelector('.pc-effects')) {
      root.dataset.pcReady = 'true';
      return true;
    }
    const top = root.querySelector('.performance-top');
    const deckPair = root.querySelector('.deck-pair');
    if (!top || !deckPair) return false;
    const effects = document.createElement('div'); effects.innerHTML = effectsMarkup();
    top.after(effects.firstElementChild);
    const decks = [...deckPair.querySelectorAll(':scope > .deck')];
    decks.forEach((deck, index) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = deckMarkup(index + 1);
      deck.append(wrap.firstElementChild);
    });
    const mixer = deckPair.querySelector('.mini-mixer');
    if (mixer) { const wrap = document.createElement('div'); wrap.innerHTML = mixerMarkup(); mixer.append(wrap.firstElementChild); }
    root.dataset.pcReady = 'true';
    return true;
  }
  function sync(deckIndex, state = {}) {
    if (!init()) return;
    const n = Number(deckIndex);
    if (n !== 1 && n !== 2) return;
    const root = panel().querySelector(`[data-pc-deck="${n}"]`);
    if (!root) return;
    const track = state.track || state.display || null;
    const detail = state.detail || {};
    const verified = state.verified === true;
    const set = (sel, value) => {const el = root.querySelector(sel); if(el) el.textContent = value;};
    const bpm = track && Number(track.bpm ?? detail.bpm ?? detail.analysis?.bpm);
    set('.pc-jog-bpm',Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(1) : '—');
    set('.pc-jog-key',track?.musicalKey || track?.musical_key || track?.key || track?.camelot || detail.key || '—');
    const length = track && Number(track.length ?? track.duration ?? detail.waveform?.duration);
    const verifiedPosition = verified && state.positionSeconds != null && Number.isFinite(Number(state.positionSeconds)) && Number(state.positionSeconds) >= 0 ? Number(state.positionSeconds) : null;
    set('.pc-sync-time',Number.isFinite(length) && length > 0 ? `${verifiedPosition===null?'—:—':formatTime(verifiedPosition)} / ${formatTime(length)}` : '—:— / —:—');
    set('.pc-sync-position',verifiedPosition===null?'POS —':'POS VERIFIED');
    set('.pc-track-title',track?.title || 'NO TRACK SELECTED');
    set('.pc-verified',verified?'TRACK VERIFIED':'CONTROL PREVIEW');
    const cues = Array.isArray(detail?.cues?.cues) ? detail.cues.cues : [];
    const slots = new Set();
    for(const cue of cues) {
      if (!cue || !cue.hot_cue) continue;
      const label = String(cue.hot_cue).trim().toUpperCase();
      if (/^[A-H]$/.test(label)) slots.add(label);
      else if (/^[1-8]$/.test(label)) slots.add('ABCDEFGH'[Number(label)-1]);
    }
    root.querySelectorAll('.pc-cue').forEach(button => {
      const available = slots.has(button.textContent.trim());
      button.classList.toggle('pc-cue-present',available);
      button.title = available ? 'Stored hot cue exists in analysis; controller unavailable' : 'UI preview only — controller unavailable';
    });
  }
  window.MusicHubPerformanceChrome = {init,sync};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
