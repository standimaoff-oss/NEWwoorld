#!/usr/bin/env node
/**
 * optimize_models.mjs — оптимизация .glb/.gltf под рантайм.
 *
 * ЗАЧЕМ ЭТО НУЖНО. Модель из Blender весит 40 МБ и содержит:
 *   * дубликаты текстур и аксессоров,
 *   * неиспользуемые материалы, анимации, сцены,
 *   * float32-координаты там, где хватает int16,
 *   * несжатые PNG по 4 КБ на пиксель,
 *   * треугольники, не упорядоченные под кэш GPU.
 * В рантайме это минуты загрузки и сотни мегабайт видеопамяти.
 * После конвейера та же модель занимает 3–8 МБ и выглядит идентично.
 *
 * ПОРЯДОК ОПЕРАЦИЙ ВАЖЕН:
 *   1. dedup/prune  — сначала убираем мусор, иначе сварка и упрощение
 *                     работают вдвое дольше над тем, что будет удалено;
 *   2. weld         — свариваем вершины: simplify требует индексированную
 *                     геометрию, иначе упрощение рвёт меш;
 *   3. simplify     — уменьшаем число треугольников (опционально, по порогу);
 *   4. tangents     — считаем тангенты: для normal mapping они обязательны,
 *                     а в экспорте из DCC их часто нет;
 *   5. textureCompress — KTX2/Basis: сжатие с GPU-декодированием, текстура
 *                     не распаковывается в памяти целиком;
 *   6. quantize     — int16 вместо float32 для позиций/нормалей/UV;
 *   7. reorder      — порядок треугольников под кэш (meshoptimizer);
 *   8. draco ИЛИ meshopt — сжатие геометрии. ВЗАИМОИСКЛЮЧАЮЩИЕ: оба
 *                     расширения делают одно и то же, а поддержка в движках
 *                     различается. Godot 4 поддерживает оба, meshopt
 *                     декодируется быстрее и не требует отдельного декодера.
 *
 * Использование:
 *   node optimize_models.mjs <каталог|файл> [--target=meshopt|draco]
 *                            [--ratio=0.75] [--max-texture=2048] [--dry-run]
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, basename, extname, resolve } from 'node:path';

import { NodeIO, Logger, Verbosity } from '@gltf-transform/core';
// ALL_EXTENSIONS покрывает KHR_draco_mesh_compression, EXT_meshopt_compression
// и KHR_texture_basisu — подключать их по отдельности не нужно, а лишние
// импорты создают ложное впечатление, что расширения настраиваются здесь.
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, unweld, simplify, normals, tangents, textureCompress,
  quantize, reorder, meshopt, draco, inspect, flatten,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
// Encoder и Decoder — РАЗНЫЕ объекты. Подстановка энкодера на место
// декодера не падает при установке зависимостей, а падает позже с
// «decodeGltfBuffer is not a function» — то есть при ПОВТОРНОМ прогоне
// конвейера по уже оптимизированной модели. Ошибка выглядит как
// «инструмент сломался», хотя причина — перепутанные роли.
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
// tangents() не умеет считать тангенты сам: ему нужен колбэк MikkTSpace.
// Без этого параметра шаг падает с «generateTangents callback required»,
// хотя пакет mikktspace установлен — зависимость НЕ транзитивная, поэтому
// объявлена в package.json явно.
import { generateTangents } from 'mikktspace';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);

// Настройки по умолчанию. Вынесены константами, потому что «оптимизация»
// без зафиксированных параметров непредсосуема: два прогона дают разный
// результат, и выяснить, кто испортил модель, невозможно.
const DEFAULTS = {
  target: 'meshopt',
  // Доля треугольников после упрощения. 1.0 = не упрощать.
  ratio: 1.0,
  // Ошибка упрощения в долях размера модели. Больше 0.01 уже видно глазом.
  error: 0.001,
  maxTexture: 2048,
  // WebP, а не KTX2. Формально KTX2/Basis лучше: текстура остаётся сжатой
  // в видеопамяти и декодируется на GPU. Но кодирование в KTX2 требует
  // внешнего набора инструментов KTX-Software (toktx, basisu), которого нет
  // ни в этой среде, ни в стандартном CI-раннере. WebP кодируется
  // установленным здесь sharp, поддерживается Godot 4 нативно и даёт
  // 25–40% экономии против PNG. KTX2 включается флагом --format=ktx2,
  // когда тулчейн доступен.
  textureFormat: 'webp',
  quantize: true,
  flatten: true,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const paths = [];
  for (const arg of argv) {
    if (arg.startsWith('--target=')) options.target = arg.slice(9);
    else if (arg.startsWith('--ratio=')) options.ratio = Number(arg.slice(8));
    else if (arg.startsWith('--error=')) options.error = Number(arg.slice(8));
    else if (arg.startsWith('--max-texture=')) options.maxTexture = Number(arg.slice(14));
    else if (arg.startsWith('--format=')) options.textureFormat = arg.slice(9);
    else if (arg === '--no-quantize') options.quantize = false;
    else if (arg === '--webp') options.textureFormat = 'webp';
    else if (arg === '--ktx2') options.textureFormat = 'ktx2';
    else if (arg === '--no-flatten') options.flatten = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`неизвестный флаг: ${arg}`);
    else paths.push(arg);
  }
  if (!paths.length) throw new Error('не указан каталог или файл');
  if (options.target !== 'meshopt' && options.target !== 'draco') {
    throw new Error(`--target должен быть meshopt или draco, получено «${options.target}»`);
  }
  if (!(options.ratio > 0 && options.ratio <= 1)) {
    throw new Error(`--ratio должен быть в (0; 1], получено ${options.ratio}`);
  }
  return { options, paths };
}

async function collectFiles(target) {
  const info = await stat(target).catch(() => null);
  if (!info) return [];
  if (info.isFile()) {
    return MODEL_EXTENSIONS.has(extname(target).toLowerCase()) ? [target] : [];
  }
  const found = [];
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(full));
    else if (MODEL_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full);
  }
  return found.sort();
}

async function createIO() {
  // Декодер Draco нужен, чтобы ЧИТАТЬ уже сжатые модели: повторный прогон
  // по оптимизированному файлу без декодера упадёт, и модель окажется
  // «испорченной» на ровном месте.
  const dracoDecoder = await draco3d.createDecoderModule();
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': dracoDecoder,
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });
  io.setLogger(new Logger(Verbosity.WARN));
  return io;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

/**
 * Нужен ли расчёт нормалей: хотя бы один примитив без атрибута NORMAL.
 */
