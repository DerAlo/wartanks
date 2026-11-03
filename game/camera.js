// game/camera.js — third-person orbit around the turret + sniper scope, one wheel ladder:
// levels 0..TP-1 = orbit distances (far → near), then ×2 ×4 ×8 ×16 in the scope (Shift toggles).
// The view direction (yaw/pitch, world) IS the aim ray; right mouse = free look (aim frozen).
import * as THREE from '../vendor/three/three.module.min.js';

const TP_DIST = [26, 19, 14, 10.5, 8];
export const MAGS = [2, 4, 8, 16];
const BASE_FOV = 60;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

export class TankCamera {
   constructor(cam) {
      this.cam = cam;
      this.yaw = 0; this.pitch = -0.08;            // view direction, world
      this.level = 2; this.dist = TP_DIST[2]; this.lastMag = 1;
      this.freeLook = false; this.aimYaw = 0; this.aimPitch = 0;
      this.dir = new THREE.Vector3(); this.pivot = new THREE.Vector3();
      this._acc = 0; this._fov = BASE_FOV; this.shake = 0;
   }
   get scoped() { return this.level >= TP_DIST.length; }
   get zoom() { return this.scoped ? MAGS[this.level - TP_DIST.length] : 1; }
   reset(yaw) { this.yaw = yaw; this.pitch = -0.08; this.level = 2; this.dist = TP_DIST[2]; }
   // notches: + = wheel toward user = zoom out. Returns true when scope state toggled.
   wheel(n) {
      this._acc += -n; let changed = false;
      while (Math.abs(this._acc) >= 0.6) {
         const s = Math.sign(this._acc); this._acc -= s;
         const was = this.scoped;
         this.level = clamp(this.level + s, 0, TP_DIST.length + MAGS.length - 1);
         if (this.scoped !== was) changed = true;
         if (this.scoped) this.lastMag = this.level - TP_DIST.length;
      }
      return changed;
   }
   toggleScope() { this.level = this.scoped ? TP_DIST.length - 1 : TP_DIST.length + this.lastMag; }
   look(dx, dy, sens) {
      const z = this.zoom, k = sens / Math.max(1, z * 0.8);
      this.yaw -= dx * k; this.pitch = clamp(this.pitch - dy * k, -1.2, this.scoped ? 0.45 : 0.6);
   }
   setFreeLook(on) {
      if (on && !this.freeLook) { this.aimYaw = this.yaw; this.aimPitch = this.pitch; }
      if (!on && this.freeLook) { this.yaw = this.aimYaw; this.pitch = this.aimPitch; }
      this.freeLook = on;
   }
   // aim direction (world): frozen while free-looking
   aimDir(out) {
      const y = this.freeLook ? this.aimYaw : this.yaw, p = this.freeLook ? this.aimPitch : this.pitch;
      return out.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
   }
   // pivot: turret top (world); scopePos: gunner sight (world); heightAt for ground clamp
   update(dt, pivot, scopePos, heightAt) {
      const cam = this.cam, d = this.dir.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      const target = this.scoped ? 0 : TP_DIST[this.level];
      this.dist += (target - this.dist) * Math.min(1, dt * 12);
      let fov;
      if (this.scoped) {
         cam.position.copy(scopePos);
         fov = 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) / (this.zoom * 1.25)) * 180 / Math.PI;
      } else {
         // orbit: behind and above the pivot, looking along d; the tank sits low in frame
         const up = 1.1 + this.dist * 0.07;
         cam.position.set(pivot.x - d.x * this.dist, pivot.y + up - d.y * this.dist, pivot.z - d.z * this.dist);
         const g = heightAt(cam.position.x, cam.position.z) + 1.0;
         if (cam.position.y < g) cam.position.y = g;
         fov = BASE_FOV;
      }
      this._fov += (fov - this._fov) * Math.min(1, dt * 18);
      if (Math.abs(cam.fov - this._fov) > 0.01) { cam.fov = this._fov; cam.updateProjectionMatrix(); }
      cam.lookAt(cam.position.x + d.x, cam.position.y + d.y, cam.position.z + d.z);
      if (this.shake > 0) {
         this.shake = Math.max(0, this.shake - dt * 3);
         const s = this.shake * this.shake * 0.02 / Math.max(1, this.zoom * 0.5);
         cam.rotation.x += (Math.random() - 0.5) * s; cam.rotation.y += (Math.random() - 0.5) * s;
      }
   }
}
