// Свечение ярких источников (bloom). Шаг 5.33 — без него ночные вывески
// и гирлянда на ёлке выглядят нарисованными.
//
// Две стадии в одном шейдере: x-компонента порога и мягкое размытие по
// девяти точкам. Делается на 1/4 разрешения, поэтому почти бесплатно.

#include "common.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec4  uBloom;          // x — порог яркости, y — коленцо (soft knee),
                               // z — смещение выборки в пикселях, w — сила
uniform vec2  uTexel;

void main() {
  vec2 d = uTexel * max(uBloom.z, 1.0);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      float fi = float(i), fj = float(j);
      float w = 1.0 / (1.0 + fi * fi + fj * fj);
      vec3 c = texture(uSrc, vUv + d * vec2(fi, fj) * 0.5).rgb;
      float lum = max(c.r, max(c.g, c.b));
      float thr = max(uBloom.x, 0.01);
      float knee = max(uBloom.y, 0.001);
      float soft = clamp(lum - thr + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee);
      float e = max(soft, lum - thr) / max(lum, 1e-4);
      sum += c * w * saturate1(e);
      wsum += w;
    }
  }
  fragColor = vec4(sum / max(wsum, 1e-3) * uBloom.w, 1.0);
}
