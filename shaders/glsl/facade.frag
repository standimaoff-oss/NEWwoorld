// Фасады города: фрагментная программа. Шаг 5.33.
//
// Требования из ТЗ: «обшарпанность, высокая детализация, процедурные качественные
// текстуры, много вывесок», «материалы не яркие, настоящие шероховатости».
//
// Как сделано:
//  • материал стены берётся из атласа фототекстур (альбедо+шероховатость в alpha)
//    и из атласа нормалей, тайлится в метрах, поэтому масштаб одинаковый на 5-
//    и 27-этажном доме;
//  • сетка окон процедурная: этажи по aWall.y, окна по aWall.z; у каждого окна
//    по хэшу — шторы, свет, разбитое стекло, кондиционер, балкон;
//  • обшарпанность — три слоя: потёки (ridge-шум по вертикали), высолы у земли,
//    выкрашивание краски на солнечной стороне, въевшаяся копоть под карнизом;
//  • ночью окна светятся изнутри (тот же приём, что в Самаре), дождь добавляет
//    блик и тёмные пятна, глобальное освещение — из объёма RTGI.

#include "common.glsl"

uniform sampler2D uFacadeAlbedo;   // атлас материалов стены, 8 строк × 4 колонки
uniform sampler2D uFacadeNrm;      // нормали того же атласа
uniform sampler2D uSignAtlas;      // вывески с иероглифами, RGBA
uniform vec4  uFacadeTile;         // x — метров на тайл по горизонтали, y — по вертикали
uniform vec4  uCityParam;          // x — день (0..1), y — ночь: доля горящих окон,
                                   // z — сила копоти, w — износ (0..1, сезон/район)
uniform vec4  uNightWarm;          // цвет лампы накаливания за окном
uniform float uLitSeed;            // общий сдвиг сетки «кто сегодня не спит»

in vec3  vWorld;
in vec3  vNormal;
in vec2  vUv;
in vec4  vWall;
in vec4  vSign;

out vec4 fragColor;

// 0 панель 9-этажная, 1 панель 5-этажная, 2 кирпич красный, 3 серый кирпич
// (хутун), 4 дворец: красная стена, 5 стекло/офис, 6 бетонный рынок, 7 черепица
// Атлас 4×4: строки 0-1 — восемь групп материала, строки 2-3 — те же группы,
// но в масштабе 2× (dense). Мелкий вариант берут низкие корпуса: рынок, киоски,
// хозпостройки, — где 4-метровый тайл иначе показал бы полтора кирпича.
vec2 facadeCell(int type, float small) {
  float c = float(type & 3);
  float r = floor(float(type) / 4.0) + 2.0 * small;
  return vec2(c, r) / 4.0;
}

