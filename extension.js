// VSCodium extension (runs on Linux inside VSCodium).
// - "ESP32 Camera" tab: frames from tools/usb_bridge.py (board's 2nd USB port,
//   /dev/ttyACM1) through a pipe; no network involved.
// - "ESP32 Devices" tab: live pin levels, your parts (devices.json) with controls,
//   I2C scan. Commands go through the same bridge to board/camstream.py.
// - Run / Upload / Stop / REPL: tools/board.py (mpremote) on the REPL port,
//   /dev/ttyACM0, in a terminal named "ESP32". Separate ports, so both tabs
//   keep working while you upload and run code.
const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

let root = null;          // project folder (contains tools/usb_bridge.py)
let camPanel = null;
let devPanel = null;
let bridge = null;
let active = true;        // false once the extension is shutting down
let wantCamera = true;
let lastFrame = null;     // Buffer (JPEG)
let link = { state: "connecting", detail: "" };   // bridge <-> board
let cam = { fps: 0 };
let frameCount = 0;
let fpsT0 = Date.now();
let boardItem, camItem;
let terminal = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let boardInfo = null;      // answer to {"op": "info"}
let devices = [];
let pollTimer = null;

function findRoot() {
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (fs.existsSync(path.join(f.uri.fsPath, "tools", "usb_bridge.py"))) return f.uri.fsPath;
  }
  return null;
}
const python = () => path.join(root, ".venv", "bin", "python");
const devicesFile = () => path.join(root, "devices.json");

// ---------------- bridge (always running while the project is open) ----------------

function startBridge() {
  if (bridge || !active) return;
  setLink({ state: "connecting", detail: "" });
  const p = cp.spawn(python(), ["-u", path.join(root, "tools", "usb_bridge.py")], { cwd: root });
  bridge = p;
  let buf = Buffer.alloc(0);
  p.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const n = buf.readUInt32LE(1);
      if (buf.length < 5 + n) break;
      const kind = String.fromCharCode(buf[0]);
      const payload = buf.subarray(5, 5 + n);
      buf = buf.subarray(5 + n);
      if (kind === "F") onFrame(Buffer.from(payload));
      else if (kind === "J") onAnswer(payload.toString());
      else if (kind === "S") {
        try { onBridgeStatus(JSON.parse(payload.toString())); } catch (e) { /* ignore */ }
      }
    }
  });
  p.stderr.on("data", (d) => console.log("[esp32cam bridge]", d.toString()));
  p.on("exit", () => {
    if (bridge === p) bridge = null;
    for (const [, w] of pending) { clearTimeout(w.timer); w.resolve({ ok: false, error: "bridge stopped" }); }
    pending.clear();
    if (active) setTimeout(startBridge, 2000);
  });
  p.stdin.on("error", () => { /* bridge died; exit handler restarts it */ });
  p.stdin.write(JSON.stringify({ op: "stream", on: wantCamera }) + "\n");
}

function send(cmd, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!bridge) { resolve({ ok: false, error: "not connected" }); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "no answer from board" }); }, timeoutMs);
    pending.set(id, { resolve, timer });
    bridge.stdin.write(JSON.stringify(Object.assign({ id }, cmd)) + "\n");
  });
}

function onAnswer(text) {
  let r;
  try { r = JSON.parse(text); } catch (e) { return; }
  if (link.state !== "live") setLink({ state: "live", detail: link.detail });
  const w = pending.get(r.id);
  if (w) { pending.delete(r.id); clearTimeout(w.timer); w.resolve(r); }
}

function onBridgeStatus(s) {
  const wasLive = link.state === "live";
  if (s.state === "connecting") {
    setLink(s);
    // (Re)connected: fetch board info, re-apply button inputs.
    setTimeout(async () => {
      const info = await send({ op: "info" });
      if (info.ok) { boardInfo = info; setLink({ state: "live", detail: s.detail }); postDevices(); }
      initInputs();
    }, 300);
  } else if (s.state === "error") {
    setLink(s);
  } else if (!wasLive) {
    setLink({ state: "live", detail: s.detail });
  }
}

