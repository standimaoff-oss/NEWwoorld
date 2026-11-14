#include "common.glsl"

in vec3 vRay;

uniform vec4  uClouds;         // x — облачность 0..1, y — высота слоя (м),
                               // z — плотность, w — смещение слоя (по году)
uniform vec3  uCloudTint;      // цвет верхней кромки в полдень
uniform float uMoonPhase;      // 0..1 — фаза луны для ночного неба

out vec4 fragColor;

// Фазовая функция Хенни-Гринштейна: вперёд сильно, назад слабо — солнце
// просвечивает край облака, как на фото.
float hg(float c, float g) {
  float a = g * g;
  return (1.0 - a) / (4.0 * PI * pow(1.0 + a - 2.0 * c * g, 1.5));
}

void main() {
  vec3 rd = normalize(vRay);
  float day = uSun.w;
  vec3 col = skyColor(rd, uSun.xyz, day, mix(2.2, 1.0, day));

  if (rd.y > 0.005 && uClouds.x > 0.001) {
    // Луч через слой: длина пути растёт у горизонта, шаг — с расстоянием.
    float hBase = max(uClouds.y, 400.0);
    float hTop = hBase * 1.55;
    float len = (hTop - hBase) / max(rd.y, 1e-4);
    int steps = 7;
    float cover = uClouds.x;
    vec2 wind = vec2(uTime * 0.9 + uClouds.w, uTime * 0.35);
    float trans = 1.0;
    vec3 scatter = vec3(0.0);
    vec3 sunCol = mix(vec3(0.30, 0.38, 0.55), vec3(1.0, 0.94, 0.84), day);
    float c = dot(rd, uSun.xyz);
    float phase = 0.35 + 0.65 * hg(c, 0.42 * saturate1(day));
    for (int i = 0; i < 8; i++) {
      if (i >= steps) break;
      float k = (float(i) + 0.5) / float(steps);
      float t = k * len;
      vec3 p = rd * t;
      float h = (p.y - hBase) / (hTop - hBase);
      float d = cloudDensity(p.xz, h, wind, cover);
      if (d > 0.001) {
        // Освещённость элемента: пройдём к солнцу двумя шагами — этого хватает,
        // чтобы край облака светился, а середина оставалась серой.
        float dl = 0.0;
        for (int j = 1; j < 3; j++) {
          vec3 q = p + uSun.xyz * float(j) * len * 0.16;
          float hq = (q.y - hBase) / (hTop - hBase);
          dl += cloudDensity(q.xz, hq, wind * 1.15, cover) * (0.6 / float(j));
        }
        float lit = exp(-dl * 1.35);
        float a = 1.0 - exp(-d * uClouds.z * 0.5 / float(steps) * 6.0);
        vec3 cc = mix(uCloudTint * (0.35 + 0.65 * lit), vec3(0.42, 0.44, 0.48), 0.35 * (1.0 - lit));
        cc = mix(cc, vec3(1.0, 0.72, 0.42) * lit, pow(1.0 - day, 2.0) * 0.55);   // закат
        scatter += trans * a * cc * (0.35 + 0.65 * phase) * sunCol;
        trans *= 1.0 - a;
        if (trans < 0.02) break;
      }
    }
    col = col * trans + scatter;
    col = mix(col, uFog.rgb, saturate1(1.0 - rd.y * 3.2) * 0.9);  // дымка у горизонта
  } else if (uFog.w > 0.0005) {
    col = mix(col, uFog.rgb, saturate1(uFog.w * 90.0) * 0.85);
  }

  // Млечный путь и луна ночью — тускло, без «синтетики».
  if (day < 0.3) {
    float night = 1.0 - day / 0.3;
    float band = exp(-pow(abs(dot(rd, normalize(vec3(0.35, 0.55, -0.75)))) * 3.4, 2.0));
    col += vec3(0.030, 0.034, 0.050) * band * night * (0.5 + 0.5 * fbm2(rd.xz * 22.0, 3));
    col += vec3(0.7, 0.75, 0.85) * uMoonPhase * night * 0.02;
  }

  fragColor = vec4(shadeOut(col, uExposure), 1.0);
}
