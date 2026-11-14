/* Space toggles a streamlined library workspace. Loaded audio stays untouched. */
(() => {
  'use strict';
  const initialize = () => {
    const shell = document.querySelector('.shell');
    const main = shell?.querySelector(':scope > .main');
    if (!shell || !main || document.getElementById('library-focus-exit')) return;

    const exit = document.createElement('button');
    exit.id = 'library-focus-exit';
    exit.type = 'button';
    exit.textContent = '▤ Full decks  ·  Space';
    exit.setAttribute('aria-label', 'Leave library focus mode and restore full deck controls');
    exit.title = 'Leave song browser focus mode (Space or Escape)';
    exit.hidden = true;
    main.insertBefore(exit, main.firstChild);

    // Persistent visible entry point: after a native reload the focused widget
    // can be a button or search field, where Space rightly belongs to that widget.
    // In the native Music Hub, the legacy .topbar is intentionally hidden;
    // place the visible Browse button beside Rows / Cards / Dense / Mini.
    const controls = main.querySelector('.work-area .section-heading .layout-toggle') ||
      main.querySelector('.work-area .section-heading') || main.querySelector('.topbar .toolbar-actions') || main.querySelector('.topbar');
    const toggle = document.createElement('button');
    toggle.id = 'library-focus-toggle';
    toggle.type = 'button';
    toggle.className = 'toolbar-chip';
    toggle.textContent = '▤ Browse';
    toggle.title = 'Toggle compact music browser (Space when outside controls)';
    toggle.setAttribute('aria-keyshortcuts', 'Space');
    toggle.setAttribute('aria-pressed', 'false');
    controls?.append(toggle);

    let priorDensity = null;
    let restoreScrollFrame = 0;
    const densities = {list:'list-mode',compact:'compact-mode',micro:'micro-mode',gallery:'grid-mode',square:'square-mode'};
    const mode = (enabled) => {
      const scroller = document.getElementById('scroller');
      const scrollFraction = scroller ? scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight) : 0;
      if (enabled) {
        priorDensity = document.getElementById('scroller')?.dataset.density || 'list';
        // Use the app's own virtualization-aware density setting.
        document.getElementById('micro-mode')?.click();
      } else if (priorDensity) {
        const currentDensity = document.getElementById('scroller')?.dataset.density;
        if (currentDensity === 'micro') document.getElementById(densities[priorDensity])?.click();
        priorDensity = null;
      }
      shell.classList.toggle('library-focus-mode', enabled);
      exit.hidden = !enabled;
      exit.setAttribute('aria-expanded', String(enabled));
      toggle.textContent = enabled ? '▣ Full decks' : '▤ Browse';
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.setAttribute('aria-label', enabled ? 'Exit compact browser and show full decks' : 'Enter compact library browser');
      document.dispatchEvent(new CustomEvent('music-hub:library-focus', {detail:{enabled}}));
      // A resizing virtual list can change visible row count without scrolling.
      window.dispatchEvent(new Event('resize'));
      if (restoreScrollFrame) cancelAnimationFrame(restoreScrollFrame);
      restoreScrollFrame = requestAnimationFrame(() => {
        restoreScrollFrame = 0;
        if (!scroller?.isConnected) return;
        scroller.scrollTop = scrollFraction * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.dispatchEvent(new Event('scroll'));
      });
    };
    exit.addEventListener('click', () => mode(false));
    toggle.addEventListener('click', () => mode(!shell.classList.contains('library-focus-mode')));

    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== ' ' && event.key !== 'Spacebar' && event.code !== 'Space' && event.key !== 'Escape') return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Native keyboard behavior inside interactive widgets must take priority.
      if (target.closest('input, textarea, select, button, [contenteditable], [role="textbox"], [role="button"], [role="slider"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="menuitem"], a, summary, dialog[open], [aria-modal="true"]')) return;
      if (document.querySelector('dialog[open], .detail-drawer:not([hidden])')) return;
      if (event.key === 'Escape') {
        if (shell.classList.contains('library-focus-mode')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          mode(false);
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation(); // app.js uses Space for local preview.
      mode(!shell.classList.contains('library-focus-mode'));
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, {once:true});
  else initialize();
})();
