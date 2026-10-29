// wizard.js — Hadex Tunnels Setup, GUI installer/runner window (v1.0.0).
//
// Continuation of Hadex GPT Key Creator: the same installer-window logic,
// the same dedicated Chrome profile (so the OpenAI sign-in done for the Key
// Creator is reused - no second login), now driving the organization
// Tunnels settings page:
//
//   https://platform.openai.com/settings/organization/tunnels
//
// The user-facing "installer window": a small local web app served on
// 127.0.0.1 and opened in its own Chrome/Edge --app window (no tabs, looks
// like a native installer dialog). It shows every step of the setup as a
// live checklist, so a failure is visible at the exact step, with Retry:
//
//   1. Install & prepare   (runs install-core.bat: npm deps + fallback browser)
//   2. Open Chrome & sign in to OpenAI   (waits for the user; live status)
//   3. Open the Tunnels settings page
//   4. Verify the page + show the saved key file status (read-only)
//
// IMPORTANT: this module imports ONLY Node built-ins at load time, because the
// npm dependencies (playwright) may not exist yet when it starts.
// The engine (src/core.js) is imported dynamically AFTER the install step.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "1.1.2";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

let core = null; // loaded after the install step (dynamic import of ./core.js)

// ---------------------------------------------------------------- step state
const STEP_DEFS = [
  { id: "install",  fa: "نصب و آماده‌سازی برنامه",                 en: "Install & prepare" },
  { id: "login",    fa: "باز کردن Chrome و ورود به OpenAI",        en: "Open browser & sign in" },
  { id: "openpage", fa: "باز کردن صفحه‌ی Tunnels سازمان",           en: "Open the Tunnels page" },
  { id: "verify",   fa: "بررسی صفحه و وضعیت کلید ذخیره‌شده",       en: "Verify page & saved key" },
  // v1.1.0: the new Create-tunnel phase (clicks the page's "Create tunnel"
  // button, fills the dialog, captures the tunnel_id and saves it to a file).
  { id: "create",   fa: "ساخت تونل (کلیک روی Create tunnel و ذخیره‌ی tunnel_id)", en: "Create the tunnel & save its ID" }
];

const state = {
  steps: {},
  keyPath: null,
  keyInfo: null,
  tunnelInfo: null, // v1.1.0: { tunnelId, file } after the create step
  busy: false,
  context: null,
  page: null
};
for (const def of STEP_DEFS) {
  state.steps[def.id] = { status: "pending", detail: "", error: "", log: [] };
}

function setStep(id, patch) { Object.assign(state.steps[id], patch); }
function stepLog(id, line) {
  const arr = state.steps[id].log;
  arr.push(String(line).replace(/\s+$/, ""));
  if (arr.length > 400) arr.splice(0, arr.length - 400);
}
function engineLog(line) {
  console.log("[hadex] " + line);
  if (core) core.log(line).catch(() => {});
  else { try { fs.appendFileSync(path.join(os.tmpdir(), "hadex-tunnels-wizard.log"), line + "\n"); } catch {} }
}

// Runs one step; returns true when the step finished successfully.
async function attempt(id, fn, pageGetter) {
  setStep(id, { status: "running", error: "" });
  try {
    await fn();
  } catch (e) {
    const message = String(e?.message || e);
    setStep(id, { status: "failed", error: message });
    engineLog("Step '" + id + "' failed: " + message);
    try {
      const p = pageGetter ? pageGetter() : null;
      if (p && core) await core.dumpDebug(p, id);
    } catch {}
    return false;
  }
  return state.steps[id].status === "done";
}

