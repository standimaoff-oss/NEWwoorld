#!/usr/bin/env node
/**
 * validate_models.mjs — проверка .glb/.gltf до того, как они попадут в игру.
 *
 * ЗАЧЕМ. Godot импортирует почти любой glTF, включая сломанный: модель с
 * отрицательными масштабами выворачивается наизнанку, материал без PBR
 * становится белым пластиком, текстура 8192×8192 съедает 256 МБ
 * видеопамяти. Ни одно из этого не ошибка импорта — игра просто выглядит
 * плохо, и причину ищут в движке, хотя она в файле модели.
 *
 * ПРОВЕРЯЕТСЯ:
 *   1. соответствие спецификации glTF 2.0 (официальный валидатор Khronos);
 *   2. размеры: число треугольников, вершин, текстур, узлов;
 *   3. наличие и тип сжатия геометрии (draco/meshopt) — модель без сжатия
 *      в репозитории почти наверняка не прошла конвейер;
 *   4. формат текстур и их разрешение;
 *   5. материалы: metallic-roughness обязателен, specular-glossiness устарел
 *      и в Godot 4 не поддерживается корректно;
 *   6. отрицательные/нулевые масштабы узлов;
 *   7. имена: кириллица и пробелы в именах узлов ломают поиск по имени в
 *      GDScript и превращаются в «%20» в путях.
 *
 * Использование:
 *   node validate_models.mjs <каталог|файл> [--strict] [--max-triangles=N]
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname, resolve } from 'node:path';

import { NodeIO, Logger, Verbosity } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspect } from '@gltf-transform/functions';
import validator from 'gltf-validator';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);

// Бюджеты. Взяты из ТЗ: «оптимизированные 3D glb-модели». Число — не
// догма, но оно обязано быть зафиксированным: без порога фраза
// «модель оптимизирована» не проверяема.
const LIMITS = {
  maxTriangles: 250_000,   // одна модель уровня (не весь уровень)
  maxVertices: 200_000,
  maxTextures: 32,
  maxTextureDimension: 4096,
  maxNodes: 512,
  maxFileBytes: 12 * 1024 * 1024,
  warnFileBytes: 4 * 1024 * 1024,
};

// Устаревшее расширение материалов. В Godot 4 оно конвертируется с
// потерями, поэтому модель с ним надо пересохранять в metallic-roughness.
const DEPRECATED_EXTENSIONS = ['KHR_materials_pbrSpecularGlossiness'];

function parseArgs(argv) {
  const options = { strict: false, ...LIMITS };
  const paths = [];
  for (const arg of argv) {
    if (arg === '--strict') options.strict = true;
    else if (arg.startsWith('--max-triangles=')) options.maxTriangles = Number(arg.slice(16));
    else if (arg.startsWith('--max-texture=')) options.maxTextureDimension = Number(arg.slice(16));
    else if (arg.startsWith('--')) throw new Error(`неизвестный флаг: ${arg}`);
    else paths.push(arg);
  }
  if (!paths.length) throw new Error('не указан каталог или файл');
  return { options, paths };
}

async function collectFiles(target) {
  const info = await stat(target).catch(() => null);
  if (!info) return [];
  if (info.isFile()) {
    return MODEL_EXTENSIONS.has(extname(target).toLowerCase()) ? [target] : [];
  }
  const found = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(full));
    else if (MODEL_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full);
  }
  return found.sort();
}

async function createIO() {
  // Декодер обязателен: модели в репозитории уже сжаты конвейером, и
  // прочитать их без meshopt-декодера нельзя.
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.decoder': MeshoptDecoder,
    });
  io.setLogger(new Logger(Verbosity.ERROR));
  return io;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

/** Проверяет один файл и возвращает список проблем: {level, message}. */
async function validateFile(path, io, options) {
  const problems = [];
  const add = (level, message) => problems.push({ level, message });

  const bytes = await readFile(path);
  const size = bytes.byteLength;
  if (size > options.maxFileBytes) {
    add('error', `размер ${formatBytes(size)} превышает лимит `
      + `${formatBytes(options.maxFileBytes)} — пропустите через optimize_models.mjs`);
  } else if (size > options.warnFileBytes) {
    add('warn', `размер ${formatBytes(size)} больше рекомендуемых `
      + `${formatBytes(options.warnFileBytes)}`);
  }

  // --- 1. официальная валидация спецификации ------------------------------
  try {
    const report = await validator.validateBytes(new Uint8Array(bytes));
    // severity 0 = error, 1 = warning, 2 = info в отчёте Khronos.
    const errors = report.issues?.numErrors ?? 0;
    const warnings = report.issues?.numWarnings ?? 0;
    const infos = report.issues?.numInfos ?? 0;
    if (errors > 0) {
      const messages = (report.issues?.messages || [])
        .filter((m) => m.severity === 0).slice(0, 5)
        .map((m) => `${m.pointer || '/'}: ${m.message}`);
      add('error', `glTF-валидатор: ${errors} ошибк(а/и)${messages.length
        ? ` — ${messages.join('; ')}` : ''}`);
    }
    if (warnings > 0) add('warn', `glTF-валидатор: ${warnings} предупреждений`);
    if (infos > 0) add('info', `glTF-валидатор: ${infos} информационных сообщений`);
  } catch (error) {
    add('error', `glTF-валидатор не смог прочитать файл: ${error.message}`);
    return problems;
  }

  // --- 2..7. разбор структуры через gltf-transform ------------------------
  let document;
  try {
    // readBinary принимает Uint8Array, а не ArrayBuffer. Node-Buffer
    // является Uint8Array, но передавать .buffer нельзя: это взгляд на
    // весь выделенный пул, и glTF-заголовок читается со смещения.
    document = await io.readBinary(new Uint8Array(bytes));
  } catch (error) {
    add('error', `файл не читается как glTF: ${error.message}`);
    return problems;
  }

  // Отчёт inspect() в @gltf-transform 4.5.1: каждый раздел — объект со
  // списком .properties. Треугольники считаются по glPrimitives мешей, а
  // не по «primitives» верхнего уровня — такого поля здесь нет.
  const report = inspect(document);
  const meshProperties = report.meshes?.properties ?? [];
  const triangles = meshProperties.reduce((sum, mesh) => sum + (mesh.glPrimitives ?? 0), 0);
  const vertices = meshProperties.reduce((sum, mesh) => sum + (mesh.vertices ?? 0), 0);

  if (triangles > options.maxTriangles) {
    add('error', `треугольников ${Math.round(triangles)} при лимите ${options.maxTriangles}`);
  } else if (triangles > options.maxTriangles * 0.6) {
    add('warn', `треугольников ${Math.round(triangles)} — больше половины бюджета`);
  }
  if (vertices > options.maxVertices) {
    add('error', `вершин ${vertices} при лимите ${options.maxVertices}`);
  }

  const extensions = document.getRoot().listExtensionsUsed()
    .map((ext) => ext.extensionName);
  const required = document.getRoot().listExtensionsRequired()
    .map((ext) => ext.extensionName);

  for (const name of DEPRECATED_EXTENSIONS) {
    if (extensions.includes(name)) {
      add('error', `устаревшее расширение ${name}: пересохраните материал `
        + 'в metallic-roughness, Godot 4 конвертирует его с потерями');
    }
  }

  // Сжатие геометрии. Его отсутствие — не ошибка спецификации, но верный
  // признак того, что файл не проходил конвейер.
  const hasGeometryCompression = extensions.includes('EXT_meshopt_compression')
    || extensions.includes('KHR_draco_mesh_compression');
  if (!hasGeometryCompression && triangles > 1000) {
    add('warn', 'геометрия не сжата (нет EXT_meshopt_compression / '
      + 'KHR_draco_mesh_compression) — запустите optimize_models.mjs');
  }
  if (extensions.includes('EXT_meshopt_compression')
      && extensions.includes('KHR_draco_mesh_compression')) {
    add('warn', 'включены ОБА сжатия геометрии — нужно одно');
  }
  for (const name of required) {
    if (name === 'KHR_draco_mesh_compression') {
      add('info', `геометрия сжата Draco; extensionsRequired: ${required.join(', ')}`);
    }
  }

  // --- текстуры ------------------------------------------------------------
  const textures = document.getRoot().listTextures();
  if (textures.length > options.maxTextures) {
    add('error', `текстур ${textures.length} при лимите ${options.maxTextures}`);
  }
  for (const texture of textures) {
    const sizeInfo = texture.getSize();
    const [width, height] = sizeInfo || [0, 0];
    if (Math.max(width, height) > options.maxTextureDimension) {
      add('error', `текстура «${texture.getName() || '?'}» ${width}×${height} `
        + `больше лимита ${options.maxTextureDimension}px`);
    }
    const mimeType = texture.getMimeType();
    // PNG допустим для масок и небольших карт, но альбедо/нормали в PNG
    // занимают в разы больше. Предупреждаем, а не запрещаем: решение
    // принимает художник.
    if (mimeType === 'image/png' && width * height > 1024 * 1024) {
      add('warn', `текстура «${texture.getName() || '?'}» ${width}×${height} в PNG — `
        + 'конвертируйте в WebP/KTX2');
    }
  }

  // --- узлы ----------------------------------------------------------------
  const nodes = document.getRoot().listNodes();
  if (nodes.length > options.maxNodes) {
    add('warn', `узлов ${nodes.length} при лимите ${options.maxNodes} — `
      + 'объедините статику через flatten/join');
  }

  const badNames = [];
  for (const node of nodes) {
    const name = node.getName();
    if (!name) continue;
    // Кириллица и пробелы в именах узлов: GDScript ищет узел по точному
    // имени, а экспортеры заменяют пробелы на «_» или кодируют их —
    // в результате get_node() молча возвращает null.
    if (/[\s]/.test(name) || /[^\x00-\x7F]/.test(name)) badNames.push(name);
    // Отрицательный масштаб выворачивает нормали наизнанку: модель
    // выглядит целой, но освещается как вывернутый носок.
    const scale = node.getScale();
    if (scale.some((component) => component < 0)) {
      add('error', `узел «${name}» имеет отрицательный масштаб ${scale.join(', ')}`);
    }
    if (scale.some((component) => component === 0)) {
      add('error', `узел «${name}» имеет нулевой масштаб — он не отрисуется`);
    }
  }
  if (badNames.length) {
    add('warn', `имена узлов с пробелами/не-ASCII: ${badNames.slice(0, 5).join(', ')}`
      + (badNames.length > 5 ? ` …и ещё ${badNames.length - 5}` : ''));
  }

  // --- материалы -----------------------------------------------------------
  for (const material of document.getRoot().listMaterials()) {
    const name = material.getName() || '?';
    const baseColor = material.getBaseColorTexture();
    if (!baseColor && material.getBaseColorFactor().slice(0, 3)
      .every((component) => component === 1)) {
      add('info', `материал «${name}» без текстуры и чисто белый — `
        + 'возможно, не назначен albedo');
    }
    const normalTexture = material.getNormalTexture();
    if (normalTexture) {
      const info = material.getNormalTextureInfo();
      if (info && info.getTexCoord() > 1) {
        add('warn', `материал «${name}»: normal map на UV-наборе ${info.getTexCoord()}`);
      }
    }
    // Double-sided вдвое дороже: каждый треугольник рисуется дважды.
    if (material.getDoubleSided()) {
      add('info', `материал «${name}» двусторонний — проверьте, что это нужно`);
    }
  }

  return problems;
}

