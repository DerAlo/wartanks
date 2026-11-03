// game/mpui.js — the multiplayer screen ("MEHRSPIELER"): game list with filter, create / join
// dialogs, the room (players, tank picker, ready, PvP teams, chat) and the results after a net
// match. Pure UI on top of game/net/lobby.js; ported from the warships game (game3d/mpui.js).
// Loaded lazily by the MEHRSPIELER button of the title screen (menu.js), so nothing here — and
// nothing network-related — runs in a singleplayer session. `?net=local` uses BroadcastChannel
// instead of the internet (two pages of one browser context, for tests); `?net=relay` never tries
// a direct WebRTC connection and plays over the relay (MQTT brokers) only.
//
// Hand-over: lobby start -> window.__game.startNetGame(session) (main.js; a stub ends the match
// after 1.2 s when it is missing). This screen hides itself on start and comes back in
// session.onEnd(result) with a results panel, then the room.
//
// Test handles: window.__mp = this screen (window.__mp.lobby = the Lobby), window.__netLastSession =
// serialisable copy of the last session, window.__mpLastResult = the last result.
// Stable selectors (playwright):
//   #mp                    root overlay (class "hidden" while closed / in a match)
//   #mp-back               list: back to the main menu; room: leave the game
//   #mp-name               player name input (saved on change / Enter)
//   #mp-net                connection status text
//   list:   #mp-create (open the create dialog), #mp-filter-q, #mp-filter-mode (''|'coop'|'pvp'),
//           #mp-filter-full / #mp-filter-locked / #mp-filter-running (checkboxes),
//           #mp-list li[data-id=<room id>][data-host=<host peer id>] (click selects),
//           li [data-join] (join that game), li [data-back] ("ZURÜCKKEHREN", rejoin),
//           #mp-join (join the selected game, else the first joinable one)
//   create: #mp-c-name, #mp-c-mode button[data-v=coop|pvp], #mp-c-mission (select standard|encounter),
//           #mp-c-map (select 'random' | maps.js id), #mp-c-diff (select leicht|normal|schwer, co-op),
//           #mp-c-max (select), #mp-c-pass, #mp-create-go, #mp-cancel
//   join:   #mp-pass (password), #mp-pass-go
//   dialog: #mp-modal (any open dialog), #mp-ok (OK of a message), .mp-err (error line)
//   room:   #mp-room[data-state=lobby|running][data-host=0|1], #mp-players [data-id] rows
//           (data-ready=0|1, data-team, data-tank, data-via=direct|relay), [data-kick=<id>],
//           [data-move=<id>] (host, PvP: other team), [data-join-team=1|2], #mp-balance, #mp-lock,
//           #mp-r-mission, #mp-r-map, #mp-r-diff, #mp-r-max (host settings selects),
//           #mp-tanks [data-tank=<id>] (own tanks; .sel = chosen), #mp-ready (client), #mp-start (host),
//           #mp-rejoin ("ZURÜCK INS GEFECHT"), #mp-chat-log, #mp-chat-in, #mp-chat-send
//   result: #mp-result (panel, data-outcome=win|loss|draw|aborted), #mp-result-ok
import { Lobby, makeBackend, filterGames, modeMissions, modeSlots, ownTanks, cleanName, missionName, mapName, allMaps, getMission,
   MODES, TEAMS, DIFFICULTIES, NET_VERSION, RANDOM_MAP, MIN_PLAYERS } from './net/lobby.js';
import { TEAM_MAX } from './net/pvp.js';
import { TANKS, CLASSES, NATIONS, TIER_ROMAN } from './config.js';
import { loadProfile } from './progress.js';

