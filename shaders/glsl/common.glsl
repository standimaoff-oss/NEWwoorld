// Общие функции шейдеров ShopSim (шаг 5.33).
// Единый исходник для Windows-сборки (raylib, GLSL 330) и веб-сборки (WebGL2, GLSL ES 3.00).
// Файл подключается текстовой вставкой: web/js/shaders.js и tools/shader_dialect.py.
//
// Что здесь: шум и волны, небо и облака, затенение (GGX + Френель), тонмаппинг,
// доступ к объёму глобального освещения. Числа подобраны по фотографиям улиц:
// альбедо не ярче 0.78, у асфальта 0.06..0.12, у бетона 0.18..0.34 —
// см. tools/check_materials.py.

#ifndef SHOPSIM_COMMON_GLSL
#define SHOPSIM_COMMON_GLSL

#define PI  3.14159265
#define TAU 6.28318531

// ---------------------------------------------------------------- глобальные
// Одинаковые для всех проходов, задаются один раз на кадр.
uniform float uTime;      // секунды игрового времени
uniform vec4  uSun;       // xyz — направление на солнце, w — день 0..1 (0 — ночь)
uniform vec4  uSkyTint;   // цвет неба в зените: отражения и подсветка
uniform vec4  uFog;       // xyz — цвет тумана, w — плотность
uniform vec4  uWeather;   // x — дождь, y — мокрость, z — снег, w — сила ветра (0..1)
uniform vec4  uCamera;    // xyz — положение глаз, w — фокусное расстояние

uniform mat4  uViewProj;      // вид × проекция (WebGL: праворукая, raylib: леворукая — см. tools/shader_dialect.py)
uniform mat4  uInvViewProj;       // обратно-прямая матрица для экранных проходов
uniform vec3  uCamPos;            // положение глаз, метры
uniform float uExposure;          // автоэкспозиция, кадровой выдержка нет

float saturate1(float x) { return clamp(x, 0.0, 1.0); }

// ------------------------------------------------------------------ утилиты
// Хэш Дэйва Хоскинса: дёшево и без видимых решёток на целых числах.
vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p += dot(p, p + 33.33);
  return fract(p);
}

// Простой скалярный шум по целой решётке: четыре угла, гладкая интерполяция.
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Фрактальный шум. oct — число октав (ветер 2, трава 3, облака 5).
float fbm2(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * (vnoise2(p) * 2.0 - 1.0);
    p = m * p;
    a *= 0.5;
  }
  return s;
}

// Ридж-шум: гребни волн, прожилки листа, потёки грязи по стене.
float ridge2(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.7, 1.3, -1.3, 1.7);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(vnoise2(p) * 2.0 - 1.0);
    s += a * n * n;
    p = m * p;
    a *= 0.5;
  }
  return s;
}

// --------------------------------------------------------------------- вода
// Волны Герстнера: вершина движется по эллипсу, нормаль берётся из суммы
// наклонных фронтов. Дисперсия настоящая (длинная волна быстрее короткой),
// поэтому гребни не «сыпятся» вдали — как в Sea на shadertoy Ms2SD1.
struct Wave { vec2 dir; float amp; float len; float speed; float steep; };

// Смещение вершины (dx, dy, dz) и наклон фронта (outGrad) одной волны.
vec3 gerstner(vec2 xz, float t, Wave w, out vec2 outGrad) {
  float k = TAU / max(w.len, 0.5);              // волновое число
  float c = sqrt(9.81 / k) * w.speed;           // фазовая скорость глубокой воды
  float f = k * (dot(w.dir, xz) - c * t);
  float a = w.amp * k;
  outGrad = vec2(0.0);
  if (a < 1e-5) return vec3(0.0);
  float sf = sin(f), cf = cos(f);
  outGrad = vec2(w.dir.x * a * cf, w.dir.y * a * cf);
  float qa = w.amp / max(k, 1e-4);
  return vec3(w.dir.x * w.steep * qa * sf, w.amp * cf, w.dir.y * w.steep * qa * sf);
}

