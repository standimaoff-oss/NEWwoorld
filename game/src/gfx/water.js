/* Вода: волны Герстнера, отражение неба, преломление и пена; рябь от капель дождя. */
import * as THREE from 'three';
import { RIVER, LAKE, HALF, WORLD_SIZE } from '../world/gen.js';
import { waterNormalTexture } from './textures.js';

const VERT = /* glsl */`
uniform float uTime;
uniform vec3 uSeaLevel;
uniform vec2 uLakeC;
uniform vec2 uLakeR;
uniform float uWaveScale;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vDepthHint;
varying float vWave;

vec3 gerstner(vec2 p, float t, vec2 dir, float steep, float len, float speed, out vec3 nrm) {
  float k = 6.28318 / len;
  float c = sqrt(9.8 / k) * speed;
  vec2 d = normalize(dir);
  float f = k * (dot(d, p) - c * t);
  float a = steep / k;
  nrm = normalize(vec3(-d.x * steep * cos(f), 1.0 - steep * sin(f), -d.y * steep * cos(f)));
  return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
}

void main(){
  vec3 pos = position;
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float wave = 0.0;
  vec3 nn;
  vec3 offs = vec3(0.0);
  vec2 p = wp.xz;
  float t = uTime;
  offs += gerstner(p, t, vec2(0.86, 0.51), 0.34, 26.0, 1.0, nn) * uWaveScale; wave += nn.y;
  offs += gerstner(p, t, vec2(-0.42, 0.91), 0.26, 13.0, 1.15, nn) * uWaveScale; wave += nn.y * 0.6;
  offs += gerstner(p, t, vec2(0.21, -0.98), 0.20, 6.7, 1.3, nn) * uWaveScale; wave += nn.y * 0.4;
  offs += gerstner(p, t, vec2(0.99, -0.14), 0.14, 3.3, 1.5, nn) * uWaveScale; wave += nn.y * 0.2;
  // мелкая рябь
  float small = sin(p.x * 2.3 + t * 1.7) * cos(p.y * 2.1 - t * 1.4) * 0.03 * uWaveScale;
  pos += offs;
  pos.y += small;
  wp = modelMatrix * vec4(pos, 1.0);
  vWorld = wp.xyz;
  // у берега волны мельче — плавно, без «ступеньки» на кромке
  float dx = (wp.x - uLakeC.x) / uLakeR.x, dz = (wp.z - uLakeC.y) / uLakeR.y;
  float dl = length(vec2(dx, dz));
  float lakeEdge = smoothstep(1.0, 0.86, dl);            // 0 в центре, 1 у берега
  float riverEdge = smoothstep(554.0, 570.0, wp.z);      // у набережной
  float edge = wp.z > 300.0 ? max(lakeEdge * 0.0, riverEdge * 0.0) : lakeEdge;
  float shallow = clamp(edge, 0.0, 1.0);
  wp.y += (offs.y) * (1.0 - shallow * 0.75);
  vNormalW = normalize(vec3(-offs.x * 0.6 * (1.0 - shallow * 0.7), 1.0, -offs.z * 0.6 * (1.0 - shallow * 0.7)));
  vWave = wave;
  vDepthHint = wp.z > 0.0 ? 1.0 : clamp(1.0 - dl, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uWaterDeep;
uniform vec3 uWaterShallow;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uRain;
uniform float uNight;
uniform sampler2D uNormalMap;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vDepthHint;
varying float vWave;

void main(){
  vec3 n = normalize(vNormalW);
  // две карты нормалей, движутся в разные стороны
  vec2 uv1 = vWorld.xz * 0.055 + vec2(uTime * 0.013, uTime * 0.009);
  vec2 uv2 = vWorld.xz * 0.11 - vec2(uTime * 0.017, uTime * 0.011);
  vec3 n1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
  vec2 ripple = (n1.xy + n2.xy) * 0.55;
  ripple += vec2(sin(vWorld.x * 4.0 + uTime * 3.1), cos(vWorld.z * 4.3 - uTime * 2.7)) * 0.05 * uRain;
  n = normalize(vec3(n.x + ripple.x * 0.9, n.y, n.z + ripple.y * 0.9));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(-uSunDir);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.2);
  // «небо» в отражении
  vec3 r = reflect(-V, n);
  vec3 sky = mix(uSkyHorizon, uSkyTop, clamp(r.y * 1.6, 0.0, 1.0));
  // цвет воды зависит от глубины у берега
  vec3 shallow = uWaterShallow;
  vec3 deep = uWaterDeep;
  float d = clamp(vDepthHint * 1.4, 0.0, 1.0);
  vec3 body = mix(shallow, deep, d);
  // солнечный блик
  float spec = pow(max(dot(reflect(-L, n), V), 0.0), 260.0) * 3.2;
  float spec2 = pow(max(dot(reflect(-L, n), V), 0.0), 40.0) * 0.25;
  // пена на гребнях и у берега
  float foam = smoothstep(0.85, 1.25, vWave * 2.4) * 0.16 + smoothstep(0.022, 0.0, vDepthHint) * 0.30;
  foam *= (0.55 + 0.45 * sin(uTime * 2.0 + vWorld.x * 1.7 + vWorld.z * 1.3));
  foam = clamp(foam, 0.0, 1.0) * (1.0 - uNight * 0.6);
  vec3 col = mix(body, sky, clamp(fres * 0.72 + 0.10, 0.0, 1.0));
  col += uSunColor * (spec + spec2) * (1.0 - uNight * 0.7);
  col = mix(col, vec3(0.90, 0.94, 0.99) * mix(0.5, 1.0, 1.0 - uNight), foam * 0.7);
  // блёстки: случайные искры по нормали
  vec2 spark = floor(vWorld.xz * 3.0 + vec2(uTime * 0.6, -uTime * 0.4));
  float h = fract(sin(dot(spark, vec2(12.9898, 78.233))) * 43758.5453);
  float glint = step(0.985, h) * pow(max(0.0, dot(reflect(-L, n), V)), 8.0);
  col += glint * 0.55 * uSunColor * (1.0 - uNight * 0.9);
  float dist = length(vWorld - cameraPosition);
  float fogT = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uFogColor, fogT);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Water {
  constructor(scene, world) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uSkyTop: { value: new THREE.Color(0.28, 0.5, 0.86) },
      uSkyHorizon: { value: new THREE.Color(0.75, 0.85, 0.95) },
      uWaterDeep: { value: new THREE.Color(0.012, 0.045, 0.075) },
      uWaterShallow: { value: new THREE.Color(0.045, 0.16, 0.15) },
      uFogColor: { value: new THREE.Color(0.75, 0.8, 0.86) },
      uFogNear: { value: 80 },
      uFogFar: { value: 900 },
      uRain: { value: 0 },
      uNight: { value: 0 },
      uNormalMap: { value: waterNormalTexture() },
      uLakeC: { value: new THREE.Vector2(LAKE.cx, LAKE.cz) },
      uLakeR: { value: new THREE.Vector2(LAKE.rx, LAKE.rz) },
      uWaveScale: { value: 0.55 },
      uSeaLevel: { value: new THREE.Vector3() },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });
    this.mat.fog = false;

    // Волга: большая плоскость с шагом, чтобы волны на вершинах было видно
    const depth = 900;
    // Река отдельным мешем, но с запасом по Z только ВПЕРЁД (в глубину), не поверх суши
    const river = new THREE.PlaneGeometry(WORLD_SIZE + 1600, depth, 320, 160);
    river.rotateX(-Math.PI / 2);
    const rmesh = new THREE.Mesh(river, this.mat);
    rmesh.position.set(0, RIVER.level, RIVER.z0 - 6 + depth / 2);
    rmesh.frustumCulled = false;
    rmesh.receiveShadow = false; rmesh.castShadow = false;
    this.group.add(rmesh);

    // озеро
    const lakeGeo = new THREE.CircleGeometry(1, 128, 0, Math.PI * 2);
    const lmesh = new THREE.Mesh(lakeGeo, this.mat);
    lmesh.rotation.x = -Math.PI / 2;
    lmesh.scale.set(LAKE.rx * 0.99, LAKE.rz * 0.99, 1);
    lmesh.position.set(LAKE.cx, RIVER.level + 0.05, LAKE.cz);
    lmesh.renderOrder = 2;
    lmesh.receiveShadow = false; lmesh.castShadow = false;
    this.group.add(lmesh);

    // пруд в бамбуковом парке — маленький круг
    const pond = new THREE.Mesh(new THREE.CircleGeometry(16, 40), this.mat);
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(665 + 70, RIVER.level + 0.03, -665 - 40);
    pond.receiveShadow = false; pond.castShadow = false;
    this.group.add(pond);
    this.pond = pond;
  }

  update(dt) { this.uniforms.uTime.value += dt; }
  setSun(dir, color, skyTop, skyHor) {
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uSunColor.value.copy(color);
    this.uniforms.uSkyTop.value.copy(skyTop);
    this.uniforms.uSkyHorizon.value.copy(skyHor);
  }
  setFog(near, far, color) { this.uniforms.uFogNear.value = near; this.uniforms.uFogFar.value = far; this.uniforms.uFogColor.value.copy(color); }
  setRain(r) { this.uniforms.uRain.value = r; }
  setNight(n) { this.uniforms.uNight.value = n; }
  setWaves(s) { this.uniforms.uWaveScale.value = s; }
}
