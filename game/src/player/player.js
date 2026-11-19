import * as THREE from 'three';

export class Player {
  constructor(scene, city, input, camera) {
    this.scene = scene; this.city = city; this.input = input; this.camera = camera;
    this.pos = new THREE.Vector3(8, 0.2, 22);
    this.yaw = 0; this.pitch = -0.06;
    this.vel = new THREE.Vector3();
    this.eye = 1.66;
    this.fly = false;
    this.flyY = 12;
    // рабочие векторы: движение считается 30 раз в секунду, и создавать
    // по три Vector3 на шаг — лишняя работа сборщику мусора
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this.body = new THREE.Group(); scene.add(this.body);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b5f8a, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.7, 4, 8), mat);
    torso.position.y = 1.15; this.body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), new THREE.MeshStandardMaterial({ color: 0xd9a878, roughness: 0.8 }));
    head.position.y = 1.72; this.body.add(head);
    this.head = head;
    this.body.visible = false;
  }
  teleport(x, z) { this.pos.set(x, 0.2, z); this.flyY = 12; }

  update(dt, mode) {
    const look = this.input.look();
    // чувствительность: в захвате мыши и на сенсоре — обычная, без захвата — нулевая
    const active = this.input.locked || this.input.isTouch;
    if (active) {
      this.yaw -= look.dx * 0.0025 * (window.__sens || 1);
      this.pitch -= look.dy * 0.0022 * (window.__sens || 1);
      this.pitch = Math.max(-1.35, Math.min(1.2, this.pitch));
    }
    // режим дрона: Tab переключает game.mode, и дрон должен реально летать
    this.fly = mode === 'drone';
    const ax = this.input.axis();
    const run = this.input.running();
    const speed = this.fly ? (run ? 42 : 14) : (run ? 6.6 : 3.0);
    const f = this._f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = this._r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = this._move.set(0, 0, 0).addScaledVector(f, ax.y).addScaledVector(r, ax.x);
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
    this.pos.add(move);
    if (this.fly) {
      // высота: Space — вверх, Ctrl — вниз
      if (this.input.down('Space')) this.flyY += dt * 18;
      if (this.input.down('ControlLeft') || this.input.down('ControlRight')) this.flyY -= dt * 18;
      this.flyY = Math.max(1.2, Math.min(260, this.flyY));
      this.pos.y = this.flyY;
      this.body.visible = false;

      this.camera.position.set(this.pos.x, this.pos.y + 0.4, this.pos.z);
      this.camera.rotation.set(0, 0, 0);
      this.camera.rotateY(this.yaw);
      this.camera.rotateX(this.pitch);
      return;
    }
    this.pos.y = 0.2;
    this.camera.position.set(this.pos.x, this.pos.y + this.eye, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.body.position.copy(this.pos);
    this.body.rotation.y = this.yaw + Math.PI;
  }
}
