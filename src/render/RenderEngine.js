// -- RenderEngine.js -------------------------------------------------------------
// Three.js-based 3D immersive particle lyric visualizer.
//
// Visual goals:
//   Futuristic holographic aesthetic inspired by sci-fi anime interfaces
//   (Chobits, Heaven's Lost Property). Particle text feels ethereal but
//   reacts aggressively to bass energy bursts.
//
// Rendering strategy:
//   - A single fullscreen WebGL canvas is appended as a fixed overlay above
//     all page content (z-index: 9999, pointer-events: none).
//   - All geometry uses BufferGeometry with dynamic Float32Arrays for per-frame
//     particle position updates.
//   - A single shared ShaderMaterial drives all particle appearance so that
//     bass energy can be applied uniformly without per-particle material copies.
//   - The render loop runs on requestAnimationFrame owned exclusively by
//     SyncController; RenderEngine does not start its own RAF loop.
//
// Particle behavior:
//   - Idle state: particles drift gently with sinusoidal noise, forming
//     readable text via a pre-computed vertex displacement from a CanvasTexture
//     bitmap of the lyric text.
//   - Bass hit: velocity impulse pushes particles outward radially from the
//     text center; turbulence is injected as per-particle noise amplitude
//     scaled by bass energy. A decay factor returns particles to idle drift.
//
// Text rendering:
//   - Lyric text is rasterized to an offscreen 2D canvas at high resolution.
//   - The bitmap is sampled to place particles on the bright regions via a
//     Monte Carlo distribution (more particles on brighter pixels).
//   - When lyrics change, a new particle cloud is built asynchronously from
//     the new bitmap while the old cloud fades out.

import * as THREE from 'three';
import Logger from '../utils/Logger.js';

const log = new Logger('RenderEngine');

// -- Constants -------------------------------------------------------------------

const PARTICLE_COUNT     = 8000;
const PARTICLE_SIZE       = 0.003;
const DRIFT_SPEED         = 0.0003;
const DRIFT_AMPLITUDE     = 0.15;
const BASS_IMPULSE        = 0.8;
const BASS_DECAY          = 0.92;
const TURBULENCE_MAX      = 0.25;
const FADE_DURATION_MS    = 400;
const CANVAS_FONT_SIZE    = 160;
const CANVAS_RESOLUTION   = 1024;
const LAYER_COUNT         = 5;
const LAYER_DEPTH_SPACING = 0.04;

// -- Shader Sources --------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3  aColor;

  uniform float uTime;
  uniform float uBassEnergy;
  uniform float uBassImpulse;
  uniform float uFade;

  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    vAlpha = aAlpha * uFade;
    vColor = aColor;

    vec3 pos = position;

    float id    = float(gl_VertexID);
    float phase = id * 0.0173;
    pos.x += sin(uTime * 1.1 + phase)        * 0.04 * uFade;
    pos.y += cos(uTime * 0.9 + phase * 1.3)  * 0.03 * uFade;

    float dist    = length(pos.xy);
    float impulse = uBassEnergy * uBassImpulse * smoothstep(0.0, 0.5, dist);
    float angle   = atan(pos.y, pos.x);
    pos.x += cos(angle) * impulse;
    pos.y += sin(angle) * impulse;

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = aSize * (300.0 / -mvPos.z);
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform float uBassEnergy;

  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    // Soft circular particle sprite.
    vec2  coord = gl_PointCoord - 0.5;
    float d     = length(coord) * 2.0;
    if (d > 1.0) discard;

    float glow = 1.0 - d;
    glow = pow(glow, 1.5);

    // Bass adds a hot core and shifts color toward white-blue.
    vec3 color = vColor;
    color = mix(color, vec3(0.7, 0.9, 1.0), uBassEnergy * 0.4);

    float alpha = vAlpha * glow;
    gl_FragColor = vec4(color, alpha);
  }