function setLink(s) {
  link = Object.assign({}, link, s);
  updateCamStatus();
  if (devPanel) devPanel.webview.postMessage({ type: "link", link });
}

// ---------------- camera ----------------

function setCamera(on) {
  wantCamera = on;
  if (bridge) bridge.stdin.write(JSON.stringify({ op: "stream", on }) + "\n");
  cam.fps = 0; frameCount = 0; fpsT0 = Date.now();
  updateCamStatus();
}

function onFrame(jpeg) {
  lastFrame = jpeg;
  frameCount++;
  if (link.state !== "live") setLink({ state: "live", detail: link.detail });
  const dt = Date.now() - fpsT0;
  if (dt >= 2000) { cam.fps = (frameCount * 1000) / dt; frameCount = 0; fpsT0 = Date.now(); updateCamStatus(); }
  if (camPanel) camPanel.webview.postMessage({ type: "frame", data: jpeg.toString("base64") });
}

function camState() {
  if (link.state === "error") return { state: "error", detail: link.detail };
  if (!wantCamera) return { state: "stopped", detail: "" };
  if (link.state === "live" && lastFrame) return { state: "live", detail: link.detail, fps: cam.fps };
  return { state: "connecting", detail: link.detail };
}

function updateCamStatus() {
  const c = Object.assign({ fps: 0 }, camState());
  if (camPanel) camPanel.webview.postMessage({ type: "status", cam: c });
  const icons = { live: "$(device-camera)", connecting: "$(sync~spin)", error: "$(error)", stopped: "$(debug-pause)" };
  camItem.text = `${icons[c.state] || ""} Camera: ${c.state}${c.state === "live" ? " " + c.fps.toFixed(1) + " fps" : ""}`;
  camItem.tooltip = c.detail || "ESP32 camera preview";
}

async function snapshot() {
  if (!lastFrame) { vscode.window.showWarningMessage("No camera frame yet."); return; }
  const dir = path.join(root, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = path.join(dir, `esp32cam_${ts}.jpg`);
  fs.writeFileSync(file, lastFrame);
  const pick = await vscode.window.showInformationMessage(`Saved ${path.relative(root, file)}`, "Open");
  if (pick) vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), vscode.ViewColumn.Active);
}

function showCamera() {
  if (camPanel) { camPanel.reveal(undefined, true); return; }
  camPanel = vscode.window.createWebviewPanel("esp32cam", "ESP32 Camera",
    { viewColumn: devPanel && devPanel.viewColumn ? devPanel.viewColumn : vscode.ViewColumn.Two, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true });
  camPanel.iconPath = new vscode.ThemeIcon("device-camera");
  camPanel.webview.html = cameraHtml();
  camPanel.webview.onDidReceiveMessage((m) => {
    if (m.type === "start") setCamera(true);
    else if (m.type === "stop") setCamera(false);
    else if (m.type === "snapshot") snapshot();
    else if (m.type === "ready") updateCamStatus();
  });
  camPanel.onDidDispose(() => { camPanel = null; });
}

// ---------------- devices ----------------

function loadDevices() {
  try { devices = JSON.parse(fs.readFileSync(devicesFile(), "utf8")); }
  catch (e) {
    devices = [
      { name: "Onboard blue LED", type: "led", pin: 2 },
      { name: "BOOT button", type: "button", pin: 0 },
    ];
    saveDevices(devices);
  }
  if (!Array.isArray(devices)) devices = [];
}

function saveDevices(list) {
  devices = list;
  fs.writeFileSync(devicesFile(), JSON.stringify(list, null, 2) + "\n");
}

function postDevices() {
  if (devPanel) devPanel.webview.postMessage({ type: "devices", devices, info: boardInfo, link });
}

async function initInputs() {
  for (const d of devices) {
    if (d.type === "button") await send({ op: "input", pin: d.pin, pull: "up" });
  }
}

