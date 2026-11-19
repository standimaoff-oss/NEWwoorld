/* Ввод: клавиатура, мышь, геймпад, касания. Один набор действий для всех платформ. */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.justDown = new Set();
    this.justUp = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    this.gp = null;
    this.gpPrev = {};
    this.touch = { stick: { x: 0, y: 0, id: null, ox: 0, oy: 0 }, look: { id: null, lx: 0, ly: 0, dx: 0, dy: 0 }, run: false };
    this.actions = [];
    this.isTouch = false;
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0, down: false, justDown: false, justUp: false };
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      const code = e.code;
      if (!this.keys.has(code)) this.justDown.add(code);
      this.keys.add(code);
      if (['Tab', 'Space', 'KeyE', 'KeyM', 'KeyB', 'KeyQ', 'F1', 'Escape'].includes(code) && this.enabled) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code); this.justUp.add(e.code);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.touch.stick.x = this.touch.stick.y = 0; this.touch.stick.id = null; });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      document.body.classList.toggle('locked', this.locked);
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (this.locked) { this.mouseDX += e.movementX || 0; this.mouseDY += e.movementY || 0; }
      this.pointer.nx = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.ny = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.pointer.down = true; this.pointer.justDown = true; }
      if (this.enabled && !this.isTouch && !this.locked && e.target === c) this.lock();
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) { this.pointer.down = false; this.pointer.justUp = true; } });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // касания
    c.addEventListener('touchstart', (e) => this._touchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this._touchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this._touchEnd(e), { passive: false });
    c.addEventListener('touchcancel', (e) => this._touchEnd(e), { passive: false });
    const stick = document.getElementById('stick');
    const look = document.getElementById('lookzone');
    const label = (t, fn) => { const el = document.getElementById(t); if (el) el.addEventListener(t, fn, { passive: false }); };
    // Стик: отдельный элемент интерфейса (там подсказка), обзор — правая половина экрана.
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((t) => label(t, (e) => {
      // касание по самому стику тоже должно включать сенсорный режим:
      // раньше первый тап по стику молча игнорировался до касания по канвасу
      if (t === 'touchstart' && !this.isTouch) {
        this.isTouch = true;
        if (this.onTouchDetected) this.onTouchDetected();
      }
      if (!this.isTouch) return;
      e.preventDefault();
      if (t === 'touchstart' || t === 'touchmove') {
        const tt = e.changedTouches[0];
        if (t === 'touchstart') { this.touch.stick.id = tt.identifier; this._stickCenter(); }
        if (this.touch.stick.id === tt.identifier) {
          const r = stick.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          let dx = (tt.clientX - cx) / (r.width / 2), dy = (tt.clientY - cy) / (r.height / 2);
          const len = Math.hypot(dx, dy);
          if (len > 1) { dx /= len; dy /= len; }
          this.touch.stick.x = dx; this.touch.stick.y = dy;
          const k = document.getElementById('stickknob');
          if (k) { k.style.transform = `translate(${dx * 34}px,${dy * 34}px)`; }
        }
      } else {
        const tt = e.changedTouches[0];
        if (this.touch.stick.id === tt.identifier) {
          this.touch.stick.id = null; this.touch.stick.x = this.touch.stick.y = 0;
          const k = document.getElementById('stickknob'); if (k) k.style.transform = '';
        }
      }
    }));
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((t) => label(t, (e) => {})); // старая ветка не нужна
  }

  _stickCenter() {}

  _touchStart(e) {
    if (!this.isTouch) { this.isTouch = true; if (this.onTouchDetected) this.onTouchDetected(); }
    e.preventDefault();
    for (const t of e.changedTouches) this._assignLook(t, 'start');
  }
  _touchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) this._assignLook(t, 'move');
  }
  _touchEnd(e) {
    for (const t of e.changedTouches) {
      if (this.touch.look.id === t.identifier) { this.touch.look.id = null; }
    }
  }
  _assignLook(t, phase) {
    if (this.touch.look.id === null && t.clientX > window.innerWidth * 0.42) {
      this.touch.look.id = t.identifier; this.touch.look.lx = t.clientX; this.touch.look.ly = t.clientY;
    } else if (this.touch.look.id === t.identifier) {
      this.touch.look.dx += (t.clientX - this.touch.look.lx);
      this.touch.look.dy += (t.clientY - this.touch.look.ly);
      this.touch.look.lx = t.clientX; this.touch.look.ly = t.clientY;
    }
  }

  lock() { if (this.canvas.requestPointerLock) { try { this.canvas.requestPointerLock(); } catch (e) {} } }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  setTouchUI(on) {
    this.isTouch = on;
    const t = document.getElementById('touch'); if (t) t.classList.toggle('hidden', !on);
    const hint = document.getElementById('hint'); if (hint) hint.classList.toggle('hidden', on);
  }

  /** Нажатие (с учётом "только что") по коду или по коду-действию. */
  pressed(code) { return this.justDown.has(code); }
  down(code) { return this.keys.has(code); }
  consume(code) { this.justDown.delete(code); }
  queueAction(a) { this.actions.push(a); }
  takeActions() { const a = this.actions; this.actions = []; return a; }

  /** Движение: x — вправо, y — вперёд (0..1). */
  axis() {
    let x = 0, y = 0;
    if (this.enabled) {
      if (this.down('KeyW') || this.down('ArrowUp')) y += 1;
      if (this.down('KeyS') || this.down('ArrowDown')) y -= 1;
      if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
      if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
      if (this.touch.stick.id !== null) { x += this.touch.stick.x; y -= this.touch.stick.y; }
      const gp = this._gamepad();
      if (gp) {
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        if (Math.abs(ax) > 0.18) x += ax;
        if (Math.abs(ay) > 0.18) y -= ay;
      }
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
    }
    return { x, y };
  }

  /** Обзор: dx, dy в пикселях (мышь/касание/геймпад). */
  look() {
    let dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = this.mouseDY = 0;
    dx += this.touch.look.dx; dy += this.touch.look.dy;
    this.touch.look.dx = this.touch.look.dy = 0;
    const gp = this._gamepad();
    if (gp) { dx += (gp.axes[2] || 0) * 22; dy += (gp.axes[3] || 0) * 16; }
    return { dx, dy };
  }

  running() {
    if (this.down('ShiftLeft') || this.down('ShiftRight')) return true;
    if (this.touch.run) return true;
    const gp = this._gamepad();
    if (gp && gp.buttons[10] && gp.buttons[10].pressed) return true;
    return false;
  }

  _gamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) { this.gp = p; break; }
    const gp = this.gp;
    if (!gp) return null;
    const b = gp.buttons || [];
    const edge = (i, name) => {
      const now = !!(b[i] && b[i].pressed);
      if (now && !this.gpPrev[name]) this.actions.push(name);
      this.gpPrev[name] = now;
    };
    edge(0, 'use'); edge(3, 'map'); edge(1, 'catalog'); edge(9, 'pause');
    return gp;
  }

  endFrame() {
    this.justDown.clear(); this.justUp.clear(); this.wheel = 0;
    this.pointer.justDown = false; this.pointer.justUp = false;
  }
}
