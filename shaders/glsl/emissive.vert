// Самара/Пекин: светящиеся вывески, фонари, гирлянды, экраны витрин. Шаг 5.33.
//
// Instanced-щиты: геометрия — quad, инстанс несёт положение, размер, поворот,
// наклон и клетку атласа. Днём это крашеный пластик (почти без излучения),
// ночью — эмиссия + bloom. Гирлянда на ёлке мигает по своим законам: не все
// лампы сразу, часть с перебоями.

#include "common.glsl"

in vec3 aPos;             // локально: x — половина ширины щита (-1..1), y — высота 0..1
in vec2 aUv;
in vec4 iPos;             // x, z, высота основания щита над землёй (м), половина ширины (м)
in vec4 iShape;           // поворот вокруг Y, наклон верхней кромки (м), высота щита (м), клетка атласа
in vec4 iExtra;           // зерно, фаза мерцания, яркость, режим (0 вывеска, 1 фонарь, 2 гирлянда)

out vec2  vUv;
out vec3  vWorld;
out vec3  vNormal;
out float vMode;
out float vPhase;
out float vBright;
flat out float vCell;

void main() {
  float rot = iShape.x;
  vec2 right = vec2(cos(rot), sin(rot));
  vec2 nrm2 = vec2(-right.y, right.x);
  float h = max(iShape.z, 0.01);
  float ux = aPos.x * iPos.w;
  float uy = aPos.y * h;
  float lean = iShape.y * aPos.y;            // верхняя кромка отходит от стены

  vec3 p = vec3(iPos.x, iPos.z, iPos.y);     // iPos.xy — план, iPos.z — отметка низа
  p.xz += right * ux + nrm2 * lean;
  p.y += uy;

  vNormal = normalize(vec3(nrm2.x, -iShape.y / h, nrm2.y));
  vWorld = p;
  vUv = aUv;
  vMode = iExtra.w;
  vPhase = iExtra.y;
  vBright = iExtra.z;
  vCell = iShape.w;
  gl_Position = uViewProj * vec4(p, 1.0);
}