async function pollOnce() {
  if (!devPanel || !devPanel.visible || !bridge) return;
  const pins = boardInfo ? [...boardInfo.read_only_pins, ...boardInfo.free_pins] : [];
  const adc = devices.filter((d) => d.type === "analog").map((d) => d.pin);
  const r = await send({ op: "poll", pins, adc }, 2000);
  if (devPanel) devPanel.webview.postMessage({ type: "poll", result: r });
}

function showDevices() {
  if (devPanel) { devPanel.reveal(undefined, true); return; }
  devPanel = vscode.window.createWebviewPanel("esp32devices", "ESP32 Devices",
    { viewColumn: camPanel && camPanel.viewColumn ? camPanel.viewColumn : vscode.ViewColumn.Two, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true });
  devPanel.iconPath = new vscode.ThemeIcon("circuit-board");
  devPanel.webview.html = devicesHtml();
  devPanel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === "ready") postDevices();
    else if (m.type === "cmd") {
      const r = await send(m.cmd);
      if (devPanel) devPanel.webview.postMessage({ type: "cmdResult", rid: m.rid, result: r });
      if (!r.ok && r.error) vscode.window.setStatusBarMessage("ESP32: " + r.error, 4000);
    } else if (m.type === "saveDevices") {
      saveDevices(m.devices);
      initInputs();
      postDevices();
    } else if (m.type === "openJson") {
      vscode.commands.executeCommand("vscode.open", vscode.Uri.file(devicesFile()));
    }
  });
  devPanel.onDidDispose(() => { devPanel = null; });
}

// ---------------- webview HTML ----------------

const baseCss = `
  html, body { height: 100%; margin: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-foreground);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-disabledForeground); flex: none; display: inline-block; }
  .dot.live, .dot.on { background: var(--vscode-testing-iconPassed, #3fb950); }
  .dot.connecting { background: var(--vscode-editorWarning-foreground, #d29922); }
  .dot.error { background: var(--vscode-errorForeground, #f85149); }`;

function cameraHtml() {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${baseCss}
  body { display: flex; flex-direction: column; }
  .bar { display: flex; gap: 6px; padding: 8px 8px 4px; align-items: center; flex-wrap: wrap; }
  #status { display: flex; align-items: center; gap: 6px; opacity: .9; padding: 0 8px 6px; white-space: nowrap; overflow: hidden; }
  #text { overflow: hidden; text-overflow: ellipsis; }
  .view { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 8px 8px; }
  img { width: 100%; height: 100%; object-fit: contain; }
  #empty { opacity: .6; text-align: center; padding: 20px; }
</style></head><body>
<div class="bar">
  <button class="primary" id="start">Start</button>
  <button id="stop">Stop</button>
  <button id="snap">Snapshot</button>
</div>
<div id="status"><span id="dot" class="dot"></span><span id="text">Connecting…</span></div>
<div class="view"><img id="img" hidden><div id="empty">Waiting for the camera…</div></div>
<script nonce="${nonce}">
  const vs = acquireVsCodeApi();
  const img = document.getElementById('img'), empty = document.getElementById('empty');
  const dot = document.getElementById('dot'), text = document.getElementById('text');
  let size = '';
  document.getElementById('start').onclick = () => vs.postMessage({ type: 'start' });
  document.getElementById('stop').onclick = () => vs.postMessage({ type: 'stop' });
  document.getElementById('snap').onclick = () => vs.postMessage({ type: 'snapshot' });
  img.onload = () => { size = img.naturalWidth + '×' + img.naturalHeight; };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'frame') { img.src = 'data:image/jpeg;base64,' + m.data; img.hidden = false; empty.hidden = true; }
    if (m.type === 'status') {
      const c = m.cam; dot.className = 'dot ' + c.state;
      text.textContent = c.state === 'live' ? 'Live' + (size ? ' · ' + size : '') + ' · ' + c.fps.toFixed(1) + ' fps'
        : c.state === 'stopped' ? 'Stopped (board runs your code at full speed)'
        : c.state === 'error' ? c.detail + ' — retrying' : 'Connecting…';
      text.title = c.detail || '';
      if (c.state === 'stopped') { img.hidden = true; empty.hidden = false; empty.textContent = 'Preview stopped. Press Start.'; }
    }
  });
  vs.postMessage({ type: 'ready' });
