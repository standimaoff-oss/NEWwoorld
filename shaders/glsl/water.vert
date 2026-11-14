// Вода: вершинная программа. Шаг 5.33 — «вода как в Water Waves, только
// анимированная и крупнее».
//
// Сетка лежит на кольцах вокруг камеры (near ring — 1 м, far ring — 420 м),
// поэтому вблизи детальная волна, вдали — та же формула, но triangles в 30 раз
// меньше. Высота и наклон считаются функцией waterSum() из common.glsl; вдали
// амплитуда уменьшается, чтобы не было «ступенек» на кольцах.

#include "common.glsl"

in vec3 aPos;              // xz — план в метрах, y — не используется
out vec3 vWorld;
out vec2 vSlope;
out float vCrest;
out float vDist;

uniform vec4  uWaterBox;   // xy — min плана воды, zw — размер в метрах
uniform float uAmp;        // амплитуда, метры (волна на озере 0.35, у моря 1.2)
uniform float uChop;       // крутизна гребня
uniform sampler2D uDepth;  // r — глубина в метрах, gb — течение, a — маска берега

void main() {
  vec2 xz = aPos.xz;
  float t = uTime;
  // На большой воде ветер сильнее — отсюда растущая с расстоянием амплитуда.
  float scale = clamp(0.55 + length(xz - uCamPos.xz) * 0.0016, 0.55, 1.6);
  vec3 w = waterSum(xz, t, 5, uAmp * scale);
  // Мелководье: волна «встаёт» и падает по глубине (эффект рефракции).
  float depth = texture(uDepth, (xz - uWaterBox.xy) / max(uWaterBox.zw, vec2(1.0))).r;
  float shoal = smoothstep(0.0, 1.4, depth) * mix(1.0, 1.35, clamp(depth / 6.0, 0.0, 1.0));
  vec3 p = vec3(xz.x, w.y * shoal, xz.y);
  vWorld = p;
  vSlope = w.xz * shoal;
  vCrest = saturate1(w.y * shoal / max(uAmp * 0.9, 0.02));
  vDist = length(uCamPos - p);
  gl_Position = uViewProj * vec4(p, 1.0);
}
