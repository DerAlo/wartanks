// game/menu.js — main menu, garage (tank list, turntable, stats, armour viewer), battle setup,
// settings, pause overlay and results screen. DOM on #menu over the WebGL canvas; the 3D
// background (garage turntable) lives in R.scene only while no battle runs.
// Reads config.js / maps.js / armor.js / tanks3d.js; uses progress.js when it exists (optional).
import * as THREE from '../vendor/three/three.module.min.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 0) => (v == null || Number.isNaN(v)) ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const SET_KEY = 'wartanks.menu.v1', INPUT_KEY = 'wartanks.input.v1';
const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const MODES = [
   { id: 'standard', name: 'Standardgefecht', desc: 'Zwei Basen. Sieg durch Vernichtung aller Gegner oder Einnahme der feindlichen Basis.' },
   { id: 'encounter', name: 'Begegnungsgefecht', desc: 'Eine neutrale Basis in der Kartenmitte – wer sie hält, gewinnt.' },
   { id: 'training', name: 'Übungsplatz', desc: 'Freies Fahren, Zielpanzer jeder Art, Panzerung unter dem Fadenkreuz prüfen.' },
];
const OUTCOME = { aborted: 'GEFECHT VERLASSEN', win: 'SIEG', won: 'SIEG', loss: 'NIEDERLAGE', lost: 'NIEDERLAGE', draw: 'UNENTSCHIEDEN' };

// class icons (own design): diamond = tank, bars = weight class, triangle = tank destroyer
const CLS_ICON = {
   LT: '<path d="M8 1 15 8 8 15 1 8Z" fill="none" stroke="currentColor" stroke-width="2"/>',
   MT: '<path d="M8 1 15 8 8 15 1 8Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 8h6" stroke="currentColor" stroke-width="2.4"/>',
   HT: '<path d="M8 1 15 8 8 15 1 8Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 6.5h6M5 9.5h6" stroke="currentColor" stroke-width="1.8"/>',
   TD: '<path d="M1.5 2.5h13L8 14.5Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 5.5h5" stroke="currentColor" stroke-width="1.8"/>',
};
const clsIcon = (c) => `<svg class="pz-ci" viewBox="0 0 16 16" width="16" height="16">${CLS_ICON[c] || CLS_ICON.MT}</svg>`;

// armour colour scale (mm): thin = blue/green, thick = red/purple
const SCALE = [[0, 0x3d6f9e], [30, 0x4fa36a], [60, 0xb9c64a], [90, 0xe8c23a], [130, 0xe07a1f], [180, 0xc7352b], [250, 0x7a2a72]];
const _ca = new THREE.Color(), _cb = new THREE.Color();
function armorColor(mm, out) {
   for (let i = 1; i < SCALE.length; i++) if (mm <= SCALE[i][0] || i === SCALE.length - 1) {
      const [a, ca] = SCALE[i - 1], [b, cb] = SCALE[i], k = Math.max(0, Math.min(1, (mm - a) / (b - a)));
      return out.copy(_ca.setHex(ca)).lerp(_cb.setHex(cb), k);
   }
   return out;
}