// Сумма волн: y — высота, xz — наклон (для нормали). Детальные рябь-волны
// идут в xz с малой амплитудой, поэтому нормаль богатая без доп. выборков.
vec3 waterSum(vec2 xz, float t, int count, float ampScale) {
  vec3 acc = vec3(0.0);
  Wave w;
  w.dir = normalize(vec2(1.0, 0.22));  w.len = 42.0; w.amp = 0.62 * ampScale; w.speed = 1.0; w.steep = 0.85;
  vec2 g; acc += gerstner(xz, t, w, g); acc.xz += g;
  w.dir = normalize(vec2(-0.35, 1.0)); w.len = 21.0; w.amp = 0.34 * ampScale; w.speed = 1.0; w.steep = 0.90;
  vec2 g2; acc += gerstner(xz, t, w, g2); acc.xz += g2;
  w.dir = normalize(vec2(0.82, -0.58)); w.len = 9.5; w.amp = 0.17 * ampScale; w.speed = 1.05; w.steep = 0.95;
  vec2 g3; acc += gerstner(xz, t, w, g3); acc.xz += g3;
  w.dir = normalize(vec2(-0.9, -0.3)); w.len = 4.2; w.amp = 0.075 * ampScale; w.speed = 1.1; w.steep = 1.0;
  vec2 g4; acc += gerstner(xz, t, w, g4); acc.xz += g4;
  w.dir = normalize(vec2(0.3, 0.95)); w.len = 1.7; w.amp = 0.028 * ampScale; w.speed = 1.2; w.steep = 1.0;
  vec2 g5; acc += gerstner(xz, t, w, g5); acc.xz += g5;
  return acc;
}

vec3 waterNormal(vec3 sum, float detail) {
  return normalize(vec3(-sum.x * detail, 1.0, -sum.z * detail));
}

// ---------------------------------------------------------------------- небо
vec3 skyColor(vec3 rd, vec3 sunDir, float day, float turbidity) {
  float h = clamp(rd.y, -0.2, 1.0);
  // По фото ясного дня: зенит 0.15/0.29/0.52, горизонт 0.54/0.64/0.76.
  vec3 zen = mix(vec3(0.012, 0.020, 0.043), vec3(0.148, 0.286, 0.524), day);
  vec3 hor = mix(vec3(0.030, 0.040, 0.068), vec3(0.540, 0.640, 0.760), day);
  float sunset = pow(1.0 - day, 1.6) * day * 4.0;
  hor += vec3(0.55, 0.20, 0.03) * sunset;
  vec3 c = mix(zen, hor, pow(1.0 - max(h, 0.0), turbidity));
  float d = max(dot(rd, sunDir), 0.0);
  vec3 sunCol = mix(vec3(1.0, 0.62, 0.30), vec3(1.0, 0.96, 0.88), day);
  c += sunCol * smoothstep(0.9985, 0.9993, d) * 24.0 * day;
  c += sunCol * pow(d, 64.0) * 0.45 * day;
  c += sunCol * pow(d, 6.0) * 0.06 * day;
  if (day < 0.35) {
    float night = 1.0 - day / 0.35;
    vec3 md = -sunDir;
    c += vec3(0.85, 0.88, 0.95) * smoothstep(0.9986, 0.9994, dot(rd, md)) * 14.0 * night;
    float st = step(0.9992, hash12(floor(rd.xz * 380.0 + rd.y * 140.0)));
    c += vec3(st) * 0.9 * night * smoothstep(0.0, 0.25, rd.y);
  }
  return max(c, vec3(0.002));
}

