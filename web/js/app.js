import * as THREE from "/vendor/three/three.module.js";
import { OrbitControls } from "/vendor/three/OrbitControls.js";
import { RoomEnvironment } from "/vendor/three/RoomEnvironment.js";

// ==================== STATE ====================
let scene, camera, renderer, controls, cadGroup, gridHelper;
let clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1000);
let currentShading = "creases";
let autoSpin = false;
let currentBounds = new THREE.Box3();
let partMeshes = [];
let lastPhotoResult = null;
let lastVisionFileBlob = null;

// ==================== TABS ====================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "cad") onResize();
  });
});

// ==================== THREE.JS CAD VIEWPORT ====================
function initViewport() {
  const host = document.getElementById("cadViewport");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090d14);

  camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(host.clientHeight, 1), 0.5, 4000);
  camera.position.set(145, -155, 115);
  camera.up.set(0, 0, 1);

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.localClippingEnabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  host.appendChild(renderer.domElement);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const dir1 = new THREE.DirectionalLight(0xffffff, 1.4);
  dir1.position.set(140, -120, 220);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x7dd3fc, 0.55);
  dir2.position.set(-160, 140, 80);
  scene.add(dir2);
  scene.add(new THREE.AmbientLight(0x94a3b8, 0.35));

  gridHelper = new THREE.GridHelper(300, 30, 0x2a3b57, 0x182235);
  gridHelper.rotation.x = Math.PI / 2; // XY floor (CAD Z-up)
  scene.add(gridHelper);

  const axes = new THREE.AxesHelper(45);
  scene.add(axes);

  cadGroup = new THREE.Group();
  scene.add(cadGroup);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;

  window.addEventListener("resize", onResize);
  animate();
}

function onResize() {
  const host = document.getElementById("cadViewport");
  if (!renderer || !host || host.clientWidth === 0) return;
  camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(host.clientWidth, host.clientHeight);
}

function animate() {
  requestAnimationFrame(animate);
  if (autoSpin && cadGroup) cadGroup.rotation.z += 0.006;
  controls.update();
  renderer.render(scene, camera);
}

function buildAssemblyInViewport(payload) {
  while (cadGroup.children.length > 0) {
    cadGroup.remove(cadGroup.children[0]);
  }
  partMeshes = [];
  cadGroup.rotation.set(0, 0, 0);

  for (const part of payload.parts) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(part.vertices, 3));
    geom.setIndex(part.faces);
    geom.computeVertexNormals();

    const [r, g, b, a] = part.material.baseColor;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      metalness: part.material.metallic,
      roughness: part.material.roughness,
      transparent: a < 0.99,
      opacity: a,
      side: THREE.DoubleSide,
      clippingPlanes: [clipPlane],
      clipShadows: true,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = part.name;

    // Sharp feature crease edges (pro CAD visual clarity)
    const edgesGeom = new THREE.EdgesGeometry(geom, part.creaseAngleDeg || 30);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.42,
      clippingPlanes: [clipPlane],
    });
    const edgeLines = new THREE.LineSegments(edgesGeom, edgesMat);
    mesh.add(edgeLines);

    // Wireframe overlay
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      clippingPlanes: [clipPlane],
    });
    const wireMesh = new THREE.Mesh(geom, wireMat);
    wireMesh.visible = false;
    mesh.add(wireMesh);

    cadGroup.add(mesh);
    partMeshes.push({ part, mesh, mat, edgeLines, wireMesh });
  }

  currentBounds.setFromObject(cadGroup);
  applyShadingMode(currentShading);
  fitCamera("iso");
  renderAuditAndPartTree(payload);
}

function applyShadingMode(mode) {
  currentShading = mode;
  for (const item of partMeshes) {
    const baseOp = item.part.material.baseColor[3];
    if (mode === "solid") {
      item.mat.wireframe = false;
      item.mat.opacity = baseOp;
      item.mat.transparent = baseOp < 0.99;
      item.edgeLines.visible = false;
      item.wireMesh.visible = false;
    } else if (mode === "creases") {
      item.mat.wireframe = false;
      item.mat.opacity = baseOp;
      item.mat.transparent = baseOp < 0.99;
      item.edgeLines.visible = true;
      item.wireMesh.visible = false;
    } else if (mode === "wire") {
      item.mat.wireframe = false;
      item.mat.opacity = 0.25;
      item.mat.transparent = true;
      item.edgeLines.visible = false;
      item.wireMesh.visible = true;
    } else if (mode === "xray") {
      item.mat.wireframe = false;
      item.mat.opacity = 0.38;
      item.mat.transparent = true;
      item.edgeLines.visible = true;
      item.wireMesh.visible = false;
    }
  }
}