function needsNormals(document) {
  return document.getRoot().listMeshes().some((mesh) => mesh.listPrimitives()
    .some((primitive) => primitive.getAttribute('POSITION') && !primitive.getAttribute('NORMAL')));
}

/**
 * Можно ли считать тангенты: нужны POSITION и TEXCOORD_0.
 *
 * NORMAL здесь сознательно НЕ проверяется. Проверка выполняется до запуска
 * конвейера, а нормали может добавить предыдущий шаг — на этом этапе их
 * legitimately ещё нет.
 *
 * КРИТИЧНО: `tangents()` из @gltf-transform 4.5.1 пропускает примитив, если
 * у него ЕСТЬ индексы (см. filterPrimitive в исходниках пакета: «primitives
 * must be unwelded»). То есть на сваренной геометрии тангенты не считаются
 * НИКОГДА — шаг печатает предупреждение и ничего не делает. Разработчик
 * видит «No qualifying primitives found», считает это несущественным и
 * получает модель без тангентов, из-за которой normal mapping выглядит
 * криво. Причина при этом ищется в шейдере, а не в конвейере.
 * Поэтому перед tangents геометрия принудительно разваривается.
 */
function canComputeTangents(document) {
  return document.getRoot().listMeshes().some((mesh) => mesh.listPrimitives()
    .some((primitive) => primitive.getAttribute('POSITION')
      && primitive.getAttribute('TEXCOORD_0')));
}

