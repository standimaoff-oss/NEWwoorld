// Покрытия: асфальт, плитка, дёрн, песок, грунт. Шаг 5.33.
//
// Один проход на всю землю: в layer-текстуре (RGBA) лежат индексы покрытий и
// плотность травы, поэтому трава растёт «везде, где дёрн», без отдельной
// генерации масок. После дождя — лужи по высотам из той же текстуры (a — глубина
// впадин), в них отражается небо и огни города.

#include "common.glsl"

in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;              // метры
out vec3  vWorld;
out vec3  vNormal;
out vec2  vUv;

void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