const CSS = `
#menu { pointer-events: none; font-family: var(--font); color: var(--ink); }
#menu .pz-card, #menu button, #menu select, #menu input, #menu .pz-int { pointer-events: auto; }
.pz-scr { position: absolute; inset: 0; display: none; }
.pz-scr.on { display: block; }
.pz-st { font-family: var(--font-stencil); letter-spacing: .14em; text-transform: uppercase; font-weight: 700; }
#menu button { font: 600 13px var(--font); letter-spacing: .08em; text-transform: uppercase; color: var(--khaki); background: var(--olive-dk);
   border: 1px solid var(--khaki-3); padding: 8px 14px; cursor: pointer; }
#menu button:hover { background: var(--olive); color: var(--paper); }
#menu button.on { background: var(--khaki); color: var(--ink); border-color: var(--khaki); }
#menu button.pri { background: var(--signal); color: #1b1206; border-color: var(--signal-hi); }
#menu button.pri:hover { background: var(--signal-hi); }
#menu button:disabled { opacity: .45; cursor: default; }
.pz-card { background: var(--paper); color: var(--ink); border: 1px solid var(--khaki-3); box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.pz-k { font: 600 10px var(--font); letter-spacing: .22em; text-transform: uppercase; color: var(--ink-3); }
/* title */
.pz-title { position: absolute; left: 7vw; top: 50%; transform: translateY(-55%); }
.pz-logo { font-size: 112px; line-height: .9; color: var(--paper); text-shadow: 0 3px 0 var(--olive-dk), 0 0 40px rgba(0,0,0,.5); letter-spacing: .2em; }
.pz-sub { color: var(--khaki); letter-spacing: .4em; font-size: 14px; margin: 14px 0 34px 6px; text-shadow: 0 1px 2px #000; }
.pz-title .pz-btns { display: flex; flex-direction: column; gap: 10px; width: 300px; }
.pz-title button { font-size: 18px !important; padding: 14px 20px !important; text-align: left; }
.pz-foot { position: absolute; left: 7vw; bottom: 26px; color: var(--khaki-2); font-size: 11px; letter-spacing: .2em; text-shadow: 0 1px 2px #000; }
/* garage */
.pz-top { position: absolute; left: 0; right: 0; top: 0; height: 50px; display: flex; align-items: center; gap: 14px; padding: 0 16px;
   background: linear-gradient(var(--olive-dk), rgba(46,50,31,.85)); border-bottom: 2px solid var(--signal); pointer-events: auto; color: var(--khaki); }
.pz-top .pz-logo { font-size: 26px; text-shadow: none; color: var(--paper); }
.pz-top .sp { flex: 1; }
.pz-top .cur { font-size: 14px; letter-spacing: .06em; } .pz-top .cur b { color: var(--paper); }
.pz-list { position: absolute; left: 12px; top: 62px; bottom: 12px; width: 270px; overflow-y: auto; padding: 8px 0; }
.pz-nat { padding: 10px 12px 4px; } .pz-nat .pz-k { color: var(--ink-2); border-bottom: 2px solid var(--ink-2); padding-bottom: 3px; display: block; }
.pz-row { display: grid; grid-template-columns: 18px 34px 1fr auto; gap: 6px; align-items: center; padding: 6px 12px; cursor: pointer; font-size: 14px; pointer-events: auto; }
.pz-row:hover { background: rgba(75,81,50,.14); }
.pz-row.sel { background: var(--olive); color: var(--paper); }
.pz-row .t { font-family: var(--font-cond); color: var(--ink-3); font-size: 12px; letter-spacing: .1em; }
.pz-row.sel .t { color: var(--khaki); }
.pz-row .s { font-size: 10px; letter-spacing: .12em; color: var(--signal-lo); text-transform: uppercase; }
.pz-row.lock { opacity: .55; }
.pz-ci { display: block; color: var(--ink-2); } .pz-row.sel .pz-ci { color: var(--signal-hi); }
.pz-stats { position: absolute; right: 12px; top: 62px; bottom: 12px; width: 360px; overflow-y: auto; padding: 14px 16px; }
.pz-name { font-size: 30px; line-height: 1; margin: 4px 0 2px; color: var(--ink); }
.pz-meta { color: var(--ink-3); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.pz-sec { margin-top: 12px; } .pz-sec h4 { margin: 0 0 4px; font: 700 12px var(--font-stencil); letter-spacing: .2em; color: var(--olive); border-bottom: 1px solid var(--rule); padding-bottom: 3px; }
.pz-kv { display: grid; grid-template-columns: 1fr auto; font-size: 13px; padding: 2px 0; } .pz-kv span:last-child { font-weight: 700; font-variant-numeric: tabular-nums; }
.pz-arm { display: grid; grid-template-columns: 1fr 52px 52px 52px; font-size: 13px; text-align: right; } .pz-arm > :nth-child(4n+1) { text-align: left; }
.pz-arm .h { font-size: 10px; color: var(--ink-3); letter-spacing: .12em; text-transform: uppercase; }
.pz-ammo { width: 100%; border-collapse: collapse; font-size: 12px; } .pz-ammo td, .pz-ammo th { padding: 3px 4px; text-align: right; border-bottom: 1px solid var(--rule); }
.pz-ammo th { font-size: 10px; color: var(--ink-3); letter-spacing: .1em; font-weight: 600; } .pz-ammo td:first-child, .pz-ammo th:first-child { text-align: left; }
.pz-ammo i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.pz-prog { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.pz-setup { position: absolute; left: 296px; right: 386px; bottom: 12px; padding: 10px 12px; display: grid; grid-template-columns: 1fr auto; gap: 8px 14px; }
.pz-setup .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pz-setup select { font: 600 13px var(--font); padding: 7px; background: var(--khaki); border: 1px solid var(--khaki-3); color: var(--ink); }
.pz-setup .go { grid-row: 1 / span 3; grid-column: 2; font: 700 26px var(--font-stencil) !important; letter-spacing: .2em !important; padding: 0 34px !important; }
.pz-setup .desc { font-size: 12px; color: var(--ink-2); min-height: 16px; }
.pz-av { position: absolute; left: 296px; top: 62px; display: flex; gap: 6px; flex-direction: column; align-items: flex-start; }
.pz-av .row { display: flex; gap: 4px; }
.pz-legend { padding: 6px 8px; font-size: 11px; } .pz-legend .bar { display: flex; height: 10px; width: 240px; margin: 4px 0 2px; }
.pz-legend .lab { display: flex; justify-content: space-between; width: 240px; font-variant-numeric: tabular-nums; }
.pz-toast { position: absolute; left: 50%; top: 70px; transform: translateX(-50%); padding: 10px 18px; font-weight: 600; letter-spacing: .06em; }
.pz-tip { position: absolute; padding: 6px 9px; font-size: 12px; display: none; background: var(--panel-solid); color: var(--hud); border: 1px solid var(--panel-edge); pointer-events: none; white-space: nowrap; }
.pz-tip b { color: var(--signal-hi); font-size: 14px; }
.pz-hint { position: absolute; left: 50%; transform: translateX(-50%); bottom: 150px; color: var(--paper); font-size: 11px; letter-spacing: .2em; text-shadow: 0 1px 2px #000; text-transform: uppercase; }
/* modal (settings / pause / results) */
.pz-modal { position: absolute; inset: 0; background: var(--veil); display: none; place-items: center; pointer-events: auto; }
.pz-modal.on { display: grid; }
.pz-modal .pz-card { min-width: 420px; max-width: 760px; padding: 22px 26px; }
.pz-modal h2 { margin: 0 0 14px; font-size: 30px; color: var(--ink); }
.pz-modal .bt { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
.pz-modal .col { display: flex; flex-direction: column; gap: 8px; min-width: 260px; }
.pz-set { display: grid; grid-template-columns: 170px 1fr; gap: 12px 14px; align-items: center; font-size: 14px; }
.pz-set input[type=range] { width: 220px; accent-color: var(--signal); }
.pz-res h2 { font-size: 54px !important; margin-bottom: 2px !important; } .pz-res h2.win { color: var(--olive); } .pz-res h2.loss { color: var(--bad); }
.pz-res .why { color: var(--ink-2); margin-bottom: 14px; font-size: 14px; }
.pz-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.pz-grid div { background: var(--khaki); padding: 8px 10px; } .pz-grid b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
.pz-grid .gold { background: var(--olive); color: var(--paper); } .pz-grid .gold .pz-k { color: var(--khaki); }
/* campaign: operations list (index cards on a dark map table), briefing sheet, results */
#pz-camp { background: radial-gradient(ellipse at 50% 40%, rgba(20,22,14,.55), rgba(10,11,7,.88)); pointer-events: auto; }
#pz-brief { background: linear-gradient(90deg, rgba(10,11,7,.82) 0, rgba(10,11,7,.5) 46%, rgba(10,11,7,0) 62%, rgba(10,11,7,0) 70%, rgba(10,11,7,.6) 100%); }
.pz-ops { position: absolute; left: 50%; top: 92px; bottom: 24px; transform: translateX(-50%); width: min(1180px, 94vw); overflow-y: auto; }
.pz-ops-h { display: flex; align-items: baseline; gap: 18px; color: var(--khaki); margin: 0 4px 14px; }
.pz-ops-h h1 { margin: 0; font-size: 40px; color: var(--paper); letter-spacing: .22em; }
.pz-ops-h .sp { flex: 1; } .pz-ops-h .tot { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; } .pz-ops-h .tot b { color: var(--signal-hi); font-size: 18px; }
.pz-opgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.pz-op { position: relative; background: var(--paper); color: var(--ink); border: 1px solid var(--khaki-3); border-left: 8px solid var(--nat, var(--olive));
   padding: 14px 16px 12px 16px; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,.4); transition: transform .12s, box-shadow .12s; min-height: 150px; }
.pz-op:hover { transform: translateY(-3px); box-shadow: 0 10px 28px rgba(0,0,0,.5); border-left-color: var(--signal); }
.pz-op .no { font: 700 12px var(--font-stencil); letter-spacing: .3em; color: var(--ink-3); }
.pz-op .nm { font: 700 24px/1.05 var(--font-stencil); letter-spacing: .06em; margin: 6px 0 6px; text-transform: uppercase; }
.pz-op .pl { font-size: 13px; color: var(--ink-2); } .pz-op .dt { font: 600 12px var(--font-cond); letter-spacing: .12em; color: var(--signal-lo); text-transform: uppercase; margin-top: 2px; }
.pz-op .ins { position: absolute; right: 12px; top: 12px; width: 34px; height: 34px; }
.pz-op .ft { display: flex; align-items: center; gap: 10px; margin-top: 12px; border-top: 1px solid var(--rule); padding-top: 8px; font-size: 12px; color: var(--ink-3); }
.pz-op .ft .sp { flex: 1; }
.pz-op.lock { cursor: default; filter: grayscale(.85); opacity: .62; } .pz-op.lock:hover { transform: none; border-left-color: var(--nat, var(--olive)); }
.pz-op .lk { display: inline-block; font: 700 12px var(--font-stencil); letter-spacing: .2em; color: var(--bad); border: 2px solid var(--bad); padding: 2px 8px; transform: rotate(-6deg); }
.pz-op .done { position: absolute; right: 56px; top: 14px; font: 700 11px var(--font-stencil); letter-spacing: .2em; color: var(--olive); border: 2px solid var(--olive); padding: 1px 6px; transform: rotate(4deg); }
.pz-stars { display: inline-flex; gap: 2px; font-size: 18px; line-height: 1; letter-spacing: 0; } .pz-stars i { font-style: normal; color: rgba(0,0,0,.18); } .pz-stars i.on { color: var(--signal); text-shadow: 0 1px 0 var(--signal-lo); }
.pz-sheet { position: absolute; left: 4vw; top: 70px; bottom: 22px; width: min(600px, 46vw); overflow-y: auto; background: var(--paper); color: var(--ink);
   padding: 26px 32px 22px; box-shadow: 0 10px 40px rgba(0,0,0,.55), inset 0 0 0 7px var(--paper), inset 0 0 0 8px var(--ink-3), inset 0 0 0 10px var(--paper), inset 0 0 0 11px var(--ink-3); }
.pz-sheet .kick { font: 700 11px var(--font); letter-spacing: .32em; text-transform: uppercase; color: var(--signal-lo); }
.pz-sheet .when { display: flex; gap: 16px; align-items: baseline; margin-top: 10px; font: 600 15px var(--font-cond); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
.pz-sheet h2 { font: 700 36px/1.02 var(--font-stencil); letter-spacing: .08em; margin: 8px 0 10px; text-transform: uppercase; color: var(--ink); }
.pz-sheet p { font: 15px/1.55 Georgia, 'Times New Roman', serif; margin: 0 0 11px; color: var(--ink); text-align: justify; hyphens: auto; }
.pz-sheet h4 { margin: 16px 0 6px; font: 700 12px var(--font-stencil); letter-spacing: .24em; color: var(--olive); border-bottom: 1px solid var(--rule); padding-bottom: 3px; }
.pz-sheet ul { list-style: none; margin: 0; padding: 0; } .pz-sheet li { padding: 3px 0 3px 22px; position: relative; font-size: 14px; }
.pz-sheet li::before { content: '◆'; position: absolute; left: 4px; color: var(--signal); font-size: 11px; top: 5px; }
.pz-sheet .tip { margin-top: 12px; padding: 8px 12px; background: var(--khaki); border-left: 4px solid var(--signal); font-size: 13px; }
.pz-stamp { position: absolute; right: 26px; top: 24px; transform: rotate(9deg); font: 700 15px var(--font-stencil); letter-spacing: .26em; color: rgba(156,42,34,.78);
   border: 3px double rgba(156,42,34,.7); padding: 4px 10px; text-transform: uppercase; }
.pz-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; } .pz-chips span { font: 600 11px var(--font); letter-spacing: .12em; text-transform: uppercase; background: var(--khaki); padding: 3px 8px; }
.pz-bside { position: absolute; right: 18px; top: 70px; width: 340px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.pz-bside h4 { margin: 0; font: 700 12px var(--font-stencil); letter-spacing: .24em; color: var(--olive); border-bottom: 1px solid var(--rule); padding-bottom: 3px; }
.pz-tk { display: grid; grid-template-columns: 18px 1fr auto; gap: 4px 8px; align-items: center; padding: 7px 10px; cursor: pointer; border: 1px solid var(--rule); }
.pz-tk:hover { background: rgba(75,81,50,.12); } .pz-tk.sel { background: var(--olive); color: var(--paper); border-color: var(--olive); } .pz-tk.sel .pz-ci { color: var(--signal-hi); }
.pz-tk .n { font-weight: 700; font-size: 15px; } .pz-tk .m { grid-column: 2 / 4; font-size: 11px; letter-spacing: .04em; color: var(--ink-3); font-variant-numeric: tabular-nums; } .pz-tk.sel .m { color: var(--khaki); }
.pz-tk .t { font: 600 11px var(--font-cond); letter-spacing: .1em; color: var(--ink-3); } .pz-tk.sel .t { color: var(--khaki); }
.pz-bside .row { display: flex; gap: 6px; flex-wrap: wrap; }
.pz-bside .go { font: 700 22px var(--font-stencil) !important; letter-spacing: .18em !important; padding: 14px 10px !important; margin-top: 6px; }
.pz-bside .rec { font-size: 12px; color: var(--ink-2); display: flex; justify-content: space-between; align-items: center; }
.pz-cres { display: grid; grid-template-columns: 1fr 170px; gap: 6px 22px; }
.pz-cres .obj { list-style: none; margin: 0; padding: 0; } .pz-cres .obj li { display: grid; grid-template-columns: 22px 1fr auto; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--rule); font-size: 14px; align-items: center; }
.pz-cres .obj .ck { font-weight: 700; text-align: center; } .pz-cres .obj .done .ck { color: var(--olive); } .pz-cres .obj .failed .ck, .pz-cres .obj .failed { color: var(--bad); }
.pz-cres .obj .active { color: var(--ink-3); } .pz-cres .obj .bn { font: 700 9px var(--font); letter-spacing: .2em; text-transform: uppercase; background: var(--khaki-2); padding: 2px 5px; color: var(--ink-2); }
.pz-cres .md { grid-row: 1 / span 3; grid-column: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
.pz-cres .md .pz-stars { font-size: 30px; } .pz-cres .md .lab { font: 700 14px var(--font-stencil); letter-spacing: .24em; text-transform: uppercase; }
.pz-cres .mini { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-top: 10px; } .pz-cres .mini b { font-size: 16px; color: var(--ink); }
`;

