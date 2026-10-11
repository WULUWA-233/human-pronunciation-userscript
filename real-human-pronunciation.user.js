// ==UserScript==
// @name         网页划词真人发音
// @namespace    local.word.pronunciation
// @version      0.3.0
// @description  在网页上划选英文单词后显示发音按钮，并通过 Wiktionary/Wikimedia 播放真人音频。
// @author       Li Tianyu (AI-assisted)
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @connect      en.wiktionary.org
// @connect      upload.wikimedia.org
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const PREFIX = '[真人发音]';
  const HOST_ID = 'real-human-pronunciation-host';
  const WIKTIONARY_API = 'https://en.wiktionary.org/w/api.php';
  const audioCache = new Map();

  let selectedWord = '';
  let requestId = 0;
  let audio = null;
  let objectUrl = '';
  let hideTimer = 0;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'all:initial',
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:2147483647',
    'display:none'
  ].join(';');

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      button {
        all: initial;
        box-sizing: border-box;
        width: 38px;
        height: 38px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(15, 23, 42, .14);
        border-radius: 19px;
        background: #fff;
        color: #0f172a;
        box-shadow: 0 8px 24px rgba(15, 23, 42, .22);
        cursor: pointer;
        font-family: Arial, sans-serif;
        font-size: 20px;
        line-height: 1;
        user-select: none;
        transition: transform .12s ease, box-shadow .12s ease;
      }
      button:hover {
        transform: translateY(-1px) scale(1.05);
        box-shadow: 0 10px 28px rgba(15, 23, 42, .28);
      }
      button:active { transform: scale(.96); }
      button[data-state="loading"] { cursor: progress; font-size: 16px; }
      button[data-state="error"] { background: #fff1f2; color: #be123c; }
      button[data-state="playing"] { background: #ecfdf5; color: #047857; }
      .tip {
        position: absolute;
        left: 50%;
        bottom: 45px;
        transform: translateX(-50%);
        max-width: 240px;
        padding: 6px 9px;
        border-radius: 7px;
        background: rgba(15, 23, 42, .94);
        color: #fff;
        font: 12px/1.35 Arial, sans-serif;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity .12s ease;
      }
      .tip[data-visible="true"] { opacity: 1; }
    </style>
    <div class="tip" role="status"></div>
    <button type="button" title="播放真人发音" aria-label="播放真人发音">🔊</button>
  `;

  const button = shadow.querySelector('button');
  const tip = shadow.querySelector('.tip');
  document.documentElement.appendChild(host);

  function normalizeWord(text) {
    const word = String(text || '')
      .trim()
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
      .replace(/[’]/g, "'");

    if (!word || word.length > 64) return '';
    if (!/^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(word)) return '';
    return word.toLowerCase();
  }

  function setState(state, message = '') {
    button.dataset.state = state;
    button.textContent = state === 'loading' ? '•••' : state === 'error' ? '!' : '🔊';
    tip.textContent = message;
    tip.dataset.visible = message ? 'true' : 'false';

    window.clearTimeout(hideTimer);
    if (message) {
      hideTimer = window.setTimeout(() => {
        tip.dataset.visible = 'false';
      }, state === 'error' ? 2600 : 1400);
    }
  }

  function hideButton() {
    requestId += 1;
    stopAudio();
    host.style.display = 'none';
    selectedWord = '';
    setState('idle');
  }

  function showButton(rect, word) {
    requestId += 1;
    stopAudio();
    selectedWord = word;
    setState('idle');
    host.style.display = 'block';

    const size = 38;
    const gap = 8;
    const left = Math.min(
      window.innerWidth - size - gap,
      Math.max(gap, rect.right + gap)
    );
    const preferredTop = rect.top - size - gap;
    const top = preferredTop >= gap
      ? preferredTop
      : Math.min(window.innerHeight - size - gap, rect.bottom + gap);

    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 12000,
        headers: { Accept: 'application/json' },
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`查询失败（HTTP ${response.status}）`));
            return;
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(new Error('发音数据格式异常'));
          }
        },
        ontimeout() { reject(new Error('查询超时')); },
        onerror() { reject(new Error('网络请求失败')); }
      });
    });
  }

  function normalizeAudioUrl(url) {
    try {
      const parsed = new URL(url, 'https://en.wiktionary.org');
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'upload.wikimedia.org'
          || parsed.port || parsed.username || parsed.password) return '';
      return parsed.href;
    } catch { return ''; }
  }

  function audioSourceScore(source) {
    const url = source.url.toLowerCase();
    const type = source.type.toLowerCase();
    let score = 0;
    if (type.includes('audio/mpeg') || url.endsWith('.mp3')) score += 10;
    if (/en-us|en_us|english-us/.test(url)) score += 30;
    if (/en-uk|en-gb|en_uk|en_gb|english-uk|english-gb/.test(url)) score += 20;
    return score;
  }

  async function findAudioUrl(word) {
    const cached = audioCache.get(word);
    if (cached && cached.expires > Date.now()) return cached.url;
    audioCache.delete(word);

    const params = new URLSearchParams({
      action: 'parse',
      page: word,
      prop: 'text',
      format: 'json',
      formatversion: '2',
      origin: '*'
    });
    const data = await requestJson(`${WIKTIONARY_API}?${params}`);
    const html = typeof data?.parse?.text === 'string'
      ? data.parse.text
      : data?.parse?.text?.['*'];

    if (!html) {
      rememberAudio(word, '');
      return '';
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const english = doc.querySelector('h2#English, h2 #English');
    if (!english) { rememberAudio(word, ''); return ''; }
    const heading = english.closest('h2');
    const start = heading.parentElement.matches('.mw-heading2') ? heading.parentElement : heading;
    const sources = [];
    // MediaWiki uses either bare h2 elements or .mw-heading2 wrappers.
    for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.matches('h2, .mw-heading2')) break;
      sources.push(...node.querySelectorAll('audio source'));
    }
    const candidates = sources
      .map(source => ({
        url: normalizeAudioUrl(source.getAttribute('src') || source.src),
        type: source.getAttribute('type') || ''
      }))
      .filter(source => source.url)
      .sort((a, b) => audioSourceScore(b) - audioSourceScore(a));

    const url = candidates[0]?.url || '';
    rememberAudio(word, url);
    return url;
  }

  function rememberAudio(word, url) {
    if (audioCache.size >= 128) audioCache.delete(audioCache.keys().next().value);
    audioCache.set(word, { url, expires: Date.now() + (url ? 21600000 : 60000) });
  }

  function requestAudioBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        responseType: 'blob',
        onload(response) {
          if (response.status >= 200 && response.status < 300 && response.response
              && (!response.finalUrl || normalizeAudioUrl(response.finalUrl))) {
            resolve(response.response);
          } else {
            reject(new Error(`音频加载失败（HTTP ${response.status}）`));
          }
        },
        ontimeout() { reject(new Error('音频加载超时')); },
        onerror() { reject(new Error('音频加载失败')); }
      });
    });
  }

  function stopAudio() {
    if (audio) {
      audio.pause();
      audio = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
  }

  async function playWord(word) {
    const id = ++requestId;
    stopAudio();
    setState('loading', `正在查找 ${word}`);

    try {
      const url = await findAudioUrl(word);
      if (id !== requestId) return;
      if (!url) throw new Error(`未收录 ${word} 的真人发音`);

      const blob = await requestAudioBlob(url);
      if (id !== requestId) return;

      stopAudio();
      objectUrl = URL.createObjectURL(blob);
      audio = new Audio(objectUrl);
      const player = audio;
      audio.volume = 1;
      audio.addEventListener('ended', () => {
        if (id !== requestId || audio !== player) return;
        setState('idle');
        stopAudio();
      }, { once: true });
      audio.addEventListener('error', () => {
        if (id !== requestId || audio !== player) return;
        setState('error', '音频播放失败');
        stopAudio();
      }, { once: true });

      await audio.play();
      if (id !== requestId || audio !== player) return;
      setState('playing', `正在播放 ${word}`);
    } catch (error) {
      if (id !== requestId) return;
      stopAudio();
      setState('error', error && error.message ? error.message : '发音查询失败');
    }
  }

  function inspectSelection() {
    const selection = window.getSelection();
    const word = normalizeWord(selection && selection.toString());
    if (!selection || selection.rangeCount === 0 || !word) {
      hideButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      hideButton();
      return;
    }

    showButton(rect, word);
  }

  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
  });

  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    if (selectedWord) playWord(selectedWord);
  });

  document.addEventListener('mouseup', event => {
    if (!event.isTrusted) return;
    if (event.composedPath().includes(host)) return;
    window.setTimeout(inspectSelection, 0);
  }, true);

  document.addEventListener('keyup', event => {
    if (!event.isTrusted) return;
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) {
      window.setTimeout(inspectSelection, 0);
    }
  }, true);

  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted) return;
    if (!event.composedPath().includes(host)) hideButton();
  }, true);

  window.addEventListener('scroll', hideButton, true);
  window.addEventListener('blur', hideButton);

  console.info(PREFIX, 'ready');
})();
