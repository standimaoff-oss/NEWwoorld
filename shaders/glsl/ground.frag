// Покрытия: фрагментная программа. Шаг 5.33.
//
// Ориентиры по фото мокрых и сухих улиц: асфальт альбедо 0.055..0.11,
// плитка 0.12..0.22, бетон 0.20..0.32, дёрн 0.09..0.16, мокрое — минус 25..35 %
// диффузной составляющей и рост блика. Ничего не выбивается в белый.

#include "common.glsl"

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;

out vec4 fragColor;

uniform sampler2D uLayers;        // r — покрытие, g — плотность травы,
                                  // b — впадина (лужа), a — износ
uniform sampler2D uGroundAlbedo;  // атлас покрытий: rgb — альбедо, a — шероховатость
uniform vec4  uGroundTile;        // x — метров на тайл атласа, z — размер карты в метрах,
                                  // w — сила луж
uniform vec4  uGroundParam;       // x — стыки плитки, y — ремонт/заплатки,
                                  // z — трава у края, w — лёд
uniform vec4  uSeason;            // x — лето, y — осень, z — зима, w — весна

// Слои атласа: 0 асфальт, 1 плитка тротуара, 2 дёрн, 3 бетон, 4 грунт,
// 5 песок пляжа, 6 асфальт старый, 7 разметка/пешеходная.
void main() {
  vec2 uvw = vUv / max(uGroundTile.x, 0.5);
  vec4 L = texture(uLayers, vWorld.xz / max(uGroundTile.z, 1.0) + 0.5);
  float gi0 = L.r * 7.0;
  float t0 = floor(gi0);
  // Смешение соседних покрытий на границе, чтобы не было «бумажного» края.
  float mixw = smoothstep(0.0, 1.0, fract(gi0));
  vec2 c0 = vec2(mod(t0, 4.0), floor(t0 / 4.0)) / 4.0;
  vec2 c1 = vec2(mod(t0 + 1.0, 4.0), floor((t0 + 1.0) / 4.0)) / 4.0;
  vec4 a0 = texture(uGroundAlbedo, c0 + fract(uvw) * 0.25);
  vec4 a1 = texture(uGroundAlbedo, c1 + fract(uvw) * 0.25);
  vec4 mat0 = mix(a0, a1, mixw * 0.6);

  vec3 alb = srgb2lin(mat0.rgb);
  float rough = mat0.a;

  // Плитка: швы, сколы, местами элемент вынут (видна подложка).
  vec2 gp = fract(uvw * 0.5) - 0.5;
  float seam = smoothstep(0.42, 0.5, max(abs(gp.x), abs(gp.y)));
  alb *= mix(1.0, 0.62, seam * uGroundParam.x * step(0.5, abs(L.r - 0.15)));

  // Заплатки и ремонт: большие светлые пятна с чётким краем.
  float patchp = smoothstep(0.62, 0.70, vnoise2(vWorld.xz * 0.035 + 3.7)) * uGroundParam.y *
                (1.0 - L.a);
  alb = mix(alb, alb * 1.28 + vec3(0.012), patchp * 0.7);
  rough = mix(rough, 0.55, patchp * 0.5);

  // Грязь, песок на обочине, листва осенью.
  float dirt = smoothstep(0.35, 0.85, fbm2(vWorld.xz * 0.09, 3)) * (0.35 + 0.65 * uSeason.y);
  alb = mix(alb, alb * vec3(1.05, 0.92, 0.68), dirt * 0.25);

  // Трава, пробивающаяся у бордюров и в швах: density из layer-карты.
  float tuft = smoothstep(0.55, 0.95, L.g) * smoothstep(0.55, 0.2, fract(uvw.y * 2.0));
  alb = mix(alb, vec3(0.075, 0.115, 0.045), tuft * uGroundParam.z);
  rough = clamp(mix(rough, 0.85, tuft), 0.04, 0.99);

  // ---- вода в впадинах -------------------------------------------------------
  float wet = uWeather.y;
  float pool = smoothstep(0.55 - wet * 0.45, 0.9, L.b) * uGroundTile.w * saturate1(wet * 1.8);
  // Лёд/соль зимой.
  float ice = uGroundParam.w * smoothstep(0.4, 0.8, vnoise2(vWorld.xz * 0.6));

  vec3 N = normalize(vNormal + vec3(dFdx(dirt + patchp), 0.0, dFdy(dirt + patchp)) * 0.6);
  N = normalize(N + vec3(dFdx(alb.r + alb.g), dFdy(alb.b), 0.0) * 0.25);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 Ld = uSun.xyz;
  float day = uSun.w;
  float nv = saturate1(dot(N, V));

  vec3 sunCol = mix(vec3(0.28, 0.36, 0.52), vec3(1.05, 0.95, 0.82), day);
  float skyVis;
  vec3 gi = giWorld(vWorld + vec3(0.0, 0.4, 0.0), N, skyVis);

  vec3 amb = alb * (mix(vec3(0.020, 0.030, 0.052), uSkyTint.rgb, day) *
                    (0.4 + 0.6 * skyVis) + gi * 0.9);
  vec3 diff = alb * sunCol * (saturate1(dot(N, Ld)) * 0.9 + 0.1) * day * mix(0.5, 1.0, skyVis);
  vec3 col = amb + diff;

  // Мокрый асфальт: диффузия падает, появляется блик и отражение неба.
  float wetMix = clamp(wet * (0.35 + 0.65 * pool), 0.0, 1.0);
  col *= 1.0 - 0.32 * wetMix;
  rough = mix(rough, mix(0.12, 0.04, pool), wetMix);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.02;
  vec3 skyRefl = skyColor(normalize(R), Ld, day, 1.7);
  float fr = fresnel(nv, mix(0.03, 0.02, pool)) * wetMix;
  col = mix(col, skyRefl * 0.8, clamp(fr, 0.0, 0.75));
  // В луже отражается город: тёмная полоса горизонта плюс огоньки ночью.
  float horizonW = pow(1.0 - saturate1(R.y), 6.0);
  col = mix(col, mix(uFog.rgb * 0.35, vec3(0.02, 0.025, 0.04), day), horizonW * pool * 0.8);
  col += vec3(0.55, 0.36, 0.16) * horizonW * pool * (1.0 - day) * 0.55;
  // Блик солнца по луже — короткий и рваный, как на фото.
  col += sunCol * ggx(N, V, Ld, mix(0.05, 0.02, pool)) * pool * day * 1.2;
  // Соль и лёд: белый налёт, сильный тусклый блик.
  col = mix(col, col * 0.75 + vec3(0.16, 0.17, 0.19), ice * 0.35);
  col += skyRefl * fresnel(nv, 0.05) * ice * 0.35;

  float dist = length(uCamPos - vWorld);
  col = applyFog(col, dist, uFog.rgb, uFog.w, day);
  fragColor = vec4(shadeOut(col, uExposure), 1.0);
}
