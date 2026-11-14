// gl.js — минимальная обёртка WebGL2: программы, FBO, текстуры, диагностика.
// Никаких библиотек: тот же GLSL, что читает raylib-сборка, и тот же код можно
// положить в WebView на Android и в WebView2 на Windows без переписывания.
'use strict';

export function createContext(canvas, { antialias = true, power = 'high-performance' } = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias,
    alpha: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,        // для снимков (S) и окна диагностики
    powerPreference: power,
    desynchronized: false,
  });
  if (!gl) throw new Error('WebGL2 недоступен. Нужен браузер 2020+ или --webgl1 (не поддерживается).');
  gl.getExtension('EXT_color_buffer_float');       // HDR-таргеты
  gl.getExtension('OES_texture_float_linear');
  gl.getExtension('EXT_texture_filter_anisotropic');
  return gl;
}

// ------------------------------------------------------------- шейдеры
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Раскрывает #include "x.glsl" и добавляет шапку диалекта. */
export function assemble(sources, name, { es = true, tonemapInPost = 1 } = {}) {
  const seen = new Set();
  const expand = (n, depth) => {
    if (seen.has(n) && n !== 'common.glsl') return '';       // двойные include допустимы только для common
    if (depth > 8) throw new Error(`#include зациклился: ${n}`);
    const src = sources[n];
    if (src === undefined) throw new Error(`нет файла ${n}`);
    seen.add(n);
    return src.replace(/^[ \t]*#include[ \t]*"([^"]+)"[ \t]*$/gm, (_m, inc) => expand(inc, depth + 1));
  };
  let body = expand(name, 0);
  if (!es) {
    body = body.replace(/^[ \t]*precision[ \t]+\w+[ \t]+\w+[ \t]*;[ \t]*$/gm, '')
               .replace(/\b(lowp|mediump|highp)[ \t]+/g, '');
    return `#version 330 core\n#define SHOPSIM_TONEMAP_IN_POST ${tonemapInPost}\n${body}`;
  }
  return `#version 300 es\nprecision highp float;\nprecision highp int;\nprecision mediump sampler3D;\n` +
         `#define SHOPSIM_TONEMAP_IN_POST ${tonemapInPost}\n${body}`;
}

function annotate(src, log) {
  // «ERROR: 0:137: …» → строка с текстом, чтобы в панели было видно, что не так.
  const lines = src.split('\n');
  return log.split('\n').map((l) => {
    const m = l.match(/ERROR:\s*\d+:(\d+):\s*(.*)/);
    if (!m) return l;
    const i = Math.max(0, Math.min(lines.length - 1, +m[1] - 1));
    return `${l}\n      ${i + 1}| ${lines[i]}`;
  }).join('\n');
}

export function makeProgram(gl, vsSrc, fsSrc, label = 'program') {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'нет лога';
      throw new Error(`${label}: шейдер не собрался\n${annotate(src, log)}`);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`${label}: линковка не удалась\n${gl.getProgramInfoLog(p)}`);
  }
  const loc = { u: {}, a: {}, n: {} };
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(p, i);
    const nm = info.name.replace(/\[0\]$/, '');
    loc.u[nm] = gl.getUniformLocation(p, nm);
    loc.n[info.name] = info.size;
  }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(p, i);
    loc.a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return {
    program: p, loc, label,
    // Диагностика: имена, которых нет в программе (обычно — опечатка в контракте),
    // и имена, для которых не пришла текстура. Их показывает панель и тест
    // tests/webgl_contract.mjs.
    missing: new Set(), unbound: new Set(),
    use() { gl.useProgram(p); return this; },
    /** Устанавливает только те uniform'ы, которые реально используются. */
    set(name, ...v) {
      const L = this.loc.u[name];
      if (!L) { if (/^u[A-Z]/.test(name)) this.missing.add(name); return this; }
      switch (v.length) {
        case 1: {
          const x = v[0];
          if (typeof x === 'number') gl.uniform1f(L, x);
          else if (x.length === 2) gl.uniform2fv(L, x);
          else if (x.length === 3) gl.uniform3fv(L, x);
          else if (x.length === 4) gl.uniform4fv(L, x);
          else if (x.length === 9) gl.uniformMatrix3fv(L, false, x);
          else if (x.length === 16) gl.uniformMatrix4fv(L, false, x);
          else gl.uniform1fv(L, x);
          break;
        }
        case 2: gl.uniform2f(L, v[0], v[1]); break;
        case 3: gl.uniform3f(L, v[0], v[1], v[2]); break;
        case 4: gl.uniform4f(L, v[0], v[1], v[2], v[3]); break;
        default: gl.uniform1f(L, v[0]);
      }
      return this;
    },
    tex(name, unit, texture) {
      const L = this.loc.u[name];
      if (!L) { this.missing.add(name); return this; }
      if (!texture) { this.unbound.add(name); return this; }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(texture.target || gl.TEXTURE_2D, texture.tex);
      gl.uniform1i(L, unit);
      return this;
    },
  };
}

