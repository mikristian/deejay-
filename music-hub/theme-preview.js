/* Music Hub appearance studio. Palette-cover model follows EXO's
 * src/core/studioThemePaletteCover20261028.js: render actual chrome colors. */
(function (global) {
  'use strict';

  const THEMES = Object.freeze([
    { id: 'dark', name: 'Dark', detail: 'Low glare', paper: '#17151e', side: '#1c1923', panel: '#27222f', ink: '#ede7f0', muted: '#a99eaf', border: '#36303f', defaultAccent: '#d08ce8' },
    { id: 'light', name: 'Light', detail: 'Clean studio', paper: '#fcfafd', side: '#f5f2f7', panel: '#f8f5fa', ink: '#332c39', muted: '#948b9d', border: '#e9e4ed', defaultAccent: '#a83bc1' },
    { id: 'glass-dark', name: 'Glass Dark', detail: 'Translucent midnight', paper: '#101b28', side: '#122235', panel: '#1b3146', ink: '#eff7ff', muted: '#a4b7cb', border: '#53718d', defaultAccent: '#8dd6ff' },
    { id: 'glass-light', name: 'Glass Light', detail: 'Frosted daylight', paper: '#e6eff7', side: '#eaf5ff', panel: '#e3f0fb', ink: '#203347', muted: '#60788f', border: '#8aaac6', defaultAccent: '#287dae' },
  ]);
  // Existing Music Hub IDs are retained. New IDs are curated EXO-style options;
  // integration must extend app.js accentColors with their hex values.
  const ACCENTS = Object.freeze([
    { id: 'default', name: 'Original', color: null, group: 'Original' },
    { id: 'violet', name: 'Violet', color: '#bb86ea', group: 'Signature' },
    { id: 'blue', name: 'Electric Blue', color: '#50b8ed', group: 'Signature' },
    { id: 'mint', name: 'Sea Mint', color: '#4fb8a3', group: 'Signature' },
    { id: 'coral', name: 'Coral', color: '#ee9b79', group: 'Signature' },
    { id: 'lavender', name: 'Lavender', color: '#c4a2fa', group: 'Spectrum' },
    { id: 'sapphire', name: 'Sapphire', color: '#7a9cf8', group: 'Spectrum' },
    { id: 'cyan', name: 'Cyan', color: '#5fcbdf', group: 'Spectrum' },
    { id: 'teal', name: 'Deep Teal', color: '#50b5ac', group: 'Spectrum' },
    { id: 'emerald', name: 'Emerald', color: '#64bc85', group: 'Spectrum' },
    { id: 'lime', name: 'Lime', color: '#a8c967', group: 'Spectrum' },
    { id: 'amber', name: 'Amber', color: '#dda552', group: 'Spectrum' },
    { id: 'copper', name: 'Copper', color: '#c58b62', group: 'Spectrum' },
    { id: 'rose', name: 'Rose', color: '#dc8ca6', group: 'Spectrum' },
    { id: 'magenta', name: 'Magenta', color: '#d778c8', group: 'Spectrum' },
    { id: 'silver', name: 'Silver', color: '#abb6c5', group: 'Neutral' },
    { id: 'sand', name: 'Sand', color: '#c6ae88', group: 'Neutral' },
    { id: 'graphite', name: 'Graphite', color: '#85919e', group: 'Neutral' },
  ]);
  const themeById = new Map(THEMES.map((theme) => [theme.id, theme]));
  const accentById = new Map(ACCENTS.map((accent) => [accent.id, accent]));
  const clampBlur = (value) => Math.max(0, Math.min(40, Math.round((Number(value) || 0) / 4) * 4));
  const hexToRgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const rgbToHex = (channels) => '#' + channels.map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, fraction) => rgbToHex(hexToRgb(a).map((n, i) => n * (1 - fraction) + hexToRgb(b)[i] * fraction));
  const luminance = (hex) => hexToRgb(hex).map((v) => {
    const channel = v / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  function visibleAccent(hex, panel) {
    const towards = luminance(panel) > .179 ? '#101820' : '#ffffff';
    let current = hex;
    for (let i = 0; i < 30 && contrast(current, panel) < 4.5; i += 1) current = mix(current, towards, .12);
    return current;
  }
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let mountCount = 0;

  function paletteFor(themeId, accentId) {
    const surface = themeById.get(themeId) || THEMES[0];
    const accent = accentById.get(accentId) || ACCENTS[0];
    const rawAccent = accent.color || surface.defaultAccent;
    return { ...surface, accent: rawAccent, readableAccent: visibleAccent(rawAccent, surface.panel) };
  }

  function mount(container, options = {}) {
    if (!(container instanceof global.HTMLElement)) throw new TypeError('MusicHubThemePreview.mount requires an HTML element');
    if (typeof container.__musicHubThemeCleanup === 'function') container.__musicHubThemeCleanup();
    let state = {
      theme: themeById.has(options.theme) ? options.theme : 'dark',
      accent: accentById.has(options.accent) ? options.accent : 'default',
      blur: clampBlur(options.blur === undefined ? 24 : options.blur),
    };
    const id = `mh-theme-preview-${++mountCount}`;
    const selected = (value, current) => value === current ? ' is-selected' : '';

    container.innerHTML = `
      <section class="mh-theme-studio" aria-label="Music Hub appearance settings">
        <div class="mh-theme-heading"><div><span class="mh-theme-kicker">APPEARANCE STUDIO</span><h3>Make Music Hub yours</h3><p>Preview the full DJ workspace before choosing a look.</p></div><span class="mh-theme-count">4 surfaces · ${ACCENTS.length} accents</span></div>
        <div class="mh-theme-stage" id="${id}-stage" aria-label="Live Music Hub appearance preview">
          <div class="mh-theme-stage-top"><span class="mh-theme-window-dots" aria-hidden="true"><i></i><i></i><i></i></span><strong>LIVE PREVIEW</strong><span data-mh-theme-name>Dark · Original</span></div>
          <div class="mh-theme-mini-app"><div class="mh-theme-mini-rail"><span class="mh-theme-mini-logo">◈</span><span class="mh-theme-mini-rail-item is-active">⌂</span><span class="mh-theme-mini-rail-item">♫</span><span class="mh-theme-mini-rail-item">☷</span></div><div class="mh-theme-mini-body"><div class="mh-theme-mini-toolbar"><span>YOUR LIBRARY</span><span class="mh-theme-mini-search">⌕ &nbsp; Search tracks</span></div><div class="mh-theme-mini-title">Tonight's collection<span>.</span></div><div class="mh-theme-mini-tracks"><div class="mh-theme-mini-track"><span class="mh-theme-mini-art">♫</span><div><strong>Midnight Drive</strong><small>Session playlist · 124 BPM</small></div><span class="mh-theme-mini-key">8A</span></div><div class="mh-theme-mini-track"><span class="mh-theme-mini-art secondary">◈</span><div><strong>After Hours</strong><small>Music Hub · 128 BPM</small></div><span class="mh-theme-mini-key">9A</span></div></div><div class="mh-theme-mini-player"><span class="mh-theme-mini-play">▶</span><span>Local preview</span><span class="mh-theme-mini-meter"><i></i></span><span>03:42</span></div></div></div>
          <div class="mh-theme-stage-footer"><span>Sidebar</span><span>Panel</span><span>Accent</span><span>Text</span><span>Border</span></div><div class="mh-theme-surface-strips" aria-hidden="true"><i data-mh-color="side"></i><i data-mh-color="panel"></i><i data-mh-color="accent"></i><i data-mh-color="ink"></i><i data-mh-color="border"></i></div>
        </div>
        <div class="mh-theme-section-heading"><div><strong>Interface style</strong><span>Choose a surface</span></div></div>
        <div class="mh-theme-surface-grid" role="group" aria-label="Interface theme">${THEMES.map((theme) => `<button type="button" class="mh-theme-surface${selected(theme.id, state.theme)}" data-mh-theme="${theme.id}" aria-pressed="${theme.id === state.theme}" aria-label="${escapeHtml(theme.name)} theme"><span class="mh-theme-surface-scene" style="--sample-paper:${theme.paper};--sample-side:${theme.side};--sample-panel:${theme.panel};--sample-accent:${theme.defaultAccent};--sample-border:${theme.border}"><i></i><b><em></em><em></em><em></em></b></span><span class="mh-theme-surface-name">${escapeHtml(theme.name)}</span><small>${escapeHtml(theme.detail)}</small></button>`).join('')}</div>
        <div class="mh-theme-section-heading"><div><strong>Accent library</strong><span>Curated colors inspired by EXO Studio</span></div><span data-mh-accent-name></span></div>
        <div class="mh-theme-accent-grid" role="group" aria-label="Accent color">${ACCENTS.map((accent) => `<button type="button" class="mh-theme-accent${selected(accent.id, state.accent)}" data-mh-accent="${accent.id}" aria-pressed="${accent.id === state.accent}" title="${escapeHtml(accent.name)}" aria-label="${escapeHtml(accent.name)} accent"><span class="mh-theme-accent-dot"${accent.color ? ` style="--sample-accent:${accent.color}"` : ''}></span><span>${escapeHtml(accent.name)}</span></button>`).join('')}</div>
        <div class="mh-theme-blur"><label for="${id}-blur"><strong>Glass blur</strong><small>Adjust backdrop softness on glass themes</small></label><input id="${id}-blur" data-mh-blur type="range" min="0" max="40" step="4" value="${state.blur}" aria-label="Glass blur in pixels"><output for="${id}-blur" data-mh-blur-label>${state.blur}px</output></div>
      </section>`;

    const root = container.querySelector('.mh-theme-studio');
    const stage = root.querySelector('.mh-theme-stage');
    const blur = root.querySelector('[data-mh-blur]');
    function paint() {
      const palette = paletteFor(state.theme, state.accent);
      stage.style.setProperty('--mh-preview-paper', palette.paper);
      stage.style.setProperty('--mh-preview-side', palette.side);
      stage.style.setProperty('--mh-preview-panel', palette.panel);
      stage.style.setProperty('--mh-preview-ink', palette.ink);
      stage.style.setProperty('--mh-preview-muted', palette.muted);
      stage.style.setProperty('--mh-preview-border', palette.border);
      stage.style.setProperty('--mh-preview-accent', palette.accent);
      stage.style.setProperty('--mh-preview-accent-ink', palette.readableAccent);
      stage.style.setProperty('--mh-preview-accent-soft', mix(palette.accent, palette.panel, .8));
      stage.style.setProperty('--mh-preview-blur', `${state.blur}px`);
      stage.dataset.mhGlass = String(state.theme.startsWith('glass'));
      stage.dataset.mhLight = String(state.theme.endsWith('light'));
      root.querySelector('[data-mh-theme-name]').textContent = `${palette.name} · ${(accentById.get(state.accent) || ACCENTS[0]).name}`;
      root.querySelector('[data-mh-accent-name]').textContent = accentById.get(state.accent).name;
      root.querySelector('[data-mh-blur-label]').textContent = `${state.blur}px`;
      blur.value = String(state.blur);
      blur.disabled = !state.theme.startsWith('glass');
      root.querySelectorAll('[data-mh-theme]').forEach((button) => {
        const active = button.dataset.mhTheme === state.theme;
        button.classList.toggle('is-selected', active);
        button.setAttribute('aria-pressed', String(active));
      });
      root.querySelectorAll('[data-mh-accent]').forEach((button) => {
        const active = button.dataset.mhAccent === state.accent;
        button.classList.toggle('is-selected', active);
        button.setAttribute('aria-pressed', String(active));
      });
      root.querySelectorAll('[data-mh-color]').forEach((element) => {
        const role = element.dataset.mhColor;
        element.style.background = palette[role];
      });
    }
    function handleClick(event) {
      const themeButton = event.target.closest('[data-mh-theme]');
      if (themeButton && root.contains(themeButton)) {
        const next = themeButton.dataset.mhTheme;
        if (next !== state.theme && themeById.has(next)) {
          state.theme = next;
          paint();
          if (typeof options.onTheme === 'function') options.onTheme(next);
        }
        return;
      }
      const accentButton = event.target.closest('[data-mh-accent]');
      if (accentButton && root.contains(accentButton)) {
        const next = accentButton.dataset.mhAccent;
        if (next !== state.accent && accentById.has(next)) {
          state.accent = next;
          paint();
          if (typeof options.onAccent === 'function') options.onAccent(next);
        }
      }
    }
    function handleInput(event) {
      if (event.target !== blur) return;
      const next = clampBlur(blur.value);
      if (next !== state.blur) {
        state.blur = next;
        paint();
        if (typeof options.onBlur === 'function') options.onBlur(next);
      }
    }
    root.addEventListener('click', handleClick);
    root.addEventListener('input', handleInput);
    const cleanup = () => {
      root.removeEventListener('click', handleClick);
      root.removeEventListener('input', handleInput);
      if (container.__musicHubThemeCleanup === cleanup) delete container.__musicHubThemeCleanup;
    };
    container.__musicHubThemeCleanup = cleanup;
    paint();
    return {
      update(next = {}) {
        if (Object.prototype.hasOwnProperty.call(next, 'theme') && themeById.has(next.theme)) state.theme = next.theme;
        if (Object.prototype.hasOwnProperty.call(next, 'accent') && accentById.has(next.accent)) state.accent = next.accent;
        if (Object.prototype.hasOwnProperty.call(next, 'blur')) state.blur = clampBlur(next.blur);
        paint();
      },
      destroy() { cleanup(); if (container.contains(root)) root.remove(); },
      getState() { return { ...state }; },
    };
  }

  global.MusicHubThemePreview = Object.freeze({ mount, themes: THEMES, accents: ACCENTS, paletteFor });
})(window);
