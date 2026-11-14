// Растительность средней крупности: фрагментная программа. Шаг 5.33.
//
// Виды: 0 куст спиреи, 1 бирючина, 2 папоротник, 3 бамбук (стебель + листва),
// 4 пальмовое перо, 5 луговые цветы, 6 еловая лапа, 7 сухая трава-каркас,
// 8 стриженый самшит. У каждого свой цвет, прозрачность листа и своя
// светопропускаемость — «пластиковых» зелёнок в игре быть не должно.

#include "common.glsl"

uniform sampler2D uVegAtlas;    // атлас листовых карт: rgb + alpha
uniform sampler2D uVegRough;    // шероховатость и подповерхностное свечение
uniform vec4  uVegParam;        // x — клеток в ряду, y — сила просвета,
                                 // z — расстояние до «схлопывания» в точку, w — тень от зданий
uniform vec4  uSeason;         // x лето, y осень, z зима, w весна

in vec2  vUv;
in float vY;
in vec3  vWorld;
in float vFacing;
in float vAO;
in float vWet;
flat in int vType;

out vec4 fragColor;

vec3 typeTint(int t) {
  if (t == 0) return vec3(0.058, 0.090, 0.034);   // спирея
  if (t == 1) return vec3(0.038, 0.064, 0.028);   // бирючина, темнее
  if (t == 2) return vec3(0.048, 0.080, 0.030);   // папоротник
  if (t == 3) return vec3(0.115, 0.110, 0.056);   // бамбук: стебель соломенный
  if (t == 4) return vec3(0.052, 0.088, 0.032);   // пальма
  if (t == 5) return vec3(0.075, 0.098, 0.045);   // разнотравье с цветами
  if (t == 6) return vec3(0.022, 0.044, 0.028);   // ель
  if (t == 7) return vec3(0.150, 0.132, 0.078);   // сухостой
  return vec3(0.043, 0.072, 0.030);                // самшит
}

void main() {
  float cells = max(uVegParam.x, 1.0);
  vec2 uv = (vec2(mod(float(vType), cells), floor(float(vType) / cells)) + vUv) /
            vec2(cells, ceil(9.0 / cells));
  vec4 tex = texture(uVegAtlas, clamp(uv, vec2(0.001), vec2(0.999)));
  if (tex.a < 0.42) discard;
  float edge = smoothstep(0.42, 0.72, tex.a);

  vec3 tint = typeTint(vType);
  // Осень: листва уходит в охру, хвоя и бамбук остаются зелёными, сухостой белеет.
  float ft = float(vType);
  float broadleaf = step(ft, 2.5) + step(3.5, ft) * step(ft, 5.5);
  vec3 season = vec3(1.0) + uSeason.y * vec3(0.55, 0.10, -0.35) * broadleaf +
                uSeason.z * vec3(-0.35, -0.25, -0.10) + uSeason.w * vec3(-0.10, 0.08, 0.02);
  vec3 albedo = srgb2lin(tex.rgb) * tint * 1.35 * season;
  float rough = texture(uVegRough, clamp(uv, vec2(0.001), vec2(0.999))).r;
  float wet = clamp(uWeather.y * 0.7 + vWet * 0.3, 0.0, 1.0);
  albedo *= 1.0 - 0.32 * wet;
  rough = mix(rough, 0.22, wet * 0.7);

  vec2 face = vec2(cos(vFacing), sin(vFacing));
  vec3 N = normalize(vec3(face.x * 0.8, 0.55 + 0.4 * vY, face.y * 0.8));
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = uSun.xyz;
  float day = uSun.w;
  float NdL = dot(N, L);

  vec3 sunCol = mix(vec3(0.30, 0.38, 0.55), vec3(1.05, 0.95, 0.82), day);
  float skyVis;
  vec3 gi = giWorld(vWorld, N, skyVis);
  float occ = mix(1.0, 0.42 + 0.58 * skyVis, uVegParam.w);

  float wrap = saturate1((NdL + 0.4) / 1.4);
  // Просвет листа: на солнце край листвы светится — то, чего не хватает
  // «кубическим» деревьям.
  float trans = pow(saturate1(-NdL), 1.5) * saturate1(1.0 - abs(dot(V, L)));
  vec3 diff = albedo * sunCol * (wrap * 0.9 + uVegParam.y * trans * 0.8) * occ * day;
  vec3 amb = albedo * (mix(vec3(0.020, 0.030, 0.052), uSkyTint.rgb, day) *
                       (0.45 + 0.55 * skyVis) + gi * 0.85);
  vec3 spec = sunCol * ggx(N, V, L, max(rough, 0.05)) * 0.35 * occ * day;
  vec3 col = diff + amb + spec * fresnel(saturate1(dot(N, V)), 0.04);
  col += gi * albedo * 0.5;

  // Дальний план: на большом расстоянии карта «схлопывается» в пятна —
  // иначе алфа-тест мерцает на субпикселях.
  float dist = length(uCamPos - vWorld);
  float far = smoothstep(0.6, 1.0, dist / max(uVegParam.z, 20.0));
  col = mix(col, col * (0.8 + 0.2 * tex.a), far);
  edge = mix(edge, 1.0, far);

  col = applyFog(col, dist, uFog.rgb, uFog.w, day);
  fragColor = vec4(shadeOut(col, uExposure), edge);
}
