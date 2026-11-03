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
      // the checks read the shader logs back synchronously: seconds of a frozen page per battle start
      r.debug.checkShaderErrors = /[?&]debug/.test(globalThis.location?.search || '');
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
   /** Compile the scene's shaders off the main thread (KHR_parallel_shader_compile) before the first
    *  frame draws them: a first render compiles and links them synchronously, which froze a page for
    *  seconds to minutes (software GL, two tabs) and starved the netcode of its heartbeats. Rendering
    *  waits for it (at most 20 s); the simulation does not. */
   warm() {
      const id = this._warmId = (this._warmId || 0) + 1, done = () => { if (this._warmId === id) this.warming = false; };
      this.warming = true;
      setTimeout(done, 20000);
      // three's compileAsync, minus its crash on a material disposed or recompiled while waiting
      let mats;
      try { mats = this.renderer.compile(this.scene, this.camera); } catch (e) { done(); return; }
      const props = this.renderer.properties;
      const poll = () => {
         if (this._warmId !== id) return;
         try { for (const m of mats) { const pr = props.get(m).currentProgram; if (!pr || pr.isReady()) mats.delete(m); } } catch (e) { mats.clear(); }
         if (mats.size) setTimeout(poll, 10); else done();
      };
      poll();
   }
   render() {
      if (this.warming) return;
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
   }
}

/** Theme with mission fog (world.campaign.fog 0..1) folded in: the fog wall closes in to roughly the
 *  spotting range (spotting.js cuts view by up to 62 %), its colour pales towards mist grey, and the
 *  sky (not fogged itself) fades to the fog colour so the horizon does not show through. */
export function fogTheme(th = {}, f = 0) {
   if (!(f > 0)) return th;
   f = Math.min(1, f);
   const mix = (a, b, t) => { const c = new THREE.Color(a).lerp(new THREE.Color(b), Math.min(1, t)); return c.getHex(); };
   const fog = mix(th.fog ?? 0xb9c2b8, 0xc3c7c2, f);
   // the sky dome shader is tone mapped (ACES) but not sRGB-encoded, fogged meshes the other way round:
   // pick sky colours (Color objects, may exceed 1) that show the same grey as the fully fogged ground
   const aces = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
   const expo = th.exposure ?? 1.05, skyOf = (hex) => {
      const c = new THREE.Color(hex), out = new THREE.Color();
      for (const k of ['r', 'g', 'b']) {
         const d = c[k] <= 0.0031308 ? c[k] * 12.92 : 1.055 * c[k] ** (1 / 2.4) - 0.055;   // displayed sRGB value
         let lo = 0, hi = 50; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (aces(m) < d) lo = m; else hi = m; }
         out[k] = lo * 0.6 / expo;
      }
      return out;
   };
   const skyFog = skyOf(fog), skyMix = (hex, t) => skyOf(hex).lerp(skyFog, Math.min(1, t));
   return { ...th, fog, fogNear: Math.max(15, (th.fogNear ?? 260) * (1 - 1.4 * f)), fogFar: Math.max(240, (th.fogFar ?? 1150) * (1 - 1.12 * f)),
      skyHor: skyFog, skyTop: skyMix(th.skyTop ?? 0x5f8fc4, f * 1.3), skyLow: skyMix(th.skyLow ?? 0x7a7a62, f * 2.5),
      sunIntensity: (th.sunIntensity ?? 2.6) * (1 - 0.45 * f), hemiIntensity: (th.hemiIntensity ?? 0.95) * (1 + 0.25 * f), cloud: (th.cloud ?? 0.6) * (1 - f),
      skySun: mix(th.sunColor ?? 0xfff1d6, 0x000000, 0.4 + 0.6 * f) };   // no glow or white clouds through the mist
}