// campaign: nation colours and vehicle insignia (no flags), star rows, medal
const NAT_COL = { DE: '#5d6266', SU: '#9c2a22', US: '#55613a', UK: '#33507a' };
const NAT_NAME = { DE: 'Deutschland', SU: 'Sowjetunion', US: 'USA', UK: 'Großbritannien' };
const INSIGNIA = {
   DE: '<path d="M13 3h8v10h10v8H21v10h-8V21H3v-8h10z" fill="#f2efe4"/><path d="M15 5h4v10h10v4H19v10h-4V19H5v-4h10z" fill="#111"/>',
   SU: '<path d="M17 2l3.7 10.4h11l-8.9 6.6 3.4 10.6L17 23.1l-9.2 6.5 3.4-10.6-8.9-6.6h11z" fill="#c4271d" stroke="#6e1410" stroke-width="1"/>',
   US: '<circle cx="17" cy="17" r="15" fill="#1f3b73"/><path d="M17 4.5l2.9 8.3h8.8l-7.1 5.2 2.7 8.4L17 21.3l-7.3 5.1 2.7-8.4-7.1-5.2h8.8z" fill="#f2efe4"/>',
   UK: '<circle cx="17" cy="17" r="15" fill="#1f3b73"/><circle cx="17" cy="17" r="10" fill="#f2efe4"/><circle cx="17" cy="17" r="5.5" fill="#b3261e"/>',
};
const insignia = (n) => `<svg class="ins" viewBox="0 0 34 34">${INSIGNIA[n] || INSIGNIA.DE}</svg>`;
const stars = (n, of = 3) => `<span class="pz-stars">${Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}">★</i>`).join('')}</span>`;
const MEDAL = { gold: ['#fff1a8', '#d9a92b', '#8a6410', 'Gold'], silber: ['#ffffff', '#b9bec4', '#62686e', 'Silber'], bronze: ['#ffd2a1', '#b46d34', '#5f3412', 'Bronze'] };
function medalSvg(kind) {
   const M = MEDAL[kind]; if (!M) return '<svg width="120" height="150" viewBox="0 0 120 150"><circle cx="60" cy="88" r="40" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="3" stroke-dasharray="6 6"/></svg>';
   const id = 'pzm-' + kind;
   return `<svg width="120" height="150" viewBox="0 0 120 150"><defs><radialGradient id="${id}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="${M[0]}"/><stop offset=".55" stop-color="${M[1]}"/><stop offset="1" stop-color="${M[2]}"/></radialGradient></defs>
      <path d="M38 0h18l10 52H48z" fill="#9c2a22"/><path d="M64 0h18L72 52H54z" fill="#1d1d1b"/><path d="M41 0h4l10 52h-4zM75 0h4L69 52h-4z" fill="#f2efe4" opacity=".85"/>
      <circle cx="60" cy="90" r="42" fill="${M[2]}"/><circle cx="60" cy="88" r="40" fill="url(#${id})"/><circle cx="60" cy="88" r="31" fill="none" stroke="${M[2]}" stroke-width="2" opacity=".7"/>
      <path d="M60 64l6.5 15.5h16.5l-13.3 10 5 16-14.7-9.9-14.7 9.9 5-16-13.3-10h16.5z" fill="${M[1]}" stroke="${M[2]}" stroke-width="1.6"/></svg>`;
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const mmss = (t) => t == null ? '–' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Menu {
   constructor(root, ctx) {
      this.root = root; this.ctx = ctx; this.mods = ctx.mods; this.R = ctx.R;
      const C = this.C = this.mods.configM || {};
      this.maps = this.mods.mapsM?.MAPS || {}; this.mapList = this.mods.mapsM?.MAP_LIST || Object.keys(this.maps);
      const st = load(SET_KEY);
      this.sel = { cls: C.TANKS?.[st.cls] ? st.cls : (C.TANK_LIST?.includes('pz4h') ? 'pz4h' : C.TANK_LIST?.[0]), mode: st.mode || 'standard', map: st.map || 'random', diff: st.diff || 'normal' };
      if (this.P && !this.owned(this.sel.cls)) this.sel.cls = this.prof().selected || this.sel.cls;
      this.inp = { sens: 1, invert: false, ...load(INPUT_KEY) };
      this.applyInput();
      this.armorView = false; this.effMode = false; this.spin = 0.6; this.yaw = 0.7; this.drag = null; this.t = 0;
      this.mouse = { x: -1, y: -1, in: false };
      const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
      root.innerHTML = this.html();
      this.$ = (q) => root.querySelector(q);
      this.bind();
      this.renderList(); this.renderStats(); this.renderSetup();
   }

   // ---------- progress.js (optional module: garage profile with credits, XP, research, purchases) ----------
   get P() { const m = this.mods.progressM; return m?.loadProfile && m.tankState ? m : null; }
   prof() { return (this._prof ??= this.P.loadProfile()); }
   ts(id) { if (!this.P || !this.C.TANKS?.[id]) return null; try { return this.P.tankState(this.prof(), id); } catch (e) { console.warn('[menu] progress', e); return null; } }
   owned(id) { return this.ts(id)?.owned ?? true; }
   researched(id) { return this.ts(id)?.researched ?? true; }
   credits() { return this.P ? this.prof().credits : null; }
   freeXp() { return this.P ? this.prof().freeXP : null; }
   progAct(fn, id) {
      const r = this.P?.[fn]?.(this.prof(), id);
      if (r && !r.ok) this.toast(r.reason || 'Nicht möglich');
      else if (r?.ok) { this.toast(fn === 'buy' ? 'Gekauft: ' + this.C.TANKS[id].name : 'Erforscht: ' + this.C.TANKS[id].name); this.ctx.getAudio?.()?.ui?.('buy'); }
   }
   applyResult(snap) {
      if (!this.P || !snap.result) return;
      if (snap.mode === 'campaign') {   // operations: a record (stars, best time) instead of XP/credits; any listed tank may be used
         try { this.P.recordCampaign?.(this.prof(), snap.op || snap.result.campaign?.op, snap.result); } catch (e) { console.warn('[menu] campaign record', e); }
         return;
      }
      if (!this.owned(snap.playerCls)) { snap.result.unowned = true; return; }
      try { this.P.applyRewards(this.prof(), snap.playerCls, { ...snap.result, dmg: snap.stats?.dmg, kills: snap.stats?.kills }); } catch (e) { console.warn('[menu] rewards', e); }
   }
   toast(text) {
      const t = document.createElement('div'); t.className = 'pz-toast pz-card'; t.textContent = text; this.root.appendChild(t);
      setTimeout(() => t.remove(), 2600);
   }

   html() {
      const C = this.C;
      return `