// ---------------------------------------------------------------- step runners
async function runInstall() {
  const id = "install";
  setStep(id, { status: "running", detail: "نصب وابستگی‌ها و آماده‌سازی مرورگر (چند دقیقه ممکن است طول بکشد)...", error: "" });
  engineLog("Install step started (install-core.bat).");
  const exitCode = await new Promise(resolve => {
    let proc;
    if (isWin) {
      const bat = path.join(APP_DIR, "install-core.bat");
      proc = spawn("cmd.exe", ["/c", bat], { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      proc = spawn("bash", ["-lc", "npm install --omit=dev --no-audit --no-fund && npx playwright install chromium || true"], { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"] });
    }
    const pump = stream => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) if (line.trim()) stepLog(id, line);
      });
      stream.on("end", () => { if (buf && buf.trim()) stepLog(id, buf); });
    };
    pump(proc.stdout);
    pump(proc.stderr);
    proc.on("close", code => resolve(code === null ? -1 : code));
    proc.on("error", err => { stepLog(id, "spawn error: " + err.message); resolve(-1); });
  });
  if (exitCode !== 0) {
    throw new Error("The installer exited with code " + exitCode + ". See the log lines below (internet access is required the first time).");
  }
  try {
    core = await import("./core.js");
  } catch (e) {
    throw new Error("Dependencies were installed but the engine could not be loaded: " + String(e?.message || e));
  }
  engineLog("Install finished; engine loaded.");
  setStep(id, { status: "done", detail: "نصب کامل شد.", error: "" });
}

async function runLogin() {
  const id = "login";
  setStep(id, { status: "running", detail: "باز کردن پنجره‌ی Chrome مخصوص Hadex (همان پروفایل مشترک با Key Creator)...", error: "" });
  if (!state.context) {
    state.context = await core.launch();
    state.context.once("close", () => { state.context = null; state.page = null; });
  }
  if (!state.page || state.page.isClosed()) {
    state.page = await core.navigate(state.context);
  }
  setStep(id, {
    status: "waiting",
    detail: "اگر از شما خواسته شد، در پنجره‌ی Chrome وارد حساب OpenAI شوید. تا آماده شدن صفحه منتظر می‌مانیم (تا ۱۰ دقیقه). اگر قبلاً در Key Creator وارد شده‌اید، معمولاً نیازی به ورود دوباره نیست.",
    error: ""
  });
  await core.waitForPageReady(state.context, state.page, s => {
    if (s.kind === "login") {
      setStep(id, { status: "waiting", detail: "در انتظار ورود شما به OpenAI در پنجره‌ی Chrome..." });
    } else if (s.kind === "securityCheck") {
      setStep(id, { status: "waiting", detail: "بررسی امنیتی (Cloudflare/کپچا) باز است — خودتان در Chrome کاملش کنید..." });
    } else if (s.kind === "googleBlock") {
      setStep(id, {
        status: "waiting",
        detail: "گوگل ورود را رد کرد. راه‌حل: به‌جای Continue with Google از کد یک‌بارمصرف ایمیل استفاده کنید، یا login-once.bat را جدا اجرا کنید.",
        error: ""
      });
    } else if (s.kind === "ready") {
      setStep(id, { status: "running", detail: "ورود انجام شد؛ در حال رفتن به صفحه‌ی Tunnels..." });
    }
  });
  setStep(id, { status: "done", detail: "ورود انجام شد و صفحه‌ی Tunnels باز است.", error: "" });
}

async function runOpenPage() {
  const id = "openpage";
  setStep(id, { status: "running", detail: "رفتن به صفحه‌ی Tunnels سازمان...", error: "" });
  const page = state.page;
  const wanted = /^https:\/\/platform\.openai\.com\/settings\/organization\/tunnels/i;
  await core.untilAvailable(async () => {
    if (!wanted.test(page.url())) {
      await page.goto(core.TARGET_PAGE, { waitUntil: "domcontentloaded", timeout: 90000 });
      await new Promise(r => setTimeout(r, 1200));
    }
    if (!wanted.test(page.url())) {
      throw new Error("URL still not on the Tunnels page: " + page.url());
    }
  }, "Tunnels settings page", 60000);
  setStep(id, { status: "done", detail: "صفحه‌ی Tunnels باز است.", error: "" });
}

