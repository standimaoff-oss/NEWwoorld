#!/usr/bin/env node
/**
 * check_pipeline.mjs — работоспособность ассет-конвейера.
 *
 * ЗАЧЕМ. Конвейер состоит из семи npm-пакетов с нативными зависимостями
 * (sharp, draco3dgltf, meshoptimizer). Любой из них может не собраться под
 * конкретную платформу, и тогда `npm install` отчитается об успехе, а
 * оптимизация моделей упадёт в самый неподходящий момент — когда модель
 * уже нужна в игре.
 *
 * Эта проверка делает то, что не делает ни lint, ни тесты: РЕАЛЬНО
 * импортирует каждый пакет, создаёт документ glTF в памяти, кодирует
 * геометрию обоими кодеками и прогоняет официальную валидацию. То есть
 * проверяет не «установлен ли пакет», а «работает ли он».
 *
 * Дополнительно создаёт временную модель, оптимизирует её полным
 * конвейером и сверяет результат — поэтому поломка в цепочке
 * преобразований видна здесь, а не на настоящем ассете художника.
 *
 * Код возврата: 0 — конвейер работает, 1 — есть провалы, 2 — нет node.
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PIPELINE_ROOT = join(SCRIPT_DIR, '..');

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '✓' : '✗';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  ${mark} ${name}${suffix}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? '');
  } catch (error) {
    record(name, false, error.message.split('\n')[0]);
  }
}

/** Собирает тестовую модель в памяти: куб с текстурой и дубликатами. */
async function buildTestDocument() {
  const { Document } = await import('@gltf-transform/core');
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    ]))
    .setBuffer(buffer);
  const indices = document.createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3,
      0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
    ]))
    .setBuffer(buffer);
  const material = document.createMaterial('TestMaterial')
    .setBaseColorFactor([0.42, 0.55, 0.62, 1.0])
    .setMetallicFactor(0.1)
    .setRoughnessFactor(0.8);
  const mesh = document.createMesh('TestMesh')
    .addPrimitive(document.createPrimitive()
      .setAttribute('POSITION', position)
      .setIndices(indices)
      .setMaterial(material));
  const node = document.createNode('TestNode').setMesh(mesh);
  document.createScene('TestScene').addChild(node);
  return document;
}

