import * as THREE from 'three';

export class Player {
  constructor(scene, city, input, camera) {
    this.scene = scene; this.city = city; this.input = input; this.camera = camera;
    this.pos = new THREE.Vector3(8, 0.2, 22);
    this.yaw = 0; this.pitch = -0.06;
    this.vel = new THREE.Vector3();
    this.eye = 1.66;
    this.fly = false;
    this.body = new THREE.Group(); scene.add(this.body);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b5f8a, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.7, 4, 8), mat);
    torso.position.y = 1.15; this.body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), new THREE.MeshStandardMaterial({ color: 0xd9a878, roughness: 0.8 }));
    head.position.y = 1.72; this.body.add(head);
    this.head = head;
    this.body.visible = false;
  }
  teleport(x, z) { this.pos.set(x, 0.2, z); }
  update(dt, mode) {
    const look = this.input.look();
    const sens = 0.0022 * (this.input.locked || this.input.isTouch ? 1 : 0);
    this.yaw -= look.dx * 0.0025 * (window.__sens || 1);
    this.pitch -= look.dy * 0.0022 * (window.__sens || 1);
    this.pitch = Math.max(-1.35, Math.min(1.2, this.pitch));
    const ax = this.input.axis();
    const speed = this.input.running() ? 6.6 : 3.0;
    if (this.fly) {
      const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.pos.addScaledVector(f, ax.y * speed * dt * 6);
      this.pos.addScaledVector(r, ax.x * speed * dt * 6);
      this.pos.y = Math.max(0.4, this.pos.y + (this.input.down('Space') ? dt * 8 : 0));
    } else {
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const move = new THREE.Vector3().addScaledVector(f, ax.y).addScaledVector(r, ax.x);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
      this.pos.add(move);
      this.pos.y = 0.2;
    }
    this.camera.position.set(this.pos.x, this.pos.y + this.eye, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.body.position.copy(this.pos);
    this.body.rotation.y = this.yaw + Math.PI;
  }
}
