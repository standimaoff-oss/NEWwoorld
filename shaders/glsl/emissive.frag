// Светящиеся вывески, фонари, гирлянды: фрагментная программа. Шаг 5.33.
//
// Реалистичность по фото ночного города: лампа не «белый квадрат», у неё есть
// корпус, стекло с пылью, жёлтое пятно на стене под ней и блик на мокром асфальте
// (последнее делает ground.frag через giWorld). Ночная эмиссия ограниченная:
// 2.5 раза ярче дневного диффуза — иначе bloom съедает половину кадра.

#include "common.glsl"

in vec2  vUv;
in vec3  vWorld;
in vec3  vNormal;
in float vMode;
in float vPhase;
in float vBright;
flat in float vCell;

out vec4 fragColor;

uniform sampler2D uEmissive;     // атлас вывесок и ламп: rgb — цвет, a — маска свечения
uniform vec4  uEmitParam;        // x — не используется (число клеток задаёт
                                 // uSignGrid), y — множитель дня, z — сила ночи,
                                 // w — доля мигающих ламп

void main() {
  // Сетка атласа — общая с facade.frag (signUV в common.glsl): id < cols·rows
  // берёт клетку из верхней половины (широкий щит), иначе — из нижней
  // (вертикальный «столб»). vUv.y у планшета растёт вверх, а PNG читается
  // сверху, поэтому по вертикали инвертируем.
  vec2 uv = signUV(vCell, vec2(vUv.x, 1.0 - vUv.y));
  vec4 t = texture(uEmissive, clamp(uv, vec2(0.002), vec2(0.998)));
  if (t.a < 0.02 && vMode > 0.5) discard;

  float day = uSun.w;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  // ИЗНАНКА. Щит — это световой короб: сзади у него крашёный лист железа, а не
  // зеркальный текст. Без этой проверки из переулка читалось зеркальное «书店»,
  // что выглядит браком даже там, где дом просто тонкий.
  float front = step(0.0, dot(N, V));
  front = max(front, 1.0 - step(vMode, 0.5));      // лампы и гирлянды двусторонние
  if (dot(N, V) < 0.0) N = -N;

  // Мигание: часть ламп работает через короткий перебой, гирлянда — по очереди.
  float rnd = hash12(vec2(vCell, vPhase) * 31.7);
  float blink = 1.0;
  if (vMode < 0.5) {
    float bad = step(1.0 - max(uEmitParam.w, 0.0), rnd);
    blink = 1.0 - bad * 0.75 * step(0.86, vnoise2(vec2(uTime * 11.0 + vPhase * 40.0, 0.0)));
  } else if (vMode > 1.5) {
    // Гирлянда: бегущая волна по фазе + лёгкая асинхронность ламп.
    blink = 0.55 + 0.45 * sin(uTime * 2.4 + vPhase * TAU + vWorld.y * 0.7);
    blink *= 1.0 - 0.25 * step(0.9, hash12(vec2(vPhase, 1.3)));
  }
  blink = mix(1.0, blink, 1.0 - day * 0.75);      // днём мигание почти не видно

  // Днём — крашеный пластик с бликом, ночью — источник света.
  vec3 ink = mix(vec3(0.105, 0.108, 0.115), srgb2lin(t.rgb), front);
  vec3 alb = ink * 0.55;
  float rough = mix(0.32, 0.12, t.a * front);
  vec3 L = uSun.xyz;
  float NdL = saturate1(dot(N, L));
  vec3 sunCol = mix(vec3(0.30, 0.38, 0.55), vec3(1.05, 0.95, 0.82), day);
  float skyVis;
  vec3 gi = giWorld(vWorld, N, skyVis);
  // Изнанка щита смотрит от улицы: она не видит ни фонари, ни витрины, а GI
  // в giWorld ориентации не знает — без поправки серая пластина светилась бы
  // ярче асфальта. Поэтому диффузиант изнанки режем до 35 %.
  vec3 diff = alb * (sunCol * (NdL * 0.8 + 0.2) * day + uSkyTint.rgb * 0.5 * day + gi * 0.8)
            * mix(0.35, 1.0, front);
  // Стекло светового короба бликует и днём.
  diff += sunCol * ggx(N, V, L, rough) * 0.25 * day * front;

  vec3 emit = srgb2lin(t.rgb) * t.a * front * mix(uEmitParam.y, uEmitParam.z, 1.0 - day) * vBright * blink;
  // Мокрое стекло вывески: ночью бликует сильнее, дождь «размазывает» свет.
  emit *= 1.0 + uWeather.x * 0.35;

  vec3 col = diff + emit;
  float dist = length(uCamPos - vWorld);
  col = applyFog(col, dist, uFog.rgb, uFog.w * mix(1.0, 1.6, uWeather.x), day);
  // В тумане вокруг лампы — ореол.
  col += emit * 0.25 * saturate1(uFog.w * 40.0) * (1.0 - day);
  fragColor = vec4(shadeOut(col, uExposure), 1.0);
}