<div class="pz-scr" id="pz-title">
   <div class="pz-title"><div class="pz-logo pz-st">PANZER</div><div class="pz-sub pz-st">Panzergefechte 1939 – 1945</div>
      <div class="pz-btns"><button class="pri" data-a="garage">Gefecht</button><button data-a="camp">Feldzug</button><button data-a="mp" id="pz-mp">Mehrspieler</button><button data-a="settings">Einstellungen</button></div></div>
   <div class="pz-foot pz-st">Panzerung · Winkel · Munition · Gelände</div>
</div>
<div class="pz-scr" id="pz-camp">
   <div class="pz-top"><span class="pz-logo pz-st">PANZER</span><span class="pz-k" style="color:var(--khaki-2)">Feldzug</span><span class="sp"></span>
      <button data-a="garage">Garage</button><button data-a="settings">Einstellungen</button><button data-a="title">Hauptmenü</button></div>
   <div class="pz-ops" id="pz-ops"></div>
</div>
<div class="pz-scr" id="pz-brief">
   <div class="pz-top"><span class="pz-logo pz-st">PANZER</span><span class="pz-k" style="color:var(--khaki-2)">Feldzug · Einsatzbesprechung</span><span class="sp"></span>
      <button data-a="camp">Operationen</button><button data-a="title">Hauptmenü</button></div>
   <div class="pz-sheet" id="pz-sheet"></div>
   <div class="pz-card pz-bside" id="pz-bside"></div>
</div>
<div class="pz-scr" id="pz-garage">
   <div class="pz-top"><span class="pz-logo pz-st">PANZER</span><span class="pz-k" style="color:var(--khaki-2)">Garage</span><span class="sp"></span>
      <span class="cur" id="pz-cur"></span><button data-a="settings">Einstellungen</button><button data-a="title">Hauptmenü</button></div>
   <div class="pz-card pz-list" id="pz-list"></div>
   <div class="pz-card pz-stats" id="pz-stats"></div>
   <div class="pz-av"><div class="row"><button id="pz-avb" data-a="armor">Panzerung anzeigen</button></div>
      <div class="row" id="pz-avm" style="display:none"><button data-a="nominal" class="on">Nennstärke</button><button data-a="eff">Effektiv aus Blickrichtung</button></div>
      <div class="pz-card pz-legend" id="pz-leg" style="display:none"></div></div>
   <div class="pz-hint" id="pz-hint">Ziehen zum Drehen · Mausrad zoomt</div>
   <div class="pz-card pz-setup" id="pz-setup"></div>
   <div class="pz-tip" id="pz-tip"></div>
</div>
<div class="pz-modal" id="pz-settings"><div class="pz-card"><h2 class="pz-st">Einstellungen</h2><div class="pz-set">
   <span>Grafikqualität</span><span class="row" id="pz-q"></span>
   <span>Gesamtlautstärke</span><span><input type="range" id="pz-vol" min="0" max="100"> <b id="pz-volv"></b></span>
   <span>Ton aus</span><span><input type="checkbox" id="pz-mute"></span>
   <span>Mausempfindlichkeit</span><span><input type="range" id="pz-sens" min="25" max="300"> <b id="pz-sensv"></b></span>
   <span>Maus Y invertieren</span><span><input type="checkbox" id="pz-inv"></span></div>
   <div class="pz-k" id="pz-qnote" style="margin-top:10px;display:none">Grafikqualität wird beim nächsten Laden der Seite aktiv.</div>
   <div class="bt"><button id="pz-reload" style="display:none" data-a="reload">Jetzt neu laden</button><button class="pri" data-a="closeSettings">Fertig</button></div></div></div>
<div class="pz-modal" id="pz-pause"><div class="pz-card"><h2 class="pz-st">Pause</h2><div class="col">
   <button class="pri" data-a="resume">Fortsetzen</button><button data-a="settings">Einstellungen</button><button data-a="leave">Gefecht verlassen</button></div></div></div>