function fitCamera(view) {
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  currentBounds.getCenter(center);
  currentBounds.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 40);
  const dist = maxDim * 1.95;

  controls.target.copy(center);
  if (view === "top") camera.position.set(center.x, center.y - 0.1, center.z + dist);
  else if (view === "front") camera.position.set(center.x, center.y - dist, center.z);
  else if (view === "side") camera.position.set(center.x + dist, center.y, center.z);
  else camera.position.set(center.x + dist * 0.72, center.y - dist * 0.78, center.z + dist * 0.56);
  camera.lookAt(center);
  controls.update();
}

function renderAuditAndPartTree(payload) {
  const a = payload.audit;
  const auditEl = document.getElementById("auditSummary");
  auditEl.innerHTML = `
    <div class="audit-cell"><div class="k">Watertight (Замкнута)</div><div class="v ${a.all_watertight ? "ok" : ""}">${a.all_watertight ? "YES ✓ (100%)" : "CHECK"}</div></div>
    <div class="audit-cell"><div class="k">Non-Manifold рёбра</div><div class="v ok">${a.non_manifold_edges}</div></div>
    <div class="audit-cell"><div class="k">Полигоны (Quads/Tris)</div><div class="v">${a.total_quads}Q / ${a.total_triangles}T</div></div>
    <div class="audit-cell"><div class="k">Вершин / Деталей</div><div class="v">${a.total_vertices} / ${a.part_count}</div></div>
    <div class="audit-cell"><div class="k">Объём (мм³)</div><div class="v">${a.total_volume_mm3.toLocaleString()}</div></div>
    <div class="audit-cell"><div class="k">Габариты (мм)</div><div class="v">${a.bounds_mm.join("×")}</div></div>
  `;

  const treeEl = document.getElementById("partTree");
  treeEl.innerHTML = "";
  partMeshes.forEach((item, idx) => {
    const [r, g, b] = item.part.material.baseColor;
    const hex = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    const row = document.createElement("div");
    row.className = "part-item";
    row.innerHTML = `
      <label>
        <input type="checkbox" checked data-idx="${idx}" />
        <span class="swatch" style="background:${hex}"></span>
        <span>${item.part.name}</span>
      </label>
      <span class="muted">${item.part.metrics.quads}Q</span>
    `;
    row.querySelector("input").addEventListener("change", (ev) => {
      item.mesh.visible = ev.target.checked;
    });
    treeEl.appendChild(row);
  });

  document.getElementById("scadPreview").textContent =
    `// CAD Tokens: ${payload.program_tokens.join(" -> ")}\n\n${payload.scad || ""}`;

  // Update clip slider range to model Z bounds
  const slider = document.getElementById("clipSlider");
  slider.value = 100;
  clipPlane.constant = currentBounds.max.z + 50;
}

