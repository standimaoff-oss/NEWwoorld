/* Рендерер: three.js, тени, качество, пауза, измерение fps. */
import * as THREE from 'three';
import { settings, q, platform, saveSettings } from '../core/settings.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: q().aa, powerPreference: 'high-performance', stencil: false,
      alpha: false, preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.12, 2600);
    this.clock = new THREE.Clock();
    this.fpsAcc = 0; this.fpsFrames = 0; this.fps = 60;
    this.drawCalls = 0; this.triangles = 0;
    this.timeScale = 1;
    this.post = null;
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
  }

  resize() {
    const pr = Math.min(window.devicePixelRatio || 1, 2.5) * (settings.pixelScale || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.viewW = w; this.viewH = h;
    this.renderer.setPixelRatio(Math.min(pr, platform.mobile ? 1.6 : 2.5));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.post) this.post.setSize(w, h, this.renderer.getPixelRatio());
  }

  applyQuality() {
    const Q = q();
    this.renderer.shadowMap.enabled = !!settings.shadows && Q.shadows;
    if (this.shadowGen) this.shadowGen.setSize(Q.shadowSize || 1024);
    if (this.scene.fog) this.scene.fog.near = 40; this.scene.fog.far = Q.grassDist * 12 + 220;
    this.resize();
  }

  start() {
    this.clock.start();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.1);
      this.fpsAcc += dt; this.fpsFrames++;
      if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.fpsFrames / this.fpsAcc); this.fpsAcc = 0; this.fpsFrames = 0; }
      if (this.onFrame) this.onFrame(dt, this.clock.elapsedTime);
      this.renderer.info.reset();
      if (this.post) this.post.render(dt); else this.renderer.render(this.scene, this.camera);
      this.drawCalls = this.renderer.info.render.calls;
      this.triangles = this.renderer.info.render.triangles;
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); }
}
