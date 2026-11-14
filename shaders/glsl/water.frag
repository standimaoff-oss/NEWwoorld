// Вода: фрагментная программа. Шаг 5.33.
//
// Модель как в Sea (shadertoy Ms2SD1): нормаль из суммы волн, Френель по
// закону Шлика, цвет воды — закон Бера-Ламберта (красный тонет первым),
// блик GGX, барашки на гребнях и у берега, рябь от дождя. Всё в линейном
// пространстве, тонмаппинг общий с остальными проходами.
//
// По фото вода никогда не «голубая plastic»: альбедо глубокой воды 0.02..0.05,
// на мелководье песок даёт 0.30..0.45, F0 = 0.02, шероховатость 0.02..0.25.

#include "common.glsl"

uniform sampler2D uDepth;      // r — глубина в метрах, g — течение X, b — течение Y, a — маска берега
uniform sampler2D uFoam;       // тайловая пена и рябь
uniform vec4  uWaterBox;       // xy — min плана, zw — размер в метрах
uniform vec4  uWaterColor;     // xyz — цвет воды на метр поглощения, w — плотность
uniform vec4  uWaterParam;     // x — детализация нормали, y — пена, z — масштаб волны, w — берег
uniform vec4  uBedColor;       // цвет ила/песка на мелководье
uniform vec3  uSunColorLin;    // цвет солнца без неба (для блика)

in vec3  vWorld;
in vec2  vSlope;
in float vCrest;
in float vDist;

out vec4 fragColor;

float depthAt(vec2 xz) {
  return texture(uDepth, (xz - uWaterBox.xy) / max(uWaterBox.zw, vec2(1.0))).r;
}

vec2 flowAt(vec2 xz) {
  return texture(uDepth, (xz - uWaterBox.xy) / max(uWaterBox.zw, vec2(1.0))).gb * 2.0 - 1.0;
}

void main() {
  vec2 xz = vWorld.xz;
  float scale = max(uWaterParam.z, 0.2);

  // ---- нормаль ---------------------------------------------------------------
  // Крупная волна — аналитическая (из vSlope), мелкая — два слоя шума с
  // собственным сдвигом по направлению волны, чтобы рябь «бежала» с волной.
  vec2 flow = flowAt(xz) * 0.25;
  vec2 t1 = vec2(uTime * 0.85, uTime * 0.42) + flow * uTime;
  vec2 p = xz * scale;
  float n1 = fbm2(p * 0.55 + t1, 3);
  float n2 = ridge2(p * 1.7 - t1.yx * 0.6, 2);
  vec2 det = vec2(dFdx(n1) * 6.5 + dFdx(n2) * 3.0, dFdy(n1) * 6.5 + dFdy(n2) * 3.0);
  det = clamp(det, vec2(-1.5), vec2(1.5));
  vec3 n = normalize(vec3(-(vSlope * 2.2 + det * uWaterParam.x), 1.0));

  float depth = depthAt(xz);
  float shore = 1.0 - smoothstep(0.0, max(uWaterParam.w, 0.2), depth);

  vec3 V = normalize(uCamPos - vWorld);
  float nv = saturate1(dot(n, V));
  vec3 L = uSun.xyz;
  float day = uSun.w;

  // ---- цвет толщи: поглощение по каналам ------------------------------------
  // Вода Самартской Кабанки: 0.05 м⁻¹ красный, 0.35 зелёный, 0.85 синий.
  vec3 absorb = exp(-max(depth, 0.0) * vec3(0.42, 0.165, 0.075) * max(uWaterColor.w, 0.15));
  vec3 deep = uWaterColor.rgb * absorb;

  // ---- дно на мелководье через преломление ---------------------------------
  vec2 refr = xz + n.xz * min(depth, 2.0) * 0.75;
  float drefr = depthAt(refr);
  vec3 bed = uBedColor.rgb * (0.55 + 0.45 * vnoise2(refr * 0.9));
  float clear = smoothstep(2.2, 0.15, depth);
  vec3 body = mix(deep, mix(deep * 0.55 + bed * 0.55, bed, clear * 0.7), clear);

  // ---- отражение неба и солнца ----------------------------------------------
  vec3 R = reflect(-V, n);
  R.y = abs(R.y) * 0.9 + 0.02;
  vec3 refl = skyColor(normalize(R), L, day, 1.35);
  // Город и берег в отражении: тёмная полоса у горизонта воды.
  float horizon = pow(1.0 - saturate1(R.y), 8.0);
  refl = mix(refl, uFog.rgb * 0.45 + uSkyTint.rgb * 0.15, horizon * 0.75);
  float f = fresnel(nv, 0.02);

  // ---- блик ------------------------------------------------------------------
  float spec = ggx(n, V, L, mix(0.22, 0.045, saturate1(1.0 - uWaterParam.x))) *
               saturate1(dot(n, L)) * day;
  vec3 specCol = uSunColorLin * spec * 2.6;

  // ---- пена -------------------------------------------------------------------
  float foamTex = texture(uFoam, xz * 0.055 + vec2(n1 * 0.25, n2 * 0.18)).r;
  float crest = smoothstep(0.62, 1.0, vCrest) * foamTex;
  float wash = shore * (0.55 + 0.45 * foamTex) *
               (0.6 + 0.4 * sin(uTime * 1.6 + depth * 3.0));
  float foam = clamp((crest * 0.9 + wash * 1.1) * uWaterParam.y, 0.0, 1.0);
  // Дождь: сотни колец и точек — вода белеет и теряет блик.
  float rain = uWeather.x;
  float drops = step(0.86, vnoise2(xz * 2.4 + vec2(uTime * 1.7, -uTime * 1.1))) *
                step(0.72, vnoise2(xz * 6.5 - vec2(uTime * 0.9, uTime * 2.3)));
  foam = clamp(foam + rain * (drops * 0.55 + 0.10 * ridge2(xz * 1.4 + uTime * 0.7, 2)), 0.0, 1.0);

  vec3 col = mix(body, refl, f) * (1.0 - foam) + vec3(0.92, 0.95, 0.97) * foam * 0.85;
  col += specCol * (1.0 - foam * 0.8) * (1.0 - rain * 0.6);
  // Ночью вода ловит фонари и вывески: тёплая полоса у берега.
  float lights = pow(1.0 - saturate1(R.y), 3.0) * (1.0 - day);
  col += vec3(0.30, 0.22, 0.12) * lights * 0.5 * (0.6 + 0.4 * n1);
  // Мягкое затенение от береговых объектов через объём GI.
  float sky;
  vec3 gi = giWorld(vWorld + vec3(0.0, 0.2, 0.0), n, sky);
  col += body * gi * 0.6;

  col = applyFog(col, vDist, uFog.rgb, uFog.w, day);
  fragColor = vec4(shadeOut(col, uExposure), 1.0);
}
