// -- Logger.js -------------------------------------------------------------------
// Centralized logging utility for the Immersive Lyric Engine.
//
// Design rationale:
//   - Every module identifies itself via a namespace tag, making console output
//     instantly traceable to its origin without opening a stack trace.
//   - Log levels are filterable at runtime via Logger.setLevel(), allowing
//     silent production operation without per-module edits.
//   - Timestamp precision is millisecond-level; sufficient for audio-sync
//     debugging without the overhead of performance.now() formatting.

const LEVELS = Object.freeze({
  DEBUG: 0,
  INFO:  1,
  WARN:  2,
  ERROR: 3,
  SILENT: 4,
});

let globalLevel = LEVELS.INFO;

export default class Logger {
  // -- Static Configuration ----------------------------------------------------

  static LEVELS = LEVELS;

  /**
   * Set the minimum severity that will be printed to console.
   * Anything below this threshold is silently discarded.
   * @param {number} level - One of Logger.LEVELS.*
   */
  static setLevel(level) {
    if (typeof level !== 'number' || level < LEVELS.DEBUG || level > LEVELS.SILENT) {
      throw new RangeError(`[Logger] Invalid level: ${level}. Use Logger.LEVELS.*`);
    }
    globalLevel = level;
  }

  static getLevel() {
    return globalLevel;
  }

  // -- Instance ----------------------------------------------------------------

  /**
   * @param {string} namespace - Module identifier, e.g. 'NetworkHijacker'.
   */
  constructor(namespace) {
    if (!namespace || typeof namespace !== 'string') {
      throw new TypeError('[Logger] A non-empty namespace string is required.');
    }
    this._prefix = `[ILE::${namespace}]`;
  }

  /**
   * Produce a formatted timestamp for log entries.
   * Format: HH:MM:SS.mmm — compact, grep-friendly, timezone-agnostic.
   * @returns {string}
   */
  _timestamp() {
    const now = new Date();
    const h   = String(now.getHours()).padStart(2, '0');
    const m   = String(now.getMinutes()).padStart(2, '0');
    const s   = String(now.getSeconds()).padStart(2, '0');
    const ms  = String(now.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  }

  debug(...args) {
    if (globalLevel <= LEVELS.DEBUG) {
      console.debug(`${this._timestamp()} ${this._prefix}`, ...args);
    }
  }

  info(...args) {
    if (globalLevel <= LEVELS.INFO) {
      console.info(`${this._timestamp()} ${this._prefix}`, ...args);
    }
  }

  warn(...args) {
    if (globalLevel <= LEVELS.WARN) {
      console.warn(`${this._timestamp()} ${this._prefix}`, ...args);
    }
  }

  error(...args) {
    if (globalLevel <= LEVELS.ERROR) {
      console.error(`${this._timestamp()} ${this._prefix}`, ...args);
    }
  }
}
