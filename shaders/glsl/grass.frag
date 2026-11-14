// Трава: фрагментная программа. Шаг 5.33, «прорисовка травы».
//
// Задача — трава как в Realtime Grass: отдельные травинки с прозрачным атласом,
// сквозное просвечивание листа, мягкое затенение соседями, блик вдоль жилки,
// мокрая трава после дождя и переход в дёрн на расстоянии (чтобы не мерцало).
//
// Всё процедурное, но по реальным числам: альбедо овсяницы 0.10..0.24,
// у основания в 2.5 раза темнее верхушки, F0 листа 0.035, шероховатость 0.55.

#include "common.glsl"

uniform sampler2D uBladeAtlas;   // атлас лент: 4 ряда по 4 вида, assets/textures/grass_blade.png
uniform sampler2D uTurfTex;      // дёрн (albedo+rough в alpha), grass_turf.png
uniform vec4  uSeason;           // x — лето, y — осень, z — зима, w — весна (сумма = 1)
uniform vec4  uGrassParam;       // x — размер атласа (4), y — сила сквозного света,
                                 // z — расстояние до полного перехода в дёрн, w — мягкость отсечения
uniform float uShadowStrength;   // 0 — нет теней (низкое качество), 1 — полные
uniform float uAlphaCutoff;      // 0.42 день, 0.30 в тумане/дожде (край мягче)

in vec2  vUv;
in float vY;
in float vAO;
in float vFacing;
in float vVariant;
in float vWet;
in vec3  vWorld;
flat in int vSpecies;

out vec4 fragColor;

// Цвет вида: овсяница, мятлик, пырей, одуванчик с белым пушком, сухостой.
vec3 speciesTint(int sp) {
  // Линейное альбедо по замерам гербария и фото лугов: трава 0.05..0.12,
  // сухостой светлее — 0.13..0.18, но почти бесцветный.
  if (sp == 0) return vec3(0.088, 0.152, 0.050);   // овсяница луговая
  if (sp == 1) return vec3(0.079, 0.136, 0.056);   // мятлик
  if (sp == 2) return vec3(0.112, 0.143, 0.047);   // пырей, суше
  if (sp == 3) return vec3(0.121, 0.146, 0.066);   // разнотравье с цветами
  return vec3(0.178, 0.152, 0.079);                 // сухостой
}