// Облака — послойный проход по слою (как fBm-облака XslGRr, но 8 шагов
// вместо сорока и с шагом, растущим по расстоянию).
float cloudDensity(vec2 p, float h, vec2 windOff, float cover) {
  if (h < 0.0 || h > 1.0) return 0.0;
  vec2 q = p + windOff;
  float base = vnoise2(q * 0.0016 + vec2(0.0, h * 0.4));
  float det = fbm2(q * 0.0062 + vec2(h * 1.7, -h * 0.9), 4);
  float d = base * 0.75 + det * 0.35 - (1.0 - cover) * 0.62;
  d -= abs(h - 0.5) * 0.55;                        // слой толще в середине
  return max(d, 0.0) * 2.2;
}

// ---------------------------------------------------------------- освещение
float ggx(vec3 n, vec3 v, vec3 l, float rough) {
  vec3 h = normalize(v + l);
  float a = max(rough * rough, 0.0025);
  float nh = max(dot(n, h), 0.0);
  float nv = max(dot(n, v), 1e-4);
  float nl = max(dot(n, l), 1e-4);
  float a2 = a * a;
  float dd = a2 / ((nh * nh * (a2 - 1.0) + 1.0) * (nh * nh * (a2 - 1.0) + 1.0) + 1e-7);
  float k = a * 0.5;
  float gv = nv / (nv * (1.0 - k) + k);
  float gl = nl / (nl * (1.0 - k) + k);
  return dd * gv * gl / (4.0 * nv * nl + 1e-6);
}

float fresnel(float u, float f0) { return f0 + (1.0 - f0) * pow(1.0 - u, 5.0); }

// Текстуры альбедо лежат в sRGB (так их снимали и так их рисует художник),
// шейдер работает в линейных числах — декодируем при выборке.
vec3 srgb2lin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

// Диэлектрический F0: вода 0.02, стекло 0.04, лак 0.05, керамика 0.035.
vec3 dielectricF0(float ior) { float r = (1.0 - ior) / (1.0 + ior); return vec3(r * r); }

// ---------------------------------------------------------------- тонмаппинг
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}
// Билдер определяет SHOPSIM_TONEMAP_IN_POST=1 для веба и высокого качества:
// шейдеры объектов пишут линейный HDR, а экспозицию, ACES и sRGB делает пост-проход.
// В «дешёвом» режиме raylib (без HDR-таргета) тонмаппинг остаётся в шейдере объекта.
#ifndef SHOPSIM_TONEMAP_IN_POST
#define SHOPSIM_TONEMAP_IN_POST 0
#endif

vec3 shadeOut(vec3 lnr, float exposure) {
#if SHOPSIM_TONEMAP_IN_POST
  return lnr;
#else
  return toSRGB(aces(lnr * exposure));
#endif
}

// Только для post.frag: здесь линейный цвет уже готов к выдаче на экран.
vec3 shadeOutPost(vec3 lnr) { return toSRGB(aces(lnr * uExposure)); }

// ---------------------------------------------------------------------- туман
vec3 applyFog(vec3 col, float dist, vec3 fogCol, float density, float day) {
  float f = 1.0 - exp(-pow(dist * density, 2.0));
  f *= mix(0.55, 1.0, day);       // ночью туман темнее и холоднее
  return mix(col, fogCol, saturate1(f));
}

// ------------------------------------------- объём глобального освещения RTGI
// Печётся на CPU (web/js/gi.js и tools/bake_gi.py) в 3D-текстуру:
// xyz — облучённость (небо + один отскок от стен и фонарей), w — доля неба.
#define GI_GRID_X 96
#define GI_GRID_Y 12
#define GI_GRID_Z 96
#define GI_WORLD  1536.0
#define GI_CELL   (GI_WORLD / float(GI_GRID_X))   // 16 м на ячейку плана по горизонтали

uniform mediump sampler3D uGIVol;
uniform float uGIOn;              // 0 — выключено (низкое качество на телефоне)