async function main() {
  console.log('Ассет-конвейер: проверка работоспособности');
  console.log(`  каталог: ${PIPELINE_ROOT}`);
  console.log();

  // --- зависимости ---------------------------------------------------------
  const packages = await readFile(join(PIPELINE_ROOT, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text));
  const declared = { ...packages.dependencies, ...packages.devDependencies };

  console.log('Пакеты:');
  for (const [name, version] of Object.entries(declared)) {
    await check(name, async () => {
      const module = await import(name);
      const loaded = module.default ?? module;
      // version у gltf-validator — ФУНКЦИЯ, у gltf-transform/core — строка.
      // Приводим обе формы, иначе в отчёте печатается «() => validator.version()».
      const raw = loaded?.version ?? loaded?.VERSION ?? '';
      const actual = typeof raw === 'function' ? raw() : raw;
      return actual ? `заявлено ${version}, загружено ${actual}` : `заявлено ${version}`;
    });
  }

  // --- реальные операции ---------------------------------------------------
  console.log();
  console.log('Операции:');

  await check('создание документа glTF', async () => {
    const document = await buildTestDocument();
    const nodes = document.getRoot().listNodes().length;
    if (nodes !== 1) throw new Error(`ожидался 1 узел, получено ${nodes}`);
    return `${nodes} узел, 12 треугольников`;
  });

  await check('запись в GLB', async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const document = await buildTestDocument();
    const io = new NodeIO();
    const binary = await io.writeBinary(document);
    if (binary.byteLength < 100) throw new Error('GLB подозрительно мал');
    return `${binary.byteLength} байт`;
  });

  await check('чтение GLB обратно', async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const document = await buildTestDocument();
    const io = new NodeIO();
    const binary = await io.writeBinary(document);
    const restored = await io.readBinary(binary);
    const nodes = restored.getRoot().listNodes().length;
    if (nodes !== 1) throw new Error(`после чтения ${nodes} узлов вместо 1`);
    return 'цикл запись/чтение сохранён';
  });

  await check('кодирование meshoptimizer', async () => {
    const { NodeIO, Logger, Verbosity } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const { reorder, meshopt } = await import('@gltf-transform/functions');
    const { MeshoptEncoder } = await import('meshoptimizer');
    await MeshoptEncoder.ready;
    const document = await buildTestDocument();
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    io.setLogger(new Logger(Verbosity.ERROR));
    await document.transform(reorder({ encoder: MeshoptEncoder }), meshopt({ encoder: MeshoptEncoder }));
    const binary = await io.writeBinary(document);
    const used = document.getRoot().listExtensionsUsed().map((e) => e.extensionName);
    if (!used.includes('EXT_meshopt_compression')) {
      throw new Error(`расширение не применено, есть только: ${used.join(', ') || 'ничего'}`);
    }
    return `EXT_meshopt_compression, ${binary.byteLength} байт`;
  });

  await check('кодирование Draco', async () => {
    const { NodeIO, Logger, Verbosity } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const { draco } = await import('@gltf-transform/functions');
    const draco3d = (await import('draco3dgltf')).default;
    const document = await buildTestDocument();
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.encoder': await draco3d.createEncoderModule(),
        'draco3d.decoder': await draco3d.createDecoderModule(),
      });
    io.setLogger(new Logger(Verbosity.ERROR));
    await document.transform(draco({ method: 'edgebreaker' }));
    const used = document.getRoot().listExtensionsUsed().map((e) => e.extensionName);
    if (!used.includes('KHR_draco_mesh_compression')) {
      throw new Error(`расширение не применено, есть только: ${used.join(', ') || 'ничего'}`);
    }
    return 'KHR_draco_mesh_compression';
  });

  await check('декодирование Draco', async () => {
    // Умение ЗАПИСАТЬ бесполезно без умения прочитать: повторный прогон
    // конвейера по уже сжатой модели — обычный сценарий.
    const { NodeIO, Logger, Verbosity } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const { draco } = await import('@gltf-transform/functions');
    const draco3d = (await import('draco3dgltf')).default;
    const document = await buildTestDocument();
    const encoderIO = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() });
    await document.transform(draco({ method: 'edgebreaker' }));
    const binary = await encoderIO.writeBinary(document);

    const decoderIO = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
    decoderIO.setLogger(new Logger(Verbosity.ERROR));
    const restored = await decoderIO.readBinary(binary);
    const nodes = restored.getRoot().listNodes().length;
    if (nodes !== 1) throw new Error(`после декодирования ${nodes} узлов`);
    return 'сжатая модель читается обратно';
  });

  await check('сварка и упрощение геометрии', async () => {
    const { weld, simplify } = await import('@gltf-transform/functions');
    const { MeshoptSimplifier } = await import('meshoptimizer');
    const document = await buildTestDocument();
    await MeshoptSimplifier.ready;
    // Ключ называется «simplifier». Опечатка «simplifyor» не даёт ошибки
    // разбора — она тихо игнорируется, и simplify падает уже в рантайме
    // с «simplifier dependency required». Проверка это и поймала.
    await document.transform(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.01 }));
    return 'weld + simplify выполнены';
  });

  await check('кодирование текстур (sharp)', async () => {
    // sharp тянет нативный бинарник под платформу. Если он не собрался,
    // textureCompress упадёт — а это половина пользы конвейера.
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#4a7fa5' },
    }).png().toBuffer();
    if (png.byteLength < 50) throw new Error('sharp вернул пустой буфер');
    const webp = await sharp(png).webp({ quality: 80 }).toBuffer();
    return `PNG ${png.byteLength} Б -> WebP ${webp.byteLength} Б`;
  });

  await check('валидатор Khronos', async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const validator = (await import('gltf-validator')).default;
    const document = await buildTestDocument();
    const binary = await new NodeIO().writeBinary(document);
    const report = await validator.validateBytes(new Uint8Array(binary));
    const errors = report.issues?.numErrors ?? -1;
    if (errors !== 0) {
      throw new Error(`валидатор нашёл ${errors} ошибок в эталонной модели`);
    }
    return `версия ${validator.version()}, 0 ошибок`;
  });

  await check('inspect() даёт числа для бюджетов', async () => {
    const { inspect } = await import('@gltf-transform/functions');
    const document = await buildTestDocument();
    const report = inspect(document);
    // Форма отчёта в 4.5.1: { scenes, meshes, materials, textures,
    // animations }, и каждый раздел — объект со списком .properties.
    // Полей «primitives» и «extensionsUsed» на верхнем уровне НЕТ, хотя
    // по аналогии со старыми версиями их хочется там искать.
    for (const section of ['scenes', 'meshes', 'materials', 'textures', 'animations']) {
      if (!report[section] || !Array.isArray(report[section].properties)) {
        throw new Error(`в отчёте нет раздела ${section}.properties`);
      }
    }
    const triangles = report.meshes.properties
      .reduce((sum, mesh) => sum + (mesh.glPrimitives ?? 0), 0);
    if (triangles !== 12) {
      throw new Error(`ожидалось 12 треугольников, получено ${triangles}`);
    }
    const vertices = report.meshes.properties
      .reduce((sum, mesh) => sum + (mesh.vertices ?? 0), 0);
    return `${triangles} треугольников, ${vertices} вершин, `
      + `${report.materials.properties.length} материал(ов)`;
  });

  await check('meshopt: энкодер и декодер различаются', async () => {
    // Повторный прогон конвейера по уже сжатой модели читает её ДЕКОДЕРОМ.
    // Если на место декодера подставить энкодер, установка зависимостей
    // пройдёт успешно, а падение случится позже и с непонятным сообщением.
    const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
    if (typeof MeshoptDecoder.decodeGltfBuffer !== 'function') {
      throw new Error('MeshoptDecoder не имеет decodeGltfBuffer');
    }
    if (typeof MeshoptEncoder.decodeGltfBuffer === 'function') {
      throw new Error('MeshoptEncoder неожиданно умеет декодировать');
    }
    if (MeshoptEncoder === MeshoptDecoder) {
      throw new Error('энкодер и декодер — один и тот же объект');
    }
    return 'роли разделены, decodeGltfBuffer есть только у декодера';
  });

  await check('повторный прогон по уже сжатой модели', async () => {
    // Сквозная проверка того, ради чего разделены энкодер и декодер:
    // оптимизировали, записали, прочитали ОБРАТНО, оптимизировали снова.
    const { NodeIO, Logger, Verbosity } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const { dedup, prune, weld, reorder, meshopt } = await import('@gltf-transform/functions');
    const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'meshopt.encoder': MeshoptEncoder,
        'meshopt.decoder': MeshoptDecoder,
      });
    io.setLogger(new Logger(Verbosity.ERROR));

    const first = await buildTestDocument();
    await first.transform(dedup(), prune(), weld(),
      reorder({ encoder: MeshoptEncoder }), meshopt({ encoder: MeshoptEncoder }));
    const compressed = await io.writeBinary(first);

    const second = await io.readBinary(compressed);
    await second.transform(dedup(), prune(), weld(),
      reorder({ encoder: MeshoptEncoder }), meshopt({ encoder: MeshoptEncoder }));
    const recompressed = await io.writeBinary(second);
    if (second.getRoot().listNodes().length !== 1) {
      throw new Error('сжатая модель не читается обратно');
    }
    return `${compressed.byteLength} Б -> повторный прогон ${recompressed.byteLength} Б`;
  });

  await check('тангенты реально появляются в файле', async () => {
    // Регрессия на ловушку порядка операций. tangents() пропускает любой
    // примитив, у которого ЕСТЬ индексы (исходники пакета: «primitives must
    // be unwelded»), поэтому сварка перед тангентами убивает шаг молча:
    // печатается лишь предупреждение, а атрибут TANGENT не появляется.
    // Проверка сверяет РЕЗУЛЬТАТ, а не отсутствие исключения.
    const { NodeIO, Logger, Verbosity } = await import('@gltf-transform/core');
    const { weld, unweld, normals, tangents } = await import('@gltf-transform/functions');
    const { generateTangents } = await import('mikktspace');

    const build = async () => {
      const document = await buildTestDocument();
      const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];
      const uv = document.createAccessor().setType('VEC2')
        .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
        .setBuffer(document.getRoot().listBuffers()[0]);
      primitive.setAttribute('TEXCOORD_0', uv);
      return document;
    };

    const hasTangent = (document) => document.getRoot().listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .some((primitive) => primitive.getAttribute('TANGENT') !== null);

    // Контрольный случай: сваренная геометрия. Тангентов быть НЕ должно —
    // если они появятся, значит поведение пакета изменилось и комментарий
    // в конвейере устарел.
    const welded = await build();
    await welded.transform(weld(), normals(), weld(), tangents({ generateTangents, overwrite: true }));
    if (hasTangent(welded)) {
      throw new Error('tangents() отработал на сваренной геометрии — '
        + 'поведение пакета изменилось, обновите порядок в optimize_models.mjs');
    }

    // Рабочий случай: разваривание перед тангентами.
    const unwelded = await build();
    await unwelded.transform(weld(), normals(), unweld(), tangents({ generateTangents, overwrite: true }));
    if (!hasTangent(unwelded)) {
      throw new Error('после unweld() тангенты не появились');
    }
    const io = new NodeIO();
    io.setLogger(new Logger(Verbosity.ERROR));
    const written = await io.writeBinary(unwelded);
    const reread = await io.readBinary(written);
    if (!hasTangent(reread)) throw new Error('TANGENT потерялся при записи/чтении');
    return 'сварка блокирует шаг, unweld() включает — TANGENT доходит до файла';
  });

  await check('скрипты конвейера на месте', async () => {
    const required = ['optimize_models.mjs', 'validate_models.mjs', 'check_pipeline.mjs'];
    const missing = [];
    for (const name of required) {
      await readFile(join(SCRIPT_DIR, name)).catch(() => missing.push(name));
    }
    if (missing.length) throw new Error(`нет: ${missing.join(', ')}`);
    return required.join(', ');
  });

  // --- сквозной прогон на временном файле ---------------------------------
  console.log();
  console.log('Сквозной прогон:');
  await check('оптимизация временной модели', async () => {
    const { NodeIO, Logger, Verbosity } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const { dedup, prune, weld, reorder, meshopt } = await import('@gltf-transform/functions');
    const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;

    const directory = await mkdtemp(join(tmpdir(), 'newwoorld-pipeline-'));
    try {
      const document = await buildTestDocument();
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'meshopt.encoder': MeshoptEncoder,
          'meshopt.decoder': MeshoptDecoder,
        });
      io.setLogger(new Logger(Verbosity.ERROR));

      const source = join(directory, 'source.glb');
      await writeFile(source, Buffer.from(await io.writeBinary(document)));

      const reloaded = await io.readBinary(await readFile(source));
      await reloaded.transform(dedup(), prune(), weld(), reorder({ encoder: MeshoptEncoder }),
        meshopt({ encoder: MeshoptEncoder }));
      const optimized = join(directory, 'optimized.glb');
      await writeFile(optimized, Buffer.from(await io.writeBinary(reloaded)));

      const before = (await readFile(source)).byteLength;
      const after = (await readFile(optimized)).byteLength;
      if (after <= 0) throw new Error('результат пуст');
      return `${before} Б -> ${after} Б (файлы удалены)`;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });

  // --- итог ----------------------------------------------------------------
  console.log();
  const passed = results.filter((r) => r.ok).length;
  if (failures > 0) {
    console.log(`КОНВЕЙЕР: ${passed} из ${results.length} проверок пройдено, ПРОВАЛОВ ${failures}`);
    console.log('Восстановление: cd tools/asset-pipeline && rm -rf node_modules package-lock.json && npm install');
    return 1;
  }
  console.log(`OK: конвейер работоспособен (${passed} проверок)`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ОШИБКА: ${error.stack || error.message}`);
    process.exit(2);
  });
