// Растительность средней крупности: кусты, папоротники, бамбук, пальмовые
// листья, цветы, еловые лапы. Шаг 5.33.
//
// Одна общая «каркас-карта» (два-три перекрещенных quad-а) на вид, инстансы
// расставляет генератор мира. Ветер у каждого типа свой: бамбук гнётся длинным
// кнутом (stiffness малый, смещение по y^1.2), куст только дрожит верхушками,
// пальмовая листовая пластина хлопает по ветру.

#include "common.glsl"

in vec3 aPos;         // локальная лента: x — ширина (-1..1), y — высота (0..1), z — вперёд
in vec2 aUv;
in vec4 iPos;         // x, z, высота (м), ширина (м)
in vec4 iShape;       // поворот, жёсткость (0 — бамбук, 1 — куст), вид, оттенок
in vec4 iExtra;       // зерно, фаза, прижатие, мокрость

uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uGust;          // 0..1 — общий порыв, общий с травой
uniform float uHeight;        // сезонный множитель высоты

out vec2  vUv;
out float vY;
out vec3  vWorld;
out float vFacing;
out float vAO;
out float vWet;
flat out int vType;

void main() {
  float y = clamp(aPos.y, 0.0, 1.0);
  float stiff = iShape.y;
  float h = iPos.z * uHeight;
  float w = iPos.w * mix(1.0, 0.35, y * y);

  // ---- ветер -----------------------------------------------------------------
  float gust = fbm2(iPos.xz * 0.021 + vec2(uTime * 0.6, uTime * 0.18), 2);
  float whip = vnoise2(iPos.xz * 0.35 + uTime * vec2(1.4, 1.0));
  float exponent = mix(1.15, 2.1, stiff);            // кнут vs дрожание
  float bend = uWindStrength * (0.4 + 0.6 * uGust) *
               (gust * 0.8 + whip * 0.35 + 0.12 * sin(uTime * 2.1 + iExtra.y * TAU)) *
               pow(y, exponent);
  bend *= mix(1.25, 0.55, stiff);                     // бамбук гуляет сильнее
  bend *= (1.0 - iExtra.z * 0.6);
  vec2 off = uWindDir * bend * h * mix(0.85, 0.30, stiff);

  float rot = iShape.x;
  vec3 p;
  p.y = h * y * (1.0 - 0.35 * bend * bend);
  p.xz = iPos.xz + off + vec2(cos(rot), sin(rot)) * aPos.x * w +
         vec2(-uWindDir.y, uWindDir.x) * aPos.z * w * 0.4;
  p.y += bend * h * 0.05 * (1.0 - stiff);

  vUv = aUv;
  vY = y;
  vWorld = p;
  vFacing = rot;
  vAO = mix(0.25, 1.0, sqrt(y));
  vWet = iExtra.w;
  vType = int(iShape.z + 0.5);
  gl_Position = uViewProj * vec4(p, 1.0);
}
