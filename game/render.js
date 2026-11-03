// game/render.js — renderer, scene, lights, fog. The sun is one directional light whose shadow
// frustum follows the camera focus (texel-snapped so shadows do not shimmer while driving).
import * as THREE from '../vendor/three/three.module.min.js';

export class Renderer {
   constructor(canvas, q) {
      this.q = q;
      const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance' });
      r.setPixelRatio(q.pixelRatio);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.05;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.info.autoReset = false;
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(0xb9c2b8, 250, 1100);
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000);
      this.hemi = new THREE.HemisphereLight(0xc9dcf0, 0x5a5236, 0.95);
      this.scene.add(this.hemi);
      const sun = this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
      sun.castShadow = true;
      sun.shadow.mapSize.set(q.shadow, q.shadow);
      const s = q.shadowDist;
      Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 900 });
      sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
      this.scene.add(sun, sun.target);
      this.sunDir = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();
      this._v = new THREE.Vector3();
      this.resize();
      addEventListener('resize', () => this.resize());
   }
   setTheme(th = {}) {
      const fog = th.fog ?? 0xb9c2b8;
      this.scene.fog.color.set(fog);
      this.scene.fog.near = th.fogNear ?? 260; this.scene.fog.far = th.fogFar ?? 1150;
      if (th.sunDir) this.sunDir.set(th.sunDir[0], th.sunDir[1], th.sunDir[2]).normalize();
      this.sun.color.set(th.sunColor ?? 0xfff1d6); this.sun.intensity = th.sunIntensity ?? 2.6;
      this.hemi.color.set(th.skyLight ?? 0xc9dcf0); this.hemi.groundColor.set(th.groundLight ?? 0x5a5236);
      this.hemi.intensity = th.hemiIntensity ?? 0.95;
      this.renderer.toneMappingExposure = th.exposure ?? 1.05;
   }
   resize() {
      const w = innerWidth, h = innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.w = w; this.h = h;
   }
   // Keep the shadow box centred on the focus point, snapped to shadow texels.
   followShadow(fx, fz, fy = 0) {
      const sun = this.sun, d = this.sunDir, s = this.q.shadowDist;
      const texel = (2 * s) / this.q.shadow;
      const x = Math.round(fx / texel) * texel, z = Math.round(fz / texel) * texel;
      sun.target.position.set(x, fy, z);
      sun.position.set(x + d.x * 400, fy + d.y * 400, z + d.z * 400);
      sun.target.updateMatrixWorld();
   }
   render() {
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
   }
}