<div class="pz-modal" id="pz-results"><div class="pz-card pz-res" id="pz-resc"></div></div>`;
   }

   bind() {
      this.root.addEventListener('click', (e) => {
         const b = e.target.closest('[data-a]'); if (b) { this.ctx.getAudio?.()?.ui?.('click'); this.action(b.dataset.a, b); }
         const r = e.target.closest('[data-tank]'); if (r) this.select(r.dataset.tank);
         const s = e.target.closest('[data-set]'); if (s) { this.sel[s.dataset.set] = s.dataset.v; save(SET_KEY, this.sel); this.renderSetup(); }
         const p = e.target.closest('[data-prog]'); if (p) { this.progAct(p.dataset.prog, this.sel.cls); this.renderList(); this.renderStats(); this.renderSetup(); }
      });
      this.root.addEventListener('change', (e) => { if (e.target.id === 'pz-map') { this.sel.map = e.target.value; save(SET_KEY, this.sel); this.renderSetup(); } });
      // turntable drag + hover on the canvas (the menu shell is pointer-events:none)
      const cv = this.R.renderer.domElement;
      cv.addEventListener('mousedown', (e) => { if (this.scene && e.button === 0) this.drag = { x: e.clientX, yaw: this.yaw }; });
      addEventListener('mouseup', () => { this.drag = null; });
      addEventListener('mousemove', (e) => {
         this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.in = e.target === cv;
         if (this.drag) { this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.008; this.spin = 0; }
      });
      cv.addEventListener('wheel', (e) => { if (this.scene) this.zoom = Math.max(0.7, Math.min(1.6, (this.zoom || 1) * (e.deltaY > 0 ? 1.08 : 0.93))); }, { passive: true });
      // settings widgets
      const au = () => this.ctx.getAudio?.();
      this.$('#pz-vol').addEventListener('input', (e) => { au()?.setVolume?.(e.target.value / 100); this.$('#pz-volv').textContent = e.target.value + ' %'; });
      this.$('#pz-mute').addEventListener('change', (e) => au()?.setMuted?.(e.target.checked));
      this.$('#pz-sens').addEventListener('input', (e) => { this.inp.sens = e.target.value / 100; this.$('#pz-sensv').textContent = fmt(this.inp.sens, 2) + '×'; this.applyInput(); });
      this.$('#pz-inv').addEventListener('change', (e) => { this.inp.invert = e.target.checked; this.applyInput(); });
   }
   applyInput() { save(INPUT_KEY, this.inp); const I = this.ctx.input; if (I) { I.sens = 0.0022 * this.inp.sens; I.invert = !!this.inp.invert; } }

   action(a, el) {
      switch (a) {
         case 'garage': this.viewCls = null; this.show('garage'); break;
         case 'camp': this.$('#pz-results').classList.remove('on'); this.openCampaign(); break;
         case 'toCamp': this.$('#pz-results').classList.remove('on'); this.openCampaign(); break;
         case 'campOp': this.openBrief(el.dataset.op); break;
         case 'campTank': this.camp.cls = this.viewCls = el.dataset.v; this.buildTank(); this.renderBrief(); break;
         case 'campDiff': this.camp.diff = el.dataset.v; this.renderBrief(); break;
         case 'campGo': this.startOp(this.camp.op, this.camp.cls, this.camp.diff); break;
         case 'campRetry': this.$('#pz-results').classList.remove('on'); if (this.lastCamp) this.startOp(this.lastCamp.op, this.lastCamp.cls, this.lastCamp.diff); break;
         case 'campNext': this.$('#pz-results').classList.remove('on'); if (this.lastCamp?.next) { this.camp = { op: this.lastCamp.next, cls: null, diff: this.lastCamp.diff }; this.openBrief(this.lastCamp.next); } break;
         case 'title': this.viewCls = null; this.show('title'); break;
         case 'settings': this.openSettings(); break;
         case 'mp': import('./mpui.js').then((m) => m.openMultiplayer(this)).catch((e) => console.warn('[menu] mpui', e)); break;   // multiplayer screen (lazy)
         case 'closeSettings': this.$('#pz-settings').classList.remove('on'); break;
         case 'reload': location.reload(); break;
         case 'armor': this.setArmorView(!this.armorView); break;
         case 'nominal': case 'eff': this.effMode = a === 'eff'; this.$('#pz-avm').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.a === a)); this.renderLegend(); break;
         case 'go': this.go(); break;
         case 'resume': this.ctx.resume?.(); break;
         case 'leave': this.ctx.leave?.(); break;
         case 'toGarage': this.$('#pz-results').classList.remove('on'); this.show('garage'); break;
         case 'q': this.ctx.saveQuality?.(el.dataset.v); this.$('#pz-q').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
            this.$('#pz-qnote').style.display = this.$('#pz-reload').style.display = this.ctx.q?.id === el.dataset.v ? 'none' : ''; break;
      }
   }

   // ---------------- screens ----------------
   show(which = 'garage') {
      this.root.classList.add('on'); this.screen = which;
      this.root.querySelectorAll('.pz-scr').forEach((s) => s.classList.toggle('on', s.id === 'pz-' + which));
      this.$('#pz-pause').classList.remove('on');
      this.buildScene();
      if (this.scene && this.tankCls !== (this.viewCls || this.sel.cls)) this.buildTank();
      if (which === 'garage') { this.renderList(); this.renderStats(); this.renderSetup(); }
      else this.setArmorView(false);
   }
   hide() { this.root.classList.remove('on'); this.root.querySelectorAll('.pz-modal').forEach((m) => m.classList.remove('on')); this.disposeScene(); }
   pause(on) {
      this.root.classList.toggle('on', on);
      this.root.querySelectorAll('.pz-scr').forEach((s) => s.classList.remove('on'));
      this.$('#pz-pause').classList.toggle('on', on);
      if (!on) this.$('#pz-settings').classList.remove('on');
   }
   get paused() { return this.$('#pz-pause').classList.contains('on'); }

   openSettings() {
      const q = this.ctx.q || {}, P = this.mods.gfxM?.PRESETS || { low: { name: 'Niedrig' }, mid: { name: 'Mittel' }, high: { name: 'Hoch' } };
      const cur = this.ctx.loadQualityId?.() || q.id;
      this.$('#pz-q').innerHTML = Object.entries(P).map(([k, v]) => `<button data-a="q" data-v="${k}" class="${k === cur ? 'on' : ''}">${esc(v.name)}</button>`).join(' ');
      const au = this.ctx.getAudio?.(), vol = Math.round((au?.volume ?? 0.8) * 100);
      this.$('#pz-vol').value = vol; this.$('#pz-volv').textContent = vol + ' %'; this.$('#pz-mute').checked = !!au?.muted;
      this.$('#pz-sens').value = Math.round(this.inp.sens * 100); this.$('#pz-sensv').textContent = fmt(this.inp.sens, 2) + '×'; this.$('#pz-inv').checked = !!this.inp.invert;
      this.$('#pz-qnote').style.display = this.$('#pz-reload').style.display = cur !== q.id ? '' : 'none';
      this.$('#pz-settings').classList.add('on');
   }

   go() {
      const ids = this.mods.mapsM?.RANDOM_MAPS || this.mapList, mapId = this.sel.map === 'random' || !this.maps[this.sel.map] ? ids[(Math.random() * ids.length) | 0] : this.sel.map;
      if (!this.owned(this.sel.cls)) return;
      this.ctx.startBattle({ mode: this.sel.mode, mapId, seed: (Math.random() * 1e9) | 0, playerCls: this.sel.cls, difficulty: this.sel.diff });
   }

   select(id) {
      if (!this.C.TANKS?.[id]) return;
      this.sel.cls = id; save(SET_KEY, this.sel);
      this.renderList(); this.renderStats(); this.renderSetup(); this.buildTank();
   }

   // ---------------- garage panels ----------------
   renderList() {
      const C = this.C, T = C.TANKS || {}, R = C.TIER_ROMAN || [];
      const nats = C.NATION_ORDER || [...new Set((C.TANK_LIST || []).map((id) => T[id].nation))];
      let h = '';
      for (const n of nats) {
         const ids = (C.TANK_LIST || []).filter((id) => T[id].nation === n).sort((a, b) => T[a].tier - T[b].tier || a.localeCompare(b));
         if (!ids.length) continue;
         h += `<div class="pz-nat"><span class="pz-k">${esc(C.NATIONS?.[n]?.name || n)}</span></div>`;
         for (const id of ids) {
            const c = T[id], own = this.owned(id), res = this.researched(id);
            const s = this.P ? (own ? '' : res ? 'kaufbar' : 'gesperrt') : '';
            h += `<div class="pz-row ${id === this.sel.cls ? 'sel' : ''} ${own ? '' : 'lock'}" data-tank="${id}" title="${esc(C.CLASSES?.[c.cls]?.name || c.cls)}">
               ${clsIcon(c.cls)}<span class="t">${R[c.tier] || c.tier}</span><span>${esc(c.name)}</span><span class="s">${s}</span></div>`;
         }
      }
      this.$('#pz-list').innerHTML = h;
      const cr = this.credits(), fx = this.freeXp();
      this.$('#pz-cur').innerHTML = this.P ? `<b>${fmt(cr)}</b> Kreditpunkte${fx != null ? ` · <b>${fmt(fx)}</b> freie EP` : ''}` : '';
   }

   armourSummary(c) {
      const A = this.mods.armorM; if (!A?.armorFor) return null;
      const m = A.armorFor(c), pose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, gunPitch: 0 };
      const H = c.hull, T = c.turret, out = {};
            // nominal thickness of the thickest plate met by level rays at several heights (WoT-style "front / side / rear")
      const probe = (key, y0, y1, cx, cz, dx, dz, part) => {
         let best = null;
         for (let i = 0; i < 7; i++) {
            const y = y0 + (y1 - y0) * (i + 0.5) / 7, o = { x: cx - dx * 30, y, z: cz - dz * 30 };
            const h = A.rayArmor(m, pose, o, { x: dx, y: 0, z: dz }).find((x) => x.part === part);
            if (h && (!best || h.t > best.t)) best = { t: h.t, eff: h.effT };
         }
         out[key] = best;
      };
      const zc = ((H.zMin ?? -3) + (H.zMax ?? 3)) / 2, y0 = H.floorY, y1 = H.roofY;
      probe('hf', y0, y1, 0, zc, 0, 1, 'hull'); probe('hs', y0, y1, 0, zc, 1, 0, 'hull'); probe('hr', y0, y1, 0, zc, 0, -1, 'hull');
      if (T) { const a = T.y + 0.05, b = T.y + T.h - 0.05; probe('tf', a, b, T.x, T.z, 0, 1, 'turret'); probe('ts', a, b, T.x, T.z, 1, 0, 'turret'); probe('tr', a, b, T.x, T.z, 0, -1, 'turret'); }
      return out;
   }

   renderStats() {
      const C = this.C, c = C.TANKS?.[this.sel.cls]; if (!c) return;
      const g = c.gun || {}, ammo = g.ammo || [], ap = ammo[0] || {}, A = C.AMMO || {};
      const kv = (k, v) => `<div class="pz-kv"><span>${k}</span><span>${v}</span></div>`;
      const ar = this.armourSummary(c);
      const am = (o) => o ? `<span title="effektiv ${fmt(o.eff)} mm">${fmt(o.t)}</span>` : '<span>–</span>';
      const pw = c.engine?.hp && c.mass ? c.engine.hp / c.mass : null;
      const tt = c.turretTraverse ?? c.turret?.traverse;
      let prog = '';
      if (this.P) {
         const s = this.ts(c.id) || {};
         prog = `<div class="pz-prog"><span>${fmt(s.xp)} EP auf diesem Panzer</span>
            ${!s.researched ? `<button data-prog="research" ${s.canResearch ? '' : 'disabled'}>Erforschen · ${fmt(s.researchXP)} EP</button>` : ''}
            ${s.researched && !s.owned ? `<button class="pri" data-prog="buy" ${s.canBuy ? '' : 'disabled'}>Kaufen · ${fmt(s.price)} Kr</button>` : ''}
            ${!s.researched && s.prev ? `<span class="pz-k">benötigt EP von ${esc(this.C.TANKS[s.prev]?.name)}</span>` : ''}</div>`;
      }
      this.$('#pz-stats').innerHTML = `
         <div class="pz-meta">${clsIcon(c.cls)}<span>${esc(C.CLASSES?.[c.cls]?.name || c.cls)}</span>·<span>Stufe ${C.TIER_ROMAN?.[c.tier] || c.tier}</span>·<span>${esc(C.NATIONS?.[c.nation]?.name || c.nation)}</span></div>
         <div class="pz-name pz-st">${esc(c.name)}</div>
         ${kv('Strukturpunkte', fmt(c.hp))}${kv('Gewicht', fmt(c.mass, 1) + ' t')}
         <div class="pz-sec"><h4>Feuerkraft</h4>
            ${kv('Kanone', esc(g.name))}${kv('Kaliber', fmt(g.cal, g.cal % 1 ? 1 : 0) + ' mm')}
            ${kv('Durchschlag', ammo.map((a) => fmt(a.pen)).join(' / ') + ' mm')}${kv('Schaden', ammo.map((a) => fmt(a.dmg)).join(' / '))}
            ${kv('Nachladezeit', fmt(g.reload, 1) + ' s')}${kv('Schaden pro Minute', fmt((ap.dmg || 0) * 60 / (g.reload || 1)))}
            ${kv('Zielzeit', fmt(g.aim, 1) + ' s')}${kv('Streuung auf 100 m', fmt(g.disp, 2) + ' m')}${kv('Höhenrichtbereich', `+${fmt(g.elev)}° / ${fmt(g.depr)}°`)}
            ${g.arc ? kv('Seitenrichtbereich', `${fmt(g.arc[0])}° / +${fmt(g.arc[1])}°`) : ''}</div>
         <div class="pz-sec"><h4>Panzerung (mm)</h4>${ar ? `<div class="pz-arm"><span class="h"></span><span class="h">Front</span><span class="h">Seite</span><span class="h">Heck</span>
            <span>Wanne</span>${am(ar.hf)}${am(ar.hs)}${am(ar.hr)}${c.turret ? `<span>Turm</span>${am(ar.tf)}${am(ar.ts)}${am(ar.tr)}` : ''}</div>` : ''}</div>
         <div class="pz-sec"><h4>Mobilität</h4>${kv('Höchstgeschw. vor / zurück', `${fmt(c.vMax)} / ${fmt(c.vRev)} km/h`)}${kv('Motor', fmt(c.engine?.hp) + ' PS')}
            ${kv('Leistungsgewicht', fmt(pw, 1) + ' PS/t')}${kv('Wannendrehgeschw.', fmt(c.traverse) + ' °/s')}${kv('Turmdrehgeschw.', c.turret ? fmt(tt) + ' °/s' : '–')}</div>
         <div class="pz-sec"><h4>Aufklärung</h4>${kv('Sichtweite', fmt(c.view) + ' m')}${kv('Tarnwert stehend / fahrend', `${fmt((c.camo?.still || 0) * 100)} % / ${fmt((c.camo?.move || 0) * 100)} %`)}</div>
         <div class="pz-sec"><h4>Munition</h4><table class="pz-ammo"><tr><th>Typ</th><th>DS 100/500 m</th><th>Schaden</th><th>v₀ m/s</th><th>Vorrat</th></tr>
            ${ammo.map((a) => `<tr><td><i style="background:${A[a.type]?.color || '#ccc'}"></i>${esc(a.type)} <span style="color:var(--ink-3)">${esc(a.name)}</span></td>
               <td>${fmt(a.pen)} / ${fmt(a.pen500 ?? a.pen)}</td><td>${fmt(a.dmg)}</td><td>${fmt(a.vel)}</td><td>${fmt(g.load?.[a.type])}</td></tr>`).join('')}</table></div>
         ${prog}`;
   }

   renderSetup() {
      const S = this.sel, M = this.maps;
      const mode = MODES.find((m) => m.id === S.mode) || MODES[0];
      const mapDesc = S.map === 'random' ? 'Zufällige Karte aus allen Gebieten.' : M[S.map]?.desc || '';
      const D = this.C.DIFFICULTY || { leicht: { name: 'Leicht' }, normal: { name: 'Normal' }, schwer: { name: 'Schwer' } };
      const own = this.owned(S.cls);
      this.$('#pz-setup').innerHTML = `
         <div class="row">${MODES.map((m) => `<button data-set="mode" data-v="${m.id}" class="${m.id === S.mode ? 'on' : ''}">${m.name}</button>`).join('')}</div>
         <div class="row"><select id="pz-map"><option value="random">Zufällige Karte</option>${this.mapList.map((id) => `<option value="${id}" ${id === S.map ? 'selected' : ''}>${esc(M[id]?.name || id)}</option>`).join('')}</select>
            <span class="pz-k" style="margin-left:10px">Gegner</span>${Object.entries(D).map(([k, d]) => `<button data-set="diff" data-v="${k}" class="${k === S.diff ? 'on' : ''}">${esc(d.name)}</button>`).join('')}</div>
         <div class="desc"><b>${esc(mode.name)}:</b> ${esc(mode.desc)}<br><b>${esc(S.map === 'random' ? 'Zufall' : M[S.map]?.name || '')}:</b> ${esc(mapDesc)}</div>
         <button class="pri go" data-a="go" ${own ? '' : 'disabled title="Panzer nicht im Besitz"'}>Gefecht!</button>`;
   }

   renderLegend() {
      const stops = [0, 25, 50, 75, 100, 150, 200, 250];
      const bar = stops.slice(0, -1).map((v) => `<i style="flex:1;background:#${armorColor(v + 12, new THREE.Color()).getHexString()}"></i>`).join('');
      this.$('#pz-leg').innerHTML = `<div class="pz-k">${this.effMode ? 'Effektive Dicke aus Blickrichtung' : 'Nennstärke'} (mm)</div><div class="bar">${bar}</div>
         <div class="lab">${stops.map((v) => `<span>${v}${v === 250 ? '+' : ''}</span>`).join('')}</div>`;
   }

   setArmorView(on) {
      this.armorView = on;
      this.$('#pz-avb').classList.toggle('on', on); this.$('#pz-avb').textContent = on ? 'Panzerung ausblenden' : 'Panzerung anzeigen';
      this.$('#pz-avm').style.display = this.$('#pz-leg').style.display = on ? '' : 'none';
      if (on) { this.renderLegend(); this.spin = 0; }
      if (this.tank) this.tank.root.visible = !on;
      if (this.armor) this.armor.visible = on;
      if (!on) this.$('#pz-tip').style.display = 'none';
   }

   // ---------------- 3D garage scene ----------------
   buildScene() {
      if (this.scene) return;
      const R = this.R, S = this.scene = new THREE.Group(); R.scene.add(S);
      const th = this.ctx.themeOf?.('steppe') || {};
      R.setTheme?.(th); this.ctx.sky?.setTheme?.(th, R.sunDir);
      this.own = [];   // geometries/materials to dispose
      const mk = (geo, mat) => { this.own.push(geo, mat); return new THREE.Mesh(geo, mat); };
      const ground = mk(new THREE.CircleGeometry(900, 48), new THREE.MeshStandardMaterial({ color: 0x5d6440, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; S.add(ground);
      const apron = mk(new THREE.CircleGeometry(11, 48), new THREE.MeshStandardMaterial({ color: 0x8a8670, roughness: 0.95 }));
      apron.rotation.x = -Math.PI / 2; apron.position.y = 0.02; apron.receiveShadow = true; S.add(apron);
      const table = this.table = mk(new THREE.CylinderGeometry(5.4, 5.6, 0.32, 64), new THREE.MeshStandardMaterial({ color: 0x6e6c62, roughness: 0.8, metalness: 0.3 }));
      table.position.y = 0.16; table.receiveShadow = true; table.castShadow = true; S.add(table);
      const ring = mk(new THREE.TorusGeometry(5.0, 0.05, 6, 64), new THREE.MeshStandardMaterial({ color: 0xe07a1f, roughness: 0.6 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.33; S.add(ring);
      // treeline silhouettes on the horizon
      const tg = new THREE.ConeGeometry(1, 1, 6), tm = new THREE.MeshStandardMaterial({ color: 0x3f4a2a, roughness: 1, flatShading: true }); this.own.push(tg, tm);
      const trees = new THREE.InstancedMesh(tg, tm, 140), o = new THREE.Object3D();
      for (let i = 0; i < 140; i++) {
         const a = i * 2.39996 + Math.sin(i) * 0.3, r = 70 + ((i * 37) % 90), h = 7 + ((i * 13) % 9);
         o.position.set(Math.cos(a) * r, h / 2 - 0.5, Math.sin(a) * r); o.scale.set(h * 0.32, h, h * 0.32); o.updateMatrix(); trees.setMatrixAt(i, o.matrix);
      }
      trees.castShadow = true; S.add(trees);
      this.buildTank();
   }
   buildTank() {
      if (!this.scene) return;
      const c = this.C.TANKS?.[this.viewCls || this.sel.cls], T3 = this.mods.tanks3dM;
      if (this.tank) { this.scene.remove(this.tank.root); this.tank = null; }
      this.disposeArmor();
      if (!c || !T3?.buildTankModel) return;
      const m = this.tank = T3.buildTankModel(c, c.id); this.tankCls = c.id;
      m.root.position.y = 0.32; this.scene.add(m.root);
      this.buildArmor(c);
      m.root.visible = !this.armorView;
      this.zoom = this.zoom || 1;
   }
   buildArmor(c) {
      const A = this.mods.armorM; if (!A?.armorFor) return;
      const model = this.armorModel = A.armorFor(c), g = this.armor = new THREE.Group(), T = c.turret, piv = c.gun?.pivot || { x: 0, y: 0, z: 0 };
      const turretG = new THREE.Group(), gunG = new THREE.Group(); gunG.rotation.order = 'YXZ';
      if (T) { turretG.position.set(T.x, T.y, T.z); turretG.add(gunG); } g.add(turretG);
      if (!T) g.add(gunG);
      gunG.position.set(piv.x, piv.y, piv.z);
      this.armorMeshes = []; this.armorGroups = { turretG, gunG };
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x1f2214, transparent: true, opacity: 0.55 }); this.armorOwn = [edgeMat];
      for (const part of model.parts) {
         const parent = part.frame === 'hull' ? g : part.frame === 'turret' ? (T ? turretG : g) : gunG;
         const edges = [];
         for (const f of part.faces) {
            if (f.internal || !f.loop || f.loop.length < 3) continue;
            const pos = [], L = f.loop;
            for (let i = 1; i < L.length - 1; i++) pos.push(...L[0], ...L[i], ...L[i + 1]);
            for (let i = 0; i < L.length; i++) edges.push(...L[i], ...L[(i + 1) % L.length]);
            const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
            const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
            const mesh = new THREE.Mesh(geo, mat);
            const cen = new THREE.Vector3(); for (const p of L) cen.add(new THREE.Vector3(...p)); cen.divideScalar(L.length);
            mesh.userData = { part: part.name, side: part.side, plate: f.plate, t: f.t, n: new THREE.Vector3(...f.normal), c: cen };
            armorColor(f.t, mat.color); parent.add(mesh); this.armorMeshes.push(mesh); this.armorOwn.push(geo, mat);
         }
         if (edges.length) { const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3)); parent.add(new THREE.LineSegments(eg, edgeMat)); this.armorOwn.push(eg); }
      }
      g.position.y = 0.32; g.visible = this.armorView; this.scene.add(g);
   }
   disposeArmor() {
      if (this.armor) { this.scene?.remove(this.armor); for (const o of this.armorOwn) o.dispose(); }
      this.armor = null; this.armorMeshes = []; this.armorOwn = [];
   }
   disposeScene() {
      if (!this.scene) return;
      this.disposeArmor();
      this.R.scene.remove(this.scene);
      for (const o of this.own) o.dispose();
      this.scene = this.tank = null; this.own = [];
   }

   pose() { return { pos: { x: 0, y: 0.32, z: 0 }, yaw: this.yaw, pitch: 0, roll: 0, turretYaw: this.turretYaw || 0, gunPitch: 0 }; }

   update(dt) {
      if (!this.scene) return;
      this.t += dt;
      const R = this.R, cam = R.camera;
      if (!this.drag && !this.armorView) this.yaw += dt * 0.12 * Math.min(1, (this.spin += dt * 0.25));
      this.turretYaw = this.armorView ? 0 : Math.sin(this.t * 0.25) * 0.35;
      const garage = this.screen === 'garage';
      if (this.tank) {
         const m = this.tank; m.root.rotation.y = this.yaw; m.turret.rotation.y = this.turretYaw;
         m.gunPivot.rotation.x = garage ? 0 : 0.04;
      }
      if (this.armor) { this.armor.rotation.y = this.yaw; this.armorGroups.turretG.rotation.y = this.turretYaw; if (!this.C.TANKS?.[this.sel.cls]?.turret) this.armorGroups.gunG.rotation.y = this.turretYaw; }
      this.table.rotation.y = this.yaw;
      // camera: title = slow wide orbit; garage = framed between the side panels
      const z = this.zoom || 1, a = garage ? 0.85 : this.t * 0.05 + 2.2, d = (garage ? 11.5 : 15) * z, h = garage ? 3.6 * z : 4.2;
      cam.position.set(Math.sin(a) * d, h, Math.cos(a) * d);
      const tgt = new THREE.Vector3(0, garage ? 1.3 : 1.6, 0);
      if (garage) { const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)); tgt.addScaledVector(right, 0.9 * z); tgt.y -= 0.6 * z; }
      else { const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)); tgt.addScaledVector(right, -4.5); }
      cam.lookAt(tgt); cam.updateMatrixWorld();
      R.followShadow?.(0, 0, 0);
      if (this.armorView && this.armor) this.updateArmor(cam);
   }

   updateArmor(cam) {
      // colours (nominal or effective from the current view direction) + hover readout via rayArmor
      this.armor.updateMatrixWorld(true);
      const n = new THREE.Vector3(), c = new THREE.Vector3(), v = new THREE.Vector3(), q = new THREE.Quaternion();
      const A = this.mods.armorM, tip = this.$('#pz-tip');
      let hit = null;
      if (this.mouse.in && A?.rayArmor && !this.drag) {
         R_ray.setFromCamera(new THREE.Vector2(this.mouse.x / innerWidth * 2 - 1, -this.mouse.y / innerHeight * 2 + 1), cam); const r = R_ray;
         const hits = A.rayArmor(this.armorModel, this.pose(), r.ray.origin, r.ray.direction);
         hit = hits[0] || null;
      }
      for (const m of this.armorMeshes) {
         const u = m.userData;
         let mm = u.t;
         if (this.effMode) {
            m.getWorldQuaternion(q); n.copy(u.n).applyQuaternion(q);
            c.copy(u.c); m.localToWorld(c); v.subVectors(c, cam.position).normalize();
            const cos = -n.dot(v); mm = cos > 0.02 ? u.t / cos : 999;
         }
         armorColor(mm, m.material.color);
         if (hit && u.part === hit.part && u.plate === hit.plateId && (u.side ?? null) === (hit.side ?? null)) m.material.color.lerp(_ca.setHex(0xffffff), 0.45);
      }
      if (hit) {
         tip.style.display = 'block'; tip.style.left = (this.mouse.x + 18) + 'px'; tip.style.top = (this.mouse.y + 12) + 'px';
         tip.innerHTML = `${esc(hit.plateName || hit.plateId)} <span style="color:var(--hud-dim)">· ${esc({ hull: 'Wanne', turret: 'Turm', mantlet: 'Blende', gun: 'Kanone', track: 'Kette', skirt: 'Schürze' }[hit.part] || hit.part)}</span><br>
            Nennstärke <b>${fmt(hit.t)} mm</b> · Winkel <b>${fmt(hit.angleDeg)}°</b><br>Effektiv <b>${fmt(hit.effT)} mm</b>`;
      } else tip.style.display = 'none';
   }

   // ---------------- campaign ("Feldzug"): operations list → briefing → battle → results ----------------
   get CM() { return this._cm?.OPS ? this._cm : null; }
   loadCampaign() { return (this._cmP ??= import('./campaign.js').then((m) => (this._cm = m)).catch((e) => { console.warn('[menu] campaign', e); this._cmP = null; return null; })); }
   campRec(id) { return this.P ? this.prof().campaign?.[id] || null : null; }
   campOpen(id) { const L = this.CM?.OP_LIST || []; return this.P?.campaignUnlocked ? this.P.campaignUnlocked(this.prof(), id, L) : true; }
   async openCampaign() {
      if (!(await this.loadCampaign())) { this.toast('Feldzug nicht verfügbar'); return; }
      this.viewCls = null; this.show('camp'); this.renderOps();
   }
   renderOps() {
      const { OPS, OP_LIST } = this.CM, prev = (i) => OPS[OP_LIST[i - 1]];
      let tot = 0;
      const cards = OP_LIST.map((id, i) => {
         const o = OPS[id], r = this.campRec(id), open = this.campOpen(id); tot += r?.stars || 0;
         return `<div class="pz-op ${open ? '' : 'lock'}" style="--nat:${NAT_COL[o.nation] || 'var(--olive)'}" ${open ? `data-a="campOp" data-op="${id}"` : ''}>
            ${insignia(o.nation)}<div class="no">Operation ${ROMAN[i + 1] || i + 1}</div><div class="nm">${esc(o.name)}</div>
            <div class="pl">${esc(o.place)}</div><div class="dt">${esc(o.date)}</div>
            ${r?.done ? '<div class="done">Erfüllt</div>' : ''}
            <div class="ft">${open ? stars(r?.stars || 0) : '<span class="lk">Gesperrt</span>'}<span class="sp"></span>${open ? (r?.bestTime != null ? `Bestzeit ${mmss(r.bestTime)}` : esc(NAT_NAME[o.nation] || o.nation)) : `erst „${esc(prev(i)?.name)}“ gewinnen`}</div></div>`;
      }).join('');
      this.$('#pz-ops').innerHTML = `<div class="pz-ops-h"><h1 class="pz-st">Feldzug</h1><span>Historische Operationen 1944–1945</span><span class="sp"></span>
         <span class="tot">Sterne <b>${tot}</b> / ${OP_LIST.length * 3}</span></div><div class="pz-opgrid">${cards}</div>`;
   }
   openBrief(id) {
      const o = this.CM?.OPS[id]; if (!o) return;
      const keep = this.camp?.op === id ? this.camp : null;
      this.camp = { op: id, cls: keep?.cls && o.tanks.includes(keep.cls) ? keep.cls : o.tanks[0], diff: keep?.diff || this.sel.diff || 'normal' };
      this.viewCls = this.camp.cls; this.show('brief'); this.renderBrief();
   }
   renderBrief() {
      const { OPS, OP_LIST } = this.CM, o = OPS[this.camp.op], C = this.C, T = C.TANKS || {}, i = OP_LIST.indexOf(o.id), r = this.campRec(o.id);
      const D = C.DIFFICULTY || { leicht: { name: 'Leicht' }, normal: { name: 'Normal' }, schwer: { name: 'Schwer' } };
      this.$('#pz-sheet').innerHTML = `<div class="pz-stamp">Historisch</div>
         <div class="kick">Einsatzbefehl · Operation ${ROMAN[i + 1] || i + 1}</div>
         <div class="when"><span>${esc(o.date)}</span><span>·</span><span>${esc(o.place)}</span></div>
         <h2>${esc(o.name)}</h2>
         <div class="pz-chips"><span>${esc(NAT_NAME[o.nation] || o.nation)}</span><span>${esc(this.maps[o.map]?.name || o.map)}</span>${o.fog ? '<span>Nebel</span>' : ''}${o.difficulty ? `<span>${esc(o.difficulty)}</span>` : ''}</div>
         <h4>Lage</h4>${(o.brief || []).map((p) => `<p>${esc(p)}</p>`).join('')}
         <h4>Auftrag</h4><ul>${(o.goals || []).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
         ${o.tip ? `<div class="tip"><b>Hinweis:</b> ${esc(o.tip)}</div>` : ''}`;
      const tk = o.tanks.map((id) => {
         const c = T[id]; if (!c) return '';
         const a = c.gun?.ammo?.[0] || {}, ar = this.armourSummary(c);
         return `<div class="pz-tk ${id === this.camp.cls ? 'sel' : ''}" data-a="campTank" data-v="${id}">${clsIcon(c.cls)}<span class="n">${esc(c.name)}</span><span class="t">${C.TIER_ROMAN?.[c.tier] || c.tier}</span>
            <span class="m">${fmt(c.gun?.cal)} mm · DS ${fmt(a.pen)} mm · ${fmt(a.dmg)} Schaden · Front ${fmt(ar?.hf?.t)}${c.turret ? '/' + fmt(ar?.tf?.t) : ''} mm · ${fmt(c.vMax)} km/h</span></div>`;
      }).join('');
      this.$('#pz-bside').innerHTML = `<h4>Fahrzeug</h4>${tk}
         <h4 style="margin-top:6px">Schwierigkeit</h4><div class="row">${Object.entries(D).map(([k, d]) => `<button data-a="campDiff" data-v="${k}" class="${k === this.camp.diff ? 'on' : ''}">${esc(d.name)}</button>`).join('')}</div>
         <div class="rec"><span>${r?.done ? 'Erfüllt' : 'Noch nicht erfüllt'}${r?.bestTime != null ? ` · Bestzeit ${mmss(r.bestTime)}` : ''}</span>${stars(r?.stars || 0)}</div>
         <button class="pri go" data-a="campGo">Einsatz beginnen</button>
         <button data-a="camp">Zurück zum Feldzug</button>`;
   }
   startOp(op, cls, diff) {
      this.viewCls = null;
      this.ctx.startBattle({ mode: 'campaign', op, playerCls: cls, difficulty: diff });
   }
   showCampResults(r) {
      const res = r.result || {}, cr = res.campaign || {}, st = r.stats || {}, CM = this.CM, o = CM?.OPS[cr.op || r.op] || {};
      const oc = res.outcome || 'aborted', win = /win|won/.test(oc), L = CM?.OP_LIST || [], next = L[L.indexOf(o.id) + 1];
      const nextOpen = next && this.campOpen(next);
      const objs = (cr.objectives || []).filter((x) => !x.hidden || x.state !== 'active');
      const mk = (x) => `<li class="${x.state}"><span class="ck">${x.state === 'done' ? '✓' : x.state === 'failed' ? '✗' : '–'}</span>
         <span>${esc(x.text)}${x.need > 1 ? ` (${fmt(x.count)}/${fmt(x.need)})` : ''}</span>${x.bonus ? '<span class="bn">Bonus</span>' : '<span></span>'}</li>`;
      const M = MEDAL[cr.medal];
      this.$('#pz-resc').innerHTML = `
         <div class="pz-k">Feldzug · ${esc(o.place || '')} · ${esc(o.date || '')} · ${esc(this.C.TANKS?.[r.playerCls]?.name || r.playerCls || '')}</div>
         <h2 class="pz-st ${win ? 'win' : /loss|lost/.test(oc) ? 'loss' : ''}">${win ? 'Auftrag erfüllt' : OUTCOME[oc] || esc(oc)}</h2>
         <div class="why"><b>${esc(o.name || '')}</b>${res.reason ? ' – ' + esc(res.reason) : ''}</div>
         <div class="pz-cres"><div><h4 class="pz-k" style="margin:0 0 4px">Ziele</h4><ul class="obj">${objs.map(mk).join('')}</ul>
            <div class="mini"><span>Zeit <b>${mmss(res.time)}</b></span><span>Abschüsse <b>${fmt(st.kills)}</b></span><span>Schaden <b>${fmt(st.dmg)}</b></span><span>Treffer <b>${fmt(st.hits)}</b> / ${fmt(st.shots)}</span></div></div>
            <div class="md">${medalSvg(win ? cr.medal : null)}${stars(win ? cr.stars | 0 : 0)}<span class="lab">${win && M ? M[3] : 'Keine Auszeichnung'}</span></div></div>
         <div class="bt"><button data-a="toCamp">Zurück zum Feldzug</button><button data-a="campRetry">Erneut versuchen</button>
            ${next ? `<button class="pri" data-a="campNext" ${nextOpen ? '' : 'disabled title="Erst diese Operation gewinnen"'}>Nächste Operation</button>` : ''}</div>`;
      this.lastCamp = { op: o.id, cls: r.playerCls, diff: r.difficulty || 'normal', next };
      this.$('#pz-results').classList.add('on');
   }

   // ---------------- results ----------------
   showResults(r) {
      if (r.mode === 'campaign' || r.result?.campaign) {
         this.loadCampaign().then(() => { this.viewCls = null; this.show('camp'); if (this.CM) this.renderOps(); this.showCampResults(r); });
         return;
      }
      this.show('garage');
      const res = r.result || {}, st = r.stats || {}, oc = res.outcome || (/won|lost|draw/.test(r.phase) ? r.phase : 'aborted');
      const cls = /win|won/.test(oc) ? 'win' : /loss|lost/.test(oc) ? 'loss' : '';
      const C = this.C, tank = C.TANKS?.[r.playerCls], map = this.maps[r.mapId];
      const box = (k, v, gold) => `<div class="${gold ? 'gold' : ''}"><span class="pz-k">${k}</span><b>${v}</b></div>`;
      this.$('#pz-resc').innerHTML = `
         <div class="pz-k">${esc(MODES.find((m) => m.id === r.mode)?.name || r.mode || '')} · ${esc(map?.name || r.mapId || '')} · ${esc(tank?.name || r.playerCls || '')}</div>
         <h2 class="pz-st ${cls}">${OUTCOME[oc] || esc(oc)}</h2>
         <div class="why">${esc(res.reason || r.reason || '')}</div>
         <div class="pz-grid">
            ${box('Schaden verursacht', fmt(st.dmg))}${box('Abschüsse', fmt(st.kills))}${box('Aufgeklärt', fmt(st.spotted))}${box('Schaden blockiert', fmt(st.blocked))}
            ${box('Schüsse', fmt(st.shots))}${box('Treffer', fmt(st.hits))}${box('Durchschläge', fmt(st.pens))}${box('Abpraller / kein DS', fmt(st.bounces))}
            ${st.assist != null ? box('Unterstützung', fmt(st.assist)) : ''}${st.received != null ? box('Schaden erhalten', fmt(st.received)) : ''}
            ${res.unowned ? box('Belohnung', 'keine – Panzer nicht im Besitz') : (res.xp != null ? box('Erfahrung', '+' + fmt(res.xp) + ' EP', true) : '') + (res.credits != null ? box('Kreditpunkte', '+' + fmt(res.credits), true) : '')}
         </div>
         <div class="bt"><button class="pri" data-a="toGarage">Zurück zur Garage</button></div>`;
      this.$('#pz-results').classList.add('on');
   }
}
const R_ray = new THREE.Raycaster();