const DIFF_LABEL = { leicht: 'Leicht', normal: 'Normal', schwer: 'Schwer' };
const MODE_LABEL = { coop: 'Koop', pvp: 'PvP' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (v == null || Number.isNaN(+v)) ? '–' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: 0 });
const LOCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:5px"><rect x="5" y="10.5" width="14" height="10" rx="1"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';
const tankLine = (id) => { const t = TANKS[id]; return t ? `${esc(t.name)} · ${TIER_ROMAN[t.tier] || t.tier} · ${esc(CLASSES[t.cls]?.short || t.cls)}` : 'kein Panzer gewählt'; };
const missionOptions = (mode, sel, need = 1) => modeMissions(mode).map(m => {
   const n = modeSlots(mode, m.id);
   return `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''} ${n < need ? 'disabled' : ''}>${esc(m.name)}</option>`;
}).join('');
const mapOptions = (sel) => `<option value="${RANDOM_MAP}" ${sel === RANDOM_MAP ? 'selected' : ''}>Zufällige Karte</option>`
   + allMaps().map(m => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
const maxOptions = (mode, mission, sel, lo) => {
   const n = modeSlots(mode, mission), min = Math.max(MIN_PLAYERS[mode] || 1, lo || 1);
   const v = Math.max(min, Math.min(n, sel || n));
   return Array.from({ length: n }, (_, i) => i + 1).filter(k => k >= min).map(k => `<option value="${k}" ${k === v ? 'selected' : ''}>${k}</option>`).join('');
};

const CSS = `
/* Mehrspieler in the "Feldkarte" style (tokens: index.html :root): olive canvas, stencil heads,
   khaki paper cards, signal-orange accent. */
#mp { position:fixed; inset:0; z-index:30; display:flex; flex-direction:column; font-family:var(--font); color:var(--ink); user-select:none;
   background:radial-gradient(ellipse at 30% 20%, rgba(93,100,64,.94), rgba(46,50,31,.97) 70%); }
#mp.hidden { display:none; }
#mp * { box-sizing:border-box; }
#mp .st { font-family:var(--font-stencil); letter-spacing:.14em; text-transform:uppercase; font-weight:700; }
#mp button { font:600 12.5px var(--font); letter-spacing:.08em; text-transform:uppercase; color:var(--khaki); background:var(--olive-dk);
   border:1px solid var(--khaki-3); padding:7px 12px; cursor:pointer; white-space:nowrap; }
#mp button:hover:not(:disabled) { background:var(--olive); color:var(--paper); }
#mp button.pri { background:var(--signal); color:#1b1206; border-color:var(--signal-hi); }
#mp button.pri:hover:not(:disabled) { background:var(--signal-hi); }
#mp button.on { background:var(--khaki); color:var(--ink); border-color:var(--khaki); }
#mp button:disabled { opacity:.45; cursor:default; }
#mp input[type=text], #mp input[type=password], #mp select { font:600 13px var(--font); padding:7px 8px; background:var(--khaki); border:1px solid var(--khaki-3);
   color:var(--ink); outline:none; width:100%; user-select:text; }
#mp input:focus, #mp select:focus { border-color:var(--signal); box-shadow:inset 0 -2px 0 var(--signal); }
#mp label { display:block; font:600 10px var(--font); letter-spacing:.22em; text-transform:uppercase; color:var(--ink-3); margin:10px 0 4px; }
#mp label.chk { display:flex; gap:8px; align-items:center; letter-spacing:.04em; text-transform:none; font-size:13px; color:var(--ink); margin:6px 0 0; cursor:pointer; }
#mp label.chk input { accent-color:var(--signal); }
.mp-top { flex:none; height:56px; display:flex; align-items:center; gap:14px; padding:0 16px; color:var(--khaki);
   background:linear-gradient(var(--olive-dk), rgba(46,50,31,.88)); border-bottom:2px solid var(--signal); }
.mp-top .logo { font-size:26px; color:var(--paper); }
.mp-top .sub { font:600 10px var(--font); letter-spacing:.3em; color:var(--khaki-2); text-transform:uppercase; }
.mp-top .sp { flex:1; }
.mp-top .nm { display:flex; align-items:center; gap:8px; font:600 10px var(--font); letter-spacing:.2em; color:var(--khaki-2); }
.mp-top .nm input { width:190px; }
#mp-net { font-size:11px; color:var(--khaki-2); text-align:right; line-height:1.35; white-space:nowrap; } #mp-net b { color:var(--ok); } #mp-net b.bad { color:var(--bad); }
.mp-body { flex:1; min-height:0; display:grid; gap:14px; padding:14px 16px; }
.mp-body.list { grid-template-columns:270px minmax(0,1fr); } .mp-body.room { grid-template-columns:330px minmax(0,1fr) 300px; }
.mp-col { min-height:0; min-width:0; display:flex; flex-direction:column; gap:8px; }
.mp-h { flex:none; font:700 12px var(--font-stencil); letter-spacing:.2em; color:var(--paper); text-transform:uppercase; display:flex; justify-content:space-between; align-items:center;
   padding:2px 0 4px; border-bottom:1px solid rgba(216,207,168,.45); text-shadow:0 1px 2px #000; }
.mp-h .n { font:600 11px var(--font); letter-spacing:.08em; color:var(--khaki-2); display:flex; gap:6px; align-items:center; }
.mp-card { background:var(--paper); color:var(--ink); border:1px solid var(--khaki-3); box-shadow:0 6px 24px rgba(0,0,0,.35); padding:12px 14px; }
.mp-scroll { min-height:0; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--khaki-3) transparent; }
.mp-note { font-size:12px; line-height:1.5; color:var(--ink-2); } .mp-note b { color:var(--ink); }
.mp-warn { padding:8px 12px; border-left:4px solid var(--signal); background:var(--khaki); color:var(--ink); font-size:12.5px; }
#mp-list { list-style:none; margin:0; padding:0; background:var(--paper); border:1px solid var(--khaki-3); box-shadow:0 6px 24px rgba(0,0,0,.35); }
.mp-grow, #mp-list li { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) 54px minmax(0,1.1fr) minmax(0,1fr) 70px 56px 84px 128px; gap:10px; align-items:center; }
.mp-grow { flex:none; padding:0 14px; font:600 10px var(--font); letter-spacing:.16em; color:var(--khaki-2); text-transform:uppercase; }
#mp-list li { padding:8px 12px 8px 14px; border-bottom:1px solid var(--rule); font-size:13px; cursor:pointer; }
#mp-list li:nth-child(even) { background:rgba(75,81,50,.06); }
#mp-list li:hover { background:rgba(75,81,50,.14); }
#mp-list li.sel { background:var(--olive); color:var(--paper); } #mp-list li.sel .st-lobby { color:var(--ok); }
#mp-list li > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } #mp-list li .n { font-weight:700; font-size:14px; }
#mp-list li .stt { font-size:10.5px; font-weight:700; letter-spacing:.14em; }
.st-lobby { color:var(--olive); } .st-running { color:var(--signal-lo); } .st-bad { color:var(--bad); }
#mp-list li.off { opacity:.55; } #mp-list li button { justify-self:end; }
#mp-list .empty, .mp-empty { padding:36px 20px; text-align:center; color:var(--ink-2); font-size:14px; line-height:1.6; cursor:default; display:block; }
.mp-row { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:2px 8px; align-items:center; padding:7px 10px; background:var(--paper); border:1px solid var(--khaki-3); }
.mp-row.me { background:var(--khaki); box-shadow:inset 4px 0 0 var(--signal); }
.mp-row .n { font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mp-row .n i { font-style:normal; font-size:9.5px; font-weight:700; letter-spacing:.1em; padding:1px 5px; background:var(--olive-dk); color:var(--khaki); margin-left:6px; vertical-align:2px; }
.mp-row .n em { font-style:normal; font-size:9.5px; font-weight:600; padding:0 5px; border:1px solid var(--khaki-3); color:var(--ink-3); margin-left:6px; vertical-align:2px; }
.mp-row .n em.direct { border-color:var(--olive); color:var(--olive); }
.mp-row .s { grid-column:1; font-size:12px; color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mp-row .r { grid-row:1 / span 2; grid-column:2; font-size:10.5px; font-weight:700; letter-spacing:.14em; color:var(--ink-3); }
.mp-row .r.on { color:var(--olive); padding:1px 6px; border:1.5px solid var(--olive); }
.mp-row .k { grid-row:1 / span 2; grid-column:3; display:flex; gap:4px; }
#mp .mp-row .k button { width:26px; height:26px; padding:0; border-color:var(--signal-lo); background:transparent; color:var(--signal-lo); font-size:13px; }
#mp .mp-row .k button:hover { background:var(--signal); color:#1b1206; }
.mp-slot { padding:9px; border:1px dashed rgba(216,207,168,.45); color:var(--khaki-2); font-size:12px; text-align:center; }
.mp-team { margin-top:6px; } .mp-team.t1 { color:var(--ally); } .mp-team.t2 { color:#ff8a6a; }
.mp-title { font:700 24px/1.1 var(--font-stencil); letter-spacing:.1em; text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mp-sub { color:var(--signal-lo); font-size:11px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; margin:4px 0 10px; padding-bottom:8px; border-bottom:1px solid var(--rule); }
.mp-set { display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px 14px; align-items:center; font-size:13px; }
.mp-set > b { font:600 10px var(--font); letter-spacing:.2em; color:var(--ink-3); text-transform:uppercase; }
#mp .mp-set select { width:auto; max-width:100%; }
.mp-desc { font-size:12.5px; line-height:1.5; color:var(--ink-2); margin-top:10px; }
.mp-chat { flex:1; min-height:0; display:flex; flex-direction:column; }
#mp-chat-log { flex:1; min-height:60px; overflow:auto; font-size:13px; line-height:1.5; user-select:text; scrollbar-width:thin; }
.mp-cl b { color:var(--olive); margin-right:6px; } .mp-cl.me b { color:var(--signal-lo); } .mp-cl.sys { color:var(--ink-3); font-style:italic; }
.mp-chat-in { flex:none; display:flex; gap:8px; margin-top:8px; }
#mp-tanks { display:flex; flex-direction:column; gap:4px; }
.mp-tank { display:grid; grid-template-columns:30px minmax(0,1fr) auto; gap:8px; align-items:center; padding:7px 10px; background:var(--paper); border:1px solid var(--khaki-3);
   cursor:pointer; font-size:13.5px; font-weight:600; }
.mp-tank:hover { background:var(--khaki); }
.mp-tank.sel { background:var(--olive); color:var(--paper); box-shadow:inset 4px 0 0 var(--signal); }
.mp-tank .tr { font-family:var(--font-cond); text-align:center; font-size:12px; letter-spacing:.1em; padding:1px 0; background:var(--ink-2); color:var(--paper); }
.mp-tank.sel .tr { background:var(--khaki); color:var(--ink); }
.mp-tank .ty { font-size:10.5px; letter-spacing:.1em; color:var(--ink-3); text-transform:uppercase; } .mp-tank.sel .ty { color:var(--khaki); }
.mp-tank.ro { cursor:default; }
.mp-act { flex:none; display:flex; gap:8px; }
#mp .mp-act button { flex:1; font:700 18px var(--font-stencil); letter-spacing:.18em; padding:12px; }
#mp-modal { position:absolute; inset:0; z-index:3; display:grid; place-items:center; background:var(--veil); }
#mp-modal .box { width:470px; max-width:calc(100% - 32px); max-height:calc(100% - 32px); overflow:auto; padding:20px 24px; background:var(--paper); color:var(--ink);
   border:1px solid var(--khaki-3); box-shadow:0 18px 50px rgba(0,0,0,.6); }
#mp-modal .box.wide { width:720px; }
#mp-modal h2 { margin:0 0 12px; font:700 26px var(--font-stencil); letter-spacing:.14em; text-transform:uppercase; }
#mp-modal p { font-size:13.5px; line-height:1.55; margin:0 0 6px; }
#mp-modal .bt { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
.mp-err { color:var(--bad); font-size:12.5px; margin-top:8px; min-height:16px; }
.mp-two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.mp-seg { display:flex; } #mp .mp-seg button { flex:1; }
#mp-result h2 { font-size:46px !important; margin-bottom:2px !important; } #mp-result h2.win { color:var(--olive); } #mp-result h2.loss { color:var(--bad); }
#mp-result .why { color:var(--ink-2); margin-bottom:12px; font-size:14px; }
.mp-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; }
.mp-grid div { background:var(--khaki); padding:7px 10px; } .mp-grid b { display:block; font-size:21px; font-variant-numeric:tabular-nums; }
.mp-grid .gold { background:var(--olive); color:var(--paper); } .mp-grid .gold .k { color:var(--khaki); }
.mp-grid .k { font:600 10px var(--font); letter-spacing:.2em; text-transform:uppercase; color:var(--ink-3); }
.mp-pl { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px; }
.mp-pl table { width:100%; border-collapse:collapse; font-size:12.5px; } .mp-pl th, .mp-pl td { padding:3px 5px; text-align:right; border-bottom:1px solid var(--rule); }
.mp-pl th { font-size:10px; letter-spacing:.12em; color:var(--ink-3); font-weight:600; text-transform:uppercase; } .mp-pl td:first-child, .mp-pl th:first-child { text-align:left; }
.mp-pl caption.t1 { color:var(--olive); } .mp-pl caption.t2 { color:var(--bad); }
.mp-pl caption { text-align:left; font:700 13px var(--font-stencil); letter-spacing:.16em; padding-bottom:4px; } .mp-pl tr.me td { font-weight:700; } .mp-pl tr.dead td { color:var(--ink-3); }
@media (max-width: 1150px) { .mp-body.room { grid-template-columns:270px minmax(0,1fr) 240px; }
   .mp-grow, #mp-list li { grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1.1fr) 56px 84px 128px; } .c-host, .c-diff, .c-map { display:none; } }
@media (max-width: 860px) { .mp-body.list, .mp-body.room { display:flex; flex-direction:column; overflow-y:auto; } .mp-top .sub, .mp-grow { display:none; } }
`;

let ui = null;
// entry point for the title screen button; menu: the Menu instance (shown again on "Zurück")
export function openMultiplayer(menu) {
   if (!ui) ui = new MpUI(menu || window.__game?.menu || null);
   ui.open();
   return ui;
}

class MpUI {
   constructor(menu) {
      this.menu = menu;
      this.netMode = new URLSearchParams(location.search).get('net') || '';
      this.local = this.netMode === 'local';
      this.flt = { q: '', mode: '', hideFull: false, hideLocked: false, hideRunning: false };
      this.backend = null; this.lobby = null; this.modal = null; this.view = ''; this.notice = ''; this.openedAt = 0; this.selId = '';
      if (!document.getElementById('mpui-style')) {
         const st = document.createElement('style'); st.id = 'mpui-style'; st.textContent = CSS; document.head.appendChild(st);
      }
      this.root = document.createElement('div');
      this.root.id = 'mp'; this.root.className = 'hidden';
      document.body.appendChild(this.root);
      // While visible this screen owns the keyboard: main.js / input.js / menu.js listen on window
      // and must not see keys typed into the chat or a dialog.
      window.addEventListener('keydown', (e) => {
         if (!this.visible) return;
         e.stopPropagation();
         if (e.code === 'Escape') { if (this.modal && !this.modal.dataset.forced) this._closeModal(); }
         else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
            if (this.modal) { e.preventDefault(); this.modal.querySelector('[data-ok]')?.click(); }
            else if (e.target?.id === 'mp-chat-in') { e.preventDefault(); this._sendChat(); }
            else if (e.target?.id === 'mp-name') { e.preventDefault(); e.target.blur(); }
         }
      }, true);
      window.__mp = this;      // test / debug handle
   }
   get visible() { return !this.root.classList.contains('hidden'); }
   profile() { return loadProfile(); }
   _click() { try { window.__game?.audio?.ui?.('click'); } catch (e) { /* no audio */ } }

   // ------------------------------------------------------------ open / close
   open() {
      this.root.classList.remove('hidden');
      if (this.lobby) { this._show(this.lobby.room ? 'room' : 'list'); return; }
      this.openedAt = Date.now(); this.notice = '';
      this._show('list');
      this._connect();
      clearInterval(this._poll);
      this._poll = setInterval(() => { if (this.visible) this._renderNet(); }, 1000);
   }
   async _connect() {
      try {
         if (!this.backend) this.backend = await makeBackend(this.netMode);
         const lobby = new Lobby(this.backend, () => this.profile(), {
            onList: () => { if (this.view === 'list') this._renderGames(); },
            onRoom: () => { if (this.view === 'room') this._renderRoom(); else if (this.visible && this.lobby?.room && !this.modal?.dataset.forced) this._show('room'); },
            onChat: (line) => this._chatLine(line),
            onLeft: (reason, text) => { this._closeModal(); if (text) this.notice = text; if (this.visible) { this._show('list'); if (text) this._message('Spiel verlassen', text); } },
            onStart: (session) => this._startSession(session),
            onEnd: (result) => this._endSession(result),
         });
         // the tank chosen in the garage is the default pick (when owned)
         const cls = this.menu?.sel?.cls;
         if (cls && ownTanks(this.profile()).includes(cls)) lobby._tank = cls;
         if (!lobby.name) lobby.setName('Kommandant ' + (100 + Math.floor(Math.random() * 900)));
         this.lobby = lobby;
         this._renderTop();
         await lobby.open();
         this._renderGames();
      } catch (e) {
         console.warn('multiplayer: could not start', e);
         this.lobby = null;
         this._message('Mehrspieler nicht verfügbar', 'Das Mehrspieler-Modul konnte nicht gestartet werden. Besteht eine Internetverbindung?', () => this.close());
      }
   }
   // back to the main menu: withdraw the own game, leave the lobby, stop all network activity
   close() {
      clearInterval(this._poll);
      this._closeModal();
      this.lobby?.close(); this.lobby = null;
      this.root.classList.add('hidden');
      this.menu?.show?.('title');
   }

   // ------------------------------------------------------------ frame
   _show(view) {
      this.view = view;
      const room = view === 'room';
      this.root.innerHTML = `
         <div class="mp-top">
            <span class="logo st">PANZER</span><span class="sub">Mehrspieler</span>
            <button id="mp-back">${room ? '◂ Spiel verlassen' : '◂ Zurück'}</button>
            <span class="sp"></span>
            <div id="mp-net"></div>
            <label class="nm" for="mp-name">SPIELER <input type="text" id="mp-name" maxlength="20" autocomplete="off"></label>
         </div>
         <div class="mp-body ${view}">${room ? this._roomSkeleton() : this._listSkeleton()}</div>`;
      const $ = (s) => this.root.querySelector(s);
      $('#mp-back').addEventListener('click', () => { this._click(); if (room) this.lobby?.leaveRoom(); else this.close(); });
      const nm = $('#mp-name');
      nm.value = this.lobby?.name || '';
      nm.addEventListener('change', () => { const n = cleanName(nm.value); if (n) this.lobby?.setName(n); nm.value = this.lobby?.name || n; });
      if (room) {
         $('#mp-chat-send').addEventListener('click', () => this._sendChat());
         $('#mp-ready').addEventListener('click', () => { this._click(); const lb = this.lobby; lb?.setReady(!lb.me?.ready); });
         $('#mp-start').addEventListener('click', () => { this._click(); this.lobby?.start(); });
         $('#mp-rejoin').addEventListener('click', () => { this._click(); this._rejoin(); });
         for (const line of this.lobby.chat) this._chatLine(line);
         this._renderRoom();
      } else {
         this.root.querySelectorAll('[data-flt]').forEach(el => el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
            const k = el.dataset.flt;
            this.flt[k] = el.type === 'checkbox' ? el.checked : el.value;
            this._renderGames();
         }));
         $('#mp-create').addEventListener('click', () => { this._click(); if (this.lobby) this._askCreate(); });
         $('#mp-join').addEventListener('click', () => {
            const lb = this.lobby; if (!lb) return;
            const all = filterGames(lb.list(), this.flt), ok = (g) => g.v === NET_VERSION && g.state === 'lobby' && g.players < g.max;
            const g = all.find(x => x.id === this.selId && ok(x)) || all.find(ok);
            if (g) { this._click(); this._tryJoin(g); }
         });
         this._renderGames();
      }
      if (this.modal) this.root.appendChild(this.modal);      // an open dialog survives the re-render
      this._renderTop();
   }
   _renderTop() {
      const nm = this.root.querySelector('#mp-name');
      if (nm && document.activeElement !== nm) nm.value = this.lobby?.name || '';
      const c = this.root.querySelector('#mp-create'); if (c) c.disabled = !this.lobby;
      this._renderNet();
   }
   _renderNet() {
      const el = this.root.querySelector('#mp-net');
      if (!el) return;
      const lb = this.lobby;
      if (this.local) { el.innerHTML = '<b>Lokaler Testmodus</b><br>ohne Internet'; return; }
      if (!lb) { el.textContent = 'Verbinde …'; return; }
      const s = lb.status();
      el.innerHTML = `Vermittlung: <b class="${s.open ? '' : 'bad'}">${s.open}/${s.total}</b>${this.netMode === 'relay' ? '<br>nur über Relay' : ''}`;
      el.title = 'Öffentliche, anmeldefreie Vermittlungsdienste (MQTT), über die sich die Spieler finden. Kommt keine direkte Verbindung zustande, laufen auch die Spieldaten verschlüsselt darüber.';
      const dead = !s.open && Date.now() - this.openedAt > 8000;
      if (dead !== this._dead) { this._dead = dead; if (this.view === 'list') this._renderGames(); }
   }

   // ------------------------------------------------------------ list view
   _listSkeleton() {
      const f = this.flt, chk = (k, id, label) => `<label class="chk"><input type="checkbox" id="${id}" data-flt="${k}" ${f[k] ? 'checked' : ''}>${label}</label>`;
      return `
         <div class="mp-col">
            <div class="mp-h"><span>Filter</span></div>
            <div class="mp-card">
               <label for="mp-filter-q">Suche</label><input type="text" id="mp-filter-q" data-flt="q" maxlength="40" placeholder="Spiel, Host, Karte" value="${esc(f.q)}">
               <label for="mp-filter-mode">Modus</label><select id="mp-filter-mode" data-flt="mode"><option value="">Alle Modi</option>${MODES.map(([k, l]) => `<option value="${k}" ${f.mode === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
               <div style="margin-top:10px">${chk('hideFull', 'mp-filter-full', 'Volle Spiele ausblenden')}${chk('hideLocked', 'mp-filter-locked', 'Passwortgeschützte ausblenden')}${chk('hideRunning', 'mp-filter-running', 'Laufende Gefechte ausblenden')}</div>
            </div>
            <div class="mp-act"><button class="pri" id="mp-create">Spiel erstellen</button></div>
            <div class="mp-card mp-note mp-scroll">${this.local
               ? '<b>Lokaler Testmodus (?net=local):</b> Spiele werden nur zwischen Fenstern dieses Browsers gefunden, es gibt keine Internetverbindung.'
               : '<b>Ohne eigenen Server:</b> Die Spieler finden sich über öffentliche, anmeldefreie Vermittlungsdienste. Im Gefecht verbinden sie sich möglichst direkt miteinander (WebRTC; Mitspieler können dabei deine IP-Adresse sehen). Blockiert ein Router die Direktverbindung, laufen die Spieldaten verschlüsselt über die Vermittlung (Relay) – das funktioniert, mit etwas mehr Verzögerung.'}
               <br><br><b>Koop:</b> bis zu 5 Spieler gemeinsam gegen Bots. <b>PvP:</b> bis zu 5 gegen 5, freie Plätze füllen Bots auf.</div>
         </div>
         <div class="mp-col">
            <div class="mp-h"><span>Offene Spiele</span><span class="n"><span id="mp-count"></span><button id="mp-join">Beitreten</button></span></div>
            <div id="mp-warn"></div>
            <div class="mp-grow"><span>Spiel</span><span class="c-host">Host</span><span>Modus</span><span>Gefechtsart</span><span class="c-map">Karte</span><span class="c-diff">Stufe</span><span>Spieler</span><span>Status</span><span></span></div>
            <ul id="mp-list" class="mp-scroll"></ul>
         </div>`;
   }
   _renderGames() {
      const box = this.root.querySelector('#mp-list');
      if (!box) return;
      const lb = this.lobby, all = lb ? lb.list() : [], shown = filterGames(all, this.flt);
      this.root.querySelector('#mp-count').textContent = all.length === shown.length ? `${all.length}` : `${shown.length} von ${all.length}`;
      this.root.querySelector('#mp-warn').innerHTML = this._dead ? '<div class="mp-warn">Kein Vermittlungsdienst erreichbar. Bitte Internetverbindung und Firewall prüfen; ohne Vermittlung können sich die Spieler nicht finden.</div>' : '';
      if (!shown.length) {
         box.innerHTML = `<li class="empty">${!lb || !lb.lt ? 'Verbinde mit dem Netz …' : all.length ? 'Kein Spiel entspricht den Filtern.' : 'Zurzeit sind keine Spiele offen.<br>Erstelle eines mit <b>SPIEL ERSTELLEN</b>.'}</li>`;
         return;
      }
      box.innerHTML = shown.map(g => {
         const bad = g.v !== NET_VERSION, full = g.players >= g.max, run = g.state === 'running';
         const st = bad ? ['bad', 'INKOMPATIBEL'] : run ? ['running', 'LÄUFT'] : full ? ['running', 'VOLL'] : ['lobby', 'OFFEN'];
         const back = !bad && lb.canRejoin(g) ? `<button class="pri" data-back="${esc(g.hostId)}" title="Zurück ins laufende Gefecht: Du übernimmst wieder deinen Panzer.">Zurückkehren</button>` : '';
         return `<li class="${bad ? 'off' : ''} ${g.id === this.selId ? 'sel' : ''}" data-id="${esc(g.id)}" data-host="${esc(g.hostId)}" data-mode="${esc(g.mode)}" data-state="${esc(g.state)}" ${bad ? 'title="Dieses Spiel wurde mit einer anderen Spielversion erstellt."' : ''}>
            <span class="n">${g.locked ? LOCK : ''}${esc(g.name)}</span><span class="c-host">${esc(g.host)}</span><span>${esc(MODE_LABEL[g.mode] || g.mode)}</span>
            <span>${esc(missionName(g.mission))}</span><span class="c-map">${esc(mapName(g.mapId))}</span><span class="c-diff">${g.mode === 'pvp' ? '–' : esc(DIFF_LABEL[g.difficulty] || g.difficulty)}</span><span>${g.players}/${g.max}</span>
            <span class="stt st-${st[0]}">${st[1]}</span>
            ${back || `<button data-join="${esc(g.hostId)}" ${bad || full || run ? 'disabled' : ''}>Beitreten</button>`}</li>`;
      }).join('');
      box.querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', (e) => {
         if (e.target.closest('button')) return;
         this.selId = li.dataset.id;
         box.querySelectorAll('li').forEach(x => x.classList.toggle('sel', x === li));
      }));
      box.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => { this._click(); this._rejoin(); }));
      box.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => {
         const g = this.lobby?.list().find(x => x.hostId === b.dataset.join);
         if (g) { this._click(); this._tryJoin(g); }
      }));
   }
   _tryJoin(g) { if (g.locked) this._askPassword(g); else this._join(g, ''); }
   async _join(g, password, onError) {
      this._busy(`Verbinde mit „${g.name}“ …`);
      try {
         await this.lobby.join(g, password);
         this._closeModal();
         this._show('room');
      } catch (e) {
         const text = e?.code ? e.message : 'Beitritt fehlgeschlagen.';
         if (!e?.code) console.warn('multiplayer: join failed', e);
         if (onError && e?.code === 'password') onError(text); else this._message('Beitritt nicht möglich', text);
      }
   }
   async _rejoin() {
      const rec = this.lobby?.rejoinable();
      if (!rec) return;
      this._busy(`Zurück ins Gefecht „${rec.name || 'Spiel'}“ …`);
      try {
         await this.lobby.rejoin();
         this._closeModal();
         this._show('room');
      } catch (e) {
         const text = e?.code ? e.message : 'Rückkehr fehlgeschlagen.';
         if (!e?.code) console.warn('multiplayer: rejoin failed', e);
         this._message('Rückkehr nicht möglich', text);
         if (this.view === 'list') this._renderGames();
      }
   }

   // ------------------------------------------------------------ room view
   _roomSkeleton() {
      return `
         <div class="mp-col"><div class="mp-h"><span>Spieler</span><span class="n" id="mp-pcount"></span></div><div class="mp-col mp-scroll" id="mp-players" style="gap:5px"></div></div>
         <div class="mp-col" id="mp-room">
            <div class="mp-card" id="mp-settings" style="flex:none"></div>
            <div class="mp-act"><button class="pri" id="mp-start">Gefecht starten</button><button class="pri" id="mp-ready">Bereit</button><button class="pri" id="mp-rejoin">Zurück ins Gefecht</button></div>
            <div class="mp-h"><span>Funkverkehr</span></div>
            <div class="mp-card mp-chat"><div id="mp-chat-log"></div>
               <div class="mp-chat-in"><input type="text" id="mp-chat-in" maxlength="200" placeholder="Nachricht schreiben …" autocomplete="off"><button id="mp-chat-send">Senden</button></div></div>
         </div>
         <div class="mp-col"><div class="mp-h"><span>Dein Panzer</span><span class="n" id="mp-tcount"></span></div><div class="mp-scroll" id="mp-tanks"></div></div>`;
   }
   _renderRoom() {
      const lb = this.lobby, r = lb?.room, $ = (s) => this.root.querySelector(s);
      if (!r || !$('#mp-players')) return;
      const host = lb.isHost, lobbyState = r.state === 'lobby', pvp = r.mode === 'pvp', edit = host && lobbyState;
      $('#mp-room').dataset.state = r.state; $('#mp-room').dataset.host = host ? '1' : '0';
      $('#mp-pcount').textContent = `${r.players.length}/${r.max}`;
      const row = (p) => {
         const ready = p.id === r.hostId ? ['on', 'HOST'] : p.ready ? ['on', 'BEREIT'] : ['', 'WARTET'];
         const via = lb.via(p.id);
         const route = via === 'direct' ? '<em class="direct" title="Direkte Verbindung zum Host">direkt</em>'
            : via === 'relay' ? '<em title="Keine direkte Verbindung zum Host: die Spieldaten laufen verschlüsselt über die Vermittlung. Das funktioniert, mit etwas mehr Verzögerung.">über Relay</em>' : '';
         const btns = [];
         if (host && pvp && lobbyState) btns.push(`<button data-move="${esc(p.id)}" data-team="${3 - p.team}" title="In Team ${3 - p.team} verschieben">⇄</button>`);
         if (host && p.id !== lb.selfId) btns.push(`<button data-kick="${esc(p.id)}" title="Aus dem Spiel entfernen">✕</button>`);
         return `<div class="mp-row ${p.id === lb.selfId ? 'me' : ''}" data-id="${esc(p.id)}" data-ready="${p.ready || p.id === r.hostId ? 1 : 0}" data-team="${p.team || 0}" data-tank="${esc(p.tank || '')}" data-via="${via}">
            <span class="n">${esc(p.name)}${p.id === lb.selfId ? '<i>DU</i>' : ''}${route}</span>
            <span class="r ${ready[0]}">${ready[1]}</span>
            ${btns.length ? `<span class="k">${btns.join('')}</span>` : ''}
            <span class="s">${tankLine(p.tank)}</span></div>`;
      };
      const free = Math.max(0, r.max - r.players.length);
      if (pvp) {
         const meTeam = lb.me?.team;
         $('#mp-players').innerHTML = TEAMS.map(t => {
            const list = r.players.filter(p => p.team === t), n = list.length;
            const join = lobbyState && meTeam !== t && n < TEAM_MAX && (host || !r.teamsLocked) ? `<button data-join-team="${t}">Wechseln</button>` : '';
            return `<div class="mp-h mp-team t${t}" data-team-head="${t}"><span>Team ${t}${meTeam === t ? ' · dein Team' : ''}</span><span class="n">${n}/${TEAM_MAX} ${join}</span></div>` + list.map(row).join('');
         }).join('') + (free ? `<div class="mp-slot">${free} freie${free === 1 ? 'r' : ''} Platz${free === 1 ? '' : 'e'} – Team frei wählbar</div>` : '')
            + `<div class="mp-slot">Freie Plätze beider Teams übernehmen Bots.${r.teamsLocked ? ' Der Host hat die Teams gesperrt.' : ''}</div>`;
         this.root.querySelectorAll('[data-join-team]').forEach(b => b.addEventListener('click', () => { this._click(); lb.chooseTeam(Number(b.dataset.joinTeam)); }));
         this.root.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => { this._click(); lb.setTeam(b.dataset.move, Number(b.dataset.team)); }));
      } else {
         $('#mp-players').innerHTML = r.players.map(row).join('') + Array.from({ length: free }, () => '<div class="mp-slot">freier Platz</div>').join('')
            + '<div class="mp-slot">Die übrigen Panzer beider Seiten steuern Bots.</div>';
      }
      this.root.querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', () => { this._click(); lb.kick(b.dataset.kick); }));

      const m = getMission(r.mission);
      $('#mp-settings').innerHTML = `
         <div class="mp-title">${r.locked ? LOCK : ''}${esc(r.name)}</div>
         <div class="mp-sub">${pvp ? 'PvP · Team gegen Team' : 'Koop gegen Bots'} · ${r.locked ? 'passwortgeschützt' : 'offen für alle'}${lobbyState ? '' : ' · GEFECHT LÄUFT'}</div>
         <div class="mp-set">
            <b>Gefechtsart</b><span>${edit ? `<select id="mp-r-mission">${missionOptions(r.mode, r.mission, r.players.length)}</select>` : `<span data-mission="${esc(r.mission)}">${esc(missionName(r.mission))}</span>`}</span>
            <b>Karte</b><span>${edit ? `<select id="mp-r-map">${mapOptions(r.mapId)}</select>` : `<span data-map="${esc(r.mapId)}">${esc(mapName(r.mapId))}</span>`}</span>
            <b>Schwierigkeit</b><span>${pvp ? 'Bots: Normal (beide Teams gleich stark)' : edit ? `<select id="mp-r-diff">${DIFFICULTIES.map(d => `<option value="${d}" ${d === r.difficulty ? 'selected' : ''}>${DIFF_LABEL[d]}</option>`).join('')}</select>` : esc(DIFF_LABEL[r.difficulty] || r.difficulty)}</span>
            <b>Spieler</b><span>${edit ? `<select id="mp-r-max">${maxOptions(r.mode, r.mission, r.max, r.players.length)}</select>` : `max. ${r.max}`}${host ? '' : '<span class="mp-note" style="margin-left:10px">Nur der Host ändert die Einstellungen.</span>'}</span>
            ${pvp ? `<b>Teams</b><span>${edit ? `<button id="mp-balance">Ausgleichen</button> <button id="mp-lock">${r.teamsLocked ? 'Entsperren' : 'Sperren'}</button>` : r.teamsLocked ? 'gesperrt (nur der Host verschiebt)' : 'frei wählbar'}</span>` : ''}
         </div>
         ${m?.desc ? `<div class="mp-desc">${esc(m.desc)}</div>` : ''}`;
      if (edit) {
         $('#mp-r-mission').addEventListener('change', (e) => lb.configure({ mission: e.target.value }));
         $('#mp-r-map').addEventListener('change', (e) => lb.configure({ mapId: e.target.value }));
         $('#mp-r-diff')?.addEventListener('change', (e) => lb.configure({ difficulty: e.target.value }));
         $('#mp-r-max').addEventListener('change', (e) => lb.configure({ max: Number(e.target.value) }));
         $('#mp-balance')?.addEventListener('click', () => { this._click(); lb.balanceTeams(); });
         $('#mp-lock')?.addEventListener('click', () => { this._click(); lb.lockTeams(!r.teamsLocked); });
      }

      // own tanks (garage profile); duplicates in the room are allowed
      const own = ownTanks(this.profile()), mine = lb.me?.tank;
      $('#mp-tcount').textContent = `${own.length} in der Garage`;
      $('#mp-tanks').innerHTML = own.length ? own.map(id => {
         const t = TANKS[id];
         return `<div class="mp-tank ${id === mine ? 'sel' : ''} ${lobbyState ? '' : 'ro'}" data-tank="${esc(id)}" title="${esc(CLASSES[t.cls]?.name || t.cls)} · ${esc(NATIONS[t.nation]?.name || t.nation)}">
            <span class="tr">${TIER_ROMAN[t.tier] || t.tier}</span><span>${esc(t.name)}</span><span class="ty">${esc(CLASSES[t.cls]?.short || t.cls)} · ${esc(t.nation)}</span></div>`;
      }).join('') : '<div class="mp-empty">Du besitzt noch keinen Panzer.</div>';
      if (lobbyState) this.root.querySelectorAll('#mp-tanks [data-tank]').forEach(el => el.addEventListener('click', () => { this._click(); lb.setTank(el.dataset.tank); }));

      // action buttons
      const start = $('#mp-start'), ready = $('#mp-ready'), rejoin = $('#mp-rejoin');
      const canBack = !host && r.state === 'running' && !lb.session && lb.canRejoin({ id: r.id, hostId: r.hostId, state: r.state });
      start.style.display = host ? '' : 'none';
      start.disabled = !lb.canStart();
      start.textContent = r.state === 'running' ? 'Gefecht läuft' : 'Gefecht starten';
      start.title = !start.disabled || !lobbyState ? '' : pvp && (!lb.teamSize(1) || !lb.teamSize(2)) ? 'Beide Teams brauchen mindestens einen Spieler' : 'Alle Mitspieler müssen bereit sein';
      ready.style.display = !host && !canBack ? '' : 'none';
      ready.disabled = !lobbyState || !lb.me?.tank;
      ready.textContent = !lobbyState ? 'Gefecht läuft' : lb.me?.ready ? 'Nicht bereit' : 'Bereit';
      ready.classList.toggle('on', !!lb.me?.ready);
      rejoin.style.display = canBack ? '' : 'none';
      this._renderTop();
   }
   _chatLine(line) {
      const log = this.root.querySelector('#mp-chat-log');
      if (!log) return;
      const el = document.createElement('div');
      el.className = 'mp-cl' + (line.id ? (line.id === this.lobby?.selfId ? ' me' : '') : ' sys');
      el.innerHTML = line.id ? `<b>${esc(line.name)}:</b>${esc(line.text)}` : esc(line.text);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
   }
   _sendChat() {
      const inp = this.root.querySelector('#mp-chat-in');
      if (!inp || !inp.value.trim()) return;
      this.lobby?.sendChat(inp.value);
      inp.value = ''; inp.focus();
   }

   // ------------------------------------------------------------ match hand-over
   _startSession(session) {
      this._closeModal();
      window.__netLastSession = { mode: session.mode, mission: session.mission, mapId: session.mapId, difficulty: session.difficulty, seed: session.seed,
         players: session.players.map(p => ({ ...p })), selfId: session.transport.selfId, hostId: session.transport.hostId, isHost: session.transport.isHost };
      const g = window.__game, start = typeof g?.startNetGame === 'function' ? (s) => g.startNetGame(s) : stubStartNetGame;
      this.root.classList.add('hidden');
      try { start(session); } catch (e) {
         console.warn('multiplayer: the game could not be started', e);
         session.onEnd({ aborted: true, reason: 'Das Gefecht konnte nicht gestartet werden.', victory: null });
      }
   }
   _endSession(result) {
      const lb = this.lobby;
      result = result || { aborted: true, reason: '', victory: null };
      window.__mpLastResult = result;
      this.root.classList.remove('hidden');
      this._show(lb?.room ? 'room' : 'list');
      // the 3D menu background behind this screen (the battle scene is gone by now)
      setTimeout(() => { const m = this.menu; if (m && !window.__game?.world && !m.root?.classList.contains('on')) m.show?.('title'); }, 0);
      const back = result.aborted && lb?.rejoinable();
      if (lb?.room) {
         const o = outcomeOf(result);
         this._chatLine({ id: '', text: result.aborted ? `Gefecht abgebrochen${result.reason ? ': ' + result.reason : '.'}` : `Gefecht beendet: ${OUTCOME_LABEL[o] || 'Ende'}.` });
         if (back && !lb.isHost && lb.room.state === 'running') this._chatLine({ id: '', text: 'Das Gefecht läuft weiter: Mit „ZURÜCK INS GEFECHT“ übernimmst du wieder deinen Panzer.' });
      }
      if (result.aborted && !result.stats) {
         if (!lb?.room && this.notice) this._message('Spiel beendet', this.notice + (back ? ' Läuft das Gefecht noch, steht es in der Spielliste mit „ZURÜCKKEHREN“.' : ''));
         else if (result.reason && !result.handover) this._message('Gefecht abgebrochen', result.reason);
         return;
      }
      this._showResult(result);
   }
   _showResult(res) {
      const o = res.aborted ? 'aborted' : outcomeOf(res), s = res.stats || {};
      const box = (k, v, gold) => `<div class="${gold ? 'gold' : ''}"><span class="k">${k}</span><b>${v}</b></div>`;
      let pl = '';
      if (res.pvp && Array.isArray(res.pvp.pl)) {
         const my = res.pvp.my, myName = this.lobby?.name;
         pl = '<div class="mp-pl">' + TEAMS.map(t => {
            const rows = res.pvp.pl.filter(x => Array.isArray(x) && x[1] === t).sort((a, b) => (b[2] || 0) - (a[2] || 0));
            return `<table data-team="${t}"><caption class="mp-team t${t}">Team ${t}${t === my ? ' · dein Team' : ''}${res.pvp.win === t ? ' · Sieger' : ''}</caption>
               <tr><th>Name</th><th>Schaden</th><th>Abschüsse</th><th>Status</th></tr>
               ${rows.map(x => `<tr class="${x[4] ? '' : 'dead'} ${t === my && x[0] === myName ? 'me' : ''}"><td>${esc(x[0])}</td><td>${fmt(x[2])}</td><td>${fmt(x[3])}</td><td>${x[4] ? 'aktiv' : 'zerstört'}</td></tr>`).join('')}</table>`;
         }).join('') + '</div>';
      }
      const el = this._modal(`<div id="mp-result" data-outcome="${o}">
         <h2 class="${o === 'win' ? 'win' : o === 'loss' ? 'loss' : ''}">${OUTCOME_LABEL[o] || 'Gefecht beendet'}</h2>
         <div class="why">${esc(res.reason || (res.pvp ? 'PvP · Team gegen Team' : 'Koop gegen Bots'))}</div>
         <div class="mp-grid">
            ${box('Schaden', fmt(s.dmg))}${box('Abschüsse', fmt(s.kills))}${box('Treffer', `${fmt(s.hits)} / ${fmt(s.shots)}`)}${box('Durchschläge', fmt(s.pens))}
            ${box('Aufgeklärt', fmt(s.spotted))}${box('Unterstützung', fmt(s.assist))}
            ${res.xp != null ? box('Erfahrung', '+' + fmt(res.xp) + ' EP', true) : ''}${res.credits != null ? box('Kreditpunkte', '+' + fmt(res.credits), true) : ''}
         </div>${pl}
         <div class="bt"><button class="pri" id="mp-result-ok" data-ok>${this.lobby?.room ? 'Zurück in den Raum' : 'Weiter'}</button></div></div>`, false, true);
      el.querySelector('[data-ok]').addEventListener('click', () => { this._click(); this._closeModal(); });
   }

   // ------------------------------------------------------------ dialogs
   _closeModal() { if (this.modal) { this.modal.remove(); this.modal = null; } }
   _modal(html, forced = false, wide = false) {
      this._closeModal();
      const el = document.createElement('div');
      el.id = 'mp-modal';
      if (forced) el.dataset.forced = '1';
      el.innerHTML = `<div class="box ${wide ? 'wide' : ''}">${html}</div>`;
      this.root.appendChild(el);
      this.modal = el;
      el.querySelector('[data-cancel]')?.addEventListener('click', () => { this._click(); this._closeModal(); });
      setTimeout(() => (el.querySelector('input[type=text],input[type=password]') || el.querySelector('[data-ok]'))?.focus(), 0);
      return el;
   }
   _message(title, text, then) {
      const el = this._modal(`<h2>${esc(title)}</h2><p class="mp-msg">${esc(text)}</p><div class="bt"><button class="pri" id="mp-ok" data-ok>OK</button></div>`);
      el.querySelector('[data-ok]').addEventListener('click', () => { this._closeModal(); then?.(); });
   }
   _busy(text) { this._modal(`<h2>Bitte warten</h2><p class="mp-busy">${esc(text)}</p>`, true); }
   _askPassword(g) {
      const el = this._modal(`<h2>Passwort</h2>
         <p>„${esc(g.name)}“ von ${esc(g.host)} ist mit einem Passwort geschützt.</p>
         <label for="mp-pass">Passwort</label><input type="password" id="mp-pass" maxlength="64" autocomplete="off">
         <div class="mp-err"></div>
         <div class="bt"><button id="mp-cancel" data-cancel>Abbrechen</button><button class="pri" id="mp-pass-go" data-ok>Beitreten</button></div>`);
      el.querySelector('[data-ok]').addEventListener('click', () => {
         const pw = el.querySelector('#mp-pass').value;
         if (!pw) { el.querySelector('.mp-err').textContent = 'Bitte das Passwort eingeben.'; return; }
         this._join(g, pw, (text) => { this._askPassword(g); this.modal.querySelector('.mp-err').textContent = text; });
      });
   }
   _askCreate() {
      const lb = this.lobby, sel = this.menu?.sel || {};
      let mode = 'coop';
      const mission0 = modeMissions('coop').some(m => m.id === sel.mode) ? sel.mode : 'standard';
      const map0 = allMaps().some(m => m.id === sel.map) ? sel.map : RANDOM_MAP;
      const diff0 = DIFFICULTIES.includes(sel.diff) ? sel.diff : 'normal';
      const el = this._modal(`<h2>Spiel erstellen</h2>
         <label for="mp-c-name">Name des Spiels</label><input type="text" id="mp-c-name" maxlength="32" value="${esc('Spiel von ' + lb.name)}">
         <label>Modus</label><div class="mp-seg" id="mp-c-mode">${MODES.map(([k, l]) => `<button data-v="${k}" class="${k === mode ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
         <div class="mp-two">
            <div><label for="mp-c-mission">Gefechtsart</label><select id="mp-c-mission">${missionOptions(mode, mission0)}</select></div>
            <div><label for="mp-c-map">Karte</label><select id="mp-c-map">${mapOptions(map0)}</select></div>
         </div>
         <div class="mp-two">
            <div id="mp-c-diffbox"><label for="mp-c-diff">Schwierigkeit</label><select id="mp-c-diff">${DIFFICULTIES.map(d => `<option value="${d}" ${d === diff0 ? 'selected' : ''}>${DIFF_LABEL[d]}</option>`).join('')}</select></div>
            <div><label for="mp-c-max">Max. Spieler</label><select id="mp-c-max"></select></div>
         </div>
         <label for="mp-c-pass">Passwort (optional)</label><input type="password" id="mp-c-pass" maxlength="64" autocomplete="new-password" placeholder="leer = offen für alle">
         <p class="mp-note" style="margin-top:8px">Mit Passwort kann nur beitreten, wer es kennt: Verbindungsaufbau und über Relay laufende Spieldaten werden damit verschlüsselt. Name, Gefechtsart, Karte und Spielerzahl bleiben in der Liste für alle sichtbar.</p>
         <div class="mp-err"></div>
         <div class="bt"><button id="mp-cancel" data-cancel>Abbrechen</button><button class="pri" id="mp-create-go" data-ok>Erstellen</button></div>`);
      const f = (id) => el.querySelector('#' + id);
      const fillMax = () => { f('mp-c-max').innerHTML = maxOptions(mode, f('mp-c-mission').value, mode === 'pvp' ? 10 : Number(f('mp-c-max').value) || 0); };
      fillMax();
      f('mp-c-mission').addEventListener('change', fillMax);
      el.querySelectorAll('#mp-c-mode button').forEach(b => b.addEventListener('click', () => {
         if (b.dataset.v === mode) return;
         mode = b.dataset.v; el.querySelectorAll('#mp-c-mode button').forEach(x => x.classList.toggle('on', x === b));
         const cur = f('mp-c-mission').value;
         f('mp-c-mission').innerHTML = missionOptions(mode, modeMissions(mode).some(m => m.id === cur) ? cur : 'standard');
         f('mp-c-diffbox').style.visibility = mode === 'pvp' ? 'hidden' : '';
         f('mp-c-max').innerHTML = ''; fillMax();
      }));
      el.querySelector('[data-ok]').addEventListener('click', async () => {
         const opts = { name: f('mp-c-name').value, mode, mission: f('mp-c-mission').value, mapId: f('mp-c-map').value, difficulty: f('mp-c-diff').value,
            max: Number(f('mp-c-max').value), password: f('mp-c-pass').value };
         this._busy('Spiel wird eröffnet …');
         try { await lb.host(opts); this._closeModal(); this._show('room'); }
         catch (e) { if (!e?.code) console.warn('multiplayer: hosting failed', e); this._message('Spiel erstellen', e?.code ? e.message : 'Das Spiel konnte nicht erstellt werden.'); }
      });
   }
}

const OUTCOME_LABEL = { win: 'Sieg', loss: 'Niederlage', draw: 'Unentschieden', aborted: 'Gefecht abgebrochen' };
function outcomeOf(r) {
   if (r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'draw') return r.outcome;
   return r.victory === true ? 'win' : r.victory === false ? 'loss' : 'draw';
}

// Stand-in until main.js provides window.__game.startNetGame: logs the session and returns to the room.
function stubStartNetGame(session) {
   console.info('[net] startNetGame is not installed; session:', JSON.stringify({ ...session, transport: undefined, onEnd: undefined }));
   setTimeout(() => session.onEnd({ aborted: true, reason: 'Das Netzspiel-Modul ist in dieser Version noch nicht enthalten.', victory: null }), 1200);
}
