// game/input.js — keyboard / mouse state. Pointer lock on the canvas during battle; mouse deltas
// and wheel notches accumulate until main.js consumes them once per frame (no allocations).
export class Input {
   constructor(canvas) {
      this.canvas = canvas;
      this.keys = new Set(); this.pressed = new Set();
      this.dx = 0; this.dy = 0; this.wheel = 0;
      this.lmb = false; this.rmb = false; this.lmbPressed = false;
      this.enabled = false; this.sens = 0.0022;
      addEventListener('keydown', (e) => {
         if (!this.enabled) return;
         if (!this.keys.has(e.code)) this.pressed.add(e.code);
         this.keys.add(e.code);
         if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      });
      addEventListener('keyup', (e) => this.keys.delete(e.code));
      addEventListener('blur', () => { this.keys.clear(); this.lmb = this.rmb = false; });
      addEventListener('mousemove', (e) => {
         if (!this.enabled) return;
         if (document.pointerLockElement === canvas || this.rmb || this.forceAim) { this.dx += e.movementX; this.dy += e.movementY; }
      });
      canvas.addEventListener('mousedown', (e) => {
         if (!this.enabled) return;
         // not captured yet (battle started without a click, e.g. a host's MP start): this click only
         // grabs the mouse and is swallowed, so it can't fire or toggle the RMB turret lock by accident
         if (document.pointerLockElement !== canvas && !this.noLock) { this.lock(); return; }
         if (e.button === 0) { this.lmb = true; this.lmbPressed = true; }
         if (e.button === 2) this.rmb = true;
      });
      addEventListener('mouseup', (e) => { if (e.button === 0) this.lmb = false; if (e.button === 2) this.rmb = false; });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      addEventListener('wheel', (e) => {
         if (!this.enabled) return;
         const n = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
         this.wheel += Math.max(-3, Math.min(3, n));
      }, { passive: true });
   }
   down(code) { return this.keys.has(code); }
   hit(code) { return this.pressed.has(code); }
   endFrame() { this.pressed.clear(); this.dx = this.dy = this.wheel = 0; this.lmbPressed = false; }
   /** Grab the mouse. Works without a fresh click while the browser's user-activation window from
    *  the menu click is still open; otherwise it fails quietly and the next canvas click grabs it. */
   lock() { if (this.enabled && !this.noLock && document.pointerLockElement !== this.canvas) { try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {} } }
   unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
}
