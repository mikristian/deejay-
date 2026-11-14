/* Music Hub connection preferences. Uses the existing read-only library API
 * and the opt-in, bearer-token paired mobile bridge. No Rekordbox database writes. */
(() => {
  'use strict';
  const SESSION_URL = 'music-hub-desktop-remote-session-url-v1';
  const SESSION_TOKEN = 'music-hub-desktop-remote-session-token-v1';
  const $ = (root, selector) => root.querySelector(selector);

  function setStatus(element, text, tone = '') {
    if (!element) return;
    element.textContent = text;
    element.dataset.state = tone;
  }
  async function getJson(url) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Service returned ' + response.status);
    return response.json();
  }
  function savedValue(key) {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
  }
  function mount(container, options = {}) {
    if (!container) return;
    const count = Number(options.trackCount) || 0;
    container.innerHTML = `
      <section class="mh-connection-card" aria-labelledby="mh-rekordbox-heading">
        <div class="mh-connection-top"><span class="mh-connection-icon" aria-hidden="true">◉</span><div>
          <h3 id="mh-rekordbox-heading">Rekordbox on this Mac</h3>
          <p>Read your local collection, playlists and track analysis. Deck feedback requires a separate verified connection.</p>
        </div><span class="mh-connection-pill" id="mh-rekordbox-state" role="status">Checking…</span></div>
        <div class="mh-connection-stat"><strong id="mh-track-count">${count.toLocaleString()}</strong><span>tracks loaded in Music Hub</span></div>
        <p class="mh-connection-detail" id="mh-rekordbox-detail">Checking Music Hub service and Rekordbox feedback…</p>
        <div class="mh-connection-actions"><button type="button" id="mh-check-rekordbox">Check connection</button><button type="button" id="mh-refresh-rekordbox">Connect / rescan library</button><button type="button" id="mh-show-rekordbox-decks">Show deck monitor</button></div>
        <p class="mh-connection-help">Music Hub reads Rekordbox metadata locally. This connection does not sign in to an AlphaTheta account or prove that a hardware deck is playing.</p>
      </section>
      <section class="mh-connection-card" aria-labelledby="mh-phone-heading">
        <div class="mh-connection-top"><span class="mh-connection-icon" aria-hidden="true">▣</span><div>
          <h3 id="mh-phone-heading">iPhone companion</h3>
          <p>Pair your phone to browse music and control the laptop's local preview. Rekordbox hardware transport stays separate.</p>
        </div><span class="mh-connection-pill" id="mh-phone-state" role="status">Checking…</span></div>
        <div class="mh-connection-fields"><label for="mh-bridge-address">Phone bridge address
          <input id="mh-bridge-address" type="url" inputmode="url" placeholder="http://192.168.1.50:18770" autocomplete="off" spellcheck="false"></label>
        <label for="mh-pair-secret">Pairing token
          <input id="mh-pair-secret" type="password" minlength="32" placeholder="32+ character private pairing token" autocomplete="off" spellcheck="false"></label></div>
        <div class="mh-connection-actions"><button type="button" id="mh-phone-connect" class="mh-primary-connect">Pair iPhone</button><button type="button" id="mh-phone-disconnect">Disconnect</button><button type="button" id="mh-phone-use-local">Use this Mac's bridge</button></div>
        <p class="mh-connection-detail" id="mh-phone-detail" role="status">The phone bridge must be running. A successful pair enables only local laptop audio preview commands.</p>
        <div class="mh-phone-howto"><strong>Connect the iPhone web app</strong>
          <ol><li>Start the opt-in bridge with <code>python3 tools/start_music_hub_mobile.py --lan-ip YOUR_PRIVATE_IP</code> on this Mac, or use its configured private tunnel.</li>
          <li>Open the URL printed by the bridge on your iPhone, using the same trusted network. Enter the bridge pairing token in the phone app.</li>
          <li>Enter the bridge URL and token above and select Pair iPhone. The app only confirms a pair after an authenticated heartbeat succeeds.</li></ol>
          <a href="./mobile.html" target="_blank" rel="noopener noreferrer">Open companion preview on this computer ↗</a>
        </div>
      </section>`;

    const state = $(container, '#mh-rekordbox-state');
    const detail = $(container, '#mh-rekordbox-detail');
    const countLabel = $(container, '#mh-track-count');
    const bridge = $(container, '#mh-bridge-address');
    const secret = $(container, '#mh-pair-secret');
    const phoneState = $(container, '#mh-phone-state');
    const phoneDetail = $(container, '#mh-phone-detail');

    bridge.value = savedValue(SESSION_URL) || 'http://127.0.0.1:18770';
    secret.value = savedValue(SESSION_TOKEN);
    async function verify() {
      setStatus(state, 'Checking…');
      try {
        await getJson('/api/music-hub/state');
        const decks = await getJson('/api/music-hub/decks');
        const known = Number(options.getTrackCount?.() ?? count) || 0;
        countLabel.textContent = known.toLocaleString();
        setStatus(state, known ? 'Library available' : 'No tracks loaded', known ? 'ok' : 'warn');
        setStatus(detail, decks.connected === true && decks.verified === true
          ? 'Local library available. Live Rekordbox deck feedback is verified.'
          : 'Local Music Hub service available. Rekordbox deck feedback is not verified; no live playback claim is made.');
      } catch (error) {
        setStatus(state, 'Unavailable', 'error');
        setStatus(detail, 'Could not reach the Music Hub service: ' + (error?.message || 'Unknown error'));
      }
    }
    function showPhoneState(note) {
      const status = window.MusicHubDesktopRemote?.status?.() || { active: false };
      setStatus(phoneState, status.active ? 'Paired' : 'Not paired', status.active ? 'ok' : 'warn');
      setStatus(phoneDetail, note || (status.active
        ? 'Paired to ' + status.base + '. Local audio preview control is enabled; hardware Rekordbox playback remains unverified.'
        : 'Not paired. Start your private phone bridge and enter its URL and pairing token.'));
    }
    $(container, '#mh-check-rekordbox').addEventListener('click', verify);
    $(container, '#mh-refresh-rekordbox').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus(detail, 'Refreshing the locally imported Rekordbox collection…');
      try { await options.onRefreshLibrary?.(); await verify(); }
      catch (error) { setStatus(detail, 'Refresh failed: ' + String(error?.message || error)); }
      finally { button.disabled = false; }
    });
    $(container, '#mh-show-rekordbox-decks').addEventListener('click', () => options.onOpenDecks?.());
    $(container, '#mh-phone-connect').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus(phoneDetail, 'Attempting authenticated bridge pairing…');
      try {
        if (!window.MusicHubDesktopRemote?.connect) throw new Error('Desktop pairing controller unavailable');
        const paired = await window.MusicHubDesktopRemote.connect(bridge.value.trim(), secret.value);
        showPhoneState(paired ? undefined : 'Pairing failed. Check the address, private network, running bridge and token (32+ characters).');
      } catch (error) { showPhoneState('Unable to pair: ' + String(error?.message || error)); }
      finally { button.disabled = false; }
    });
    $(container, '#mh-phone-disconnect').addEventListener('click', () => {
      window.MusicHubDesktopRemote?.stop?.();
      secret.value = '';
      showPhoneState('Disconnected. No remote preview commands will be accepted.');
    });
    $(container, '#mh-phone-use-local').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const config = await getJson('/api/music-hub/local-remote/bootstrap');
        if (typeof config?.token !== 'string' || config.token.length < 32) throw new Error('Private token not provided');
        bridge.value = config.bridge;
        secret.value = config.token;
        setStatus(phoneDetail, 'This Mac has a configured bridge. The loopback address works on this laptop; the iPhone needs the bridge’s private Wi-Fi or tunnel URL. Select Pair iPhone to connect the desktop.');
      } catch { setStatus(phoneDetail, 'This Mac has no active local pairing configuration. Start the bridge using the instructions below.'); }
      finally { button.disabled = false; }
    });
    verify();
    showPhoneState();
  }
  window.MusicHubConnectionSettings = { mount };
})();
