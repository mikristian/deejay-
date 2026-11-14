/* Independent, dependency-free studio contract tests. Run: node tests/test_music_hub_studio.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'music-hub/studio.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'music-hub/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'music-hub/studio.css'), 'utf8');
const host = {window: {}};
vm.runInNewContext(source, host, {filename: 'studio.js', timeout: 1000});
const studio = host.window.MusicHubStudio;
assert.ok(studio?.parseLyrics && studio.compatibleKey, 'studio exports pure lyric and harmonic functions');

const lrc = studio.parseLyrics('[ar:Example]\n[00:01.25]One line\n[00:05.40]Second line');
assert.equal(lrc.length, 2, 'LRC timestamps create two timed lyric lines');
assert.equal(lrc[0].time, 1.25);
assert.equal(lrc[1].text, 'Second line');
assert.equal(lrc[1].time, 5.4);
const enhanced = studio.parseLyrics('[00:02.00]<00:02.10>Good <00:02.50>night');
assert.equal(enhanced[0].text, 'Good night');
assert.equal(enhanced[0].words.length, 2, 'enhanced LRC exposes word timings');
assert.equal(enhanced[0].words[0].time, 2.1);
assert.equal(enhanced[0].words[1].text, 'night');
assert.equal(studio.parseLyrics('A plain unsynced lyric')[0].time, null);
assert.equal(studio.parseLyrics('[00:04.00]Later\n[00:01.00]Earlier')[0].text, 'Earlier', 'timed lines are sorted');

assert.equal(studio.compatibleKey('8A', '8A'), 'Same key');
assert.equal(studio.compatibleKey('8A', '8B'), 'Relative major/minor');
assert.equal(studio.compatibleKey('12A', '1A'), 'Adjacent Camelot');
assert.equal(studio.compatibleKey('4B', '9A'), '');

for(const name of ['lyrics', 'karaoke', 'harmonic', 'autoqueue', 'visuals']) {
  assert.ok(html.includes(`data-studio-open="${name}"`), `studio launcher exposes ${name}`);
}
assert.ok(source.includes("'STAGED PREVIEW" ) === false, 'studio does not re-label deck stage as live playback');
assert.ok(source.includes('playing===true&&t.verified===true'), 'automatic native deck follow requires confirmed playback');
assert.ok(source.includes("addEventListener('play',onLocalPreviewPlay)"), 'auto queue can follow actual local preview play events');
assert.ok(source.includes('Retry-After'), 'LRCLIB cooldown honors server limits');
assert.ok(source.includes("action:'lyrics.set'"), 'lyrics persistence uses app-owned action');
assert.ok(source.includes("source:'Music Hub cue preview'"), 'TouchDesigner cue reports a preview');
assert.ok(css.includes(':root[data-theme="dark"]'), 'default charcoal theme tokens exist');
assert.ok(css.includes('.studio-karaoke-view[data-effect="cathedral"]'), 'karaoke supports saved visual backdrop bindings');

console.log('Music Hub Studio: lyrics LRC/eLRC, Camelot rules, karaoke, auto queue, and visual cue contracts passed.');
