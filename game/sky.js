// game/sky.js — sky dome: gradient + sun glow + procedural cloud band in one shader, one draw call.
// Follows the camera, drawn first, ignores fog/depth.
import * as THREE from '../vendor/three/three.module.min.js';

const VS = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;
const FS = `uniform vec3 top; uniform vec3 hor; uniform vec3 low; uniform vec3 sunDir; uniform vec3 sunCol; uniform float cloud; uniform float time;
varying vec3 vDir;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
void main(){
  vec3 d = normalize(vDir); float y = d.y;
  vec3 c = y > 0.0 ? mix(hor, top, pow(clamp(y,0.0,1.0), 0.55)) : mix(hor, low, clamp(-y*6.0,0.0,1.0));
  float sd = max(dot(d, sunDir), 0.0);
  c += sunCol * (pow(sd, 900.0) * 6.0 + pow(sd, 12.0) * 0.28 + pow(sd, 3.0) * 0.08);
  if (y > 0.0 && cloud > 0.0) {
    vec2 uv = d.xz / (y + 0.12) * 1.6 + vec2(time * 0.004, time * 0.0015);
    float k = smoothstep(0.52 - cloud * 0.18, 0.86, fbm(uv));
    vec3 cc = mix(vec3(0.92,0.93,0.9), vec3(0.62,0.65,0.66), smoothstep(0.6,1.0,fbm(uv*1.7+3.0)));
    cc += sunCol * pow(sd, 6.0) * 0.25;
    c = mix(c, cc, k * smoothstep(0.0, 0.18, y) * 0.9);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
   constructor(scene) {
      this.u = {
         top: { value: new THREE.Color(0x5f8fc4) }, hor: { value: new THREE.Color(0xc6d2d0) }, low: { value: new THREE.Color(0x7a7a62) },
         sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(0xfff0d0) },
         cloud: { value: 0.6 }, time: { value: 0 },
      };
      const m = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VS, fragmentShader: FS, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
      this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), m);
      this.mesh.renderOrder = -10; this.mesh.frustumCulled = false;
      scene.add(this.mesh);
   }
   setTheme(th = {}, sunDir) {
      this.u.top.value.set(th.skyTop ?? 0x5f8fc4); this.u.hor.value.set(th.skyHor ?? th.fog ?? 0xc6d2d0);
      this.u.low.value.set(th.skyLow ?? 0x7a7a62); this.u.cloud.value = th.cloud ?? 0.6;
      this.u.sunCol.value.set(th.sunColor ?? 0xfff0d0);
      if (sunDir) this.u.sunDir.value.copy(sunDir);
   }
   update(camera, t) { this.mesh.position.copy(camera.position); this.u.time.value = t; }
}