</script></body></html>`;
}

function devicesHtml() {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${baseCss}
  body { overflow-y: auto; }
  main { padding: 10px 12px 24px; max-width: 760px; }
  h2 { font-size: 1.05em; margin: 18px 0 8px; font-weight: 600; }
  .muted { opacity: .65; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
  .card { background: var(--vscode-sideBar-background, rgba(127,127,127,.08)); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
          border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .card .head { display: flex; align-items: center; gap: 8px; }
  .card .name { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .meta { font-size: .9em; opacity: .65; }
  .x { background: transparent; padding: 0 4px; opacity: .6; }
  .x:hover { opacity: 1; background: transparent; }
  input[type=range] { flex: 1; min-width: 100px; accent-color: var(--vscode-button-background); }
  select { max-width: 100%; }
  select, input[type=text], input[type=number] { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 6px; font: inherit; }
  .bar { height: 8px; border-radius: 4px; background: rgba(127,127,127,.25); overflow: hidden; flex: 1; }
  .bar > div { height: 100%; width: 0; background: var(--vscode-button-background); transition: width .2s; }
  .pins { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
  .pin { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25)); border-radius: 4px; padding: 5px 7px; display: flex; align-items: center; gap: 6px; }
  .pin .used { font-size: .85em; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { font-variant-numeric: tabular-nums; }
  #err { color: var(--vscode-errorForeground); min-height: 1.2em; }
  label { display: flex; flex-direction: column; gap: 3px; font-size: .9em; }
  .note { font-size: .9em; opacity: .75; margin: 4px 0 0; }
</style></head><body><main>
<div class="row"><span id="ldot" class="dot"></span><span id="ltext">Connecting to the board…</span></div>
<div id="cam" class="note"></div>

<h2>My devices</h2>
<div id="cards" class="cards"></div>
<p class="note">The board can't detect LEDs, buttons, servos or buzzers by itself (they are just wires on a pin), so add them here once. Saved in <a href="#" id="json">devices.json</a>.
If your own script uses the same pin, the two will fight. Use one or the other.</p>

<h2>Add a device</h2>
<div class="row" id="add">
  <label>Type<select id="atype">
    <option value="led">LED (on/off)</option>
    <option value="dimmable">LED (brightness)</option>
    <option value="rgb">RGB LED (common anode)</option>
    <option value="button">Button / switch (to GND)</option>
    <option value="buzzer_active">Buzzer (active)</option>
    <option value="buzzer_passive">Buzzer (passive, tones)</option>
    <option value="servo">Servo</option>
    <option value="analog">Analog: potentiometer / light / temperature</option>
  </select></label>
  <label>Name<input type="text" id="aname" placeholder="e.g. Red LED" size="14"></label>
  <span id="apins" class="row"></span>
  <button class="primary" id="addbtn" style="align-self:flex-end">Add</button>
</div>
<div id="err"></div>

<h2>All free pins <span class="muted">(live, HIGH = 3.3 V)</span></h2>
<div id="pins" class="pins"></div>
<p class="note">Only these GPIOs are free on this board. The others belong to the camera, PSRAM, USB or boot. GPIO0 is the BOOT button (read only).</p>

<h2>I2C scan <span class="muted">(displays, sensors…)</span></h2>
<div class="row">
  <label>SDA<select id="sda"></select></label>
  <label>SCL<select id="scl"></select></label>
  <button id="scan" style="align-self:flex-end">Scan</button>
  <span id="i2c" class="note" style="align-self:flex-end"></span>
</div>
</main>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const ANALOG_PINS = [1, 2, 14];   // ESP32-S3: only these free pins have an ADC
const I2C_NAMES = { 0x27: 'LCD1602 (PCF8574)', 0x3f: 'LCD1602 (PCF8574A)', 0x3c: 'OLED SSD1306', 0x3d: 'OLED SSD1306',
  0x68: 'MPU6050 / DS3231', 0x76: 'BMP280 / BME280', 0x77: 'BMP280 / BME280', 0x23: 'BH1750 light', 0x48: 'ADS1115 / PCF8591', 0x40: 'PCA9685 / HTU21D' };
let devices = [], info = null, rid = 1, state = {};   // state: per-device UI state (led on, slider values)

function cmd(c) { vs.postMessage({ type: 'cmd', cmd: c, rid: rid++ }); }
// Sliders fire on every pixel; send at most one command per 80 ms per key, always the latest value.
const lastSent = {}, later = {};
function throttled(key, c) {
  clearTimeout(later[key]);
  const wait = 80 - (Date.now() - (lastSent[key] || 0));
  if (wait <= 0) { lastSent[key] = Date.now(); cmd(c); }
  else later[key] = setTimeout(() => { lastSent[key] = Date.now(); cmd(c); }, wait);
}
function save() { vs.postMessage({ type: 'saveDevices', devices }); }
function pinsOf(d) { return d.type === 'rgb' ? d.pins : [d.pin]; }
const freePins = () => info ? info.free_pins : [1, 2, 14, 21, 38, 39, 40, 41, 42, 47, 48];

function pinSelect(id, list, val) {
  return '<select id="' + id + '">' + list.map((p) => '<option value="' + p + '"' + (p === val ? ' selected' : '') + '>GPIO' + p + '</option>').join('') + '</select>';
}
function renderAddPins() {
  const t = $('atype').value;
  const list = t === 'analog' ? ANALOG_PINS : freePins();
  if (t === 'rgb') $('apins').innerHTML = ['R', 'G', 'B'].map((c, i) => '<label>' + c + pinSelect('ap' + i, list, [38, 39, 40][i]) + '</label>').join('');
  else $('apins').innerHTML = '<label>Pin' + pinSelect('ap0', list, list[0]) + '</label>';
}
$('atype').onchange = renderAddPins;
$('json').onclick = (e) => { e.preventDefault(); vs.postMessage({ type: 'openJson' }); };
$('addbtn').onclick = () => {
  const t = $('atype').value, label = $('atype').selectedOptions[0].textContent;
  const d = { name: $('aname').value.trim() || label, type: t };
  if (t === 'rgb') d.pins = [0, 1, 2].map((i) => +$('ap' + i).value); else d.pin = +$('ap0').value;
  const used = new Map(); devices.forEach((x) => pinsOf(x).forEach((p) => used.set(p, x.name)));
  const clash = pinsOf(d).find((p) => used.has(p));
  if (clash !== undefined) { $('err').textContent = 'GPIO' + clash + ' is already used by "' + used.get(clash) + '".'; return; }
  if (new Set(pinsOf(d)).size !== pinsOf(d).length) { $('err').textContent = 'Pick three different pins.'; return; }
  $('err').textContent = ''; $('aname').value = '';
  devices.push(d); save(); render();
};

function card(d, i) {
  const pins = pinsOf(d).map((p) => 'GPIO' + p).join(' · ');
  let body = '';
  if (d.type === 'led') body = '<div class="row"><span class="dot" id="s' + i + '"></span><span class="state" id="t' + i + '">–</span><span style="flex:1"></span><button data-a="on">On</button><button data-a="off">Off</button></div>';
  else if (d.type === 'dimmable') body = '<div class="row"><input type="range" min="0" max="100" value="' + (state[i] ?? 0) + '" data-a="dim"><span class="state" id="t' + i + '">' + (state[i] ?? 0) + '%</span></div>';
  else if (d.type === 'rgb') body = '<div class="row"><input type="color" value="' + (state[i] || '#000000') + '" data-a="rgb"><button data-a="rgboff">Off</button></div>';
  else if (d.type === 'button') body = '<div class="row"><span class="dot" id="s' + i + '"></span><span class="state" id="t' + i + '">–</span></div>';
  else if (d.type === 'buzzer_active') body = '<div class="row"><button data-a="hold">Hold to beep</button></div>';
  else if (d.type === 'buzzer_passive') body = '<div class="row"><input type="range" min="200" max="4000" step="10" value="' + (state[i] ?? 1000) + '" data-a="freq"><span class="state" id="t' + i + '">' + (state[i] ?? 1000) + ' Hz</span></div><div class="row"><button data-a="hold">Hold to play</button></div>';
  else if (d.type === 'servo') body = '<div class="row"><input type="range" min="0" max="180" value="' + (state[i] ?? 90) + '" data-a="servo"><span class="state" id="t' + i + '">' + (state[i] ?? 90) + '°</span></div><div class="row"><button data-a="release">Relax (no signal)</button></div>';
  else if (d.type === 'analog') body = '<div class="row"><div class="bar"><div id="b' + i + '"></div></div><span class="state" id="t' + i + '">–</span></div>';
  return '<div class="card" data-i="' + i + '"><div class="head"><span class="name" title="' + esc(d.name) + '">' + esc(d.name) + '</span><span class="meta">' + pins + '</span><button class="x" data-a="remove" title="Remove">✕</button></div>' + body + '</div>';
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render() {
  $('cards').innerHTML = devices.length ? devices.map(card).join('') : '<span class="muted">No devices yet. Add one below.</span>';
  const used = new Map(); devices.forEach((d) => pinsOf(d).forEach((p) => used.set(p, d.name)));
  const all = [...(info ? info.read_only_pins : [0]), ...freePins()];
  $('pins').innerHTML = all.map((p) => '<div class="pin"><span class="dot" id="p' + p + '"></span><b>' + p + '</b><span class="used" title="' + esc(used.get(p) || '') + '">' + esc(used.get(p) || (p === 0 ? 'BOOT' : '')) + '</span></div>').join('');
  const fp = freePins();
  if (!$('sda').options.length) { $('sda').innerHTML = fp.map((p) => '<option>' + p + '</option>').join(''); $('scl').innerHTML = $('sda').innerHTML; $('sda').value = 41; $('scl').value = 42; }
}

function hex2rgb(h) { return [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16)); }
document.addEventListener('input', (e) => {
  const c = e.target.closest('.card'); if (!c) return;
  const i = +c.dataset.i, d = devices[i], a = e.target.dataset.a, v = e.target.value;
  if (a === 'dim') { state[i] = +v; $('t' + i).textContent = v + '%'; throttled(d.pin, { op: 'pwm', pin: d.pin, freq: 1000, duty: Math.round(v * 655.35) }); }
  if (a === 'servo') { state[i] = +v; $('t' + i).textContent = v + '°'; throttled(d.pin, { op: 'servo', pin: d.pin, angle: +v }); }
  if (a === 'freq') { state[i] = +v; $('t' + i).textContent = v + ' Hz'; }
  if (a === 'rgb') { state[i] = v; hex2rgb(v).forEach((x, k) => throttled(d.pins[k], { op: 'pwm', pin: d.pins[k], freq: 10000, duty: 65535 - x * 257 })); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); const c = e.target.closest('.card'); if (!b || !c) return;
  const i = +c.dataset.i, d = devices[i], a = b.dataset.a;
  if (a === 'on' || a === 'off') cmd({ op: 'set', pin: d.pin, value: a === 'on' ? 1 : 0 });
  if (a === 'rgboff') { state[i] = '#000000'; d.pins.forEach((p) => cmd({ op: 'pwm', pin: p, freq: 10000, duty: 65535 })); render(); }
  if (a === 'release') cmd({ op: 'release', pin: d.pin });
  if (a === 'remove') { pinsOf(d).forEach((p) => { if (p !== 0) cmd({ op: 'release', pin: p }); }); devices.splice(i, 1); delete state[i]; save(); render(); }
});
let holding = null;   // index of the buzzer card being held
function buzz(i, on) {
  const d = devices[i]; if (!d) return;
  if (d.type === 'buzzer_active') cmd({ op: 'set', pin: d.pin, value: on ? 1 : 0 });
  else cmd({ op: 'pwm', pin: d.pin, freq: state[i] ?? 1000, duty: on ? 32768 : 0 });
}
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button[data-a=hold]'); if (!b) return;
  holding = +b.closest('.card').dataset.i; buzz(holding, true);
});
const unhold = () => { if (holding !== null) { buzz(holding, false); holding = null; } };
window.addEventListener('pointerup', unhold);
window.addEventListener('pointercancel', unhold);
window.addEventListener('blur', unhold);

$('scan').onclick = () => { $('i2c').textContent = 'Scanning…'; const r = rid; cmd({ op: 'i2c_scan', sda: +$('sda').value, scl: +$('scl').value }); scanRid = r; };
let scanRid = -1;

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'devices') { devices = m.devices; info = m.info; setLink(m.link); render(); renderAddPins(); }
  if (m.type === 'link') setLink(m.link);
  if (m.type === 'cmdResult') {
    if (m.rid === scanRid) {
      const r = m.result;
      $('i2c').textContent = !r.ok ? r.error : r.i2c.length ? 'Found: ' + r.i2c.map((a) => '0x' + a.toString(16) + (I2C_NAMES[a] ? ' (' + I2C_NAMES[a] + ')' : '')).join(', ') : 'Nothing found on these pins.';
    } else if (!m.result.ok) $('err').textContent = m.result.error;
  }
  if (m.type === 'poll' && m.result.ok) {
    const r = m.result;
    for (const [p, v] of Object.entries(r.pins)) { const el = $('p' + p); if (el) el.className = 'dot' + (v ? ' on' : ''); }
    devices.forEach((d, i) => {
      if (d.type === 'led' && $('t' + i)) { const v = r.pins[d.pin]; $('s' + i).className = 'dot' + (v ? ' on' : ''); $('t' + i).textContent = v ? 'ON' : 'OFF'; }
      if (d.type === 'button' && $('t' + i)) { const v = r.pins[d.pin]; $('s' + i).className = 'dot' + (v === 0 ? ' on' : ''); $('t' + i).textContent = v === 0 ? 'PRESSED' : 'released'; }
      if (d.type === 'analog' && $('t' + i)) { const v = r.adc[d.pin]; if (v !== undefined) { $('b' + i).style.width = (v / 655.35) + '%'; $('t' + i).textContent = Math.round(v / 655.35) + '% · ' + (v / 65535 * 3.3).toFixed(2) + ' V'; } }
    });
    $('cam').textContent = info ? 'Camera ' + info.sensor + ' ' + info.width + '×' + info.height + ' · ' + (r.streaming ? 'streaming ' + r.fps + ' fps' : 'paused') : '';
  }
});
function setLink(l) {
  if (!l) return;
  $('ldot').className = 'dot ' + l.state;
  $('ltext').textContent = l.state === 'live' ? 'Connected to ESP32-S3 (live)' : l.state === 'error' ? 'Not connected: ' + l.detail : 'Connecting to the board…';
}
render(); renderAddPins();
vs.postMessage({ type: 'ready' });
</script></body></html>`;
}

