// game/sky.js — sky dome: gradient + sun glow + lit procedural clouds in one shader, one draw call.
// Follows the camera, drawn first, ignores fog/depth. Its horizon is the scene fog colour plus the
// same sun in-scatter render.js adds to fogged meshes, so distant terrain melts into the sky.
import * as THREE from '../vendor/three/three.module.min.js';

const VS = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;
const FS = `uniform vec3 top; uniform vec3 hor; uniform vec3 fogCol; uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 sunLight; uniform float cloud; uniform float time;
varying vec3 vDir;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*n(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }
void main(){
  vec3 d = normalize(vDir); float y = max(d.y, 0.0);
  float mu = max(dot(d, sunDir), 0.0);
  // the fog colour as render.js' fog_fragment computes it for a fully fogged object in this direction
  vec3 fogC = fogCol + sunLight * (0.035 * pow(mu, 5.0) + 0.05 * pow(mu, 24.0));
  vec3 c = mix(hor, top, pow(clamp(y * 1.1, 0.0, 1.0), 0.62));
  c += sunCol * (pow(mu, 14.0) * 0.22 + pow(mu, 3.0) * 0.07);
  float cov = 0.0;
  if (cloud > 0.0 && d.y > 0.0) {
    vec2 uv = d.xz / (y + 0.09) * 1.15 + vec2(time * 0.0035, time * 0.0012);
    float base = fbm(uv * 0.55), det = fbm(uv * 2.4 + 5.0);
    float shape = base * 0.78 + det * 0.32;
    cov = smoothstep(0.56 - cloud * 0.24, 0.9 - cloud * 0.1, shape);
    // light from the sun side: density sampled a step towards the sun -> brighter rims, grey bellies
    float toward = fbm((uv + normalize(sunDir.xz + 1e-4) * 0.22) * 0.55) * 0.78 + det * 0.32;
    float lit = clamp(0.62 + (shape - toward) * 3.2, 0.0, 1.0);
    vec3 belly = mix(hor, vec3(0.32, 0.34, 0.37), 0.55), crown = vec3(1.05, 1.03, 0.98);
    vec3 cc = mix(belly, crown, lit * (1.0 - 0.35 * smoothstep(0.75, 1.0, shape)));
    cc += sunCol * pow(mu, 7.0) * 0.55 * (1.0 - cov * 0.6);       // silver lining around the sun
    c = mix(c, cc, cov * smoothstep(0.0, 0.12, y) * 0.95);
  }
  c += sunCol * pow(mu, 1800.0) * 40.0 * (1.0 - cov);              // HDR disc: bloom makes the glow
  // horizon haze: blends exactly into the fog colour at and below the horizon
  c = mix(c, fogC, exp(-y * 9.0));
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
   constructor(scene) {
      this.u = {
         top: { value: new THREE.Color(0x5f8fc4) }, hor: { value: new THREE.Color(0xc6d2d0) }, fogCol: { value: new THREE.Color(0xb9c2b8) },
         sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(0xfff0d0) }, sunLight: { value: new THREE.Color(0xfff1d6).multiplyScalar(2.6) },
         cloud: { value: 0.6 }, time: { value: 0 },
      };
      const m = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VS, fragmentShader: FS, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
      this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), m);
      this.mesh.renderOrder = -10; this.mesh.frustumCulled = false;
      scene.add(this.mesh);
   }
   setTheme(th = {}, sunDir) {
      this.u.top.value.set(th.skyTop ?? 0x5f8fc4); this.u.hor.value.set(th.skyHor ?? th.fog ?? 0xc6d2d0);
      this.u.fogCol.value.set(th.fog ?? 0xb9c2b8); this.u.cloud.value = th.cloud ?? 0.6;
      this.u.sunLight.value.set(th.sunColor ?? 0xfff1d6).multiplyScalar(th.sunIntensity ?? 2.6);
      this.u.sunCol.value.set(th.skySun ?? th.sunColor ?? 0xfff0d0);   // skySun: glow only (fogTheme dims it)
      if (sunDir) this.u.sunDir.value.copy(sunDir);
   }
   update(camera, t) { this.mesh.position.copy(camera.position); this.u.time.value = t; }
}
