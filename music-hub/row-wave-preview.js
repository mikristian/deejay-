/* Independent, delegated waveform scrub preview for virtualized library rows. */
(() => {
  'use strict';
  if (window.MusicHubRowWavePreview) return;

  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = 0.75;
  audio.setAttribute('aria-hidden', 'true');
  const status = document.createElement('span');
  status.className = 'row-wave-preview-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Waveform preview ready';
  const mount = () => { if (!status.isConnected) document.body.appendChild(status); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();

  let active = null;
  let dragging = null;
  let generation = 0;
  let lastSeek = 0;
  let requestedFraction = null;
  let previewUnlocked = false;
  let hoverTimer = null;
  let hoveredButton = null;
  const cancelHover = () => { if (hoverTimer !== null) clearTimeout(hoverTimer); hoverTimer = null; };
  const waveButton = target => target instanceof Element ? target.closest('#scroller .row-wave-button') : null;
  const trackId = button => button?.closest('.track-row[data-id]')?.dataset.id;
  const fraction = (button, clientX) => {
    const rect = button.getBoundingClientRect();
    return Math.max(0, Math.min(1, rect.width ? (clientX - rect.left) / rect.width : 0));
  };
  const message = (button, text) => {
    status.textContent = text;
    if (button?.isConnected) button.setAttribute('aria-description', text);
  };
  const describe = button => {
    const playing = active === trackId(button) && !audio.paused;
    const label = playing ? 'Preview playing. Click to stop; drag to scrub; Escape to stop; Shift-click for cue markers'
      : 'Click to preview; drag to scrub; hover after first click; Escape to stop; Shift-click for cue markers';
    button.title = label;
    button.setAttribute('aria-label', label);
  };
  const position = (button, value) => {
    button.style.setProperty('--row-preview-x', `${(value * 100).toFixed(3)}%`);
    button.classList.add('row-preview-hover');
  };
  const seek = (value, force = false) => {
    requestedFraction = value;
    const now = performance.now();
    if (!force && now - lastSeek < 70) return;
    lastSeek = now;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      try { audio.currentTime = Math.min(Math.max(0, value * audio.duration), Math.max(0, audio.duration - 0.03)); }
      catch { /* Wait for metadata on formats that reject early seeks. */ }
    }
  };
  const clearActive = () => {
    document.querySelectorAll('.row-wave-button.row-preview-playing').forEach(button => button.classList.remove('row-preview-playing'));
  };
  function stop() {
    cancelHover();
    dragging = null;
    generation++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    active = null;
    requestedFraction = null;
    clearActive();
    status.textContent = 'Waveform preview stopped';
  }
  async function play(button, value, userGesture = false) {
    const id = trackId(button);
    if (!id || !/^\d+$/.test(id)) { message(button, 'This song has no available local audio ID'); return; }
    if (active !== id) {
      ++generation;
      audio.pause();
      clearActive();
      active = id;
      requestedFraction = value;
      audio.src = '/api/music-hub/audio?id=' + encodeURIComponent(id);
      audio.load();
    }
    const token = generation;
    position(button, value);
    button.classList.add('row-preview-playing');
    seek(value, true);
    message(button, 'Loading independent song preview');
    try {
      await audio.play();
      if (generation === token) {
        if (userGesture) previewUnlocked = true;
        message(button, 'Song preview playing; drag or click waveform to seek');
      }
    } catch (error) {
      if (generation !== token) return;
      clearActive();
      if (error?.name === 'NotAllowedError') previewUnlocked = false;
      const reason = error?.name === 'NotAllowedError' ? 'Click waveform once to enable hover previews' : 'Local audio unavailable for this song';
      message(button, reason);
    }
  }
  audio.addEventListener('loadedmetadata', () => { if (requestedFraction !== null) seek(requestedFraction, true); });
  audio.addEventListener('error', () => {
    if (!active) return;
    clearActive();
    message(document.querySelector(`#scroller .track-row[data-id="${active}"] .row-wave-button`), 'Local audio could not be loaded');
  });
  audio.addEventListener('ended', () => { clearActive(); status.textContent = 'Song preview ended'; });
  audio.addEventListener('pause', () => { clearActive(); });

  // Capture the native markers click before the app's bubble listener. Other row actions remain intact.
  document.addEventListener('click', event => {
    const button = waveButton(event.target);
    if (!button) return;
    if (event.shiftKey) return; // Retain the existing cue/marker editor shortcut.
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.rowPreviewSuppressClick === '1') {
      delete button.dataset.rowPreviewSuppressClick;
      return;
    }
    const value = button.dataset.rowPreviewLast ? Number(button.dataset.rowPreviewLast) : 0;
    if (active === trackId(button) && !audio.paused) stop();
    else if (!dragging) play(button, value, true);
    describe(button);
  }, true);
  document.addEventListener('pointermove', event => {
    const button = dragging?.button || waveButton(event.target);
    if (!button) return;
    if (dragging && event.pointerId !== dragging.pointerId) return;
    const value = fraction(button, event.clientX);
    button.dataset.rowPreviewLast = String(value);
    position(button, value);
    describe(button);
    if (dragging) {
      dragging.moved ||= Math.abs(event.clientX - dragging.startX) > 3;
      if (dragging.moved && dragging.wasPlaying && !dragging.restarted) {
        dragging.restarted = true;
        play(button, value, true);
      }
      seek(value);
    } else if (previewUnlocked && active === trackId(button) && !audio.paused) {
      // After the first intentional click unlocks audio, moving the white
      // hover line through this already-playing preview auditions that point.
      seek(value);
    }
  }, true);
  document.addEventListener('pointerdown', event => {
    const button = waveButton(event.target);
    if (!button || event.button !== 0) return;
    const wasPlaying = active === trackId(button) && !audio.paused;
    dragging = {button, pointerId:event.pointerId, startX:event.clientX, moved:false, wasPlaying, restarted:false};
    cancelHover();
    button.dataset.rowPreviewLast = String(fraction(button, event.clientX));
    position(button, Number(button.dataset.rowPreviewLast));
    describe(button);
    // Start in the trusted pointer gesture so audio can be heard throughout scrubbing.
    if (!wasPlaying) play(button, Number(button.dataset.rowPreviewLast), true);
    button.dataset.rowPreviewSuppressClick = '1';
    // Keep the row's native draggable behavior for gestures begun outside the waveform.
    event.stopPropagation();
  }, true);
  document.addEventListener('pointerup', event => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const {button, moved, wasPlaying} = dragging;
    const value = fraction(button, event.clientX);
    dragging = null;
    if (wasPlaying && !moved) stop();
    else seek(value, true);
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
    }
    // Some touch interactions generate no click; let a later intentional click through.
    setTimeout(() => { if (button.dataset.rowPreviewSuppressClick === '1') delete button.dataset.rowPreviewSuppressClick; }, 250);
  }, true);
  document.addEventListener('pointercancel', event => {
    if (dragging && event.pointerId === dragging.pointerId) {
      const wasPlaying = dragging.wasPlaying;
      dragging = null;
      if (!wasPlaying) stop();
    }
  }, true);
  document.addEventListener('dragstart', event => {
    if (waveButton(event.target) || (dragging && dragging.button.contains(event.target))) event.preventDefault();
  }, true);
  document.addEventListener('pointerout', event => {
    const button = waveButton(event.target);
    if (button && !button.contains(event.relatedTarget) && dragging?.button !== button) {
      button.classList.remove('row-preview-hover');
      if (hoveredButton === button) { hoveredButton = null; cancelHover(); }
    }
  }, true);
  document.addEventListener('pointerover', event => {
    const button = waveButton(event.target);
    if (!button || button.contains(event.relatedTarget) || dragging) return;
    hoveredButton = button;
    describe(button);
    cancelHover();
    // Browsers require an initial gesture. Later previews switch tracks only after a stable hover.
    if (!previewUnlocked) {
      message(button, 'Click waveform once to enable hover previews');
      return;
    }
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (hoveredButton === button && button.isConnected && !dragging) {
        play(button, Number(button.dataset.rowPreviewLast || 0));
      }
    }, 250);
  }, true);
  document.addEventListener('focusin', event => {
    const button = waveButton(event.target);
    if (button) describe(button);
  }, true);
  document.addEventListener('keydown', event => {
    const button = waveButton(event.target);
    if (event.key === 'Escape' && active !== null && !event.defaultPrevented &&
        !(event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) {
      stop();
      event.preventDefault();
      return;
    }
    if (!button) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();event.stopPropagation();
      const next = Math.max(0,Math.min(1, Number(button.dataset.rowPreviewLast || 0) + (event.key === 'ArrowRight' ? .05 : -.05)));
      button.dataset.rowPreviewLast = String(next);
      position(button, next);
      if (active === trackId(button)) seek(next, true);
    }
  }, true);
  window.addEventListener('pagehide', stop);
  window.MusicHubRowWavePreview = {stop, get audio() {return audio;}};
})();
