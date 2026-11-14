// Дождь на стекле. Шаг 5.33, по мотивам shadertoy ltffzl (капли, которые
// ползут вниз, сливаются и тянут за собой дорожку).
//
// Два слоя:
//  • статичные капли на стекле витрины/лобового стекла дрона — с реальным
//    преломлением фона (сдвиг выборки по норме капли) и размытием за каплей;
//  • дорожки от сорвавшихся капель: капля едет, оставляет след, в следе
//    остаются мелкие капли. Считается процедурно по времени — без симуляции
//    на GPU, поэтому работает и на телефоне.
//
// Используется как пост-проход поверх экрана (вид из магазина, из автобуса)
// и как материал стекла в facade.frag (там только блик).

#include "common.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;      // то, что за стеклом (линейный HDR до тонмаппинга)
uniform vec2  uRes;            // разрешение экрана
uniform vec4  uRainParam;      // x — сила дождя 0..1, y — размер капель,
                               // z — размытие за стеклом, w — «пальцы» и разводы
uniform float uThrough;        // 1 — смотрим сквозь стекло (витрина), 0 — просто на камере

// Капельная сетка: в каждой ячейке капля своего размера и со своим «таймером».
float dropField(vec2 uv, float scale, float t, out vec2 offset) {
  vec2 g = uv * scale;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float h = hash12(id);
  // Капля растёт, отрывается, и на её месте снова маленькая.
  float life = fract(h * 7.13 + t * (0.22 + 0.5 * h));
  float r = mix(0.06, 0.42, life) * (0.5 + 0.5 * hash12(id + 3.7));
  // Ползущая капля съезжает вниз и тянет след.
  float slide = step(0.62, h) * life;
  vec2 c = f - vec2(0.5 + sin(id.y * 12.0 + t * 2.0) * 0.05, 0.5 + slide * 0.35);
  float d = length(c / vec2(1.0, 1.25));
  float drop = smoothstep(r, r * 0.55, d);
  // Преломление: сдвиг выборки — как у линзы, плюс переворот в центре.
  offset = (d < r) ? -c * (1.0 - d / max(r, 1e-4)) * 0.16 * r : vec2(0.0);
  // След: тонкая полоска выше капли с мелкими бусинами.
  float trail = step(0.62, h) * smoothstep(0.16, 0.0, abs(c.x)) *
                step(0.0, c.y) * step(c.y, 1.0) * 0.55;
  float beads = step(0.78, hash12(id + floor(vec2(f.x, f.y - c.y) * 20.0))) * trail;
  return max(drop, beads);
}

void main() {
  vec2 uv = vUv;
  float rain = uRainParam.x;
  float t = uTime;

  vec2 off1;
  float d1 = dropField(uv * vec2(uRes.x / uRes.y, 1.0), max(uRainParam.y, 4.0), t, off1);
  vec2 off2;
  float d2 = dropField(uv * vec2(uRes.x / uRes.y, 1.0) * 0.42 + 17.0,
                       max(uRainParam.y * 0.45, 2.0), t * 0.7, off2);
  float drops = clamp(d1 + d2, 0.0, 1.0);
  vec2 off = clamp((off1 + off2 * 0.7) * rain, vec2(-0.06), vec2(0.06));

  // Что за стеклом: крупный дождь — сильное размытие, капли показывают чётко.
  float blur = mix(uRainParam.z * (0.35 + 0.65 * rain), 0.0, drops) * uThrough;
  vec2 px = blur / max(uRes, vec2(1.0));
  vec3 bg = vec3(0.0);
  // Пять выборок по кругу вместо гауссиана — на телефоне быстрее.
  bg += texture(uScene, uv + off).rgb;
  bg += texture(uScene, uv + off + px * vec2(1.0, 0.6)).rgb;
  bg += texture(uScene, uv + off - px * vec2(1.0, 0.6)).rgb;
  bg += texture(uScene, uv + off + px * vec2(-0.6, 1.0)).rgb;
  bg += texture(uScene, uv + off + px * vec2(0.6, -1.0)).rgb;
  bg *= 0.2;

  // Капля работает как линза: в центре изображение перевёрнуто и светлее.
  vec3 lens = texture(uScene, uv + off * 2.4 - vec2(0.0, 0.004 * rain)).rgb;
  bg = mix(bg, lens * 1.12 + vec3(0.008), drops * 0.85);

  // Плёнка воды на стекле и разводы: тёмные пальцы, радужные края.
  float sheet = vnoise2(uv * vec2(9.0, 13.0) + t * 0.15) * 0.5 +
                ridge2(uv * vec2(3.0, 8.0) - t * 0.06, 3) * 0.5;
  bg *= 1.0 - 0.18 * rain * sheet * uThrough;
  bg += vec3(0.02, 0.03, 0.05) * rain * uThrough * 0.6;   // отражение комнаты/неба

  // Потеки «пальцев» после рук — только в витринах.
  float smudge = smoothstep(0.55, 0.95, vnoise2(uv * 4.0 + 7.0)) * uRainParam.w;
  bg = mix(bg, bg * 0.86 + vec3(0.012), smudge * 0.5);

  // Блик капли от солнца или лампы: короткая белая точка у верхней кромки.
  float glint = drops * saturate1(dot(normalize(vec3(off * 9.0, 1.0)), uSun.xyz)) *
                (0.25 + 0.75 * uSun.w);
  bg += vec3(0.7, 0.75, 0.85) * glint * 0.14;

  // Струи по самому стеклу — вертикальные полосы, бегущие вниз.
  float streak = smoothstep(0.86, 1.0, vnoise2(vec2(uv.x * 220.0, uv.y * 3.0 - t * 9.0))) * rain;
  bg += vec3(0.05) * streak;

  fragColor = vec4(bg, 1.0);
}