// ---------------- board actions (terminal) ----------------

async function boardCommand(args) {
  let closed = false;
  for (const t of vscode.window.terminals) {
    if (t === terminal || t.name === "ESP32") { t.dispose(); closed = true; }
  }
  terminal = null;
  if (closed) await new Promise((r) => setTimeout(r, 400));
  // VSCodium closes a terminal as soon as its program exits, which hid the output of
  // short scripts. bash keeps it open until a key is pressed (or the next Run replaces it).
  const keepOpen = '"$@"; code=$?; echo; ' +
    'if [ $code -eq 0 ]; then echo "── finished ── press any key to close (F5 runs again)"; ' +
    'else echo "── stopped (exit code $code) ── press any key to close"; fi; read -r -s -n 1';
  terminal = vscode.window.createTerminal({
    name: "ESP32",
    cwd: root,
    shellPath: "/bin/bash",
    shellArgs: ["-c", keepOpen, "esp32", python(), path.join(root, "tools", "board.py"), ...args],
    iconPath: new vscode.ThemeIcon("circuit-board"),
  });
  terminal.show(true);
}

async function currentPythonFile() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "python") {
    vscode.window.showWarningMessage("Open a Python file first.");
    return null;
  }
  if (ed.document.isUntitled) { await vscode.commands.executeCommand("workbench.action.files.saveAs"); }
  else if (ed.document.isDirty) { await ed.document.save(); }
  return ed.document.isUntitled ? null : ed.document.uri.fsPath;
}

