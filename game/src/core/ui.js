/* Интерфейс: HUD, уведомления, панели. */
import { VERSION, settings, saveSettings, q, qualityPresets } from './settings.js';

const $ = (s) => document.querySelector(s);
export const el = (tag, attrs = {}, html) => {
  const e = document.createElement(tag);
  for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'style') e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (html != null) e.innerHTML = html;
  return e;
};
export const money = (n) => {
  n = Math.round(n);
  const s = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (n < 0 ? '−' : '') + s + ' ₽';
};

export class UI {
  constructor(game) {
    this.game = game;
    this.notes = [];
    this.panels = {};
    $('#ver').textContent = 'v' + VERSION;
    this._bindHudButtons();
  }

  boot(p, text) {
    const f = $('#bootfill'); if (f) f.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    const s = $('#bootstatus'); if (s) s.textContent = text;
  }
  bootDone() {
    const b = $('#boot'); if (!b) return;
    b.style.opacity = '0'; setTimeout(() => b.classList.add('hidden'), 550);
    $('#hud').classList.remove('hidden');
    if (this.game.input && this.game.input.isTouch) this.showTouch(true);
  }
  showTouch(on) { const t = $('#touch'); if (t) t.classList.toggle('hidden', !on); }

  _bindHudButtons() {
    $('#btnmap').onclick = () => this.game.togglePanel('map');
    $('#btncatalog').onclick = () => this.game.togglePanel('catalog');
    $('#btnquality').onclick = () => this.game.togglePanel('graphics');
    $('#btnfull').onclick = () => this.game.toggleFullscreen();
    const bq = $('#btnquality'); if (bq) bq.textContent = 'Графика: ' + q().name;
    document.querySelectorAll('#btns .tbtn').forEach((b) => {
      const act = b.dataset.act;
      b.addEventListener('touchstart', (e) => { e.preventDefault(); this.game.touchAction(act, true); }, { passive: false });
      b.addEventListener('touchend', (e) => { e.preventDefault(); this.game.touchAction(act, false); }, { passive: false });
      b.addEventListener('mousedown', () => this.game.touchAction(act, true));
      b.addEventListener('mouseup', () => this.game.touchAction(act, false));
    });
  }

  hud(st) {
    const m = $('#money'), c = $('#clock'), d = $('#daylbl'), f = $('#fps'), z = $('#zone');
    if (m) m.textContent = money(st.money);
    if (c) c.textContent = st.clockText;
    if (d) d.textContent = 'день ' + st.day + (st.paused ? ' · пауза' : '');
    if (f) f.textContent = st.fps;
    if (z) z.innerHTML = st.zone || '';
  }

  prompt(text, key) {
    const p = $('#prompt'); if (!p) return;
    if (!text) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    $('#promptkey').textContent = key || (this.game.input.isTouch ? '✋' : 'E');
    $('#prompttext').textContent = text;
  }

