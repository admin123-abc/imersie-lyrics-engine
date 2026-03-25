// -- NetworkHijacker.js ----------------------------------------------------------
// Intercepts Netease Cloud Music network traffic to extract lyric payloads and
// audio CDN URLs.
//
// Architecture:
//   This module proxies both window.fetch and XMLHttpRequest at the earliest
//   possible moment. It is the sole owner of network data ingestion. Parsed
//   lyric lines are published through a subscriber model so SyncController
//   can register interest. Audio CDN URLs are dispatched to AudioEngine which
//   creates a silent mirror <audio> element for frequency analysis.
//
// Netease lyric API contract (as of 2024):
//   Endpoint pattern : /api/song/lyric  (v1) | /eapi/lyric  (eapi)
//   Response shape   : { lrc: { lyric: "[00:01.23]text\n..." }, tlyric: {...} }
//
// Netease audio CDN:
//   Audio is served from *.music.126.net with 206 Partial Content responses.

import Logger from '../utils/Logger.js';

const log = new Logger('NetworkHijacker');

const LYRIC_URL_RE = /\/(?:api|eapi)\/(?:song\/)?lyric/i;
const AUDIO_URL_RE = /\.music\.126\.net\//i;

const LRC_LINE_RE  = /(\[(?:\d+:\d{2}[.:]\d{2,3})\])+([^\[]*)/g;
const TIMECODE_RE  = /\[(\d+):(\d{2})[.:](\d{2,3})\]/;

function timecodeToMs(tag) {
  const m = TIMECODE_RE.exec(tag);
  if (!m) return NaN;
  const minutes = parseInt(m[1], 10);
  const seconds = parseInt(m[2], 10);
  const msStr  = m[3].length === 2 ? m[3] + '0' : m[3];
  const millis = parseInt(msStr, 10);
  return (minutes * 60 + seconds) * 1000 + millis;
}

function parseLRC(lrc) {
  if (!lrc || typeof lrc !== 'string') return [];
  const lines = [];
  let match;
  LRC_LINE_RE.lastIndex = 0;
  while ((match = LRC_LINE_RE.exec(lrc)) !== null) {
    const fullMatch = match[0];
    const text      = match[2].trim();
    const tagMatches = fullMatch.match(/\[\d+:\d{2}[.:]\d{2,3}\]/g) || [];
    for (const tag of tagMatches) {
      const time = timecodeToMs(tag);
      if (!isNaN(time)) {
        lines.push({ time, text });
      }
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function extractLyrics(json) {
  if (!json || typeof json !== 'object') return null;
  if (!json.lrc || typeof json.lrc.lyric !== 'string') return null;
  const main        = parseLRC(json.lrc.lyric);
  const translation = json.tlyric?.lyric ? parseLRC(json.tlyric.lyric) : [];
  log.debug(`Parsed ${main.length} main lines, ${translation.length} translation lines.`);
  return { main, translation };
}

// -- NetworkHijacker Class -------------------------------------------------------

export default class NetworkHijacker {
  constructor() {
    this._lyricSubscribers = new Set();
    this._audioSubscribers = new Set();
    this._installed        = false;
  }

  subscribeLyrics(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[NetworkHijacker] Lyric subscriber must be a function.');
    }
    this._lyricSubscribers.add(fn);
  }

  unsubscribeLyrics(fn) {
    this._lyricSubscribers.delete(fn);
  }

  subscribeAudio(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[NetworkHijacker] Audio subscriber must be a function.');
    }
    this._audioSubscribers.add(fn);
  }

  unsubscribeAudio(fn) {
    this._audioSubscribers.delete(fn);
  }

  install() {
    if (this._installed) {
      log.warn('install() called more than once — ignoring.');
      return;
    }
    this._installed = true;
    this._proxyFetch();
    this._proxyXHR();
    log.info('Network proxies installed.');
  }

  _dispatchLyrics(payload) {
    for (const fn of this._lyricSubscribers) {
      try {
        fn(payload);
      } catch (err) {
        log.error('Lyric subscriber threw an error:', err);
      }
    }
  }

  _dispatchAudio(url) {
    log.info('Audio URL captured:', url.substring(0, 80) + '...');
    for (const fn of this._audioSubscribers) {
      try {
        fn(url);
      } catch (err) {
        log.error('Audio subscriber threw an error:', err);
      }
    }
  }

  _proxyFetch() {
    const self          = this;
    const originalFetch = unsafeWindow.fetch.bind(unsafeWindow);

    unsafeWindow.fetch = async function (...args) {
      const response = await originalFetch(...args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');

      if (AUDIO_URL_RE.test(url)) {
        self._dispatchAudio(url);
        return response;
      }

      if (!LYRIC_URL_RE.test(url)) return response;

      try {
        const cloned = response.clone();
        const json   = await cloned.json();
        const lyrics = extractLyrics(json);
        if (lyrics) {
          log.info('Lyric payload captured via fetch.');
          self._dispatchLyrics(lyrics);
        }
      } catch (err) {
        log.warn('fetch lyric parse failed:', err);
      }

      return response;
    };
  }

  _proxyXHR() {
    const self        = this;
    const OriginalXHR = unsafeWindow.XMLHttpRequest;

    function ProxiedXHR() {
      const xhr       = new OriginalXHR();
      let requestUrl  = '';

      const originalOpen = xhr.open.bind(xhr);
      xhr.open = function (method, url, ...rest) {
        requestUrl = url;
        return originalOpen(method, url, ...rest);
      };

      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4) return;

        if (AUDIO_URL_RE.test(requestUrl)) {
          self._dispatchAudio(requestUrl);
          return;
        }

        if (!LYRIC_URL_RE.test(requestUrl)) return;

        try {
          const json   = JSON.parse(xhr.responseText);
          const lyrics = extractLyrics(json);
          if (lyrics) {
            log.info('Lyric payload captured via XHR.');
            self._dispatchLyrics(lyrics);
          }
        } catch (err) {
          log.warn('XHR lyric parse failed:', err);
        }
      });

      return xhr;
    }

    Object.setPrototypeOf(ProxiedXHR, OriginalXHR);
    ProxiedXHR.prototype = OriginalXHR.prototype;

    unsafeWindow.XMLHttpRequest = ProxiedXHR;
  }
}