vec3 giWorld(vec3 p, vec3 n, out float sky) {
  if (uGIOn < 0.5) { sky = 1.0; return vec3(0.0); }
  // Выборка смещена вдоль нормали на 1.5 м: иначе у стены берётся окрестность
  // земли и фасад темнеет. По высоте сетка мельче (12 ярусов по 16 м), поэтому
  // y делим на GI_GRID_Y * GI_CELL, а не на размер мира.
  vec3 sc = vec3(GI_WORLD, float(GI_GRID_Y) * GI_CELL, GI_WORLD);
  vec3 s = (p + n * 1.5 + vec3(GI_WORLD * 0.5, 0.0, GI_WORLD * 0.5)) / sc;
  vec4 t = texture(uGIVol, clamp(s, vec3(0.002), vec3(0.998)));
  sky = t.w;
  // Объём пишется на CPU со «усилением» 1.6 (см. web/js/gi.js), чтобы в 8 битах
  // не потерять тёмные дворы; здесь снимаем масштаб и добавляем лёгкий
  // нелинейный подъём — иначе углы выглядят «грязными».
  vec3 e = t.xyz * (1.0 / 1.6);
  return e * e * 0.6 + e * 0.75;
}

float giSky(vec3 p, vec3 n) {
  float sky;
  giWorld(p, n, sky);
  return sky;
}

// Мягкое затенение травы и мелкого декора: полусфера из четырёх выборок.
// Дешёвая замена SSAO для instanced-проходов, где глубины нет.
float giAO(vec3 p, float radius) {
  if (uGIOn < 0.5) return 1.0;
  float occ = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 a = hash22(p.xz * 4.0 + float(i) * 13.0);
    vec3 q = p + vec3(a.x * radius, radius * (0.25 + 0.5 * float(i) / 3.0), a.y * radius);
    occ += giSky(q, vec3(0.0, 1.0, 0.0));
  }
  return 0.35 + 0.65 * saturate1(occ * 0.25);
}


// ---------------------------------------------------------------- вывески
// Атлас вывесок один на всех (facade.frag красит ленту на стене, emissive.frag
// кладёт на стену отдельный щит), и у него ДВЕ сетки клеток в одной квадратной
// текстуре 2048²: верхняя половина — широкие щиты cols×rows (512×128 px, аспект
// 4 = панель 12×3.4 м), нижняя — вертикальные «столбы» vcols×vrows (128×512 px).
// Числа приходят из JS (LOOK.emissive.grid), который, в свою очередь, списан с
// assets/beijing_signs.json — того же реестра, что пишет генератор. Разъезд на
// одну строку (8 рядов вместо 16, потому что ряды занимают половину высоты)
// превращал каждую вывеску в кашу из половинок соседних.
//
// q — координата внутри клетки: x слева направо, y СВЕРХУ ВНИЗ (атлас грузится
// без FLIP_Y, первая строка PNG = v = 0, а в геометрии y растёт от земли).
uniform vec4 uSignGrid;             // xy — колонок/рядов широких, zw — вертикальных

vec2 signUV(float id, vec2 q) {
  float cols = max(uSignGrid.x, 1.0), rows = max(uSignGrid.y, 1.0);
  float vcols = max(uSignGrid.z, 1.0), vrows = max(uSignGrid.w, 1.0);
  float nWide = cols * rows;                    // id < nWide — широкая клетка
  float isV = step(nWide, id);
  float k = id - nWide * isV;
  vec2 g = mix(vec2(cols, rows), vec2(vcols, vrows), isV);
  vec2 cell = vec2(mod(k, g.x), floor(k / g.x));
  // каждая сетка жмётся в половину текстуры → рядов по вертикали вдвое больше,
  // чем кажется на вид, и нижняя половина сдвинута на 0.5
  vec2 div = vec2(g.x, g.y * 2.0);
  return (cell + clamp(q, vec2(0.0), vec2(1.0))) / div + vec2(0.0, 0.5 * isV);
}

#endif
