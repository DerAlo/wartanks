// game/render.js — renderer, scene, lights, fog, post. The sun is one directional light whose
// shadow frustum follows the camera focus (texel-snapped so shadows do not shimmer while driving).
// Every frame goes through post.js (HDR target, bloom on mid/high, grading, ACES, vignette).
//
// Atmosphere API (also used by campaign ops):
//   R.setTheme(th)            map look: fog / fogNear / fogFar, sun, hemi, exposure, grade{...}
//   R.setFog(amount, color?)  mission fog 0..1 on top of the map theme (0 = clear map look);
//                             closes the fog in, pales it towards `color` (default mist grey) and
//                             fades the sky so the horizon never shows through. Sky follows.
// Fog is three's THREE.Fog (near/far), but the curve is exponential (`fog_fragment` replaced
// below): clear up to `fogNear`, ~97 % at `fogFar`, plus sun in-scatter (warmer haze towards the
// sun) on lit materials. The sky dome (sky.js) evaluates the same colour on its horizon, so a fully
// fogged hill and the sky behind it are one colour.
import * as THREE from '../vendor/three/three.module.min.js';
import { Post } from './post.js';

THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
   varying float vFogDepth;
   varying vec3 vFogView;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
   vFogDepth = - mvPosition.z;
   vFogView = mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
   uniform vec3 fogColor;
   varying float vFogDepth;
   varying vec3 vFogView;
   #ifdef FOG_EXP2
      uniform float fogDensity;
   #else
      uniform float fogNear;
      uniform float fogFar;
   #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
   float fogDist = length(vFogView);
   #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogDist * fogDist );
   #else
      float fogT = clamp( ( fogDist - fogNear ) / max( fogFar - fogNear, 1.0 ), 0.0, 1.0 );
      float fogFactor = 1.0 - exp( -3.6 * pow( fogT, 1.45 ) );
   #endif
   vec3 fogC = fogColor;
   #if NUM_DIR_LIGHTS > 0 && (defined( STANDARD ) || defined( PHONG ) || defined( LAMBERT ) || defined( TOON ))
      float fogMu = max( dot( normalize( vFogView ), directionalLights[ 0 ].direction ), 0.0 );
      fogC += directionalLights[ 0 ].color * ( 0.035 * pow( fogMu, 5.0 ) + 0.05 * pow( fogMu, 24.0 ) );
   #endif
   gl_FragColor.rgb = mix( gl_FragColor.rgb, fogC, fogFactor );
#endif`;

const GRADE = { saturation: 0.98, contrast: 1.08, vignette: 0.32, bloom: 0.14, bloomThreshold: 1.5, tint: null, shadowTint: [0.93, 0.98, 1.06] };

export class Renderer {
   constructor(canvas, q) {
      this.q = q;
      // MSAA lives in the post target; the canvas itself only receives the composite
      const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
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
      this.post = new Post(r, { samples: q.antialias ? (q.msaa ?? 4) : 0, bloomLevels: q.bloomLevels ?? 5 });
      this.post.setQuality({ bloom: q.bloom ?? q.id !== 'low' });
      this.grade = { ...GRADE }; this.sunLight = new THREE.Color();
      this.resize();
      addEventListener('resize', () => this.resize());
   }
   /** Map theme; keeps it as the base that setFog() thickens. */
   setTheme(th = {}) { this.base = th; this.fogAmt = 0; this._apply(th); }
   setFog(amount = 0, color) {
      this.fogAmt = amount; const th = fogTheme(this.base || {}, amount, color);
      this._apply(th); this.sky?.setTheme(th, this.sunDir);
   }
   _apply(th) {
      const fog = th.fog ?? 0xb9c2b8;
      this.scene.fog.color.set(fog);
      this.scene.fog.near = th.fogNear ?? 260; this.scene.fog.far = th.fogFar ?? 1150;
      if (th.sunDir) this.sunDir.set(th.sunDir[0], th.sunDir[1], th.sunDir[2]).normalize();
      this.sun.color.set(th.sunColor ?? 0xfff1d6); this.sun.intensity = th.sunIntensity ?? 2.6;
      this.hemi.color.set(th.skyLight ?? 0xc9dcf0); this.hemi.groundColor.set(th.groundLight ?? 0x5a5236);
      this.hemi.intensity = th.hemiIntensity ?? 0.95;
      this.renderer.toneMappingExposure = th.exposure ?? 1.05;
      this.grade = { ...GRADE, ...(th.grade || {}) };
      this.sunLight.copy(this.sun.color).multiplyScalar(this.sun.intensity);   // sky.js in-scatter
   }
   resize() {
      const w = innerWidth, h = innerHeight;
      this.renderer.setSize(w, h, false);
      const pr = this.renderer.getPixelRatio(); this.post?.setSize(w * pr, h * pr);
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
      this.grade.exposure = this.renderer.toneMappingExposure; this.grade.time = performance.now() / 1000;
      this.post.render(this.scene, this.camera, this.grade);
   }
}

/** Theme with mission fog (0..1) folded in: the fog wall closes in to roughly the spotting range
 *  (spotting.js cuts view by up to 62 %), its colour pales towards `color` (mist grey), and the sky
 *  fades to the fog colour so the horizon does not show through. All colours mix linearly (post.js
 *  renders the scene in linear HDR), so the sky's horizon is simply the fog colour. */
export function fogTheme(th = {}, f = 0, color = 0xc3c7c2) {
   if (!(f > 0)) return th;
   f = Math.min(1, f);
   const mix = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), Math.min(1, t)).getHex();
   const fog = mix(th.fog ?? 0xb9c2b8, color, f);
   return { ...th, fog, fogNear: Math.max(15, (th.fogNear ?? 260) * (1 - 1.4 * f)), fogFar: Math.max(240, (th.fogFar ?? 1150) * (1 - 1.12 * f)),
      skyHor: fog, skyTop: mix(th.skyTop ?? 0x5f8fc4, fog, f * 1.3), skyLow: fog,
      sunIntensity: (th.sunIntensity ?? 2.6) * (1 - 0.45 * f), hemiIntensity: (th.hemiIntensity ?? 0.95) * (1 + 0.25 * f), cloud: (th.cloud ?? 0.6) * (1 - f),
      skySun: mix(th.sunColor ?? 0xfff1d6, 0x000000, 0.4 + 0.6 * f),   // no glow or white clouds through the mist
      grade: { ...(th.grade || {}), saturation: (th.grade?.saturation ?? 1.06) * (1 - 0.25 * f), bloom: 0.1 } };
}
