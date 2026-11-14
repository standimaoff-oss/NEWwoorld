import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { U, CANAL } from './state.js';

// Original procedural effects written for this preview. The linked Shadertoy
// works are visual references only; their source code is not copied here.
const noiseGLSL = `
float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float v=0.,a=.5; for(int i=0;i<4;i++){v+=a*vnoise(p);p=p*2.03+vec2(17.1,9.2);a*=.5;} return v; }
`;
export function makeSky(scene) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uTime: U.time, uRain: U.rain, uNight: U.night, uSun: U.sunDir, uEffects: U.effects },
    vertexShader: `varying vec3 vDir; void main(){vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `${noiseGLSL}
      uniform float uTime,uRain,uNight,uEffects; uniform vec3 uSun; varying vec3 vDir;
      void main(){
        vec3 d=normalize(vDir); float h=max(d.y,0.);
        vec3 day=mix(vec3(.68,.72,.72),vec3(.25,.40,.52),pow(h,.55));
        vec3 night=mix(vec3(.055,.07,.09),vec3(.012,.02,.045),pow(h,.5));
        vec3 col=mix(day,night,uNight);
        float sd=max(dot(d,uSun),0.); col+=vec3(1.,.82,.55)*pow(sd,350.)*(1.-uNight)*.8;
        col+=vec3(.9,.72,.5)*pow(sd,12.)*(1.-uNight)*.10;
        vec2 cp=d.xz/(h+.22)*1.8+vec2(uTime*.006,0.);
        float cl=fbm(cp*1.4); float cover=smoothstep(.46,.72,cl)*smoothstep(.02,.22,h);
        vec3 cc=mix(vec3(.82,.82,.78),vec3(.10,.12,.15),uNight);
        cc=mix(cc,vec3(.32,.35,.37),uRain*.7);
        col=mix(col,cc,cover*(.65+uRain*.3)*uEffects);
        col=mix(col,mix(vec3(.43,.47,.49),vec3(.04,.05,.07),uNight),uRain*.55);
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(650, 32, 16), mat); sky.renderOrder = -10; scene.add(sky); return sky;
}

export function makeWater(scene) {
  const geo = new THREE.PlaneGeometry(CANAL.length, CANAL.width, 160, 28); geo.rotateX(-Math.PI / 2);
  const shader = {
    name: 'ChinaCanalWater',
    uniforms: {
      color: { value: new THREE.Color(0x2a5555) }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() },
      uTime: U.time, uRain: U.rain, uNight: U.night, uSun: U.sunDir, uEffects: U.effects,
    },
    vertexShader: `uniform mat4 textureMatrix; uniform float uTime,uEffects; varying vec4 vCoord; varying vec3 vWorld; varying vec3 vNorm;
      float wave(vec2 p){ return (sin(p.x*.32+p.y*.21+uTime*.9)*.10+sin(p.x*.57-p.y*.38+uTime*1.25)*.055+sin(p.x*1.1+p.y*.8-uTime*1.6)*.025)*uEffects; }
      void main(){ vec3 p=position; p.y+=wave(p.xz); float e=.15;
        vNorm=normalize(vec3(wave(p.xz-vec2(e,0))-wave(p.xz+vec2(e,0)),2.*e,wave(p.xz-vec2(0,e))-wave(p.xz+vec2(0,e))));
        vCoord=textureMatrix*vec4(position,1.); vec4 wp=modelMatrix*vec4(p,1.); vWorld=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `${noiseGLSL}
      uniform vec3 color,uSun; uniform float uTime,uRain,uNight,uEffects; uniform sampler2D tDiffuse;
      varying vec4 vCoord; varying vec3 vWorld; varying vec3 vNorm;
      void main(){
        vec2 p=vWorld.xz; float t=uTime;
        float n1=fbm(p*.9+vec2(t*.12,t*.07)), n2=fbm(p*2.3-vec2(t*.09,t*.15));
        vec3 n=normalize(vNorm+vec3((n1-.5)*.22,0.,(n2-.5)*.22)*uEffects);
        vec3 v=normalize(cameraPosition-vWorld); float fres=pow(1.-max(dot(v,n),0.),3.);
        vec4 q=vCoord; q.xy+=n.xz*.035*q.w*uEffects;
        vec3 refl=texture2DProj(tDiffuse,q).rgb;
        // Grazing rays hit the bright procedural sky in the reflection buffer and
        // paint a wide white band across the canal. Keep dark building reflections,
        // but replace sky-bright samples with the deep-water tint.
        float skyLum=dot(refl,vec3(.299,.587,.114));
        float bank=abs(p.y-${CANAL.z.toFixed(1)}); float shallow=smoothstep(${(CANAL.width / 2 - 5).toFixed(1)},${(CANAL.width / 2).toFixed(1)},bank);
        vec3 deep=mix(vec3(.045,.135,.145),vec3(.10,.20,.185),shallow);
        deep=mix(deep,deep*.22,uNight);
        // The reflection texture's sky edge bleeds into a white band at grazing
        // angles near the banks, so fade the mirror out toward the shoreline.
        refl=mix(refl,deep*.9,smoothstep(.34,.60,skyLum));
        float reflMix=(.18+fres*.28)*(1.-smoothstep(13.,18.,bank)*.45);
        vec3 col=mix(deep,refl*.55,reflMix);
        float spec=pow(max(dot(reflect(-uSun,n),v),0.),160.); col+=vec3(1.,.85,.6)*spec*.9*(1.-uNight)*(1.-uRain*.7);
        float foam=smoothstep(${(CANAL.width / 2 - 1.1).toFixed(1)},${(CANAL.width / 2).toFixed(1)},bank)*smoothstep(.45,.7,n1)*.05;
        col+=vec3(foam);
        vec2 rp=p*2.4; vec2 id=floor(rp); vec2 f=fract(rp)-.5; float ph=fract(t*1.3+hash21(id));
        float ring=smoothstep(.035,.0,abs(length(f)-ph*.45))*(1.-ph); col+=ring*uRain*.08*uEffects;
        col*=1.-uRain*.12;
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  };
  const water = new Reflector(geo, { textureWidth: 768, textureHeight: 512, clipBias: .003, multisample: 0, shader });
  // Reflector clones the shader uniforms; re-share the live simulation clocks so
  // waves, rain, night and effect toggles actually reach the water material.
  const wu = water.material.uniforms;
  wu.uTime = U.time; wu.uRain = U.rain; wu.uNight = U.night; wu.uSun = U.sunDir; wu.uEffects = U.effects;
  water.position.set(0, CANAL.y, CANAL.z); water.receiveShadow = true;
  const original = water.onBeforeRender; let frame = 0;
  water.onBeforeRender = function (r, s, c) { if (s.overrideMaterial) return; if (frame++ % 2 === 0 || U.time.value < .1) original.call(this, r, s, c); };
  scene.add(water); return water;
}