void main() {
  // ---- атлас: 5 видов × 2 варианта ленты, сетка 4 × 3 ----------------------
  float cells = max(uGrassParam.x, 4.0);
  float id = float(vSpecies) * 2.0 + vVariant;
  vec2 uv = (vec2(mod(id, cells), floor(id / cells)) + vec2(vUv.x, clamp(vUv.y, 0.0, 0.999)))
            / vec2(cells, 3.0);
  vec4 tex = texture(uBladeAtlas, uv);
  float cut = uAlphaCutoff * mix(1.0, 0.75, uWeather.y * 0.5);
  // Две ленты на крест: соседняя пара повёрнута на 90°, иначе с боков видна «картонка».
  if (tex.a < cut) discard;
  // Мягкий край только у верхушки — иначе полупрозрачные концы «лысеют».
  float edge = smoothstep(cut, cut + max(uGrassParam.w, 0.01), tex.a);

  // ---- альбедо ---------------------------------------------------------------
  vec3 tint = speciesTint(vSpecies);
  // Сезон: осень выжигает низ, весна даёт сочный зелёный, зима — серый снег.
  vec3 season = tint * (uSeason.x * 1.0 + uSeason.y * vec3(1.10, 0.92, 0.55) * 0.9 +
                        uSeason.z * vec3(0.72, 0.80, 0.72) * 0.55 +
                        uSeason.w * vec3(0.85, 1.06, 0.80));
  // Ткань листа: прожилки светлее, по краям темнее; текстура атласа это уже
  // несёт в rgb — домножаем и убираем «белёсость» дальнего плана.
  vec3 albedo = srgb2lin(tex.rgb) * season * mix(0.42, 1.0, vAO);
  // Мокрая трава темнеет на треть и теряет диффузную составляющую.
  float wet = clamp(uWeather.y * 0.65 + vWet * 0.35, 0.0, 1.0);
  albedo *= (1.0 - 0.34 * wet);

  // ---- нормаль ---------------------------------------------------------------
  // Лента двусторонняя: нормаль разворачиваем к камере, наклон берём из
  // ориентации травинки (vFacing) и подъёма к верхушке.
  vec2 face = vec2(cos(vFacing), sin(vFacing));
  vec3 n = normalize(vec3(face.x * 0.75, 0.62 + 0.35 * vY, face.y * 0.75));
  if (dot(n, uCamPos - vWorld) < 0.0) n.xz = -n.xz;
  // Рябь поперёк листа — микронормаль из координаты ленты.
  n = normalize(n + vec3(sin(vUv.x * 42.0) * 0.10, 0.0, 0.0));

  vec3 V = normalize(uCamPos - vWorld);
  vec3 L = uSun.xyz;
  float day = uSun.w;
  float NdV = abs(dot(n, V));
  float rough = mix(0.62, 0.30, wet);

  // ---- солнце: диффузия с оборотом (лист прозрачен на просвет) --------------
  float NdL = dot(n, L);
  float wrapL = saturate1((NdL + 0.35) / 1.35);
  vec3 sunCol = mix(vec3(0.35, 0.42, 0.58), vec3(1.05, 0.96, 0.82), day);
  // Просвет: считаем, что с обратной стороны листа свет идёт через него.
  float trans = saturate1(-NdL) * pow(saturate1(1.0 - abs(dot(V, L))), 2.0);
  float back = uGrassParam.y * (trans * 0.85 + saturate1(1.0 - NdV) * 0.25);
  // Пятно тени соседних травинк: берём из объёма GI (доля неба над точкой).
  float skyVis;
  vec3 gi = giWorld(vWorld, vec3(0.0, 1.0, 0.0), skyVis);
  float occ = mix(1.0, 0.45 + 0.55 * skyVis, uShadowStrength);
  vec3 diff = albedo * sunCol * wrapL * occ * day;
  diff += albedo * sunCol * back * saturate1(NdL * 0.5 + 0.5) * occ * day;

  // ---- ambient: небо + отскок от земли, один отскок из объёма GI -----------
  vec3 skyAmb = mix(vec3(0.030, 0.045, 0.075), uSkyTint.rgb * 1.15, day);
  skyAmb *= mix(0.55, 1.0, 0.5 + 0.5 * n.y);
  vec3 bounce = albedo * vec3(0.10, 0.13, 0.05) * saturate1(0.5 - 0.5 * n.y) * day;
  vec3 amb = albedo * (skyAmb + bounce) * occ + gi * albedo * 0.85;
  // В тумане ambient холоднее и ярче — так выглядят мокрые луга.
  amb = mix(amb, uFog.rgb * albedo * 0.55, saturate1(uFog.w * 26.0));

  // ---- блик ------------------------------------------------------------------
  vec3 H = normalize(V + L);
  vec3 spec = sunCol * ggx(n, V, L, rough) * occ * day;
  // Блик вытянут вдоль травинки: оставляем только компоненту вдоль жилки.
  vec3 along = normalize(vec3(cos(vFacing), 0.55 + vY, sin(vFacing)));
  float aniso = saturate1(1.0 - abs(dot(along, V)));
  spec *= mix(0.30, 1.0, aniso * aniso);
  // Капли: мелкие точечные, только на мокрых листьях, мерцают при движении.
  float drop = smoothstep(0.82, 0.99, vnoise2(vUv * vec2(28.0, 9.0) + vY * 3.0));
  spec += vec3(0.9, 0.95, 1.0) * (drop * wet * 3.0 * saturate1(dot(n, normalize(L + V * 0.4))));

  vec3 col = diff + amb + spec * (fresnel(NdV, 0.035) * 0.6);

  // ---- переход в дёрн на расстоянии ---------------------------------------
  float dist = length(uCamPos - vWorld);
  float fade = smoothstep(0.55, 1.0, dist / max(uGrassParam.z, 10.0));
  if (fade > 0.001) {
    vec3 turf = srgb2lin(texture(uTurfTex, vWorld.xz * 0.12).rgb);
    col = mix(col, turf * (skyAmb + sunCol * 0.32) * 1.0, fade * 0.85);
    edge *= 1.0 - fade * 0.55;
  }

  col = applyFog(col, dist, uFog.rgb, uFog.w, day);
  fragColor = vec4(shadeOut(col, uExposure), edge);
}