// ------------------------------------------------------------------- буферы
export function makeVAO(gl, { attribs, indices, usage = gl.STATIC_DRAW }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const a of attribs) {
    if (a.loc === undefined || a.loc < 0) continue;      // атрибут вырезан компилятором
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, a.usage || usage);
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, a.type || gl.FLOAT, false, a.stride || 0, a.offset || 0);
    if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
    a._buf = buf;
  }
  let ibo = null;
  if (indices) {
    ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, usage);
  }
  gl.bindVertexArray(null);
  return {
    gl, vao, attribs, ibo,
    count: indices ? indices.length : (attribs[0] ? attribs[0].count || 0 : 0),
    // Перезапись динамических потоков без пересоздания VAO (трава, толпы, толпа
    // покупателей): буферы выделяются под максимум, count меняется на лету.
    update(index, data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.attribs[index]._buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    },
  };
}

export function updateInstanced(geo, index, data) {
  const gl = geo.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, geo.attribs[index]._buf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
}

// ---------------------------------------------------------------- текстуры
export function tex2D(gl, { width, height, data, internal = gl.RGBA8, format = gl.RGBA,
                            type = gl.UNSIGNED_BYTE, wrap = gl.REPEAT, min = gl.LINEAR_MIPMAP_LINEAR,
                            mag = gl.LINEAR, mips = true, aniso = 4 }) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data || null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? min : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  if (mips) {
    gl.generateMipmap(gl.TEXTURE_2D);
    const ex = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ex) gl.texParameterf(gl.TEXTURE_2D, ex.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { tex: t, target: gl.TEXTURE_2D, width, height };
}

export function tex3D(gl, { size, data, internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE }) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, internal, size[0], size[1], size[2], 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return { tex: t, target: gl.TEXTURE_3D, size };
}

export async function texImage(gl, url, { srgb = false, flipY = false, mips = true, aniso = 4 } = {}) {
  const img = new Image();
  img.src = url;
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`не загрузился ${url}`)); });
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mips) {
    gl.generateMipmap(gl.TEXTURE_2D);
    const ex = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ex) gl.texParameterf(gl.TEXTURE_2D, ex.TEXTURE_MAX_ANISOTROPY_EXT, aniso);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { tex: t, target: gl.TEXTURE_2D, width: img.width, height: img.height };
}

// ------------------------------------------------------------------- FBO
export function makeFBO(gl, w, h, { color = gl.RGBA16F, depth = true, samples = 0, count = 1 } = {}) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const texs = [];
  for (let i = 0; i < count; i++) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, color, w, h, 0, gl.RGBA,
                  color === gl.RGBA16F || color === gl.RGBA32F ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    texs.push({ tex: t, target: gl.TEXTURE_2D, width: w, height: h });
  }
  let d = null;
  if (depth) {
    d = gl.createRenderbuffer ? gl.createTexture() : null;
    gl.bindTexture(gl.TEXTURE_2D, d);
    if (samples > 0) {
      // MSAA: глубина тоже многоточечная, отдельной текстуры не делаем
      gl.bindTexture(gl.TEXTURE_2D, null);
      d = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, d);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, d, 0);
    }
  }
  if (count > 1) {
    const bufs = [];
    for (let i = 0; i < count; i++) bufs.push(gl.COLOR_ATTACHMENT0 + i);
    gl.drawBuffers(bufs);
  }
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO неполный: 0x${st.toString(16)}`);
  return { fb, color: texs, depthTex: d && d.tex ? { tex: d, target: gl.TEXTURE_2D, width: w, height: h } : (d ? { renderbuffer: d } : null), width: w, height: h, samples };
}

// MSAA-таргет: цвет в renderbuffer, разрешение для блума снимается копированием.
export function makeMSAA(gl, w, h, samples, resolve) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const cb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, cb);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, cb);
  const db = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, db);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`MSAA FBO неполный: 0x${st.toString(16)}`);
  return { fb, color: cb, depth: db, width: w, height: h, samples };
}

export function blitTo(gl, srcFBO, dstFBO, w, h) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFBO);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dstFBO);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

// --------------------------------------------------------------- матрицы
export function mat4() { return new Float32Array(16); }

export function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) * nf; out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function lookAt(out, eye, center, up) {
  let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
  let len = 1 / (Math.hypot(z0, z1, z2) || 1);
  z0 *= len; z1 *= len; z2 *= len;
  let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
  len = Math.hypot(x0, x1, x2);
  if (len < 1e-6) { x0 = 1; x1 = 0; x2 = 0; } else { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }
  const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
  out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
  out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
  out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
  out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
  out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
  out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
  out[15] = 1;
  return out;
}

export function mul4(out, a, b) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] = a[j] * b[i * 4] + a[4 + j] * b[i * 4 + 1] + a[8 + j] * b[i * 4 + 2] + a[12 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

export function invert4(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return out;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
