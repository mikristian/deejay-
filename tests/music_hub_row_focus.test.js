/* Browser-script behavior under a tiny fake DOM; no live Rekordbox/audio writes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'music-hub');
function classes() {
  const values = new Set();
  return {
    add: key => values.add(key), remove: key => values.delete(key),
    contains: key => values.has(key),
    toggle(key, force) {
      const next = force === undefined ? !values.has(key) : Boolean(force);
      if (next) values.add(key); else values.delete(key);
      return next;
    }
  };
}

test('row waveform click/drag and subsequent hover audition use their own audio player', async () => {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let time = 100;
  let deckPauseCount = 0;
  class Element {
    constructor() {
      this.style = {setProperty(key, val) {this[key] = val;}};
      this.classList = classes();
      this.dataset = {};
      this.isConnected = true;
      this.attrs = {};
    }
    setAttribute(key, value) {this.attrs[key] = value;}
    contains(target) {return this === target;}
    getBoundingClientRect() {return {left: 0, width: 100};}
    closest() {return null;}
  }
  const rows = ["101", "202"].map(id => {
    const row = new Element();
    row.dataset.id = id;
    const button = new Element();
    button.closest = selector => selector === '.track-row[data-id]' ? row : null;
    const canvas = new Element();
    canvas.closest = selector => selector === '#scroller .row-wave-button' ? button : null;
    button.contains = child => child === canvas || child === button;
    return {id, row, button, canvas};
  });
  class Audio {
    constructor() {
      this.paused = true;
      this.currentTime = 0;
      this.duration = 120;
      this.events = {};
      this.playCount = 0;
      Audio.instances.push(this);
    }
    setAttribute() {}
    removeAttribute(k) {if (k === 'src') this.src = '';}
    addEventListener(k, cb) {this.events[k] = cb;}
    pause() {this.paused = true;this.events.pause?.();}
    load() {this.loadCount = (this.loadCount || 0) + 1;}
    play() {this.paused = false;this.playCount++;return Promise.resolve();}
  }
  Audio.instances = [];
  const status = new Element();
  status.className = '';
  const document = {
    readyState:'complete',
    body:{appendChild(el) {el.isConnected = true;}},
    createElement:() => status,
    addEventListener(name, fn) {if (!listeners.has(name)) listeners.set(name, []);listeners.get(name).push(fn);},
    querySelectorAll(selector) {return selector.includes('row-preview-playing') ? rows.map(x => x.button).filter(x => x.classList.contains('row-preview-playing')) : [];},
    querySelector(selector) {const id = selector.match(/data-id="(\d+)"/)?.[1];return rows.find(x => x.id === id)?.button || null;}
  };
  const window = {addEventListener(){}, previewDeck: {pause:() => {deckPauseCount++;}}};
  const sandbox = {Element, Audio, document, window, performance:{now:() => time},
    setTimeout(fn) {const id = ++nextTimer;timers.set(id, fn);return id;},
    clearTimeout(id) {timers.delete(id);}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'row-wave-preview.js'),'utf8'), sandbox);
  const send = (name, values) => {
    const event = {button:0,pointerId:11,target:rows[0].canvas,clientX:20,
      preventDefault(){this.prevented = true;},stopPropagation(){this.stopped = true;},...values};
    for (const fn of listeners.get(name) || []) fn(event);
    return event;
  };
  send('pointerdown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Audio.instances.length, 1);
  const audio = Audio.instances[0];
  assert.equal(audio.src, '/api/music-hub/audio?id=101');
  assert.equal(audio.paused, false, 'audio begins with the initial trusted pointer press');
  assert.equal(audio.currentTime, 24);
  time += 90;
  send('pointermove', {clientX:65});
  assert.equal(audio.currentTime, 78, 'dragging changes audition position while playing');
  send('pointerup', {clientX:65});
  time += 100;
  send('pointermove', {clientX:85});
  assert.equal(audio.currentTime, 102, 'after gesture unlock, moving the hover line auditions the new position');
  assert.equal(deckPauseCount, 0, 'row preview does not pause or touch either deck');
  assert.equal(rows[0].button.style['--row-preview-x'], '85.000%');
  const click = send('click', {target:rows[0].canvas});
  assert(click.stopped, 'row waveform click cannot open cue-marker dialog');
  // One gesture unlocks the browser's audio policy. Hover another row for
  // 250 ms and it auditions that song without clicking or stopping a deck.
  send('pointerover', {target:rows[1].canvas, relatedTarget:null});
  for (const [id, fn] of [...timers]) {timers.delete(id);fn();}
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.src, '/api/music-hub/audio?id=202');
  assert.equal(audio.paused, false);
  assert.equal(Audio.instances.length, 1, 'same independent preview player is reused');
  assert.equal(deckPauseCount, 0);
  assert(rows[1].button.classList.contains('row-preview-playing'));
  window.MusicHubRowWavePreview.stop();
  assert.equal(audio.paused, true);
});

test('Space switches to dense browse, keeps deck targets, and restores the previous view', () => {
  const listeners = {};
  class Element {
    constructor() {this.classList = classes();this.attrs = {};this.hidden = false;}
    setAttribute(key, value) {this.attrs[key] = value;}
    addEventListener(key, fn) {listeners['exit-' + key] = fn;}
    closest() {return null;}
  }
  const shell = new Element();
  const main = new Element();
  const toolbar = {append(button) {assert.equal(button, toggle);}};
  const scroller = {dataset:{density:'list'},scrollTop:100,scrollHeight:600,
    clientHeight:200,isConnected:true,dispatchEvent(){}};
  const exit = new Element();
  const toggle = new Element();
  shell.querySelector = () => main;
  main.insertBefore = button => {assert.equal(button, exit);};
  main.querySelector = () => toolbar;
  const ids = {
    scroller,
    'micro-mode':{click() {scroller.dataset.density = 'micro';}},
    'list-mode':{click() {scroller.dataset.density = 'list';}}
  };
  const document = {
    readyState:'complete',
    querySelector(selector) {return selector === '.shell' ? shell : null;},
    getElementById(id) {return id === 'library-focus-exit' ? undefined : ids[id];},
    createElement() {return this.created++ ? toggle : exit;},
    created:0,
    addEventListener(key, fn) {listeners[key] = fn;},
    dispatchEvent() {}
  };
  const window = {dispatchEvent() {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'library-focus.js'),'utf8'),
    {document,window,Element,CustomEvent:class {},Event:class {},
     requestAnimationFrame(fn) {fn();return 1;},cancelAnimationFrame() {}});
  const keydown = (key, target = new Element(), changes = {}) => {
    const event = {key,code:key === ' ' ? 'Space' : key,target,repeat:false,
      preventDefault(){this.prevented = true;},
      stopImmediatePropagation(){this.stopped = true;},...changes};
    listeners.keydown(event);
    return event;
  };
  const input = new Element();
  input.closest = () => input;
  assert.equal(keydown(' ', input).prevented, undefined, 'typing retains native Space');
  assert.equal(shell.classList.contains('library-focus-mode'), false);
  assert(keydown(' ').prevented);
  assert(shell.classList.contains('library-focus-mode'));
  assert.equal(scroller.dataset.density, 'micro', 'uses the app native dense virtual-scroller mode');
  assert.equal(exit.hidden, false);
  assert.equal(keydown(' ', input).prevented, undefined, 'a focused input cannot switch back');
  keydown(' ');
  assert.equal(shell.classList.contains('library-focus-mode'), false);
  assert.equal(scroller.dataset.density, 'list', 'prior row style is restored');
  keydown(' ');
  assert(shell.classList.contains('library-focus-mode'));
  keydown('Escape');
  assert.equal(shell.classList.contains('library-focus-mode'), false);
  assert.equal(keydown(' ', new Element(), {metaKey:true}).prevented, undefined);
});
