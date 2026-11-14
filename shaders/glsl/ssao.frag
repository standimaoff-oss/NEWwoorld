// SSAO из глубины. Шаг 5.33 — входит в RTGI-контур вместе с объёмом проб.
//
// Нормали восстанавливаются из производных линейной глубины, поэтому отдельного
// G-buffer не нужно (на телефоне это экономит полпрохода). Семь лепестков,
// радиус в метрах, затухание по расстоянию — как в raylib-версии игры.

#include "common.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uDepth;      // нелинейная глубина WebGL/GL (0..1)
uniform vec2  uRes;
uniform vec4  uSSAO;           // x — радиус в метрах, y — сила, z — масштаб шума, w — шаг выборки
uniform vec2  uNearFar;        // ближняя и дальняя плоскости, метры

float linearDepth(vec2 uv) {
  float d = texture(uDepth, uv).r;
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNearFar.x * uNearFar.y) / max(uNearFar.y + uNearFar.x - ndc * (uNearFar.y - uNearFar.x), 1e-5);
}

vec3 viewPos(vec2 uv, float z) {
  vec4 c = uInvViewProj * vec4(uv * 2.0 - 1.0, z, 1.0);
  return c.xyz / c.w;
}

void main() {
  float z = texture(uDepth, vUv).r;
  if (z > 0.99995) { fragColor = vec4(1.0); return; }   // небо не затеняем
  vec3 p = viewPos(vUv, z * 2.0 - 1.0);
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  vec3 eye = normalize(uCamPos - p);
  if (dot(n, eye) < 0.0) n = -n;

  float radius = max(uSSAO.x, 0.1);
  float occ = 0.0;
  float rot = hash12(vUv * uRes * uSSAO.z) * TAU;
  vec2 rt = vec2(cos(rot), sin(rot));
  float pd = length(p - uCamPos);
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    // Спираль Фибоначчи в полусфере — ровное покрытие без муара.
    vec3 k = hash33(vec3(fi * 12.9898, fi * 78.233, 1.0));
    k = vec3(normalize(k.xy) * rt + vec2(0.0), abs(k.z));
    vec3 sp = p + n * radius * 0.2 + k * radius * (0.30 + 0.70 * fi / 8.0);
    vec4 o = uViewProj * vec4(sp, 1.0);
    vec2 suv = o.xy / max(o.w, 1e-4) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float sd = linearDepth(suv);
    // Окклюдер — если в этой точке поверхность ближе к камере, чем точка выборки.
    float bias = max(0.02 * radius, 0.05);
    float occluded = step(sd + bias, length(sp - uCamPos));
    float rangeFade = 1.0 - saturate1((length(sp - p) - radius) / max(radius, 0.01));
    occ += occluded * max(rangeFade, 0.0);
  }
  float ao = 1.0 - uSSAO.y * occ / 8.0;
  ao = mix(ao, 1.0, saturate1(length(p - uCamPos) / 220.0));   // вдали не нужен
  fragColor = vec4(vec3(clamp(ao, 0.15, 1.0)), 1.0);
}
