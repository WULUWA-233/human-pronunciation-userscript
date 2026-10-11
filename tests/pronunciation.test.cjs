const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const dom = new JSDOM('<p>hello</p>', { runScripts: 'outside-only', url: 'https://example.test' });
  const w = dom.window, requests = [], players = [], revoked = [];
  w.GM_xmlhttpRequest = args => requests.push(args);
  w.URL.createObjectURL = () => 'blob:test-' + players.length;
  w.URL.revokeObjectURL = value => revoked.push(value);
  w.Audio = class {
    constructor() { this.events = {}; this.playCount = 0; this.paused = false; players.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    play() { this.playCount++; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  let root;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { root = attach.call(this, options); return root; };
  const source = fs.readFileSync(path.join(__dirname, '../real-human-pronunciation.user.js'), 'utf8');
  w.eval(source.replace(/\}\)\(\);\s*$/, 'window.testAPI = {findAudioUrl, normalizeAudioUrl, normalizeWord, playWord, hideButton, showButton}; })();'));
  return { dom, w, requests, players, revoked, root };
}

test('English OGG is preferred over MP3 in another language; both MediaWiki heading layouts work', async () => {
  for (const heading of ['<h2><span id="English">English</span></h2>', '<div class="mw-heading mw-heading2"><h2 id="English">English</h2></div>']) {
    const { dom, w, requests } = setup();
    const pending = w.testAPI.findAudioUrl('hello');
    requests[0].onload({ status: 200, responseText: JSON.stringify({ parse: { text: heading +
      '<div><audio><source src="//upload.wikimedia.org/english.ogg" type="audio/ogg"></audio></div>' +
      '<h2 id="French">French</h2><div><audio><source src="//upload.wikimedia.org/french.mp3" type="audio/mpeg"></audio></div>' } }) });
    assert.equal(await pending, 'https://upload.wikimedia.org/english.ogg');
    dom.window.close();
  }
});

test('URL validation rejects lookalike hosts, insecure schemes and credentials', () => {
  const { dom, w } = setup();
  for (const url of ['https://upload.wikimedia.org.evil.test/a.mp3', 'https://evil.test/upload.wikimedia.org', 'http://upload.wikimedia.org/a.mp3', 'https://user@upload.wikimedia.org/a.mp3']) {
    assert.equal(w.testAPI.normalizeAudioUrl(url), '');
  }
  assert.equal(w.testAPI.normalizeWord('two words'), '');
  dom.window.close();
});

test('hiding the selection during lookup prevents stale audio playback', async () => {
  const { dom, w, requests, players } = setup();
  const pending = w.testAPI.playWord('hello');
  w.testAPI.hideButton();
  requests[0].onload({ status: 200, responseText: JSON.stringify({ parse: { text: '<h2 id="English">English</h2><div><audio><source src="//upload.wikimedia.org/a.ogg"></audio></div>' } }) });
  await pending;
  assert.equal(requests.length, 1);
  assert.equal(players.length, 0);
  dom.window.close();
});

test('old ended callbacks cannot stop a new player and hiding releases blob URLs', async () => {
  const { dom, w, requests, players, revoked } = setup();
  const finishLookup = index => requests[index].onload({ status: 200, responseText: JSON.stringify({ parse: { text: '<h2 id="English">English</h2><div><audio><source src="//upload.wikimedia.org/a.ogg"></audio></div>' } }) });
  const first = w.testAPI.playWord('hello');
  finishLookup(0); await tick();
  requests[1].onload({ status: 200, response: new w.Blob(['audio']) }); await first;
  const second = w.testAPI.playWord('world');
  finishLookup(2); await tick();
  requests[3].onload({ status: 200, response: new w.Blob(['audio']) }); await second;
  players[0].events.ended();
  assert.equal(players[1].paused, false);
  w.testAPI.hideButton();
  assert.equal(players[1].paused, true);
  assert.equal(revoked.length, 2);
  dom.window.close();
});

test('synthetic button clicks cannot trigger lookups', () => {
  const { dom, w, requests, root } = setup();
  w.testAPI.showButton({ right: 50, top: 50, bottom: 80 }, 'hello');
  root.querySelector('button').click();
  assert.equal(requests.length, 0);
  assert.equal(w.document.querySelector('#real-human-pronunciation-host').shadowRoot, null);
  dom.window.close();
});