// ==================== API ACTIONS ====================
async function generateCAD() {
  const btn = document.getElementById("btnGenCad");
  btn.disabled = true;
  btn.textContent = "Нейро-генерация CAD...";
  try {
    const body = {
      prompt: document.getElementById("cadPrompt").value.trim() || "шестерня эвольвентная",
      archetype_override: document.getElementById("cadArchetype").value || null,
      size_mm: parseFloat(document.getElementById("cadSize").value) || null,
      chamfer: parseFloat(document.getElementById("cadChamfer").value) || null,
    };
    const countVal = parseInt(document.getElementById("cadCount").value, 10);
    if (!Number.isNaN(countVal)) {
      body.teeth = countVal;
      body.blades = countVal;
      body.fins = countVal;
    }

    const res = await fetch("/api/cad/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    buildAssemblyInViewport(data);

    const pred = data.prediction || {};
    document.getElementById("cadPredBox").innerHTML = `
      <div><b>Модель:</b> ${data.title}</div>
      <div><b>Архетип:</b> ${data.archetype} (${Math.round((pred.confidence || 1) * 100)}%)</div>
      <div><b>CAD-операции:</b> ${(data.program_tokens || []).join(" → ")}</div>
    `;
  } catch (err) {
    alert("Ошибка генерации CAD: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Сгенерировать 3D CAD модель";
  }
}

async function generatePhotoPartByPart() {
  const btn = document.getElementById("btnGenPhoto");
  btn.disabled = true;
  btn.textContent = "Синтез по частям...";
  try {
    const body = {
      prompt: document.getElementById("photoPrompt").value.trim() || "закат в горах альпы озеро",
      size: parseInt(document.getElementById("photoSize").value, 10) || 512,
      seed: parseInt(document.getElementById("photoSeed").value, 10) || 42,
    };
    const res = await fetch("/api/photo/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    lastPhotoResult = data;

    document.getElementById("photoMetaBox").innerHTML = `
      <div><b>Сцена:</b> ${data.scene_archetype} (${Math.round(data.confidence * 100)}%)</div>
      <div><b>Разрешение:</b> ${data.resolution[0]}×${data.resolution[1]}</div>
      <div><b>Палитра:</b> ${data.palette_rgb.map((c) => `rgb(${c.join(",")})`).join(" | ")}</div>
    `;

    const strip = document.getElementById("photoPartsStrip");
    strip.innerHTML = "";
    const mainImg = document.getElementById("photoMainImg");
    const stepLbl = document.getElementById("photoStepLabel");
    const badge = document.getElementById("photoProgressBadge");
    const fill = document.getElementById("photoProgressFill");

    // Animate progressive part-by-part reveal (Часть 1 -> 5)
    for (let i = 0; i < data.parts.length; i++) {
      const p = data.parts[i];
      const card = document.createElement("div");
      card.className = "part-card" + (i === data.parts.length - 1 ? " active" : "");
      card.innerHTML = `
        <img src="data:image/png;base64,${p.layer_png_b64}" alt="${p.name}" />
        <div class="p-title">${p.label}</div>
      `;
      card.addEventListener("click", () => {
        document.querySelectorAll(".part-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        mainImg.src = "data:image/png;base64," + p.composite_png_b64;
        stepLbl.textContent = p.label;
        badge.textContent = p.progress_pct + "%";
        fill.style.width = p.progress_pct + "%";
      });
      strip.appendChild(card);

      mainImg.src = "data:image/png;base64," + p.composite_png_b64;
      stepLbl.textContent = p.label;
      badge.textContent = p.progress_pct + "%";
      fill.style.width = p.progress_pct + "%";
      await new Promise((r) => setTimeout(r, 240));
    }

    document.getElementById("btnDownloadPhoto").disabled = false;
    document.getElementById("btnPhotoToVision").disabled = false;
  } catch (err) {
    alert("Ошибка синтеза фото: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Создать фото по частям";
  }
}

async function analyzeVisionImage(blob) {
  lastVisionFileBlob = blob;
  document.getElementById("visionInputPreview").src = URL.createObjectURL(blob);
  const fd = new FormData();
  fd.append("file", blob, "input.png");

  const res = await fetch("/api/vision/analyze", { method: "POST", body: fd });
  const data = await res.json();

  document.getElementById("visionAnnotatedPreview").src =
    "data:image/png;base64," + data.ocr.annotated_png_b64;
  document.getElementById("visionOcrText").textContent =
    data.ocr.text ? `${data.ocr.text}\n\n[Символов: ${data.ocr.char_count}, уверенность OCR: ${Math.round(data.ocr.mean_confidence * 100)}%]` : "Текст не обнаружен";

  const sc = data.scene;
  document.getElementById("visionSceneBox").innerHTML = `
    <div><b>Категория сцены:</b> ${sc.scene_category} (${Math.round(sc.scene_confidence * 100)}%)</div>
    <div><b>Рекомендуемый CAD-архетип:</b> ${sc.suggested_cad_archetype} (${Math.round(sc.cad_confidence * 100)}%)</div>
    <div><b>Атрибуты:</b> Металл=${sc.attributes.metallic} | Органика=${sc.attributes.organic} | Архитектура=${sc.attributes.architectural} | Текст=${sc.attributes.text_density}</div>
    <div><b>Размер:</b> ${sc.visual_stats.size_px.join("×")} px | Резкость: ${sc.visual_stats.edge_sharpness}</div>
  `;
}

async function visionToCad(mode) {
  if (!lastVisionFileBlob) {
    alert("Сначала выберите или загрузите изображение!");
    return;
  }
  const fd = new FormData();
  fd.append("file", lastVisionFileBlob, "input.png");
  fd.append("mode", mode);
  const res = await fetch("/api/vision/to-cad", { method: "POST", body: fd });
  const data = await res.json();
  buildAssemblyInViewport(data);
  document.querySelector('.tab-btn[data-tab="cad"]').click();
}

function drawLossChart(report) {
  const canvas = document.getElementById("lossChartCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#0a0e16";
  ctx.fillRect(0, 0, w, h);

  const series = [
    { label: "CadGPT", color: "#38bdf8", pts: (report.cadgpt?.history || []).map((x) => x.loss) },
    { label: "PhotoPartNet", color: "#a855f7", pts: (report.photopart?.history || []).map((x) => x.loss) },
    { label: "VisionOCR-Glyph", color: "#10b981", pts: (report.vision_ocr?.ocr_history || []).map((x) => x.loss) },
    { label: "VisionOCR-Scene", color: "#f59e0b", pts: (report.vision_ocr?.scene_history || []).map((x) => x.loss) },
  ].filter((s) => s.pts.length > 0);

  if (series.length === 0) return;
  const maxLoss = Math.max(...series.flatMap((s) => s.pts), 1.0);
  const padL = 42, padR = 16, padT = 24, padB = 28;

  ctx.strokeStyle = "#1f293d";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * (h - padT - padB);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = "#8ea0bd";
    ctx.font = "11px monospace";
    ctx.fillText(((1 - i / 4) * maxLoss).toFixed(2), 4, y + 4);
  }

  series.forEach((s, si) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    s.pts.forEach((val, idx) => {
      const x = padL + (idx / Math.max(s.pts.length - 1, 1)) * (w - padL - padR);
      const y = padT + (1 - val / maxLoss) * (h - padT - padB);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = s.color;
    ctx.fillRect(padL + si * 155, 6, 10, 10);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(s.label, padL + si * 155 + 15, 15);
  });
}

async function initApp() {
  initViewport();

  // Wire CAD presets & tools
  document.querySelectorAll("#cadPresets .chip").forEach((ch) => {
    ch.addEventListener("click", () => {
      document.getElementById("cadPrompt").value = ch.dataset.prompt;
      generateCAD();
    });
  });
  document.getElementById("btnGenCad").addEventListener("click", generateCAD);
  document.querySelectorAll("[data-cam]").forEach((b) =>
    b.addEventListener("click", () => fitCamera(b.dataset.cam))
  );
  document.getElementById("btnAutoSpin").addEventListener("click", (ev) => {
    autoSpin = !autoSpin;
    ev.target.classList.toggle("active", autoSpin);
  });
  document.querySelectorAll("[data-shade]").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-shade]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      applyShadingMode(b.dataset.shade);
    });
  });
  document.getElementById("clipSlider").addEventListener("input", (ev) => {
    const pct = parseFloat(ev.target.value) / 100.0;
    const zMin = currentBounds.min.z;
    const zMax = currentBounds.max.z + 2;
    clipPlane.constant = pct >= 0.99 ? 1000 : zMin + pct * (zMax - zMin);
  });

  // Wire Photo AI
  document.querySelectorAll("#photoPresets .chip").forEach((ch) => {
    ch.addEventListener("click", () => {
      document.getElementById("photoPrompt").value = ch.dataset.prompt;
      generatePhotoPartByPart();
    });
  });
  document.getElementById("btnGenPhoto").addEventListener("click", generatePhotoPartByPart);
  document.getElementById("btnDownloadPhoto").addEventListener("click", () => {
    if (!lastPhotoResult) return;
    const a = document.createElement("a");
    a.href = "data:image/png;base64," + lastPhotoResult.final_png_b64;
    a.download = `newwoorld_${lastPhotoResult.scene_archetype}.png`;
    a.click();
  });
  document.getElementById("btnPhotoToVision").addEventListener("click", async () => {
    if (!lastPhotoResult) return;
    const b64 = lastPhotoResult.final_png_b64;
    const res = await fetch("data:image/png;base64," + b64);
    const blob = await res.blob();
    document.querySelector('.tab-btn[data-tab="vision"]').click();
    await analyzeVisionImage(blob);
  });

  // Wire Vision & OCR
  const fileIn = document.getElementById("visionFileInput");
  fileIn.addEventListener("change", () => {
    if (fileIn.files && fileIn.files[0]) analyzeVisionImage(fileIn.files[0]);
  });
  document.getElementById("btnAnalyzeVision").addEventListener("click", () => {
    if (lastVisionFileBlob) analyzeVisionImage(lastVisionFileBlob);
  });
  document.querySelectorAll(".sample-vis").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = await fetch(`/api/vision/sample/${b.dataset.sample}`);
      const blob = await r.blob();
      await analyzeVisionImage(blob);
    });
  });
  document.getElementById("btnVisToCadSemantic").addEventListener("click", () => visionToCad("auto"));
  document.getElementById("btnVisToCadRelief").addEventListener("click", () => visionToCad("relief"));

  // Wire Live Fine-Tuning
  document.getElementById("btnLiveFineTune").addEventListener("click", async () => {
    const btn = document.getElementById("btnLiveFineTune");
    btn.disabled = true;
    try {
      const res = await fetch("/api/train/fine-tune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samples: [
            {
              prompt: document.getElementById("ftPrompt").value,
              archetype: document.getElementById("ftArch").value,
            },
          ],
          steps: parseInt(document.getElementById("ftSteps").value, 10) || 8,
        }),
      });
      const out = await res.json();
      document.getElementById("ftResultBox").textContent = JSON.stringify(out, null, 2);
    } finally {
      btn.disabled = false;
    }
  });

  // Load Health, Archetypes, Training Stats, Scaling Blueprints
  const hRes = await fetch("/api/health");
  const h = await hRes.json();
  document.getElementById("backendStatusText").textContent =
    h.backend === "native_c_fallback" ? "Native C Standalone (.exe)" : "NEWwoorld AI Core Active";

  const archSel = document.getElementById("cadArchetype");
  const ftSel = document.getElementById("ftArch");
  (h.archetypes || []).forEach((a) => {
    const o1 = document.createElement("option");
    o1.value = a;
    o1.textContent = a;
    archSel.appendChild(o1);
    const o2 = o1.cloneNode(true);
    ftSel.appendChild(o2);
  });

  if (h.models) {
    document.getElementById("coreStatsCards").innerHTML = `
      <div class="stat-box"><div class="title">CadGPT Core</div><div class="meta">Параметров: ${h.models.cadgpt.params.toLocaleString()}<br>Эпох: ${h.models.cadgpt.trained_epochs}<br>Loss: ${h.models.cadgpt.last_loss}</div></div>
      <div class="stat-box"><div class="title">PhotoPartNet Core</div><div class="meta">Параметров: ${h.models.photopart.params.toLocaleString()}<br>Эпох: ${h.models.photopart.trained_epochs}<br>Loss: ${h.models.photopart.last_loss}</div></div>
      <div class="stat-box"><div class="title">VisionOCR Core</div><div class="meta">Параметров: ${h.models.vision_ocr.params.toLocaleString()}<br>OCR Acc: ${Math.round((h.models.vision_ocr.ocr_accuracy || 0) * 100)}%<br>Scene Acc: ${Math.round((h.models.vision_ocr.scene_accuracy || 0) * 100)}%</div></div>
    `;
  }

  if (h.training_report) drawLossChart(h.training_report);

  if (h.scaling_catalog) {
    const bEl = document.getElementById("billionTable");
    bEl.innerHTML = "";
    Object.values(h.scaling_catalog).forEach((cfg) => {
      const c = document.createElement("div");
      c.className = "billion-card";
      c.innerHTML = `
        <h4>${cfg.name}</h4>
        <div class="small muted">
          Параметры: <b style="color:#fff">${cfg.exact_params || cfg.total_trained_params || cfg.cad_params}</b><br>
          Железо: ${cfg.hardware}<br>
          Статус: <span style="color:#10b981">${cfg.status}</span>
        </div>
      `;
      bEl.appendChild(c);
    });
  }

  // Generate default gear CAD + default sample preview immediately!
  await generateCAD();
}

initApp();