/**
 * Собирает цепочку преобразований под выбранные параметры.
 *
 * ПОРЯДОК ВЫВЕДЕН ИЗ ИСХОДНИКОВ ПАКЕТА И ПРОВЕРЕН ИЗМЕРЕНИЕМ, а не взят из
 * документации. Три неочевидных места:
 *
 * 1. simplify требует СВАРЕННУЮ геометрию (иначе рвёт меш на куски),
 *    а tangents требует РАЗВАРЕННУЮ. Значит между ними обязателен переход.
 *    `normals()` разваривает сам (внутри вызывает unweld), но он запускается
 *    только когда нормалей нет. Если нормали уже были, разваривание
 *    приходится делать явно — иначе тангенты молча не посчитаются.
 *
 * 2. reorder требует сваренную геометрию: на разваренной печатает
 *    «No qualifying primitives found; may need to weld first».
 *
 * 3. Квантование идёт ПОСЛЕ переупорядочивания. Измерено на модели
 *    800 треугольников с текстурой 1024×1024:
 *      quantize -> reorder        : 693 948 байт, reorder предупреждает
 *      weld -> reorder -> quantize: 679 044 байт, предупреждений нет
 *    Квантование меняет значения атрибутов и может пересчитать вершины,
 *    отменив кэш-оптимальный порядок треугольников.
 */
function buildPipeline(options, notes, document) {
  const steps = [];

  if (options.flatten) {
    // Выстраивает иерархию узлов в линейную: после экспорта из DCC модель
    // часто несёт десятки пустых узлов-трансформов, каждый из которых
    // стоит матричного умножения на кадр.
    steps.push(flatten());
  }
  steps.push(dedup());
  steps.push(prune({ keepAttributes: true, keepIndices: true, keepSolidTextures: false }));

  if (options.ratio < 1.0) {
    steps.push(weld());
    steps.push(simplify({
      simplifier: MeshoptSimplifier,
      ratio: options.ratio,
      error: options.error,
    }));
  } else {
    steps.push(weld());
  }

  const wantNormals = needsNormals(document);
  if (wantNormals) {
    // normals() внутри вызывает unweld(), поэтому после него геометрия
    // разварена — ровно то, что нужно следующему шагу.
    steps.push(normals());
    notes.push('рассчитаны плоские нормали (в файле их не было)');
  }

  if (canComputeTangents(document)) {
    if (!wantNormals) {
      // Нормали уже были, значит normals() не запускался и геометрия всё
      // ещё сварена. Без явного разваривания tangents() пропустит все
      // примитивы.
      steps.push(unweld());
    }
    steps.push(tangents({ generateTangents, overwrite: true }));
    notes.push('рассчитаны тангенты (MikkTSpace)');
  } else {
    notes.push('тангенты НЕ рассчитаны: нет TEXCOORD_0 — normal mapping невозможен');
  }

  if (options.maxTexture > 0) {
    steps.push(textureCompress({
      resize: [options.maxTexture, options.maxTexture],
      targetFormat: options.textureFormat,
      quality: 80,
      powerOfTwo: false,
    }));
  }

  steps.push(weld());
  steps.push(reorder({ encoder: MeshoptEncoder }));

  if (options.quantize) {
    steps.push(quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8,
      quantizeWeight: 8,
    }));
  }

  if (options.target === 'draco') {
    steps.push(draco({ method: 'edgebreaker', quantizePosition: 14 }));
  } else {
    steps.push(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  }

  return steps;
}