void main() {
  float day = uSun.w;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.0) N = -N;                     // тонкие стены видимы с двух сторон

  // ---------------- материал стены ------------------------------------------
  int type = int(vWall.x + 0.5);
  vec2 tile = vUv / max(uFacadeTile.xy, vec2(0.25));
  // aWall = (тип материала, шаг этажа, ширина окна, высота дома / 100).
  // Последние 32 ячейки атласа — те же восемь групп, но фактура вдвое мельче:
  // их берут низкие корпуса (павильоны рынка, киоски, хозпостройки до 10 м),
  // где 4-метровый тайл иначе выглядел бы «полтора кирпича на стену».
  float small = step(vWall.w, 0.10);
  vec2 base = facadeCell(type, small) + fract(tile) * 0.25;
  vec3 alb = srgb2lin(texture(uFacadeAlbedo, base).rgb);
  float rough = texture(uFacadeAlbedo, base).a;
  vec3 nrm = texture(uFacadeNrm, base).xyz * 2.0 - 1.0;

  // Микронеровности сверх карты: песок, штукатурка, поры бетона.
  float grit = fbm2(vUv * 5.5 + vWorld.xz * 0.7, 3);
  nrm.xy += vec2(dFdx(grit), dFdy(grit)) * 3.0;
  N = normalize(N + vec3(nrm.x * 0.55, 0.0, nrm.y * 0.55) * (1.0 - 0.4 * rough));

  // ---------------- обшарпанность --------------------------------------------
  float hAboveGround = max(vWorld.y, 0.0);
  // Потёки: вертикальные полосы, темнее и шершавее, начинаются от швов и карнизов.
  float streak = ridge2(vec2(vUv.x * 3.2, 0.0) + vec2(vWorld.x * 0.31, 0.0), 2) *
                 (0.5 + 0.5 * vnoise2(vec2(vUv.x * 0.9, vUv.y * 0.05)));
  float grime = smoothstep(0.35, 1.0, streak) * uCityParam.z *
                (0.35 + 0.65 * saturate1(1.0 - hAboveGround / 42.0));
  // Высолы и сырость у земли — по фото первых этажей.
  float damp = smoothstep(3.4, 0.0, hAboveGround) * (0.4 + 0.6 * vnoise2(vUv * 1.7));
  // Краска выцветает на солнечной стороне и облезает пятнами.
  float sunSide = saturate1(dot(N, vec3(0.7, 0.35, 0.6)));
  float peel = smoothstep(0.55, 0.85, vnoise2(vUv * 2.3 + 11.0)) * uCityParam.w;
  alb *= mix(1.0, 0.72, grime * 0.8);
  alb = mix(alb, alb * vec3(1.06, 1.02, 0.94) + vec3(0.05), damp * 0.5);
  alb = mix(alb, alb * vec3(1.18, 1.12, 0.98), (sunSide - 0.5) * 0.35);
  alb = mix(alb, alb * 0.62 + vec3(0.03), peel * 0.7);
  rough = clamp(rough + grime * 0.22 + damp * 0.10 - peel * 0.06, 0.28, 0.96);
  // Дождь: стена темнеет и блестит там, где она не закрыта козырьком.
  float wet = uWeather.y * (0.35 + 0.65 * saturate1(1.0 - hAboveGround / 6.0));
  alb *= 1.0 - 0.30 * wet;
  rough = mix(rough, 0.18, wet * 0.55);

  // ---------------- окна ------------------------------------------------------
  float floorH = max(vWall.y, 2.2);
  float winW = max(vWall.z, 1.1);
  vec2 cellSz = vec2(winW, floorH);
  vec2 cell = floor(vUv / cellSz);
  vec2 f = fract(vUv / cellSz);
  float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.28, f.y) * step(f.y, 0.86);
  // На нижних этажах магазинов — витрина во всю высоту.
  float shopfront = step(vWorld.y, 4.6) * step(0.06, f.x) * step(f.x, 0.94);
  win = clamp(win + shopfront, 0.0, 1.0);
  float rnd = hash12(cell + vWall.w * 37.0 + uLitSeed);
  // Рама: тёмная полоса по краю проёма, подоконник светлее.
  float frame = win * (1.0 - smoothstep(0.86, 1.0, min(min(f.x, 1.0 - f.x) * 4.4,
                                    min(f.y, 1.0 - f.y) * 6.0)));
  vec3 frameCol = vec3(0.10, 0.105, 0.115);
  // Стекло: не зеркало, а пыльное стекло с плёнкой — шероховатость 0.12.
  float glassRough = mix(0.10, 0.34, 0.35 + 0.35 * hash12(cell * 1.7 + 5.0));
  glassRough = mix(glassRough, 0.06, wet);
  vec3 albWall = alb;
  alb = mix(albWall, frameCol, frame * 0.85);
  rough = mix(rough, 0.65, frame * 0.6);
  float isGlass = win * (1.0 - frame * 0.5);

  vec3 L = uSun.xyz;
  float NdL = saturate1(dot(N, L));
  vec3 sunCol = mix(vec3(0.28, 0.36, 0.52), vec3(1.05, 0.95, 0.82), day);

  vec3 col;
  // ---- стена
  float skyV;
  vec3 gi = giWorld(vWorld + N * 0.6, N, skyV);
  vec3 amb = alb * (mix(vec3(0.022, 0.032, 0.055), uSkyTint.rgb, day) *
                    (0.45 + 0.55 * skyV) + gi * 0.9);
  vec3 lit = alb * sunCol * (NdL * 0.85 + 0.15) * day * mix(0.45, 1.0, skyV);
  col = amb + lit;
  // Блик солнца по стеклу и по мокрому фасаду.
  float sp = ggx(N, V, L, mix(glassRough, rough, 1.0 - isGlass));
  col += sunCol * sp * (0.35 + isGlass * 1.6) * day * (1.0 - wet * 0.2);
  col += sunCol * ggx(N, V, L, max(rough * 0.4, 0.05)) * wet * 0.5;

  // ---- что за окном
  float lit1 = step(1.0 - uCityParam.y, rnd) * (1.0 - day);
  float curtain = step(0.45, hash12(cell * 2.3 + 9.0));
  vec3 room = mix(uNightWarm.rgb * 0.9, uNightWarm.rgb * 0.32, curtain * 0.7);
  room *= 0.55 + 0.45 * vnoise2(f * vec2(3.0, 2.0) + cell);
  // Днём стекло — это небо на отражении плюс тёмная комната.
  vec3 R = reflect(-V, N);
  vec3 skyRefl = skyColor(normalize(R + vec3(0.0, 0.15, 0.0)), L, day, 1.6);
  vec3 glassCol = mix(room * (0.35 + 1.3 * lit1), skyRefl * 0.55,
                      mix(0.25, 0.85, fresnel(saturate1(dot(N, V)), 0.045)));
  glassCol = mix(glassCol, skyRefl * (0.8 + 0.4 * (1.0 - wet)), wet * 0.45);
  col = mix(col, glassCol, isGlass);
  // Ночью окно светится и освещает стену под собой — мягкое пятно.
  float spill = lit1 * isGlass * saturate1(1.0 - abs(vUv.y / floorH - (cell.y + 0.5)) * 1.4);
  col += room * spill * 0.12;

  // ---------------- вывески ---------------------------------------------------
  // aSign = (клетка атласа 0..31, отметка низа щита, сдвиг по стене, признак).
  // Щит лежит на той же грани, что и стена: его координаты считаются из vUv
  // (метры), поэтому вывеска масштабируется метрически и не «едет» на доме
  // другой ширины. Шаг ленты — 16 м, ширина 12 м, высота 3.4 м.
  if (vSign.w > 0.5 && vSign.x > -0.5) {
    float sw = 16.0;
    float u = fract(vUv.x / sw + vSign.z);
    float q = (u - 0.5) * sw;                       // метры от центра ленты
    float wide = 1.0 - smoothstep(5.6, 6.2, abs(q));
    float vy = (vUv.y - vSign.y) / 3.4;
    float tall = smoothstep(0.0, 0.06, vy) * (1.0 - smoothstep(0.94, 1.0, vy));
    float m = wide * tall * step(vy, 1.02) * step(-0.02, vy);
    if (m > 0.004) {
      // клетки 30..31 широкого набора заняты под ФОРМУ свечения (фонарь и
      // гирлянда, см. emissive.frag), поэтому лента пересчитывается в 0..27
      float cid = mod(max(vSign.x, 0.0), 28.0);
      // vy растёт ОТ ЗЕМЛИ, а атлас грузится без FLIP_Y (первая строка PNG — это
      // v = 0): по вертикали клетку берём сверху вниз, иначе иероглифы читаются
      // вверх ногами. Координаты считает signUV() — она общая с emissive.frag,
      // потому что атлас один и делить его надо одинаково.
      vec2 suv = signUV(cid, vec2(0.5 + q / 12.0, 1.0 - clamp(vy, 0.0, 1.0)));
      vec4 sign = texture(uSignAtlas, suv);
      float glow = mix(0.25, 1.0, day) + (1.0 - day) * 1.9;
      float flick = 1.0 - 0.35 * step(0.85, hash12(vec2(vSign.x, vSign.y))) *
                    step(0.5, vnoise2(vec2(uTime * 9.0, vSign.x)));
      vec3 sc = srgb2lin(sign.rgb) * sign.a;
      float k = sign.a * m * (1.0 - grime * 0.6);
      col = mix(col, sc * (0.30 + 0.70 * glow) * flick, k);
      col += sc * (1.0 - day) * 1.6 * flick * m;    // ночная подсветка
      rough = mix(rough, 0.25, k * 0.8);
    }
  }

  // ---------------- дождь по стеклу витрин (только снаружи, снизу вверх) ------
  if (uWeather.x > 0.01 && isGlass > 0.4) {
    float rivulet = smoothstep(0.72, 0.99, vnoise2(vec2(vUv.x * 9.0, vUv.y * 1.1 - uTime * 1.9)));
    col += skyRefl * rivulet * 0.35 * uWeather.x;
  }

  float dist = length(uCamPos - vWorld);
  col = applyFog(col, dist, uFog.rgb, uFog.w, day);
  fragColor = vec4(shadeOut(col, uExposure), 1.0);
}