async function runVerify() {
  const id = "verify";
  setStep(id, { status: "running", detail: "بررسی محتوای صفحه‌ی Tunnels...", error: "" });
  const note = await core.checkTunnelsPage(state.page);
  setStep(id, { status: "running", detail: "بررسی فایل کلید ذخیره‌شده از مرحله‌ی قبل (فقط خواندن)...", error: "" });
  const info = await core.readSavedKeyFile();
  state.keyInfo = info;
  state.keyPath = info.exists && !info.empty ? info.file : null;
  engineLog("Verify OK: " + note + ". Key file at " + info.file + ": " +
    (info.exists ? (info.empty ? "exists but EMPTY" : "found, preview " + info.preview) : "NOT found"));
  setStep(id, {
    status: "done",
    detail: info.exists
      ? (info.empty
          ? "صفحه‌ی Tunnels تایید شد. فایل کلید پیدا شد ولی خالی است: " + info.file
          : "صفحه‌ی Tunnels تایید شد. فایل کلید از مرحله‌ی قبل موجود است: " + info.file)
      : "صفحه‌ی Tunnels تایید شد. فایل کلید پیدا نشد: " + info.file + " (اول با Key Creator کلید بسازید)",
    error: ""
  });
}

// v1.1.0: the Create-tunnel step runner (clicks the button, fills the form,
// submits, saves the tunnel_id and shows it in the window).
async function runCreate() {
  const id = "create";
  setStep(id, { status: "running", detail: "کلیک روی Create tunnel و پر کردن فرم (Name، Description، Organizations، Workspaces)...", error: "" });
  const result = await core.createTunnel(state.page);
  state.tunnelInfo = { tunnelId: result.tunnelId, file: result.file };
  engineLog("Create-tunnel OK (" + (result.created ? "created" : "reused") + "): " + result.tunnelId + " -> " + result.file);
  setStep(id, {
    status: "done",
    detail: (result.created
      ? "تونل ساخته شد و tunnel_id ذخیره شد در: "
      : "تونل از قبل موجود بود (دوباره ساخته نشد) و tunnel_id ذخیره شد در: ") + result.file,
    error: ""
  });
}

const RUNNERS = {
  install:  () => attempt("install",  runInstall),
  login:    () => attempt("login",    runLogin,    () => state.page),
  openpage: () => attempt("openpage", runOpenPage, () => state.page),
  verify:   () => attempt("verify",   runVerify,   () => state.page),
  create:   () => attempt("create",   runCreate,   () => state.page)
};

// ---------------------------------------------------------------- pipeline
let pipelineRunning = false;
async function runPipeline(fromId) {
  if (pipelineRunning) return;
  pipelineRunning = true;
  try {
    const order = STEP_DEFS.map(s => s.id);
    for (let i = Math.max(0, order.indexOf(fromId)); i < order.length; i++) {
      const id = order[i];
      if (id !== fromId && state.steps[id].status === "done") continue;
      const ok = await RUNNERS[id]();
      if (!ok) break; // failed step: stop and let the user Retry in the window
    }
  } finally {
    pipelineRunning = false;
  }
}

function resetFrom(id) {
  const order = STEP_DEFS.map(s => s.id);
  const fromIdx = Math.max(0, order.indexOf(id));
  for (const sid of order.slice(fromIdx)) {
    setStep(sid, { status: "pending", detail: "", error: "" });
  }
  state.keyPath = null;
  state.keyInfo = null;
  // v1.1.0: when the reset starts at/before the create step, drop the old
  // tunnel info too (it will be filled again by the retried step).
  if (order.indexOf("create") >= fromIdx) state.tunnelInfo = null;
}

