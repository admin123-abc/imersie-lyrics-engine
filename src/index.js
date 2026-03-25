// -- index.js --------------------------------------------------------------------
// Immersive Lyric Engine — Tampermonkey bootstrapper.
//
// Responsibilities:
//   1. Bootstrap all subsystems (NetworkHijacker, AudioEngine, RenderEngine,
//      SyncController) in dependency order without creating circular imports.
//   2. Wire up the NetworkHijacker → SyncController lyric pipeline.
//   3. Guard against multiple instantiations using a global singleton.
//   4. Expose GM_info for introspection in the browser console.
//
// Execution gating:
//   The script is marked @run-at document-idle, so the DOM is fully parsed
//   when this module executes. No additional polling is required.

import Logger from './utils/Logger.js';
import NetworkHijacker from './core/NetworkHijacker.js';
import AudioEngine from './core/AudioEngine.js';
import SyncController from './core/SyncController.js';
import RenderEngine from './render/RenderEngine.js';

const log = new Logger('ImmersiveLyricEngine');

// Prevent double-boot if the page somehow reloads the script.
if (unsafeWindow.__ILE_BOOTSTRAPPED__) {
  log.warn('ILE already bootstrapped. refusing second init.');
} else {
  unsafeWindow.__ILE_BOOTSTRAPPED__ = true;

  const hijacker    = new NetworkHijacker();
  const audioEngine = new AudioEngine();
  const renderEngine = new RenderEngine();
  const syncController = new SyncController(audioEngine, renderEngine);

  hijacker.subscribeLyrics((payload) => {
    syncController.loadLyrics(payload);
  });

  hijacker.subscribeAudio((url) => {
    audioEngine.playStream(url);
  });

  renderEngine.init();
  hijacker.install();
  audioEngine.start();
  syncController.start();

  unsafeWindow.__ILE__ = {
    hijacker,
    audioEngine,
    renderEngine,
    syncController,

    /** Tear down all subsystems and remove the canvas from the DOM. */
    destroy() {
      syncController.stop();
      audioEngine.stop();
      renderEngine.destroy();
      unsafeWindow.__ILE_BOOTSTRAPPED__ = false;
      log.info('ILE destroyed.');
    },
  };

  log.info(`ILE v${GM_info.script.version} bootstrapped. Access via window.__ILE__`);
  log.debug('Lyric endpoint hooks installed. Awaiting first playback...');
}