export function bladeGeometry() {
  const pos = [], col = [], idx = [];
  const base = new THREE.Color(0x4a5f33), tip = new THREE.Color(0xa8b86a);
  for (let b = 0; b < 5; b++) {
    const a = b * 2.399, h = .22 + (b % 3) * .07, w = .025 + (b % 2) * .012, lean = .06 + b * .018;
    const dx = Math.cos(a), dz = Math.sin(a), ox = dx * .06, oz = dz * .06, start = pos.length / 3;
    for (let s = 0; s <= 3; s++) {
      const t = s / 3, ww = w * (1 - t * .92), bend = lean * t * t;
      for (const side of [-1, 1]) {
        pos.push(ox + dx * bend - dz * ww * side, h * t, oz + dz * bend + dx * ww * side);
        const c = base.clone().lerp(tip, t); col.push(c.r, c.g, c.b);
      }
      if (s < 3) { const k = start + s * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
export function grassMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95, side: THREE.DoubleSide, emissive: 0x2a3518, emissiveIntensity: .4 });
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = U.time; sh.uniforms.uWind = U.wind; sh.uniforms.uRadius = U.grassRadius; sh.uniforms.uPlayer = U.player; sh.uniforms.uEffects = U.effects;
    sh.vertexShader = sh.vertexShader.replace('void main() {', `uniform float uTime,uWind,uRadius,uEffects; uniform vec3 uPlayer;
      void main() {`).replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip=instanceMatrix[3].xyz; float h=position.y; float d=distance(cameraPosition.xz,ip.xz);
        float lod=1.-smoothstep(uRadius-14.,uRadius,d); transformed*=lod;
        float sway=sin(uTime*1.7+ip.x*.23+ip.z*.19)+sin(uTime*2.6+ip.x*.61)*.35;
        transformed.x+=sway*h*h*.20*uWind*uEffects; transformed.z+=cos(uTime*1.3+ip.z*.3)*h*h*.09*uWind*uEffects;
        vec2 pd=ip.xz-uPlayer.xz; float pl=length(pd); if(pl<1.1){transformed.xz+=normalize(pd+vec2(.001))*(1.1-pl)*h*.5;}
      `);
  };
  m.customProgramCacheKey = () => 'grass-wind-lod'; return m;
}
export function foliageMaterial(color = 0x5d7147) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: .92, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = U.time; sh.uniforms.uWind = U.wind; sh.uniforms.uEffects = U.effects;
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'uniform float uTime,uWind,uEffects;\nvoid main() {').replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip=instanceMatrix[3].xyz; float k=max(position.y,0.);
        transformed.x+=sin(uTime*1.2+ip.x*.2+ip.z*.13)*k*.035*uWind*uEffects;
        transformed.z+=cos(uTime*.9+ip.z*.2)*k*.02*uWind*uEffects;
      #endif
    `);
  }; m.customProgramCacheKey = () => 'foliage-wind'; return m;
}

export function makeRain(scene) {
  const N = 1400, pos = new Float32Array(N * 6), end = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { const x = (Math.random() - .5) * 70, y = Math.random() * 32, z = (Math.random() - .5) * 70; pos.set([x, y, z, x, y, z], i * 6); end[i * 2] = 0; end[i * 2 + 1] = 1; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const center = { value: new THREE.Vector3() };
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uTime: U.time, uRain: U.rain, uCenter: center },
    vertexShader: `uniform float uTime; uniform vec3 uCenter; attribute float aEnd; varying float vA;
      void main(){vec3 p=position; p.y=mod(p.y-uTime*14.,32.)-8.; p.x+=sin(uTime*.3)*2.; p+=uCenter; p.y+=aEnd*.65; p.x+=aEnd*.12; vA=.18+aEnd*.22; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);}`,
    fragmentShader: `uniform float uRain; varying float vA; void main(){gl_FragColor=vec4(.68,.74,.78,vA*uRain);}`,
  });
  const rain = new THREE.LineSegments(g, m); rain.frustumCulled = false; rain.visible = false; scene.add(rain); return { rain, center };
}
