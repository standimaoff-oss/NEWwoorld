// Финальный проход. Шаг 5.33.
//
// Порядок: линейный HDR из геомерии → SSAO (умножается в линейном) → bloom
// (сложение) → дождь/снег в воздухе → отражение витрины (rain_window) →
// экспозиция, ACES, sRGB, лёгкая виньетка и зерно. Всё в одном проходе,
// кроме rain_window, который идёт отдельным (он читает сцену до пост-обработки).

#include "common.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;      // линейный HDR
uniform sampler2D uBloomTex;
uniform sampler2D uAO;
uniform vec4  uPost;           // x — сила bloom, y — сила AO, z — виньетка, w — зерно
uniform vec4  uRainAir;        // x — дождь, y — направление струй (x), z — длина, w — капли на камере
uniform vec2  uRes;
uniform float uFlash;          // вспышка молнии 0..1

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 col = texture(uScene, vUv).rgb;
  float ao = mix(1.0, texture(uAO, vUv).r, max(uPost.y, 0.0));
  col *= ao;
  col += texture(uBloomTex, vUv).rgb * max(uPost.x, 0.0);

  // Дождь в воздухе: наклонные штрихи. Яркость штриха зависит от того, насколько
  // он около источника света; света в пост-проходе нет, поэтому используем
  // яркость самой сцены под штрихом.
  float rain = uRainAir.x;
  if (rain > 0.004) {
    float sk = uRainAir.y;
    vec2 q = vec2(vUv.x + vUv.y * sk, vUv.y);
    float a = vnoise2(q * vec2(420.0, 42.0) + vec2(0.0, -uTime * 26.0));
    float streak = smoothstep(0.80, 0.99, a) * smoothstep(0.0, 0.35, vUv.y);
    float b = vnoise2(q * vec2(210.0, 26.0) + vec2(3.0, -uTime * 15.0));
    streak += smoothstep(0.86, 1.0, b) * 0.6;
    float lit = saturate1(lum(col) * 1.8 + 0.12);
    col += vec3(0.55, 0.60, 0.68) * streak * rain * 0.10 * (0.35 + lit);
    // Капли на «объективе» дрона.
    float onLens = uRainAir.w * smoothstep(0.72, 0.98,
                   vnoise2(vUv * 24.0 + floor(uTime * 3.0) * 7.0));
    col += skyColor(normalize(vec3(vUv * 2.0 - 1.0, 1.0)), uSun.xyz, uSun.w, 1.0) * onLens * 0.05;
  }

  // Снег в воздухе — те же штрихи, но короче и медленнее.
  float snow = uWeather.z;
  if (snow > 0.004) {
    float f = vnoise2(vUv * vec2(260.0, 150.0) + vec2(sin(uTime * 0.6) * 2.0, -uTime * 2.4));
    col += vec3(0.85, 0.88, 0.95) * smoothstep(0.86, 0.99, f) * snow * 0.5;
  }

  col += vec3(0.9, 0.95, 1.0) * uFlash * 0.35;

  // Виньетка и зерно — по фотографиям, не «фильтр из приложения».
  vec2 c = vUv - 0.5;
  float vig = 1.0 - max(uPost.z, 0.0) * dot(c, c) * 1.6;
  col *= vig;
  float g = hash12(vUv * uRes + fract(uTime) * 137.0) - 0.5;
  col += g * max(uPost.w, 0.0) * (0.06 + 0.10 * (1.0 - saturate1(lum(col))));

  fragColor = vec4(shadeOutPost(col), 1.0);
}