async function exitAll() {
  engineLog("Exit requested; closing the Hadex browser window.");
  try { if (state.context) await state.context.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
}

async function handleAction(body) {
  const action = body && body.action;
  if (action === "start") {
    if (state.steps.install.status === "done") return;
    resetFrom("install");
    await runPipeline("install");
  } else if (action === "retry") {
    const failed = STEP_DEFS.map(s => s.id).find(id => state.steps[id].status === "failed");
    if (!failed) return;
    resetFrom(failed);
    await runPipeline(failed);
  } else if (action === "resume") {
    const next = STEP_DEFS.map(s => s.id).find(id => state.steps[id].status !== "done");
    if (next) await runPipeline(next);
  } else if (action === "open-folder") {
    // v1.1.0: prefer the tunnel-id file, fall back to the key file.
    const target = (state.tunnelInfo && state.tunnelInfo.file) || state.keyPath;
    if (isWin && target) {
      try { spawn("explorer.exe", ["/select,", target], { detached: true, stdio: "ignore" }).unref(); } catch {}
    }
  } else if (action === "exit") {
    await exitAll();
  }
}

// ---------------------------------------------------------------- HTTP server
function sendJson(res, obj, code = 200) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}
function readBody(req) {
  return new Promise(resolve => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 10000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(PAGE_HTML);
    return;
  }
  if (req.method === "GET" && url === "/api/status") {
    const stepsOut = {};
    for (const d of STEP_DEFS) stepsOut[d.id] = { fa: d.fa, en: d.en, ...state.steps[d.id] };
    sendJson(res, {
      version: VERSION,
      busy: pipelineRunning,
      keyPath: state.keyPath,
      keyInfo: state.keyInfo,
      tunnelInfo: state.tunnelInfo,
      steps: stepsOut
    });
    return;
  }
  if (req.method === "POST" && url === "/api/action") {
    const body = await readBody(req);
    try { await handleAction(body); } catch (e) { engineLog("Action error: " + String(e?.message || e)); }
    sendJson(res, { ok: true });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

function openWizardWindow(url) {
  if (!isWin) {
    console.log("Open the installer window at: " + url);
    return;
  }
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const lad = process.env["LOCALAPPDATA"] || "";
  const candidates = [
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(lad, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
  const exe = candidates[0];
  try {
    if (exe) {
      // Use a dedicated temporary profile so cleanup never touches the user's everyday browser.
      const args = [];
      if (process.env.HADEX_UI_PROFILE_DIR) {
        args.push("--user-data-dir=" + path.resolve(process.env.HADEX_UI_PROFILE_DIR));
      }
      args.push("--no-first-run", "--no-default-browser-check", "--app=" + url, "--window-size=600,800", "--window-position=60,50");
      spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    console.log("Could not open the window automatically. Open this address manually: " + url);
  }
}

process.on("SIGINT", () => { exitAll(); });
process.on("SIGTERM", () => { exitAll(); });

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const url = "http://127.0.0.1:" + port + "/";
  console.log("Hadex Tunnels Setup v" + VERSION + " - installer window");
  console.log("Wizard UI: " + url + "  (keep this console window open; it is the engine)");
  engineLog("Wizard started at " + url);
  openWizardWindow(url);
});

// ---------------------------------------------------------------- UI (single page)
const PAGE_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hadex Tunnels Setup</title>
<style>
:root{--bg:#0f1218;--card:#171c26;--line:#242c3c;--txt:#e8ecf3;--mut:#94a1b6;--acc:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#60a5fa}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:Tahoma,'Segoe UI',sans-serif;font-size:13px;line-height:1.8}
header{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line);background:#131824}
.logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#22c55e);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:18px;color:#fff;flex:0 0 38px}
h1{font-size:15px}
.sub{color:var(--mut);font-size:11px}
.ver{margin-inline-start:auto;background:#1d2635;border:1px solid var(--line);color:var(--mut);border-radius:20px;padding:1px 10px;font-size:11px;direction:ltr}
main{padding:14px 16px 4px}
ol{list-style:none;display:flex;flex-direction:column;gap:8px}
li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
li.running{border-color:rgba(96,165,250,.55)}
li.waiting{border-color:rgba(245,158,11,.5)}
li.done{border-color:rgba(34,197,94,.4)}
li.failed{border-color:rgba(239,68,68,.55)}
.strow{display:flex;align-items:flex-start;gap:10px}
.ico{width:24px;height:24px;border-radius:50%;flex:0 0 24px;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid var(--line);color:var(--mut);margin-top:3px}
li.running .ico{border-color:var(--blue);color:var(--blue)}
li.waiting .ico{border-color:var(--amber);color:var(--amber)}
li.done .ico{border-color:var(--acc);color:var(--acc)}
li.failed .ico{border-color:var(--red);color:var(--red)}
.tt{font-weight:bold;font-size:13px}
.en{color:var(--mut);font-size:10px;direction:ltr;text-align:right;display:block}
.dt{color:var(--mut);font-size:11px;margin-top:2px;white-space:pre-wrap}
.err{margin-top:6px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.35);color:#fca5a5;border-radius:8px;padding:6px 8px;font-size:11px;direction:ltr;text-align:left;white-space:pre-wrap;word-break:break-word}
.pre{margin-top:6px;background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:6px 8px;direction:ltr;text-align:left;font-family:Consolas,monospace;font-size:10.5px;color:#9fb0c8;max-height:130px;overflow:auto;white-space:pre-wrap}
.spin{display:inline-block;animation:rot 1s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
.done{margin-top:12px;border-radius:12px;padding:12px;background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.5)}
.done-title{font-weight:bold;margin-bottom:4px}
.done-note{color:var(--mut);font-size:11.5px}
.warn{margin-top:8px;border-radius:8px;padding:6px 8px;font-size:11px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.45);color:#fcd34d}
.path{direction:ltr;text-align:left;background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin:8px 0;font-family:Consolas,monospace;font-size:11px;color:#86efac;word-break:break-all}
footer{display:flex;gap:8px;padding:12px 16px 6px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:#1d2635;color:var(--txt);border-radius:10px;padding:8px 14px;font-family:inherit;font-size:12.5px;cursor:pointer}
.btn:hover{filter:brightness(1.18)}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:var(--acc);border-color:var(--acc);color:#06220f;font-weight:bold}
.btn.danger{background:transparent;border-color:rgba(239,68,68,.4);color:#fca5a5}
.btn.ghost{background:transparent}
.btn.big{flex:1}
.hint{padding:8px 16px 14px;color:var(--mut);font-size:10.5px}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <div class="logo">H</div>
  <div><h1>Hadex Tunnels Setup</h1><div class="sub">ادامه‌ی کار: صفحه‌ی Tunnels سازمان OpenAI</div></div>
  <span class="ver" id="ver"></span>
</header>
<main>
  <ol id="steps"></ol>
  <div id="done" class="done hidden">
    <div class="done-title">همه‌چیز آماده است ✔</div>
    <div class="path" id="tunnelid" dir="ltr"></div>
    <div class="done-note" id="tunnelnote"></div>
    <div class="path" id="keypath" dir="ltr"></div>
    <div class="done-note" id="keynote"></div>
    <div class="warn hidden" id="keywarn"></div>
  </div>
</main>
<footer>
  <button id="btn-main" class="btn primary big">شروع نصب و راه‌اندازی</button>
  <button id="btn-folder" class="btn ghost hidden">نمایش فایل‌ها در Explorer</button>
  <button id="btn-exit" class="btn danger">خروج</button>
</footer>
<div class="hint">پنجره‌ی مشکی کنسول را نبندید — موتور برنامه است. وضعیت هر مرحله همین‌جا زنده به‌روز می‌شود؛ اگر مرحله‌ای خطا بدهد، همان‌جا با دکمه‌ی «تلاش مجدد» مشخص می‌شود. این برنامه از همان پروفایل Chrome مشترک با Key Creator استفاده می‌کند؛ هر دو برنامه را هم‌زمان اجرا نکنید.</div>
<script>
var st = null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
var ICO={pending:'\\u00b7',running:'<span class="spin">\\u25cb</span>',waiting:'\\u23f8',done:'\\u2714',failed:'\\u2716'};
var IDS=['install','login','openpage','verify','create'];
function render(){
  if(!st) return;
  document.getElementById('ver').textContent='v'+st.version;
  var html='';
  for(var i=0;i<IDS.length;i++){
    var id=IDS[i]; var s=st.steps[id]; if(!s) continue;
    html+='<li class="'+s.status+'"><div class="strow"><div class="ico">'+ICO[s.status]+'</div><div style="flex:1">';
    html+='<span class="tt">'+esc(s.fa)+'</span><span class="en">'+esc(s.en)+'</span>';
    if(s.detail) html+='<div class="dt">'+esc(s.detail)+'</div>';
    if(s.error) html+='<div class="err">'+esc(s.error)+'</div>';
    if(id==='install'&&s.log&&s.log.length&&(s.status==='running'||s.status==='failed')){
      var tail=s.log.slice(-12).join('\\n');
      html+='<div class="pre">'+esc(tail)+'</div>';
    }
    html+='</div></div></li>';
  }
  document.getElementById('steps').innerHTML=html;
  var doneOn=st.steps.create&&st.steps.create.status==='done';
  document.getElementById('done').className='done'+(doneOn?'':' hidden');
  if(doneOn){
    var ki=st.keyInfo||{};
    var ti=st.tunnelInfo||{};
    var tid=document.getElementById('tunnelid');
    var tnote=document.getElementById('tunnelnote');
    if(ti.tunnelId){
      tid.textContent='tunnel_id: '+ti.tunnelId;
      tnote.textContent='برای اجرای tunnel-client به این دو مقدار نیاز دارید: CONTROL_PLANE_TUNNEL_ID (فایل بالا) و CONTROL_PLANE_API_KEY (فایل کلید پایین).';
      tnote.className='done-note';
    } else {
      tid.textContent='';
      tnote.textContent='tunnel_id ذخیره نشده است.';
      tnote.className='warn';
    }
    var note=document.getElementById('keynote');
    var warn=document.getElementById('keywarn');
    if(ki.exists&&!ki.empty){
      note.textContent='کلید ساخته‌شده در مرحله‌ی قبل موجود است (نمایش مختصر: '+(ki.preview||'')+').';
      warn.className='warn hidden';
    } else if(ki.exists){
      note.textContent='فایل کلید وجود دارد ولی خالی است.';
      warn.textContent='اول با Hadex GPT Key Creator یک کلید بسازید.';
      warn.className='warn';
    } else {
      note.textContent='فایل کلید پیدا نشد.';
      warn.textContent='اول با Hadex GPT Key Creator یک کلید بسازید، بعد این برنامه را دوباره اجرا کنید.';
      warn.className='warn';
    }
    var folder=document.getElementById('btn-folder');
    if((ki.exists&&!ki.empty)||(ti.tunnelId&&ti.file)){folder.className='btn ghost';}
    else{folder.className='btn ghost hidden';}
  } else {
    document.getElementById('btn-folder').className='btn ghost hidden';
  }
  var b=document.getElementById('btn-main');
  var anyFailed=IDS.some(function(i){return st.steps[i]&&st.steps[i].status==='failed';});
  var allDone=IDS.every(function(i){return st.steps[i]&&st.steps[i].status==='done';});
  b.disabled=false;
  if(st.busy){b.disabled=true;b.textContent='در حال اجرا...';}
  else if(anyFailed){b.textContent='تلاش مجدد از مرحله‌ی خطادار';}
  else if(allDone){b.className='btn ghost big hidden';}
  else if(st.steps.install.status==='pending'){b.className='btn primary big';b.textContent='شروع نصب و راه‌اندازی';}
  else{b.className='btn primary big';b.textContent='ادامه';}
}
async function poll(){
  try{var r=await fetch('/api/status',{cache:'no-store'});st=await r.json();render();}catch(e){}
}
async function act(a){
  try{await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});}catch(e){}
}
document.getElementById('btn-main').onclick=function(){
  if(st&&st.busy)return;
  var a='resume';
  if(st&&IDS.some(function(i){return st.steps[i].status==='failed';})) a='retry';
  else if(st&&st.steps.install.status==='pending') a='start';
  act(a);
};
document.getElementById('btn-folder').onclick=function(){act('open-folder');};
document.getElementById('btn-exit').onclick=function(){act('exit');setTimeout(function(){try{window.close();}catch(e){}},600);};
setInterval(poll,800); poll();
</script>
</body>
</html>`;