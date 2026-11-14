// Фасады города: вершинная программа. Шаг 5.33 — Пекин заново, с обшарпанностью.
//
// Стена несёт в себе «метровой» UV: u — вдоль стены, v — вверх, оба в метрах.
// Все сетки окон и этажей считаются по ним, поэтому окно не растягивается на
// доме в 9 и в 27 этажей. Данные о стене приходят одним атрибутом aWall:
//   aWall = vec4(тип фасада, высота этажа, ширина окна, семя дома)
//   aSign = vec4(вывеска: id строки в атласе, id колонки, масштаб, светится/нет)

#include "common.glsl"

in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
in vec4 aWall;
in vec4 aSign;

out vec3  vWorld;
out vec3  vNormal;
out vec2  vUv;
out vec4  vWall;
out vec4  vSign;

void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vUv = aUv;
  vWall = aWall;
  vSign = aSign;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