  notify(text, type = '') {
    const box = $('#notify'); if (!box) return;
    const n = el('div', { class: 'note ' + type }, text);
    box.appendChild(n);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => { n.style.transition = 'opacity .4s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 420); }, 3600);
  }

  zoneHTML(name, sub) { return `<b>${name}</b>${sub ? ' <span style="color:#8fa4b3">· ' + sub + '</span>' : ''}`; }

  objectives(list, title = 'Задачи') {
    const o = $('#objective'); if (!o) return;
    if (!list || !list.length) { o.classList.add('hidden'); return; }
    o.classList.remove('hidden');
    o.innerHTML = `<h4>${title}</h4><ul>` + list.map((t) => `<li class="${t.done ? 'done' : ''}">${t.text}</li>`).join('') + '</ul>';
  }

  task(text) { const t = $('#task'); if (t) t.textContent = text || ''; }

  dialogue(who, text, options = []) {
    const d = $('#dialogue'); if (!d) return;
    d.classList.remove('hidden');
    d.innerHTML = `<div class="who">${who}</div><div>${text}</div>`;
    if (options.length) {
      const row = el('div', { class: 'opts' });
      options.forEach((o) => {
        const b = el('button', {}, o.label);
        b.onclick = () => { this.closeDialogue(); o.action && o.action(); };
        row.appendChild(b);
      });
      d.appendChild(row);
    }
    clearTimeout(this._dlt);
    if (!options.length) this._dlt = setTimeout(() => this.closeDialogue(), 5200);
  }
  closeDialogue() { const d = $('#dialogue'); if (d) d.classList.add('hidden'); }

  /** Создаёт окно панели. body — html, onOpen/onClose. */
  makePanel(id, o) {
    const root = document.getElementById('panel-' + id);
    if (!root) return null;
    root.innerHTML = '';
    const win = el('div', { class: 'win' });
    const head = el('header');
    head.appendChild(el('h2', {}, o.title));
    if (o.sub) head.appendChild(el('div', { class: 'sub' }, o.sub));
    const x = el('button', { class: 'x' }, '×');
    x.onclick = () => this.game.closePanel(id);
    head.appendChild(x);
    win.appendChild(head);
    const body = el('div', { class: 'body' });
    if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
    win.appendChild(body);
    if (o.foot) { const f = el('div', { class: 'foot' }); f.innerHTML = o.foot; win.appendChild(f); }
    root.appendChild(win);
    return { root, win, body };
  }

  openPanel(id) { const p = document.getElementById('panel-' + id); if (p) p.classList.remove('hidden'); }
  closePanel(id) { const p = document.getElementById('panel-' + id); if (p) p.classList.add('hidden'); }
  isPanelOpen(id) { const p = document.getElementById('panel-' + id); return p && !p.classList.contains('hidden'); }

  graphicsPanel() {
    const p = this.makePanel('graphics', {
      title: 'Графика',
      sub: 'трава, вода, облака, дождь',
      body: '',
      foot: 'Изменения применяются сразу. На телефоне «средне» — разумный выбор.',
    });
    if (!p) return;
    const b = p.body;
    const rowQ = el('div', { class: 'row' });
    const presets = qualityPresets();
    Object.keys(presets).forEach((k) => {
      const btn = el('button', { class: 'btn ' + (settings.quality === k ? '' : 'ghost') }, presets[k].name);
      btn.onclick = () => { this.game.setQuality(k); this.graphicsPanel(); };
      rowQ.appendChild(btn);
    });
    b.appendChild(el('h3', {}, 'Качество'));
    b.appendChild(rowQ);

    const mk = (label, min, max, step, val, get, set) => {
      const wr = el('div', { class: 'row', style: 'margin:10px 0' });
      const t = el('div', { style: 'width:210px;font-size:12.5px' }, label);
      const inp = el('input', { type: 'range', min, max, step, value: val, style: 'flex:1;max-width:320px' });
      const vv = el('div', { style: 'width:52px;text-align:right;font-size:12px;color:#8fa4b3' }, (+val).toFixed(2));
      inp.oninput = () => { const v = parseFloat(inp.value); vv.textContent = v.toFixed(2); set(v); };
      wr.appendChild(t); wr.appendChild(inp); wr.appendChild(vv);
      b.appendChild(wr);
      return inp;
    };
    b.appendChild(el('h3', {}, 'Детализация'));
    // Густота травы: 0..2 — множитель к пресету
    const gs = settings.grassScale;
    mk('Трава (густота)', 0, 2.5, 0.1, gs, () => settings.grassScale, (v) => { settings.grassScale = v; this.game.applyGraphics(); });
    mk('Трава (дальность, м)', 10, 160, 2, q().grassDist, () => q().grassDist, (v) => { q().grassDist = v; this.game.applyGraphics(); });
    mk('Масштаб кадра', 0.5, 2, 0.05, settings.pixelScale, () => settings.pixelScale, (v) => { settings.pixelScale = v; this.game.applyGraphics(); });
    const sh = el('label', { class: 'row', style: 'margin:10px 0;font-size:12.5px' });
    const cb = el('input', { type: 'checkbox' }); cb.checked = settings.shadows;
    cb.onchange = () => { settings.shadows = cb.checked; this.game.applyGraphics(); };
    sh.appendChild(cb); sh.appendChild(el('span', {}, 'Тени от солнца'));
    b.appendChild(sh);

    b.appendChild(el('h3', {}, 'Мир'));
    const rowW = el('div', { class: 'row' });
    [['auto', 'Погода по сезону'], ['clear', 'Ясно'], ['rain', 'Дождь'], ['storm', 'Гроза']].forEach(([k, nm]) => {
      const btn = el('button', { class: 'btn ' + (settings.weather === k ? '' : 'ghost') }, nm);
      btn.onclick = () => { settings.weather = k; saveSettings(); this.game.applyWeather(); this.graphicsPanel(); };
      rowW.appendChild(btn);
    });
    b.appendChild(rowW);
    const rowS = el('div', { class: 'row', style: 'margin-top:10px' });
    [['summer', 'Лето'], ['autumn', 'Осень'], ['winter', 'Зима (Новый год)']].forEach(([k, nm]) => {
      const btn = el('button', { class: 'btn ' + (settings.season === k ? '' : 'ghost') }, nm);
      btn.onclick = () => { settings.season = k; saveSettings(); this.game.applySeason(); this.graphicsPanel(); };
      rowS.appendChild(btn);
    });
    b.appendChild(rowS);
    b.appendChild(el('div', { class: 'note-inline', style: 'margin-top:12px' },
      'Трава — своя геометрия с колыханием на ветру и приминанием под ногами, вода — волны, отражение неба и преломление, облака — объёмные, движутся. Дождь идёт полосами и рисует круги на лужах.'));
  }

  bugRect(r) { this.notify('Ошибка на экране — см. правый нижний угол', 'bad'); }
}