// ---------------- status bar ----------------

function updateBoard() {
  let ok = false;
  try { ok = fs.readdirSync("/dev/serial/by-id").some((n) => n.includes("Espressif") && n.endsWith("-if00")); }
  catch (e) { ok = false; }
  boardItem.text = ok ? "$(circuit-board) ESP32: connected" : "$(circuit-board) ESP32: not connected";
  boardItem.backgroundColor = ok ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
  boardItem.tooltip = ok ? "Board on USB (REPL /dev/ttyACM0, video /dev/ttyACM1). Click for the REPL." : "Plug the board into its USB port";
}

function warnIfThonny() {
  cp.exec("pgrep -f 'bin/thonny'", (err, out) => {
    if (!err && out.trim()) {
      vscode.window.showWarningMessage("Thonny is running. It uses the same USB ports — close it, or Run/Upload and the camera here will fail.");
    }
  });
}

// ---------------- activation ----------------

function activate(context) {
  root = findRoot();
  if (!root) return;
  vscode.commands.executeCommand("setContext", "esp32cam.enabled", true);

  boardItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  boardItem.command = "esp32cam.repl";
  camItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  camItem.command = "esp32cam.showCamera";
  boardItem.show(); camItem.show();
  updateBoard();
  updateCamStatus();
  const timer = setInterval(updateBoard, 2000);
  pollTimer = setInterval(pollOnce, 500);
  loadDevices();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg("esp32cam.run", async () => { const f = await currentPythonFile(); if (f) boardCommand(["run", f]); });
  reg("esp32cam.upload", async () => { const f = await currentPythonFile(); if (f) boardCommand(["upload", f]); });
  reg("esp32cam.stop", () => boardCommand(["stop"]));
  reg("esp32cam.repl", () => boardCommand(["repl"]));
  reg("esp32cam.reset", () => boardCommand(["reset"]));
  reg("esp32cam.listFiles", () => boardCommand(["ls"]));
  reg("esp32cam.showCamera", showCamera);
  reg("esp32cam.showDevices", showDevices);
  reg("esp32cam.startCamera", () => { showCamera(); setCamera(true); });
  reg("esp32cam.stopCamera", () => setCamera(false));
  reg("esp32cam.snapshot", snapshot);

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "devices.json"));
  watcher.onDidChange(() => { loadDevices(); initInputs(); postDevices(); });
  context.subscriptions.push(watcher);
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => { if (t === terminal) terminal = null; }));
  context.subscriptions.push({ dispose: () => { clearInterval(timer); clearInterval(pollTimer); shutdown(); } });
  for (const v of ["esp32cam", "esp32devices"]) {
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(v, {
      async deserializeWebviewPanel(panel) { panel.dispose(); },
    }));
  }

  warnIfThonny();
  startBridge();
  // Both as tabs in editor group 2, next to your code; Camera in front.
  showDevices();
  showCamera();
  // After a restart VSCodium may restore an old layout (seen: Devices missing, empty
  // 3rd group). Once the layout has settled, make sure Devices sits next to Camera.
  setTimeout(() => {
    if (!camPanel) return;
    if (!devPanel) showDevices();
    else if (devPanel.viewColumn !== camPanel.viewColumn) devPanel.reveal(camPanel.viewColumn, true);
    camPanel.reveal(camPanel.viewColumn, true);
  }, 1500);
}

function shutdown() {
  active = false;
  if (bridge) { bridge.stdin.end(); bridge.kill(); bridge = null; }
}

function deactivate() { shutdown(); }

module.exports = { activate, deactivate };
