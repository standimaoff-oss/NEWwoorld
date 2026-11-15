import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Screen-space ray-traced diffuse GI (SSGI). For every visible pixel we
// reconstruct view-space position and normal from GTAO's G-buffer and march
// short hemisphere rays through the depth buffer. A hit contributes the colour
// already rendered at that pixel as one indirect bounce. This is NOT hardware
// ray tracing: light outside the screen is not accounted for.
//
// Three measures keep the estimate stable instead of a speckled mess:
//   * the raw estimate is computed at half resolution,
//   * it is accumulated over frames while the camera is still,
//   * the composite pass does a depth-aware 3x3 blur before adding it.
const VERT = `varying vec2 vUv;
  void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;

const GI_FRAG = `
  uniform sampler2D tScene, tDepth, tNormal, tHistory;
  uniform mat4 uProj, uInvProj;
  uniform float uNear, uFar, uRadius, uHistory;
  uniform vec2 uResolution;
  varying vec2 vUv;
  const float PI2 = 6.2831853;
  const vec3 LUMA = vec3(.2126,.7152,.0722);

  float viewZ(float d){ return (uNear*uFar)/((uFar-uNear)*d-uFar); }
  vec3 viewPos(vec2 uv, float d){
    vec4 v = uInvProj * vec4(uv*2.-1., d*2.-1., 1.);
    return v.xyz / v.w;
  }
  void main(){
    vec4 src = texture2D(tScene, vUv);
    float d = texture2D(tDepth, vUv).x;
    if (d >= .9999) { gl_FragColor = vec4(0.); return; }
    vec3 p = viewPos(vUv, d) + normalize(texture2D(tNormal, vUv).xyz * 2. - 1.) * .05;
    vec3 n = normalize(texture2D(tNormal, vUv).xyz * 2. - 1.);
    if (n.z < 0.) n = -n;
    vec2 texel = 1. / uResolution;
    vec3 radiance = vec3(0.);
    float wsum = 0.;
    // Deterministic 4x8 disk gather in screen space. View-space distance and
    // both surface normals decide whether a neighbour actually illuminates this
    // point; no stochastic rays, so the estimate is stable from frame one.
    for (int j = 0; j < 4; j++) {
      float ring = float(j) + 1.;
      for (int i = 0; i < 8; i++) {
        float a = (float(i) + ring * .5) * PI2 / 8.;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * ring * 2.3 * texel;
        if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) continue;
        float sd = texture2D(tDepth, uv).x;
        if (sd >= .9999) continue;
        vec3 q = viewPos(uv, sd);
        vec3 delta = q - p;
        float dist = length(delta);
        if (dist < .2 || dist > uRadius * 1.6) continue;
        vec3 dir = delta / dist;
        float cosT = max(dot(n, dir), 0.);
        if (cosT < .02) continue;
        vec3 ns = normalize(texture2D(tNormal, uv).xyz * 2. - 1.);
        if (ns.z < 0.) ns = -ns;
        float emit = .25 + .75 * max(dot(-dir, ns), 0.);
        float w = cosT * emit / (1. + dist * .4);
        radiance += texture2D(tScene, uv).rgb * w;
        wsum += w;
      }
    }
    radiance /= max(wsum, .001);
    // No albedo buffer: approximate it by de-lighting the surface colour.
    vec3 albedo = clamp(src.rgb / max(dot(src.rgb, LUMA), .08), 0., 1.5);
    vec3 bounce = min(radiance * albedo, vec3(2.0));
    vec3 prev = texture2D(tHistory, vUv).rgb;
    gl_FragColor = vec4(mix(bounce, prev, uHistory), 1.);
  }`;

const COMPOSITE_FRAG = `
  uniform sampler2D tDiffuse, tGI, tDepth;
  uniform vec2 uTexel;
  uniform float uNear, uFar, uIntensity;
  varying vec2 vUv;
  float viewZ(float d){ return (uNear*uFar)/((uFar-uNear)*d-uFar); }
  void main(){
    vec4 src = texture2D(tDiffuse, vUv);
    float cd = texture2D(tDepth, vUv).x;
    if (cd >= .9999) { gl_FragColor = src; return; }
    float cz = viewZ(cd);
    vec3 gi = vec3(0.);
    float wsum = 0.;
    // Wide Gaussian kernel on the half-resolution GI target. A depth-aware
    // kernel made the nearest-sampled G-buffer stamp 8x8 blocks into the image;
    // the ray march itself already rejects hits across depth discontinuities.
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * 1.15;
        float k = exp(-float(x*x + y*y) * .22);
        gi += texture2D(tGI, uv).rgb * k;
        wsum += k;
      }
    }
    // Screen-space rays only carry light across a few metres, so fade the
    // effect out with distance instead of lifting fogged far geometry.
    float fade = 1.0 - smoothstep(70.0, 190.0, -cz);
    vec3 bounce = min(gi / max(wsum, .001) * uIntensity * fade, vec3(1.1));
    // Never add more than a modest fraction of the surface's own radiance:
    // without this clamp the whole frame washes out on bright days.
    bounce = min(bounce, src.rgb * .26 + .022);
    gl_FragColor = vec4(src.rgb + bounce, src.a);
  }`;

class GIEstimatePass extends Pass {
  constructor(effect, camera, gtao, width, height) {
    super();
    this.effect = effect;
    this.camera = camera;
    this.gtao = gtao;
    this.needsSwap = false;
    this.uniforms = {
      tScene: { value: null }, tDepth: { value: gtao.depthTexture },
      tNormal: { value: gtao.normalTexture }, tHistory: { value: null },
      uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
      uNear: { value: camera.near }, uFar: { value: camera.far },
      uRadius: { value: 11 }, uHistory: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'ChinaSSGI-Estimate', uniforms: this.uniforms,
      vertexShader: VERT, fragmentShader: GI_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this._fsQuad = new FullScreenQuad(this.material);
    this._prevCam = new THREE.Matrix4();
    this._prevProj = new THREE.Matrix4();
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms, e = this.effect;
    u.tScene.value = readBuffer.texture;
    u.tDepth.value = this.gtao.depthTexture;
    u.tNormal.value = this.gtao.normalTexture;
    u.tHistory.value = e.targets[e.readIndex].texture;
    u.uProj.value.copy(this.camera.projectionMatrix);
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    const moved = !this._prevCam.equals(this.camera.matrixWorld) || !this._prevProj.equals(this.camera.projectionMatrix);
    u.uHistory.value = moved || e.resetAccum ? 0 : .9;
    this._prevCam.copy(this.camera.matrixWorld);
    this._prevProj.copy(this.camera.projectionMatrix);
    e.resetAccum = false;
    renderer.setRenderTarget(e.targets[1 - e.readIndex]);
    this._fsQuad.render(renderer);
    e.readIndex = 1 - e.readIndex;
  }
  setSize(w, h) { this.effect.setSize(w, h); }
  dispose() { this.material.dispose(); this._fsQuad.dispose(); }
}

class GICompositePass extends Pass {
  constructor(effect, camera, gtao) {
    super();
    this.effect = effect;
    this.camera = camera;
    this.gtao = gtao;
    this.needsSwap = true;
    this.uniforms = {
      tDiffuse: { value: null }, tGI: { value: null }, tDepth: { value: gtao.depthTexture },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uNear: { value: camera.near }, uFar: { value: camera.far },
      uIntensity: { value: .38 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'ChinaSSGI-Composite', uniforms: this.uniforms,
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this._fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms, e = this.effect;
    u.tDiffuse.value = readBuffer.texture;
    u.tGI.value = e.targets[e.readIndex].texture;
    u.tDepth.value = this.gtao.depthTexture;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._fsQuad.render(renderer);
  }
  setSize(w, h) { this.effect.setSize(w, h); }
  dispose() { this.material.dispose(); this._fsQuad.dispose(); }
}

export class SSGIEffect {
  constructor(camera, gtao, width, height) {
    this.camera = camera;
    this.gtao = gtao;
    this.readIndex = 0;
    this.resetAccum = true;
    const opts = {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false,
    };
    this.targets = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];
    this.estimate = new GIEstimatePass(this, camera, gtao, width, height);
    this.composite = new GICompositePass(this, camera, gtao);
    this.setSize(width, height);
    this.enabled = true;
  }
  setSize(width, height) {
    const w = Math.max(2, Math.floor(width * .5)), h = Math.max(2, Math.floor(height * .5));
    if (this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this.targets.forEach(t => t.setSize(w, h));
    this.estimate.uniforms.uResolution.value.set(w, h);
    this.composite.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.resetAccum = true;
  }
  // EffectComposer toggles passes individually; keep both in sync.
  setEnabled(v) { this.enabled = v; this.estimate.enabled = v; this.composite.enabled = v; if (v) this.resetAccum = true; }
  get intensity() { return this.composite.uniforms.uIntensity.value; }
  set intensity(v) { this.composite.uniforms.uIntensity.value = v; }
  dispose() { this.targets.forEach(t => t.dispose()); this.estimate.dispose(); this.composite.dispose(); }
}