`;

// -- Helpers ---------------------------------------------------------------------

function hexToRGB(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}

const CYAN   = hexToRGB('#00e5ff');
const MAGENTA = hexToRGB('#ff00aa');
const WHITE   = hexToRGB('#ffffff');

// -- RenderEngine Class ---------------------------------------------------------

export default class RenderEngine {
  constructor() {
    this._canvas    = null;
    this._renderer = null;
    this._scene     = null;
    this._camera    = null;
    this._clock     = null;

    // Particle system state.
    this._points    = null;
    this._positions = null;
    this._alphas    = null;
    this._colors    = null;
    this._sizes     = null;
    this._basePositions = null; // For returning to origin after turbulence.

    // Active lyric state.
    this._currentText  = '';
    this._targetAlpha  = 1.0;
    this._fadeAlpha    = 0.0;
    this._fadeStart    = null;
    this._transitioning = false;

    // Bass energy state.
    this._bassEnergy = 0;

    // Layered clouds for 3D depth effect.
    this._layers = [];

    // Subsystem status.
    this._ready    = false;
    this._destroyed = false;
  }

  // -- Public API ----------------------------------------------------------------

  /**
   * Append a fullscreen canvas overlay and initialise Three.js.
   */
  init() {
    if (this._ready || this._destroyed) return;

    this._canvas = document.createElement('canvas');
    this._canvas.id     = 'ile-canvas';
    this._canvas.width  = window.innerWidth;
    this._canvas.height = window.innerHeight;
    Object.assign(this._canvas.style, {
      position:   'fixed',
      top:        '0',
      left:       '0',
      width:      '100%',
      height:     '100%',
      zIndex:     '9999',
      pointerEvents: 'none',
      opacity:    '1',
    });

    document.body.appendChild(this._canvas);

    this._renderer = new THREE.WebGLRenderer({
      canvas:    this._canvas,
      alpha:     true,
      antialias: true,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(window.innerWidth, window.innerHeight);
    this._renderer.setClearColor(0x000000, 0);

    this._scene  = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.01,
      100
    );
    this._camera.position.z = 1.0;

    this._clock = new THREE.Clock();

    this._buildParticleLayers();
    this._bindResize();

    this._ready = true;
    log.info('RenderEngine initialised.');
  }

  /**
   * Update the displayed lyric line and trigger a crossfade rebuild.
   * @param {string} text        - Main lyric text.
   * @param {string} translation - Optional translation (unused in v1, reserved).
   */
  setLyricLine(text, translation = '') {
    if (text === this._currentText && this._currentText !== '') return;
    this._currentText = text;
    this._transitioning = true;
    this._fadeStart = performance.now();
    this._rebuildParticles(text);
  }

  /**
   * Forward bass energy from AudioEngine.
   * @param {number} energy - Normalised [0, 1] bass energy scalar.
   */
  setBassEnergy(energy) {
    this._bassEnergy = Math.max(0, Math.min(1, energy));
  }

  /**
   * Clear the current lyric and fade out.
   */
  clearLyrics() {
    this._currentText = '';
    this._transitioning = true;
    this._fadeStart = performance.now();
    this._targetAlpha = 0;
  }

  /**
   * Called by SyncController on each animation frame.
   * Renders one Three.js frame.
   */
  renderFrame() {
    if (!this._ready || this._destroyed) return;

    const elapsed = this._clock.getElapsedTime();
    const bass    = this._bassEnergy;

    // Update fade alpha.
    if (this._fadeStart !== null) {
      const t = Math.min(1, (performance.now() - this._fadeStart) / FADE_DURATION_MS);
      this._fadeAlpha = this._transitioning
        ? (this._targetAlpha === 0 ? 1 - t : t)
        : this._targetAlpha;

      if (t >= 1) {
        this._fadeAlpha    = this._targetAlpha;
        this._fadeStart    = null;
        this._transitioning = false;
      }
    }

    // Update each layer.
    for (let i = 0; i < this._layers.length; i++) {
      const layer = this._layers[i];
      const uniforms = layer.material.uniforms;
      uniforms.uTime.value        = elapsed;
      uniforms.uBassEnergy.value  = bass;
      uniforms.uFade.value        = this._fadeAlpha;
    }

    this._renderer.render(this._scene, this._camera);
  }

  /**
   * Tear down the renderer and remove the canvas from the DOM.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }

    for (const layer of this._layers) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this._layers = [];

    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }

    window.removeEventListener('resize', this._onResize);
    this._ready = false;
    log.info('RenderEngine destroyed.');
  }

  // -- Internal -----------------------------------------------------------------

  /**
   * Build LAYER_COUNT particle layers at varying depths.
   * Each layer is a separate THREE.Points object with its own ShaderMaterial
   * sharing the same vertex/fragment shaders but with independent uniform blocks.
   */
  _buildParticleLayers() {
    const particlesPerLayer = Math.floor(PARTICLE_COUNT / LAYER_COUNT);

    for (let i = 0; i < LAYER_COUNT; i++) {
      const depth    = (i - LAYER_COUNT / 2) * LAYER_DEPTH_SPACING;
      const opacity  = 0.4 + 0.6 * (1 - Math.abs(i - LAYER_COUNT / 2) / (LAYER_COUNT / 2));
      const scale    = 1.0 + (i - LAYER_COUNT / 2) * 0.05;

      const { geometry, basePositions } = this._createParticleGeometry(
        particlesPerLayer,
        depth,
        scale
      );

      const material = new THREE.ShaderMaterial({
        vertexShader:   VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: {
          uTime:        { value: 0 },
          uBassEnergy:  { value: 0 },
          uBassImpulse: { value: BASS_IMPULSE },
          uFade:        { value: 0 },
        },
        transparent: true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
      });

      const points = new THREE.Points(geometry, material);
      this._scene.add(points);

      this._layers.push({ points, geometry, material, basePositions });
    }

    log.debug(`Built ${LAYER_COUNT} particle layers, ~${particlesPerLayer} particles each.`);
  }

  /**
   * Create a BufferGeometry populated with randomised particle attributes.
   * Particles are initially scattered in a loose sphere volume.
   *
   * @param {number} count
   * @param {number} zDepth
   * @param {number} scale
   * @returns {{ geometry: THREE.BufferGeometry, basePositions: Float32Array }}
   */
  _createParticleGeometry(count, zDepth, scale) {
    const positions  = new Float32Array(count * 3);
    const basePositions = new Float32Array(count * 3);
    const alphas      = new Float32Array(count);
    const colors      = new Float32Array(count * 3);
    const sizes       = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // Loose sphere distribution.
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 0.3 + Math.random() * 0.3;

      const x = r * Math.sin(phi) * Math.cos(theta) * scale;
      const y = r * Math.sin(phi) * Math.sin(theta) * scale;
      const z = zDepth + (Math.random() - 0.5) * 0.02;

      positions[i * 3]     = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      basePositions[i * 3]     = x;
      basePositions[i * 3 + 1] = y;
      basePositions[i * 3 + 2] = z;

      // Colour gradient: cyan (center) → magenta (edges) → white (outer).
      const t = Math.random();
      let c;
      if (t < 0.4) {
        c = CYAN;
      } else if (t < 0.7) {
        c = MAGENTA;
      } else {
        c = WHITE;
      }
      colors[i * 3]     = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      alphas[i] = 0.6 + Math.random() * 0.4;
      sizes[i]  = PARTICLE_SIZE * (0.5 + Math.random());
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions,  3));
    geometry.setAttribute('aAlpha',  new THREE.BufferAttribute(alphas,     1));
    geometry.setAttribute('aColor',   new THREE.BufferAttribute(colors,     3));
    geometry.setAttribute('aSize',    new THREE.BufferAttribute(sizes,      1));

    return { geometry, basePositions };
  }

  /**
   * Rebuild particle positions from the lyric text bitmap.
   * @param {string} text
   */
  _rebuildParticles(text) {
    const bitmap = this._textToBitmap(text);
    const centers = this._sampleBitmap(bitmap);

    for (const layer of this._layers) {
      this._scatterParticlesToPositions(layer, centers, layer.basePositions);
    }
  }

  /**
   * Rasterise text to a 2D canvas and return the ImageData.
   * @param {string} text
   * @returns {ImageData}
   */
  _textToBitmap(text) {
    const canvas = document.createElement('canvas');
    canvas.width  = CANVAS_RESOLUTION;
    canvas.height = CANVAS_RESOLUTION;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle   = 'white';
    ctx.font        = `bold ${CANVAS_FONT_SIZE}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Monte Carlo sample of bright pixels from the bitmap.
   * Returns an array of [x, y] in normalised [-0.5, 0.5] coords.
   * @param {ImageData} data
   * @returns {Array<[number, number]>}
   */
  _sampleBitmap(data) {
    const { width, height, data: pixels } = data;
    const centers = [];
    const N = Math.floor(PARTICLE_COUNT * 0.7); // Use 70% of particles for text.

    // Collect bright pixels.
    const brightPixels = [];
    for (let i = 0; i < width * height; i++) {
      const brightness = pixels[i * 4];
      if (brightness > 128) {
        const x = (i % width) / width;
        const y = 1 - (i / width | 0) / height; // Flip Y, origin at bottom.
        brightPixels.push([x - 0.5, y - 0.5]);
      }
    }

    if (brightPixels.length === 0) return centers;

    // Monte Carlo sampling.
    for (let k = 0; k < N; k++) {
      const idx = Math.floor(Math.random() * brightPixels.length);
      const [bx, by] = brightPixels[idx];
      // Add slight jitter to break grid artefacts.
      centers.push([
        bx + (Math.random() - 0.5) * 0.008,
        by + (Math.random() - 0.5) * 0.008,
      ]);
    }

    return centers;
  }

  /**
   * Distribute particles from their current basePositions to target positions.
   * @param {object} layer
   * @param {Array<[number, number]>} targets - Normalised XY targets.
   * @param {Float32Array} basePositions
   */
  _scatterParticlesToPositions(layer, targets, basePositions) {
    const { geometry } = layer;
    const positions = geometry.attributes.position.array;
    const count = positions.length / 3;
    const scale = 0.5; // Map normalised coords to scene units.

    // Copy current base positions before scattering.
    for (let i = 0; i < count; i++) {
      basePositions[i * 3]     = positions[i * 3];
      basePositions[i * 3 + 1] = positions[i * 3 + 1];
      basePositions[i * 3 + 2] = positions[i * 3 + 2];
    }

    // Scatter to text targets or random idle positions.
    for (let i = 0; i < count; i++) {
      const isTextParticle = i < targets.length;
      const [tx, ty] = isTextParticle
        ? targets[i]
        : [
            (Math.random() - 0.5) * 0.6,
            (Math.random() - 0.5) * 0.3,
          ];

      positions[i * 3]     = tx * scale + (Math.random() - 0.5) * 0.01;
      positions[i * 3 + 1] = ty * scale + (Math.random() - 0.5) * 0.01;
      positions[i * 3 + 2] = basePositions[i * 3 + 2]; // Keep z from base.
    }

    geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Handle window resize — update camera aspect, renderer size, and canvas.
   */
  _bindResize() {
    this._onResize = () => {
      if (!this._renderer) return;
      this._canvas.width  = window.innerWidth;
      this._canvas.height = window.innerHeight;
      this._camera.aspect = window.innerWidth / window.innerHeight;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);
  }
}