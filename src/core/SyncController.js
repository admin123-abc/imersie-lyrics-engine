// -- SyncController.js ----------------------------------------------------------
// Orchestrates the relationship between parsed lyric data, audio frequency
// analysis, and the render pipeline.
//
// Architecture:
//   SyncController is the single point of integration. It subscribes to lyric
//   events from NetworkHijacker, polls AudioEngine for frequency data on each
//   animation frame, and pushes render commands to RenderEngine. It owns the
//   requestAnimationFrame loop — no other module runs a frame loop.
//
// Lyric advancement:
//   A simple binary-search-based cursor walks the sorted lyric array, advancing
//   whenever the current audio time (derived from the page's <audio> element)
//   crosses the next line's timecode. This is deliberately independent of the
//   audio analysis graph so that lyric sync survives graph failures.
//
// Bass reaction:
//   Each frame the bass energy scalar from AudioEngine is forwarded to
//   RenderEngine.setBassEnergy(). The render layer interprets that value to
//   drive particle turbulence — the control boundary stays here, the visual
//   interpretation stays there.

import Logger from '../utils/Logger.js';

const log = new Logger('SyncController');

// How many milliseconds behind the timecode marker a line is still considered
// "current". A positive value compensates for render and decode latency.
const SYNC_TOLERANCE_MS = 200;

export default class SyncController {
  /**
   * @param {import('./AudioEngine.js').default} audioEngine
   * @param {import('../render/RenderEngine.js').default} renderEngine
   */
  constructor(audioEngine, renderEngine) {
    this._audioEngine  = audioEngine;
    this._renderEngine = renderEngine;

    // Lyric state.
    this._lines        = [];   // Array<{time: number, text: string}> — sorted.
    this._translations = [];   // Parallel optional translation lines.
    this._cursor       = 0;    // Index of the currently displayed line.
    this._lastText     = null; // Tracks changes to avoid redundant render calls.

    // Frame loop handle.
    this._rafHandle    = null;
    this._running      = false;

    // The DOM audio element — resolved once on first access.
    this._audioEl      = null;

    // Bind the frame callback once to avoid repeated allocations.
    this._onFrame = this._onFrame.bind(this);
  }

  // -- Public API ---------------------------------------------------------------

  /**
   * Load a new set of parsed lyric lines.
   * Typically called by the NetworkHijacker subscriber registered in index.js.
   * @param {{ main: Array<{time:number, text:string}>, translation: Array }} payload
   */
  loadLyrics(payload) {
    this._lines        = payload.main        || [];
    this._translations = payload.translation || [];
    this._cursor       = 0;
    this._lastText     = null;
    log.info(`Lyrics loaded: ${this._lines.length} lines.`);

    // Notify render engine so it can clear the previous song's particles.
    this._renderEngine.clearLyrics();
  }

  /**
   * Start the animation frame loop.
   * Safe to call only once.
   */
  start() {
    if (this._running) {
      log.warn('start() called more than once — ignoring.');
      return;
    }
    this._running  = true;
    this._rafHandle = requestAnimationFrame(this._onFrame);
    log.info('Frame loop started.');
  }

  /**
   * Stop the frame loop and release resources.
   */
  stop() {
    this._running = false;
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    log.info('Frame loop stopped.');
  }

  // -- Internal -----------------------------------------------------------------

  /**
   * Per-frame update called by requestAnimationFrame.
   * Responsibilities: advance lyric cursor, push audio data, schedule next frame.
   * @param {DOMHighResTimeStamp} _ts - Unused; we derive time from <audio>.currentTime.
   */
  _onFrame(_ts) {
    if (!this._running) return;

    const currentMs = this._getCurrentAudioMs();

    if (currentMs !== null && this._lines.length > 0) {
      this._advanceCursor(currentMs);
    }

    // Sample frequency data every frame. AudioEngine returns null if not ready.
    const snapshot = this._audioEngine.getFrequencySnapshot();
    if (snapshot) {
      this._renderEngine.setBassEnergy(snapshot.bass);
    }

    this._renderEngine.renderFrame();

    this._rafHandle = requestAnimationFrame(this._onFrame);
  }

  /**
   * Return the current audio playback position in milliseconds, or null if
   * the audio element has not yet been located.
   * @returns {number|null}
   */
  _getCurrentAudioMs() {
    if (!this._audioEl) {
      this._audioEl = this._audioEngine.getAudioElement();
    }
    if (!this._audioEl) return null;
    return this._audioEl.currentTime * 1000;
  }

  /**
   * Walk the lyric array forward until the cursor points at the last line
   * whose timecode is <= currentMs + SYNC_TOLERANCE_MS.
   * Advances by one step per frame to avoid skipping over lines at seek.
   * @param {number} currentMs
   */
  _advanceCursor(currentMs) {
    const effectiveMs = currentMs + SYNC_TOLERANCE_MS;

    // Walk forward while the next line is due.
    while (
      this._cursor < this._lines.length - 1 &&
      this._lines[this._cursor + 1].time <= effectiveMs
    ) {
      this._cursor++;
    }

    // Handle backward seeks — reset cursor with binary search.
    if (this._lines[this._cursor].time > effectiveMs) {
      this._cursor = this._binarySearchCursor(effectiveMs);
    }

    const line = this._lines[this._cursor];
    if (line.text !== this._lastText) {
      this._lastText = line.text;

      const translation = this._translations[this._cursor]?.text || '';
      log.debug(`Line [${this._cursor}]: "${line.text}"`);
      this._renderEngine.setLyricLine(line.text, translation);
    }
  }

  /**
   * Binary search returning the index of the last line with time <= targetMs.
   * @param {number} targetMs
   * @returns {number}
   */
  _binarySearchCursor(targetMs) {
    let lo = 0;
    let hi = this._lines.length - 1;

    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lines[mid].time <= targetMs) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return lo;
  }
}