async function main() {
  const { options, paths } = parseArgs(process.argv.slice(2));
  const io = await createIO();

  const files = [];
  for (const target of paths) files.push(...await collectFiles(resolve(target)));

  if (!files.length) {
    console.log('Модели .glb/.gltf не найдены — проверять нечего.');
    console.log('Для пустого проекта это норма: конвейер готов, ассетов пока нет.');
    return 0;
  }

  console.log(`Валидация моделей: ${files.length} файл(ов)`);
  console.log(`  лимиты: ${options.maxTriangles} треугольников, `
    + `${options.maxTextureDimension}px текстуры, `
    + `${formatBytes(options.maxFileBytes)} на файл`);
  console.log();

  let errors = 0;
  let warnings = 0;

  for (const file of files) {
    const problems = await validateFile(file, io, options);
    const fileErrors = problems.filter((p) => p.level === 'error');
    const fileWarnings = problems.filter((p) => p.level === 'warn');
    errors += fileErrors.length;
    warnings += fileWarnings.length;

    const mark = fileErrors.length ? '✗' : (fileWarnings.length ? '!' : '✓');
    console.log(`  ${mark} ${basename(file)}`);
    for (const problem of problems) {
      const tag = problem.level.toUpperCase().padEnd(5);
      console.log(`      [${tag}] ${problem.message}`);
    }
  }

  console.log();
  const failed = errors > 0 || (options.strict && warnings > 0);
  if (failed) {
    console.log(`МОДЕЛИ: ошибок ${errors}, предупреждений ${warnings}`);
    return 1;
  }
  console.log(`OK: модели соответствуют требованиям (предупреждений: ${warnings})`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ОШИБКА: ${error.message}`);
    process.exit(2);
  });
