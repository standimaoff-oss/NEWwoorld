// Трава: вершинная программа. Шаг 5.33.
//
// Одна травинка — лента из четырёх сегментов (8 треугольников, 10 вершин).
// Геометрия общая на все инстансы; форма задаётся instance-атрибутами:
//   iPos   = vec4(x, z, высота_в_метрах, ширина_у_основания)
//   iShape = vec4(угов поворота, изгиб, оттенок, вид)
//   iExtra = vec4(зерно, фаза_порыва, прижатие_к_земле, мокрость_лужка)
// Локальные координаты вершины: aPos.x — половина ширины (-1..1), aPos.y —
// доля высоты (0..1), aPos.z — смещение вперёд по изгибу.
//
// Ветер: два слоя — длинный порыв (низкочастотный fbm по миру) и дрожание
// верхушки (шум по вершине). Изгиб растёт как y^1.7, поэтому у основания
// травинка стоит, а гнётся только верх — как на фото после шквала.

#include "common.glsl"

in vec3  aPos;
in vec2  aUv;
in vec4  iPos;
in vec4  iShape;
in vec4  iExtra;

uniform vec2  uWindDir;       // куда дует, единичный вектор в плане
uniform float uWindStrength;  // 0..1, уже содержит силу порывов
uniform float uCut;           // 0..1: вытоптанность (ниже трава, меньше гнётся)
uniform float uHeight;        // общий множитель высоты (сезон, качество)

out vec2  vUv;
out float vY;
out float vAO;
out float vFacing;
out float vVariant;
out float vWet;
out vec3  vWorld;
flat out int vSpecies;

void main() {
  float y = clamp(aPos.y, 0.0, 1.0);
  float h = iPos.z * uHeight * (1.0 - uCut * 0.55);
  float w = iPos.w * (1.0 - 0.72 * y * y);        // к основанию шире, к верхушке — ноль

  // ---- изгиб и наклон -------------------------------------------------------
  float curve = iShape.y;
  float bendY = pow(y, 1.7);
  vec2 lean = hash22(iPos.xz * 1.7 + iExtra.x).xy * 0.34 + vec2(0.06, 0.0);

  // ---- ветер ----------------------------------------------------------------
  vec2 wp = iPos.xz + lean * h;
  float gust = fbm2(wp * 0.018 + vec2(uTime * 0.55, uTime * 0.21), 2);
  float gust2 = vnoise2(wp * 0.0032 - vec2(uTime * 0.09, uTime * 0.05));
  float phase = iExtra.y * TAU;
  float sway = gust * 0.75 + gust2 * 0.55 + 0.18 * sin(uTime * 2.7 + phase);
  // Порыв приходит волной: трава в 40 м впереди начинает гнуться раньше.
  float dist = length(iPos.xz - uCamPos.xz);
  float travel = sin(dist * 0.09 - uTime * 3.1) * 0.5 + 0.5;
  float strength = uWindStrength * (0.55 + 0.45 * travel) * (0.6 + 0.4 * gust2);
  float bend = clamp(strength * (0.35 + sway * 0.5), 0.0, 1.35) * bendY;
  // Прижатая к земле трава (вытоптанная тропа, покос) почти не гнётся.
  bend *= (1.0 - iExtra.z * 0.7) * (1.0 - uCut * 0.5);

  vec2 dir = uWindDir;
  float rot = iShape.x + curve * bend * 0.6;
  vec2 off = dir * bend * h * 0.62 + lean * h;

  // ---- положение вершины ---------------------------------------------------
  vec3 p;
  p.y = h * y * (1.0 - 0.42 * bend * bend);        // при сильном изгибе ниже
  vec2 base = iPos.xz;
  p.xz = base + off + vec2(cos(rot), sin(rot)) * aPos.x * w;
  p.xz += vec2(-dir.y, dir.x) * aPos.z * w * 0.5;  // лёгкая скрученность ленты
  p.y += curve * bendY * h * 0.10;

  vWorld = p;
  vUv = aUv;
  vY = y;
  vSpecies = int(iShape.w + 0.5);
  // У основания темно (соседние травинки), наверху светло.
  vAO = mix(iExtra.z * 0.35 + 0.18, 1.0, sqrt(y));
  // Мокрость: у земли капли держатся дольше, плюс общий слой от дождя.
  vWet = clamp(iExtra.w * 0.6 + (1.0 - y) * 0.25, 0.0, 1.0);
  // Ориентация ленты нужна во фрагментном шейдере, чтобы вернуть нормаль
  // «на зрителя» у двухсторонних лент (иначе трава выглядит плоской).
  vFacing = rot;
  // 2 варианта ленты на вид: разные изгибы в одном атласе, иначе поле «клонирует».
  vVariant = floor(fract(iExtra.x * 7.13) * 2.0);

  gl_Position = uViewProj * vec4(p, 1.0);
}
