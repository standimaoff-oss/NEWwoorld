// Экраный треугольник для пост-проходов (SSAO, bloom, дождь на стекле, финал).
// Вершинные данные приходят из uFullscreenQuad (два треугольника, -1..3).

#include "common.glsl"

in vec2 aPos;
out vec2 vUv;

void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