async function optimizeFile(path, io, options) {
  const originalBytes = await readFile(path);
  const before = originalBytes.byteLength;

  // readBinary ждёт Uint8Array. Передача .buffer даёт «Method requires
  // Uint8Array parameter; received "object"» — ошибку, которую невозможно
  // угадать по сигнатуре, поэтому она зафиксирована здесь.
  const document = await io.readBinary(new Uint8Array(originalBytes));

  const reportBefore = inspect(document);
  await MeshoptSimplifier.ready;
  const notes = [];
  const pipeline = buildPipeline(options, notes, document);
  await document.transform(...pipeline);
  const reportAfter = inspect(document);

  // Пишем всегда в .glb: один файл вместо .gltf + bin + textures проще
  // отслеживать в git (LFS), сложнее потерять и быстрее загружать.
  const outputPath = options.dryRun
    ? path
    : path.replace(/\.(glb|gltf)$/i, '.glb');
  const buffer = await io.writeBinary(document);

  if (!options.dryRun) await writeFile(outputPath, Buffer.from(buffer));

  return {
    path,
    outputPath,
    before,
    after: buffer.byteLength,
    beforeMeshes: reportBefore.meshes?.properties?.length ?? 0,
    afterMeshes: reportAfter.meshes?.properties?.length ?? 0,
    beforeTriangles: countTriangles(reportBefore),
    afterTriangles: countTriangles(reportAfter),
    beforeTextures: reportBefore.textures?.properties?.length ?? 0,
    afterTextures: reportAfter.textures?.properties?.length ?? 0,
    notes,
  };
}

function countTriangles(report) {
  // report.meshes — объект со списком .properties, а не массив.
  const properties = report?.meshes?.properties;
  if (!Array.isArray(properties)) return 0;
  return properties.reduce((sum, mesh) => sum + (mesh.glPrimitives ?? 0), 0);
}

async function main() {
  const { options, paths } = parseArgs(process.argv.slice(2));
  const io = await createIO();

  const files = [];
  for (const target of paths) files.push(...await collectFiles(resolve(target)));
  if (!files.length) {
    console.log('Модели .glb/.gltf не найдены — оптимизировать нечего.');
    console.log('Это нормально для пустого проекта: конвейер готов, моделей пока нет.');
    return 0;
  }

  console.log(`Оптимизация моделей: ${files.length} файл(ов)`);
  console.log(`  сжатие геометрии: ${options.target}`);
  console.log(`  упрощение: ${options.ratio < 1 ? `ratio=${options.ratio}` : 'выключено'}`);
  console.log(`  текстуры: ${options.textureFormat}, лимит ${options.maxTexture}px`);
  if (options.dryRun) console.log('  РЕЖИМ ПРОСМОТРА: файлы не перезаписываются');
  console.log();

  let totalBefore = 0;
  let totalAfter = 0;
  let failures = 0;

  for (const file of files) {
    try {
      const result = await optimizeFile(file, io, options);
      totalBefore += result.before;
      totalAfter += result.after;
      const saved = result.before - result.after;
      const percent = result.before > 0 ? (saved / result.before) * 100 : 0;
      console.log(`  ✓ ${basename(file)}`);
      console.log(`      размер:   ${formatBytes(result.before)} -> ${formatBytes(result.after)} (-${percent.toFixed(1)}%)`);
      console.log(`      треугольники: ${Math.round(result.beforeTriangles)} -> ${Math.round(result.afterTriangles)}`);
      console.log(`      текстуры: ${result.beforeTextures} -> ${result.afterTextures}`);
      if (result.outputPath !== result.path) {
        console.log(`      записан: ${basename(result.outputPath)}`);
      }
      for (const note of result.notes) console.log(`      · ${note}`);
      // Рост размера после «оптимизации» — признак того, что параметры
      // подобраны неверно (например, KTX2 на крошечной текстуре даёт
      // накладные расходы больше экономии).
      if (saved < 0) console.log('      ! размер вырос — проверьте параметры');
    } catch (error) {
      failures += 1;
      console.error(`  ✗ ${basename(file)}: ${error.message}`);
    }
  }

  console.log();
  if (files.length > 0) {
    const saved = totalBefore - totalAfter;
    console.log(`ИТОГО: ${formatBytes(totalBefore)} -> ${formatBytes(totalAfter)}`
      + ` (сэкономлено ${formatBytes(saved)})`);
  }
  if (failures > 0) {
    console.log(`\nОШИБОК: ${failures}`);
    return 1;
  }
  console.log('\nOK: все модели обработаны');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ОШИБКА: ${error.message}`);
    process.exit(2);
  });
