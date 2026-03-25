// -- AudioEngine.js -------------------------------------------------------------
// Web Audio API wrapper for real-time frequency analysis of the music stream.
//
// Strategy:
//   NetEase serves audio from CDN via cross-origin requests that cannot be
//   tapped directly from the main page (the <audio> element lives inside an
//   iframe). Our solution: when NetworkHijacker captures an audio CDN URL,
//   we receive it here and create a silent, hidden <audio> element purely
//   for the purpose of attaching Web Audio analysis nodes. NetEase's own
//   audio element continues to play audio normally; we merely listen on the
//   side without affecting playback.
//
// Audio element creation:
//   1. We intercept document.createElement('audio') and window.Audio to catch
//      any audio elements created by the page itself (legacy/fallback).
//   2. For captured CDN URLs, we create our own hidden <audio> element,
//      set src to the captured URL, and attach the Web Audio graph.
//
// Volume control:
//   The hidden audio element has volume=0 (muted) so no sound comes from it.
//   It does not interfere with NetEase's own playback.

import Logger from '../utils/Logger.js';

const log = new Logger('AudioEngine');

const FFT_SIZE       = 2048;
const BASS_BIN_START = 1;
const BASS_BIN_END   = 4;

export default class AudioEngine {
  constructor() {
    this._context      = null;
    this._analyser     = null;
    this._dataBuffer   = null;
    this._running      = false;
    this._patchedAudios = new WeakSet();

    // Our own hidden audio element for playing captured CDN URLs.
    this._mirrorAudio = null;
    this._mirrorConnected = false;

    this._subscribers    = new Set();
    this._onAudioCreated = this._onAudioCreated.bind(this);
  }

  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[AudioEngine] Subscriber must be a function.');
    }
    this._subscribers.add(fn);
  }

  unsubscribe(fn) {
    this._subscribers.delete(fn);
  }

  /**
   * Play an audio stream URL and attach the Web Audio graph.
   * Called by the SyncController when NetworkHijacker captures an audio CDN URL.
   * @param {string} url - Audio CDN URL from Netease.
   */
  playStream(url) {
    if (!url) return;

    log.info('Setting mirror audio src:', url.substring(0, 80) + '...');

    if (!this._mirrorAudio) {
      this._mirrorAudio = document.createElement('audio');
      this._mirrorAudio.crossOrigin = 'anonymous';
      this._mirrorAudio.volume = 0;
      Object.assign(this._mirrorAudio.style, {
        position: 'fixed',
        top:     '-9999px',
        left:    '-9999px',
        width:   '1px',
        height:  '1px',
        opacity: '0',
        pointerEvents: 'none',
      });
      document.body.appendChild(this._mirrorAudio);
      this._attachToAudio(this._mirrorAudio);
    }

    this._mirrorAudio.src = url;
    this._mirrorAudio.play().catch(err => {
      log.warn('Mirror audio play failed (may need user interaction first):', err.message);
    });
  }

  start() {
    if (this._running) {
      log.warn('start() called more than once — ignoring.');
      return;
    }
    this._running = true;
    this._interceptCreateElement();
    this._interceptAudioConstructor();
    log.info('AudioEngine started. Intercepting <audio> creation and monitoring for CDN URLs...');
  }

  stop() {
    if (this._mirrorAudio) {
      this._mirrorAudio.pause();
      this._mirrorAudio.src = '';
    }

    if (this._context && this._context.state !== 'closed') {
      this._context.close().catch(err => log.warn('AudioContext close failed:', err));
      this._context = null;
    }

    this._analyser   = null;
    this._dataBuffer = null;
    this._running    = false;
    log.info('AudioEngine stopped.');
  }

  getFrequencySnapshot() {
    if (!this._analyser || !this._dataBuffer) return null;
    this._analyser.getByteFrequencyData(this._dataBuffer);
    return { bass: this._computeBassEnergy(this._dataBuffer) };
  }

  /**
   * Return the primary audio element (mirror audio if available, otherwise
   * any intercepted page audio).
   * @returns {HTMLAudioElement|null}
   */
  getAudioElement() {
    if (this._mirrorAudio && this._mirrorAudio.src) return this._mirrorAudio;
    const all = document.querySelectorAll('audio');
    for (const audio of all) {
      if (this._patchedAudios.has(audio)) return audio;
    }
    return all[0] || null;
  }

  // -- Internal ----------------------------------------------------------------

  _interceptCreateElement() {
    const self = this;
    const orig = document.createElement.bind(document);

    document.createElement = function (tagName, ...args) {
      const el = orig(tagName, ...args);
      if (String(tagName).toLowerCase() === 'audio') {
        self._onAudioCreated(el);
      }
      return el;
    };
    log.debug('document.createElement interception installed.');
  }

  _interceptAudioConstructor() {
    const self     = this;
    const OrigAudio = window.Audio;

    if (!OrigAudio) {
      log.debug('window.Audio constructor not found — skipping.');
      return;
    }

    window.Audio = function () {
      const audio = new OrigAudio();
      self._onAudioCreated(audio);
      return audio;
    };

    window.Audio.prototype     = OrigAudio.prototype;
    window.Audio.NOT_SUPPORTED = OrigAudio.NOT_SUPPORTED;

    log.debug('window.Audio constructor interception installed.');
  }

  _onAudioCreated(audio) {
    if (this._patchedAudios.has(audio)) return;
    this._patchedAudios.add(audio);
    log.info('Intercepted page <audio>. Attaching Web Audio graph...');
    this._attachToAudio(audio);
  }

  _attachToAudio(audioEl) {
    try {
      if (!this._context || this._context.state === 'closed') {
        this._context  = new (unsafeWindow.AudioContext || unsafeWindow.webkitAudioContext)();
        this._analyser = this._context.createAnalyser();
        this._analyser.fftSize = FFT_SIZE;
        this._analyser.smoothingTimeConstant = 0.75;
        this._dataBuffer = new Uint8Array(this._analyser.frequencyBinCount);
      }

      const source = this._context.createMediaElementSource(audioEl);
      source.connect(this._analyser);
      this._analyser.connect(this._context.destination);

      if (this._context.state === 'suspended') {
        this._context.resume().catch(err =>
          log.warn('AudioContext.resume() rejected:', err)
        );
      }

      log.info('Web Audio graph attached.');
    } catch (err) {
      log.error('Failed to attach Web Audio graph:', err);
    }
  }

  _computeBassEnergy(data) {
    let sum = 0, count = 0;
    for (let i = BASS_BIN_START; i <= BASS_BIN_END && i < data.length; i++) {
      sum += data[i];
      count++;
    }
    return count > 0 ? sum / (count * 255) : 0;
  }
}