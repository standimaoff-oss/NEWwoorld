import * as THREE from 'three';
import { loadAssets, initMaterials, M, pbr, plain, Batch } from '../../preview/src/materials.js';
import { U } from '../../preview/src/state.js';

export { M, loadAssets, initMaterials, pbr, plain, Batch };

// A compact animated water surface for OSM lake/river polygons. The original
// China_Preview.html used a canal-sized Reflector; here the geometry is a set of
// arbitrary OSM polygons, so reflection is replaced by a stylistic wave shader.
function waterMaterial() {
  return new THREE.ShaderMaterial({
    name: 'BeijingOsmWater',
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    uniforms: {
      uTime: U.time, uNight: U.night, uRain: U.rain, uEffects: U.effects, uSun: U.sunDir,
      uColor: { value: new THREE.Color(0x21464c) },
    },
    vertexShader: `varying vec3 vWorld; varying vec2 vUv;
      void main(){ vUv=uv; vWorld=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime,uNight,uRain,uEffects; uniform vec3 uColor,uSun; varying vec3 vWorld; varying vec2 vUv;
      float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
      void main(){
        vec2 p=vWorld.xz;
        float w=sin(p.x*.21+uTime*.9)*.5+sin(p.y*.29-uTime*.72)*.5+sin((p.x+p.y)*.13+uTime*.43)*.35;
        w*=uEffects;
        float n=hash21(floor(p*1.7))*.08;
        vec3 deep=mix(vec3(.025,.085,.105),uColor,.55+w*.08+n);
        vec3 v=normalize(cameraPosition-vWorld);
        float fres=pow(1.-max(dot(v,vec3(0.,1.,0.)),0.),3.);
        vec3 col=deep+fres*vec3(.055,.095,.10);
        float spec=pow(max(dot(reflect(-uSun,vec3(0.,1.,0.)),v),0.),90.)*(1.-uRain*.7);
        col+=vec3(1.,.82,.55)*spec*.20*(1.-uNight);
        col=mix(col,col*.32,uNight);
        col*=1.-uRain*.14;
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export async function initSceneMaterials(scene) {
  await loadAssets();          // reads window.__CHINA_ASSETS__ (embedded JPG + WOFF2)
  initMaterials();             // photographic PBR palette from China_Preview.html
  // Brighter hutong palette than the old night-market preview: low-rise OSM
  // footprints need enough roof/wall contrast to read as 3D from an oblique view.
  M.concrete.color.setHex(0xe1ddd0);
  M.concreteDark.color.setHex(0xc4c7bd);
  M.brick.color.setHex(0xd9bda3);
  M.brickRed.color.setHex(0xd29a7e);
  M.asphalt.color.setHex(0xbfc1bc);
  M.road.color.setHex(0xd0ccbf);
  M.paving.color.setHex(0xdcd5c5);
  M.roof.color.setHex(0x9b9282);
  M.red.color.setHex(0xc4775f);
  M.stone.color.setHex(0xc9c6ba);
  M.ground = pbr('Concrete012', 0xd0ccbf, 3.0, .94);
  M.wall = pbr('Bricks066', 0xc2aa8f, 1.6, .93);
  M.fence = pbr('Metal063', 0x969890, 1.2, .78, .35);
  M.pitch = plain(0x7f9a62, .95);
  M.marker = plain(0xd8bd80, .55, 0, { emissive: 0x8a6a2e, emissiveIntensity: .45 });
  M.monument = plain(0xc4775f, .82, 0, { emissive: 0x3a120c, emissiveIntensity: .12 });
  M.gold = plain(0xc3a05a, .62, .2);
  M.roofTile = pbr('Bricks066', 0x77766f, 1.1, .9);
  M.roofWarm = pbr('Bricks066', 0xb89a78, 1.25, .9);
  M.roofCool = pbr('Bricks066', 0x8e948b, 1.25, .9);
  M.darkWood = pbr('Metal063', 0x6e5640, 1.4, .9);
  M.water = waterMaterial();
  // Flat OSM ribbons, walls and merged boxes can face either way after winding
  // normalisation; double-sided materials keep every exact footprint visible.
  for (const m of [
    M.ground, M.wall, M.fence, M.pitch, M.marker, M.monument, M.gold, M.roofTile, M.roofWarm, M.roofCool, M.darkWood,
    M.brick, M.brickRed, M.concrete, M.concreteDark, M.roof, M.roofGold,
    M.paving, M.road, M.asphalt, M.white, M.dark, M.frame, M.metal, M.wood, M.red, M.lamp, M.glass, M.stone,
  ]) if (m && 'side' in m) m.side = THREE.DoubleSide;
  // A small colour-matched emissive lift keeps exact OSM walls legible even on
  // the shadowed side of the tower; it is a lighting choice, not extra geometry.
  for (const m of [
    M.ground, M.wall, M.fence, M.roofTile, M.roofWarm, M.roofCool, M.darkWood,
    M.brick, M.brickRed, M.concrete, M.concreteDark, M.roof, M.roofGold,
    M.paving, M.road, M.asphalt, M.metal, M.wood, M.red, M.stone,
  ]) if (m?.userData.tile) { m.emissive.copy(m.color).multiplyScalar(.10); m.emissiveIntensity = .55; }
  scene.userData.signMats = [];
}
