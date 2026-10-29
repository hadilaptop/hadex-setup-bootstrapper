// core.js — Hadex Plugins Setup automation engine (shared by console + wizard).
// A SEPARATE Hadex app, built with the same proven logic as Hadex Tunnels
// Setup: same dedicated Chrome profile (one shared sign-in for all Hadex
// apps), same installer-window-friendly helpers, same retry/dumpDebug
// philosophy. This engine drives the ChatGPT Plugins page:
//
//   https://chatgpt.com/plugins
//
// and adds the custom MCP server "hadex-gpt" through
//   Add  ->  Add custom MCP server  ->  dialog fields.
// No side effects here: importing this module never starts a browser.
//
// v1.1.0 POLICY (user request): the add flow is ALWAYS performed from
// scratch, even when a server named "hadex-gpt" already exists. The old
// "if it looks installed -> skip everything" pre-check was removed: it
// misread the page and falsely reported the server as installed. Only
// ChatGPT itself may end the run early, by rejecting the SUBMIT with its
// own "name already exists / in use" message AFTER the full flow ran.
//
// v1.1.1 POLICY (user report fixed): the Authentication step ALWAYS clicks
// the field open and ALWAYS picks "No authentication" from the dropdown.
// The old fast path ("the text exists somewhere -> already selected") was
// removed: ChatGPT's dialog pre-renders hidden dropdown markup, so that
// check fired without a single click and the option was never really set.
//
// v1.1.2 POLICY (user report fixed): the page-level "Add" button is found
// ROBUSTLY - flexible name matching ("Add", "+ Add", "Add a plugin", ...),
// up to ~30s of polling with one automatic page reload for slow hydration,
// and clicks repeated until the dropdown is REALLY open. The old one-shot
// strict search threw "Could not identify the Add button" when the page had
// not finished rendering (the page check can pass from hidden HTML while
// the visible button is not mounted yet).
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// v1.1.0 target: the ChatGPT Plugins page.
const TARGET_PAGE = "https://chatgpt.com/plugins";
// The custom MCP server this app adds (exact values confirmed by the user).
const SERVER_NAME = "hadex-gpt";
const SERVER_DESC = "bridge for hadex-gpt";
// ONE shared Hadex Chrome profile (same as Key Creator + Tunnels Setup). The
// ChatGPT sign-in is stored once in this profile and reused by every Hadex
// app. The apps must not run at the same time (one profile lock); stale
// windows holding the profile are closed automatically below.
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Hadex", "GPTKeyCreator", "chrome-profile");
// This app keeps its OWN log/debug folder, separate from the other Hadex apps.
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Hadex", "PluginsSetup");
const LOG_FILE = path.join(DATA_DIR, "setup.log");
const DEBUG_DIR = path.join(DATA_DIR, "debug");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// The Plugins page sits on chatgpt.com; signing in redirects through
// auth.openai.com - both hosts count as "on the right site".
const CHAT_HOST = /^https:\/\/(chatgpt\.com|auth\.openai\.com)\//i;

// Google blocks sign-in when it detects an automated browser. These switches and the
// init script below remove the most common automation fingerprints. They do not
// bypass any verification; if Google still refuses, use login-once.bat or sign in
// with the email one-time code instead of "Continue with Google".
const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars"
];
const IGNORE_DEFAULT_ARGS = ["--enable-automation"];

async function log(message) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}
function loginRequired(page) {
  return /auth\.openai\.com|\/log-in|\/login|\/sign-in|\/auth\//i.test(page.url());
}

// Close leftover browser processes that still hold Hadex's own profile.
// Only processes whose command line contains the Hadex profile path are killed,
// so the user's normal Chrome/Edge windows are never touched. This fixes the
// "about:blank + black window" symptom when a previous Hadex window (or a
// double-started run.bat) still owns the profile.
function closeStaleProfileBrowsers() {
  if (process.platform !== "win32") return 0;
  const script = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*Hadex\\GPTKeyCreator\\chrome-profile*' };",
    "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue };",
    "if ($procs) { $procs.Count } else { 0 }"
  ].join(" ");
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script
    ], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    const count = parseInt(String(result.stdout).trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

async function hideAutomationFlags(context) {
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {}
    try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array; } catch {}
  }).catch(() => {});
}
async function launch() {
  await log("Connecting to the running Hadex Chromium instance at 127.0.0.1:9223.");
  let browser;
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 15000 });
  } catch (error) {
    throw new Error(
      "Hadex Chromium is not reachable on 127.0.0.1:9223. The setup runner must start Hadex Chromium first. Details: " +
      String(error?.message || error)
    );
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("Hadex Chromium connected, but its default browser context was not found.");
  await hideAutomationFlags(context);
  await log("Connected to Hadex Chromium. Existing page count: " + context.pages().length);
  return context;
}
async function navigate(context) {
  await log("Opening target URL in Hadex Chromium: " + TARGET_PAGE);
  const managedPage = /^https:\/\/(platform\.openai\.com|chatgpt\.com|auth\.openai\.com)\//i;
  const pages = context.pages();
  let page = pages.find(candidate => managedPage.test(candidate.url()));
  if (!page) page = pages.find(candidate => /^file:\/\//i.test(candidate.url()) && /index\.html/i.test(candidate.url()));
  if (!page) {
    throw new Error("Could not find the Hadex Chromium window through CDP. Keep Hadex Chromium open and retry.");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(TARGET_PAGE, { waitUntil: "commit", timeout: 90000 });
      lastError = null;
    } catch (error) {
      lastError = error;
      await log("Navigation attempt " + attempt + " threw: " + String(error?.message || error));
    }

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (page.isClosed()) break;
      if (managedPage.test(page.url())) {
        await wait(1000);
        await page.bringToFront().catch(() => {});
        await log("Target page is ready in Hadex Chromium: " + page.url());
        return page;
      }
      await wait(300);
    }
    if (page.isClosed()) break;
    await wait(1000);
  }

  throw new Error(
    "Hadex Chromium did not reach the target page. Current URL: " +
    (page.isClosed() ? "(window closed)" : page.url()) +
    (lastError ? " | last error: " + String(lastError?.message || lastError) : "")
  );
}
async function visibleLogin(page) {
  if (loginRequired(page)) return true;
  const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 2500);
  return /welcome back|log in|sign up|continue with google|enter your email/i.test(text);
}
async function requiredButton(scope, names, description) {
  for (const name of names) {
    const item = scope.getByRole("button", { name }).first();
    if (await item.count() && await item.isVisible().catch(() => false)) return item;
  }
  throw new Error(`Could not identify ${description}. The app stopped without guessing.`);
}
// Custom dropdown widgets and visibility checks need the element brought into
// view first - this helper does that without throwing.
async function scrollIntoView(loc) {
  try { await loc.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
}
// True when a dropdown popup (menu/listbox) is currently open on the page.
const POPUP_SEL = "[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [data-radix-menu-content], [data-radix-dropdown-menu-content], [data-radix-select-content]";
async function popupOpen(scope) {
  return (await scope.locator(POPUP_SEL).count().catch(() => 0)) > 0;
}
// Scroll an element to the MIDDLE of the view (a centered scroll keeps the
// control away from sticky footers/overlays that would steal the click).
async function scrollCenter(loc) {
  try { await loc.evaluate(el => el.scrollIntoView({ block: "center", inline: "nearest" })); } catch {}
  try { await loc.scrollIntoViewIfNeeded({ timeout: 1500 }); } catch {}
}
// Waits until a dropdown popup is really visible on the page.
async function waitPopup(scope, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const popups = scope.locator(POPUP_SEL);
    const n = await popups.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      if (await popups.nth(i).isVisible().catch(() => false)) return true;
    }
    await wait(250);
  }
  return false;
}
// Reads an option's/element's checked state WITHOUT guessing:
//   true  -> explicitly checked (aria-checked / data-state / real input)
//   false -> explicitly UNCHECKED (safe to click)
//   null  -> unreadable (never toggled blindly a second time)
async function readCheckedState(item) {
  const aria = await item.getAttribute("aria-checked").catch(() => null);
  const state = await item.getAttribute("data-state").catch(() => null);
  if (aria === "true" || state === "checked") return true;
  if (aria === "false" || state === "unchecked") return false;
  try { if (await item.isChecked()) return true; } catch {}
  return null;
}
// Segmented toggles ("Server URL / Tunnel") and selectable chips use
// aria-pressed or data-state="on" instead of aria-checked - this variant
// reads all of those shapes.
async function segmentState(el) {
  const aria = await el.getAttribute("aria-checked").catch(() => null);
  const pressed = await el.getAttribute("aria-pressed").catch(() => null);
  const state = await el.getAttribute("data-state").catch(() => null);
  if (aria === "true" || pressed === "true" || state === "on" || state === "checked") return true;
  if (aria === "false" || pressed === "false" || state === "off" || state === "unchecked") return false;
  return null;
}
async function untilAvailable(fn, description, timeoutMs = 30000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try { return await fn(); } catch (error) { lastError = error; }
    await wait(500);
  }
  throw new Error(lastError ? lastError.message : description + " did not appear in time.");
}
// Saves a full-page screenshot + HTML so a failure can be diagnosed afterwards.
async function dumpDebug(page, tag) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: path.join(DEBUG_DIR, stamp + "-" + tag + ".png"), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(DEBUG_DIR, stamp + "-" + tag + ".html"), await page.content().catch(() => ""), "utf8");
    await log("Debug dump saved for step: " + tag);
    console.log("Debug snapshot saved to " + DEBUG_DIR + " (" + tag + ")");
  } catch {}
}
async function pageSignals(page) {
  const title = await page.title().catch(() => "");
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
  const securityCheck = /just a moment|checking your browser|verify you are human|performing security verification|complete the security check/i.test(title + "\n" + body);
  const googleBlock = /browser or app may not be secure|try using a different browser|couldn.t sign you in/i.test(body);
  const login = loginRequired(page) || /welcome back|\blog in\b|sign up|continue with google|enter your email/i.test(body);
  return { title, body, securityCheck, googleBlock, login };
}
// onState (optional) reports live progress to GUI callers:
//   { kind: "login" | "securityCheck" | "googleBlock" | "ready" }
async function waitForPageReady(context, page, onState = null) {
  console.log("\nA visible Chrome window is open.");
  console.log("If asked, sign in to ChatGPT and complete the security check yourself in that window.");
  console.log("TIP: if \"Continue with Google\" is rejected as an insecure browser, use the email");
  console.log("     one-time code instead, or run login-once.bat first and then Hadex again.");
  console.log("The app will wait for the real Plugins page; it does not bypass verification or read passwords/cookies.");
  const start = Date.now();
  let notifiedSecurity = false;
  let notifiedLogin = false;
  let notifiedGoogle = false;
  while (Date.now() - start < 10 * 60 * 1000) {
    if (!context.pages().length || page.isClosed()) throw new Error("Chrome was closed before the Plugins page became ready.");
    const state = await pageSignals(page);
    if (state.googleBlock) {
      if (!notifiedGoogle) {
        console.log("Google refused the sign-in in this browser.");
        console.log("Do this instead: close this window, run login-once.bat, sign in there, then run Hadex again.");
        console.log("Or sign in with the email one-time code instead of Google. Waiting...");
        await log("Google blocked sign-in: 'browser or app may not be secure'.");
        notifiedGoogle = true;
      }
      onState?.({ kind: "googleBlock" });
      await wait(2000);
      continue;
    }
    if (state.securityCheck) {
      if (!notifiedSecurity) {
        console.log("Security verification is displayed. Complete it manually; waiting...");
        await log("Waiting for user to complete the visible browser security check.");
        notifiedSecurity = true;
      }
      onState?.({ kind: "securityCheck" });
      await wait(2000);
      continue;
    }
    if (state.login) {
      if (!notifiedLogin) {
        console.log("Please sign in to your ChatGPT account in the visible Chrome window.");
        await log("Waiting for user sign-in in visible Chrome.");
        notifiedLogin = true;
      }
      onState?.({ kind: "login" });
      await wait(2000);
      continue;
    }
    if (/^https:\/\/chatgpt\.com\//i.test(page.url())) {
      // Signed in and on ChatGPT: make sure the tab ends up on the Plugins
      // page itself (the sign-in redirect can land on the chat root).
      if (!/^https:\/\/chatgpt\.com\/plugins/i.test(page.url())) {
        await page.goto(TARGET_PAGE, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        await wait(1200);
        continue;
      }
      onState?.({ kind: "ready" });
      return;
    }
    await wait(1500);
  }
  throw new Error("The Plugins page did not become ready within ten minutes. Nothing was changed in your ChatGPT account.");
}

// --------------------------------------------------------- Plugins helpers
// Verifies that the browser really shows the ChatGPT Plugins page (URL +
// page content), so the wizard never reports success on a redirect, the chat
// root or an error page. Same hardening as the Tunnels app's page check: the
// content side accepts ANY of several independent signals, falls back to the
// raw HTML when innerText is empty during hydration, and retries a few times.
function pluginsPageSignal(hay) {
  const s = String(hay || "");
  if (/connect plugins to let chatgpt/i.test(s)) return "Plugins page subtitle";
  if (/add custom mcp server/i.test(s)) return "'Add custom MCP server' menu entry";
  if (/search plugins/i.test(s)) return "'Search plugins' box";
  if (/\bplugins\b/i.test(s) && /installed/i.test(s)) return "Plugins + Installed sections";
  return null;
}
async function checkPluginsPage(page) {
  const url = page.url();
  if (!/^https:\/\/chatgpt\.com\/plugins/i.test(url)) {
    throw new Error("The Plugins page is not open. Current URL: " + url);
  }
  const collect = async () => {
    let text = "";
    try { text = (await page.locator("body").innerText()) || ""; } catch {}
    // innerText only sees VISIBLE text and can fail during re-renders; the
    // raw HTML always includes hidden/pre-hydration content as a fallback.
    const html = (await page.content().catch(() => "")) || "";
    return text + "\n" + html;
  };
  let signal = null;
  for (let attempt = 0; attempt < 5 && !signal; attempt++) {
    if (attempt) await wait(1500); // give a still-hydrating page more chances
    signal = pluginsPageSignal(await collect());
  }
  if (!signal) {
    await dumpDebug(page, "plugins-page-unrecognized");
    throw new Error("The Plugins page is open, but none of its known elements was found in its content. A debug snapshot was saved to " + DEBUG_DIR + " - if ChatGPT redesigned the page, send that snapshot so the check can be updated.");
  }
  await log("Plugins page verified (URL + content: " + signal + ").");
  return "Plugins page verified (" + signal + ")";
}

// ═══════════════ HADEX v1.1.0: ADD-CUSTOM-MCP-SERVER PHASE ═══════════════════
// Flow confirmed from the user's screenshots of chatgpt.com/plugins:
//   1) click the page-level "Add" button
//   2) in the dropdown menu pick exactly: "Add custom MCP server"
//   3) the dialog opens; fill/select:
//        Name           = hadex-gpt
//        Description    = bridge for hadex-gpt
//        Connection     = two choices next to each other ("Server URL" and
//                         "Tunnel") -> "Tunnel" must be selected
//        (the tunnel list then appears) -> pick exactly "hadex-gpt"
//        Authentication = dropdown with three options -> "No authentication"
//        risk warning   -> tick the "I understand and want to continue" box
//   4) submit INSIDE the dialog, wait for it to close, verify the server.
//
// v1.1.0: NO pre-check, NO skipping. Even if the server already exists, the
// whole flow is repeated exactly as requested. Before the flow starts,
// anything a previous attempt left open (the Add menu or the dialog) is
// closed, so every run begins from a clean state.

// ChatGPT's own duplicate-name rejection, e.g. "A server with this name
// already exists" / "This name is already in use". Deliberately STRICT (no
// vague "must be unique" hints, which pages can show as static helper text)
// and matched ONLY against real ChatGPT messages AFTER the full flow was
// performed - it is never used to skip work.
const ALREADY_EXISTS_RE = /\b(?:already\s+exists|already\s+in\s+use|already\s+been\s+(?:added|used|registered|created|taken)|name\s+is\s+already\s+(?:taken|in\s+use|used)|is\s+already\s+(?:taken|in\s+use)|duplicate\s+(?:name|server|entry))\b/i;
function alreadyExistsText(text) { return ALREADY_EXISTS_RE.test(String(text || "")); }

// v1.1.0: closes anything a previous attempt may have left open on the
// Plugins page (the Add dropdown or the Add-custom-MCP-server dialog), so a
// retry or a re-run always starts clean. Escape first; if a dialog survives,
// its Cancel/Close/Dismiss/Back button is clicked. Best effort.
async function resetToAddState(page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.getByRole("dialog").first();
    const dialogOpen = (await dlg.count().catch(() => 0)) > 0 &&
                       (await dlg.isVisible().catch(() => false));
    if (!dialogOpen && !(await popupOpen(page))) return;
    await page.keyboard.press("Escape").catch(() => {});
    await wait(600);
  }
  const dlg = page.getByRole("dialog").first();
  if ((await dlg.count().catch(() => 0)) && (await dlg.isVisible().catch(() => false))) {
    for (const name of [/^cancel$/i, /^close$/i, /^dismiss$/i, /^back$/i]) {
      const btn = dlg.getByRole("button", { name }).first();
      if ((await btn.count().catch(() => 0)) && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 2500 }).catch(() => btn.click({ force: true, timeout: 1500 }).catch(() => {}));
        await wait(600);
        break;
      }
    }
  }
  if (await popupOpen(page)) { await page.keyboard.press("Escape").catch(() => {}); await wait(400); }
}

// Exact-text confirmation that a plugin/server named SERVER_NAME is listed -
// used ONLY AFTER the full flow has run (never as a skip pre-check). The
// Personal tab is opened once (best effort) because custom MCP servers are
// listed under it, and the list is re-scanned for up to 15 seconds.
async function confirmServerListed(page) {
  const esc = SERVER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp("^\\s*" + esc + "\\s*$", "i");
  const scan = async () => {
    const items = page.getByText(exact);
    const n = await items.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      if (await items.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
  };
  const deadline = Date.now() + 15000;
  let tabTried = false;
  while (Date.now() < deadline) {
    if (await scan()) return true;
    if (!tabTried) {
      tabTried = true;
      const tabs = [
        page.getByRole("tab", { name: /personal/i }).first(),
        page.getByRole("button", { name: /personal/i }).first()
      ];
      for (const t of tabs) {
        if ((await t.count().catch(() => 0)) && (await t.isVisible().catch(() => false))) {
          await t.click({ timeout: 3000 }).catch(() => {});
          await wait(1200);
          break;
        }
      }
    }
    await wait(900);
  }
  return false;
}

// Fills the Name field of the dialog (placeholder "Custom Tool"), verified by
// reading the value back.
async function fillServerName(scope) {
  const candidates = [
    scope.getByRole("textbox", { name: /^name\b/i }).first(),
    scope.getByLabel(/^name/i).first(),
    scope.getByPlaceholder(/^custom tool$/i).first(),
    scope.locator('input[name="name"]:visible').first(),
    scope.locator('input[type="text"]:visible').first()
  ];
  for (const field of candidates) {
    if (!(await field.count())) continue;
    if (!(await field.isVisible().catch(() => false))) continue;
    try {
      await field.fill(SERVER_NAME, { timeout: 8000 });
      const value = (await field.inputValue().catch(() => "")).trim();
      if (value === SERVER_NAME) return "name filled (verified)";
    } catch {}
  }
  throw new Error("Could not find the Name field of the Add-custom-MCP-server dialog. Nothing was submitted.");
}

// Description (optional, but filled exactly as requested):
// "bridge for hadex-gpt". Never fatal - an unfilled description must not stop
// the step.
async function fillServerDescription(scope) {
  const candidates = [
    scope.getByRole("textbox", { name: /description/i }).first(),
    scope.getByLabel(/description/i).first(),
    scope.locator("textarea:visible").first()
  ];
  for (const field of candidates) {
    if (!(await field.count())) continue;
    if (!(await field.isVisible().catch(() => false))) continue;
    try {
      await field.fill(SERVER_DESC, { timeout: 6000 });
      const value = (await field.inputValue().catch(() => "")).trim();
      if (value === SERVER_DESC) return "description filled (verified)";
    } catch {}
  }
  try {
    const boxes = scope.locator('input[type="text"]:visible');
    const total = await boxes.count();
    if (total >= 2) {
      await boxes.nth(1).fill(SERVER_DESC, { timeout: 5000 });
      return "description filled (second text field)";
    }
  } catch {}
  return "description left empty (optional)";
}

// The Connection row is a segmented toggle with the two choices NEXT TO EACH
// OTHER: "Server URL" and "Tunnel". "Tunnel" must be selected; afterwards the
// list of tunnel names (hadex-gpt / connect-gpt / Hadex) appears.
async function clickConnectionTunnel(scope) {
  const tunnelListVisible = async () => {
    const esc = SERVER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const chip = scope.getByText(new RegExp("^\\s*" + esc + "\\s*$", "i"));
    if (await chip.count()) return true;
    // Any tunnel-list shape: our chip, or the other known tunnel names.
    const others = scope.getByText(/^\s*(connect-gpt|Hadex)\s*$/i);
    return (await others.count().catch(() => 0)) > 0;
  };
  if (await tunnelListVisible()) return "Connection already on Tunnel (tunnel list visible)";
  const candidates = [];
  for (const role of ["radio", "tab", "button", "menuitemradio"]) {
    const items = scope.getByRole(role, { name: /^\s*tunnel\s*$/i });
    const n = await items.count();
    for (let i = 0; i < n; i++) candidates.push({ el: items.nth(i), via: role });
  }
  const texts = scope.getByText(/^\s*tunnel\s*$/i);
  const textTotal = await texts.count().catch(() => 0);
  for (let i = 0; i < Math.min(textTotal, 5); i++) candidates.push({ el: texts.nth(i), via: "text" });
  for (const c of candidates) {
    if (!(await c.el.count())) continue;
    await scrollCenter(c.el);
    if (!(await c.el.isVisible().catch(() => false))) continue;
    if ((await segmentState(c.el)) === true) return "Tunnel already selected (verified by state)";
    await c.el.click({ timeout: 5000 }).catch(() => c.el.click({ force: true, timeout: 2000 }).catch(() => {}));
    await wait(800);
    if ((await segmentState(c.el)) === true) return "Tunnel clicked (verified by state)";
    if (await tunnelListVisible()) return "Tunnel clicked (tunnel list appeared)";
  }
  throw new Error('The "Tunnel" option of the Connection toggle was not found (the two choices "Server URL" and "Tunnel" were searched inside the dialog). Nothing was submitted.');
}

// After Connection = Tunnel, the dialog lists the available tunnels. Exactly
// the one named "hadex-gpt" must be picked - "connect-gpt" and "Hadex" are
// DIFFERENT tunnels and are never touched. The exact regex makes confusion
// impossible ("connect-gpt" cannot match "^hadex-gpt$").
async function selectTunnelChip(page, scope) {
  const esc = SERVER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp("^\\s*" + esc + "\\s*$", "i");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const candidates = [];
    for (const role of ["radio", "option", "menuitemradio", "tab", "button", "checkbox"]) {
      const items = scope.getByRole(role, { name: exact });
      const n = await items.count();
      for (let i = 0; i < n; i++) candidates.push({ el: items.nth(i), via: role });
    }
    const texts = scope.getByText(exact);
    const textTotal = await texts.count().catch(() => 0);
    for (let i = 0; i < Math.min(textTotal, 6); i++) candidates.push({ el: texts.nth(i), via: "text" });
    for (const c of candidates) {
      if (!(await c.el.count())) continue;
      await scrollCenter(c.el);
      if (!(await c.el.isVisible().catch(() => false))) continue;
      if ((await segmentState(c.el)) === true) return SERVER_NAME + " already selected (" + c.via + " state)";
      await c.el.click({ timeout: 5000 }).catch(() => c.el.click({ force: true, timeout: 2000 }).catch(() => {}));
      await wait(700);
      if ((await segmentState(c.el)) === true) return SERVER_NAME + " selected (verified by state)";
      // The chip text is unique in the dialog, so a successful click of THIS
      // exact element is a safe selection even when the widget exposes no
      // state attribute.
      return SERVER_NAME + " clicked (" + c.via + ")";
    }
    await wait(600);
  }
  await dumpDebug(page, "tunnel-chip-not-found");
  throw new Error('The tunnel "' + SERVER_NAME + '" did not appear in the dialog\'s tunnel list within ten seconds. Make sure the tunnel exists on the OpenAI Tunnels page (Hadex Tunnels Setup creates it), then Retry this step.');
}

async function clearFieldMarks(scope) {
  await scope.evaluate(() => {
    document.querySelectorAll("[data-hadex-field]").forEach(el => el.removeAttribute("data-hadex-field"));
  }).catch(() => {});
}

// The Authentication field is a dropdown with THREE options; "No
// authentication" must be picked. v1.1.1 POLICY (user report fixed): the
// field is ALWAYS clicked open and the option is ALWAYS picked from the
// dropdown. The old fast path ("the text 'No authentication' exists
// somewhere -> already selected") is GONE: ChatGPT's dialog pre-renders its
// hidden dropdown markup, so that check fired WITHOUT a single click and
// the option was never actually set. The step now always performs the real
// interaction, exactly as the user demands:
//   click the Authentication field -> the dropdown opens with its options ->
//   click "No authentication" -> verify the FIELD itself now shows it.
// Read states are never used to skip: even a checked-looking option is
// clicked (harmless for a single-select and closes the popup).
// Same ancestor-walk approach as the Tunnels app: label -> field container
// (marked) -> trigger; the popup is searched on the PAGE because Radix
// portals it to document.body.
async function selectNoAuthentication(page, scope) {
  const optionRe = /no\s+authentication/i;
  const closePopup = async () => {
    if (await popupOpen(page)) { await page.keyboard.press("Escape").catch(() => {}); await wait(400); }
  };
  const popupTexts = async () => {
    const popups = page.locator(POPUP_SEL);
    const n = await popups.count().catch(() => 0);
    const parts = [];
    for (let p = 0; p < n; p++) {
      const t = ((await popups.nth(p).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t.slice(0, 200));
    }
    return parts.join(" | ");
  };
  // Clicks the first visible option spelled "No authentication" inside the
  // open popup. ALWAYS clicks - a read state never skips the click; a second
  // click happens only when the state explicitly reads unchecked afterwards.
  const pickOption = async () => {
    const roles = ["option", "menuitemradio", "menuitemcheckbox", "menuitem"];
    const popups = page.locator(POPUP_SEL);
    const popCount = await popups.count().catch(() => 0);
    for (let p = 0; p < popCount; p++) {
      const popup = popups.nth(p);
      if (!(await popup.isVisible().catch(() => false))) continue;
      for (const role of roles) {
        const opts = popup.getByRole(role, { name: optionRe });
        const on = await opts.count();
        for (let k = 0; k < on; k++) {
          const opt = opts.nth(k);
          if (!(await opt.isVisible().catch(() => false))) continue;
          await scrollCenter(opt);
          try { await opt.click({ timeout: 4000 }); }
          catch { await opt.click({ force: true, timeout: 2000 }).catch(() => {}); }
          await wait(700);
          if ((await readCheckedState(opt)) === false) { // explicitly unchecked: ONE deliberate re-click
            try { await opt.click({ timeout: 3000 }); } catch {}
            await wait(700);
          }
          return true;
        }
      }
      // Text fallback inside the popup (custom widgets without option roles).
      const t = popup.getByText(optionRe).first();
      if (await t.count() && await t.isVisible().catch(() => false)) {
        try { await t.click({ timeout: 4000 }); await wait(700); return true; } catch {}
      }
    }
    return false;
  };

  let lastProblem = "";
  // Two full passes over all candidates: the first click after a re-render
  // can be swallowed, so the whole open -> pick -> verify cycle is repeated.
  for (let round = 0; round < 2; round++) {
    // Candidate anchors: the "Authentication" label (exact, then loose), plus
    // every combobox/popup-trigger/select control in the dialog (the
    // Authentication dropdown is the only combobox here; Connection is a
    // segmented toggle and the tunnel list uses chips).
    const anchors = [];
    const labelPasses = [
      scope.getByText(/^\s*authentication\s*:?\s*$/i), // exact label
      scope.getByText(/\bauthentication\b/i)           // loose match
    ];
    for (const pass of labelPasses) {
      const n = Math.min(await pass.count().catch(() => 0), 8);
      for (let i = 0; i < n; i++) anchors.push(pass.nth(i));
    }
    const ctrls = scope.locator("[role='combobox'], [aria-haspopup='listbox'], select");
    const cn = Math.min(await ctrls.count().catch(() => 0), 8);
    for (let i = 0; i < cn; i++) anchors.push(ctrls.nth(i));

    for (const anchor of anchors) {
      if (!(await anchor.isVisible().catch(() => false))) continue;
      await clearFieldMarks(scope);
      // Mark the field container that owns the Authentication control: walk
      // up from the anchor to the nearest block that holds a control and is
      // field-sized (not the whole dialog).
      const marked = await anchor.evaluate(el => {
        const ctrlSel = "button, [role='combobox'], [aria-haspopup], select";
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          if (a.querySelector && a.querySelector(ctrlSel)) {
            const h = a.getBoundingClientRect().height;
            if (h > 0 && h <= 480) { a.setAttribute("data-hadex-field", "1"); return true; }
            return false; // climbed into a dialog-sized wrapper: not the field
          }
        }
        return false;
      }).catch(() => false);
      if (!marked) continue;
      const field = scope.locator("[data-hadex-field='1']").first();

      // Trigger candidates inside the marked field, in order of likelihood:
      // popup trigger -> combobox -> button -> native select.
      const trigSels = ["[aria-haspopup]", "[role='combobox']", "button", "select"];
      let opened = false;
      for (const sel of trigSels) {
        const list = field.locator(sel);
        const total = await list.count().catch(() => 0);
        for (let i = 0; i < total && !opened; i++) {
          const trig = list.nth(i);
          if (!(await trig.isVisible().catch(() => false))) continue;
          await scrollCenter(trig);
          await closePopup(); // close anything a previous field left open
          try { await trig.click({ timeout: 5000 }); }
          catch { await trig.click({ force: true, timeout: 2000 }).catch(() => {}); }
          await wait(500);
          if (await waitPopup(page, 4000)) { opened = true; break; }
          // Some widgets only react to a click on the field box itself.
          try { await field.click({ timeout: 3000 }); } catch {}
          await wait(500);
          if (await waitPopup(page, 4000)) { opened = true; break; }
        }
      }
      if (!opened) {
        // Last resort for borderless custom widgets: the field box itself.
        await closePopup();
        try { await field.click({ timeout: 3000 }); } catch {}
        await wait(500);
        opened = await waitPopup(page, 4000);
      }
      if (!opened) { lastProblem = "the Authentication control was clicked, but no dropdown opened"; continue; }

      // The dropdown is open: ALWAYS pick "No authentication".
      const picked = await pickOption();
      if (!picked) {
        const seen = await popupTexts();
        await closePopup();
        await clearFieldMarks(scope);
        lastProblem = 'the Authentication dropdown opened, but no "No authentication" option was found in it' + (seen ? ". Popup contains: " + seen : "");
        continue;
      }
      // Verify on the FIELD itself (the only trustworthy proof).
      await wait(500);
      await closePopup();
      await wait(300);
      const fieldText = ((await field.innerText().catch(() => "")) || "").replace(/\s+/g, " ");
      await clearFieldMarks(scope);
      if (optionRe.test(fieldText)) {
        return "No authentication selected (field clicked open, option picked from the dropdown, verified on the field)";
      }
      lastProblem = 'the dropdown was opened and "No authentication" was clicked, but the field still shows: "' + fieldText.slice(0, 120) + '"';
    }
    await wait(800); // let a re-render settle before the second pass
  }

  await closePopup();
  await clearFieldMarks(scope);
  await dumpDebug(page, "authentication-not-selected");
  if (lastProblem && /dropdown opened/i.test(lastProblem)) {
    throw new Error('The Authentication dropdown was opened, but "No authentication" could not be confirmed on the field. ' + lastProblem + ". A debug snapshot was saved to " + DEBUG_DIR + ".");
  }
  if (lastProblem) {
    throw new Error('The Authentication field could not be set to "No authentication": ' + lastProblem + ". A debug snapshot was saved to " + DEBUG_DIR + ".");
  }
  throw new Error("The Authentication field was not found in the Add-custom-MCP-server dialog. Nothing was submitted. A debug snapshot was saved to " + DEBUG_DIR + ".");
}

// The risk warning: a box with the "I understand and want to continue"
// checkbox that MUST be ticked. Verified via aria-checked / isChecked; the
// second click only happens when the state is explicitly still unchecked.
async function tickRiskCheckbox(scope) {
  const nowChecked = async box =>
    (await readCheckedState(box)) === true || (await box.isChecked().catch(() => false));
  const tryClick = async box => {
    await scrollCenter(box);
    try { await box.click({ timeout: 5000 }); return true; }
    catch { try { await box.click({ force: true, timeout: 2000 }); return true; } catch { return false; } }
  };
  const boxes = scope.getByRole("checkbox");
  const n = await boxes.count().catch(() => 0);
  if (n === 1) {
    const box = boxes.first();
    if (await nowChecked(box)) return "already ticked";
    if (await tryClick(box)) {
      await wait(600);
      if (await nowChecked(box)) return "ticked (verified)";
    }
  }
  // Fallback: find the checkbox that belongs to the warning text itself.
  const anchor = scope.getByText(/i understand and want to continue/i).first();
  if (await anchor.count()) {
    const marked = await anchor.evaluate(el => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const ctrl = a.querySelector("input[type='checkbox'], [role='checkbox'], [role='switch']");
        if (ctrl) { ctrl.setAttribute("data-hadex-risk", "1"); return true; }
      }
      return false;
    }).catch(() => false);
    if (marked) {
      const box = scope.locator("[data-hadex-risk='1']").first();
      if (!(await nowChecked(box))) {
        if (!(await tryClick(box))) {
          await clearRiskMark(scope);
          throw new Error('The "I understand and want to continue" checkbox could not be clicked. Nothing was submitted.');
        }
        await wait(600);
      }
      const ok = await nowChecked(box);
      await clearRiskMark(scope);
      if (ok) return "ticked (verified via warning text)";
      return "clicked the warning checkbox (state unreadable)";
    }
  }
  throw new Error('The "I understand and want to continue" checkbox could not be ticked. Nothing was submitted.');
}
async function clearRiskMark(scope) {
  await scope.evaluate(() => {
    document.querySelectorAll("[data-hadex-risk]").forEach(el => el.removeAttribute("data-hadex-risk"));
  }).catch(() => {});
}

// The submit button of the dialog, searched ONLY inside the dialog so the
// page-level "Add" button can never be clicked again by mistake.
async function findServerSubmitButton(scope) {
  const patterns = [/^add$/i, /^add server$/i, /^add custom mcp server$/i, /^save$/i, /^create$/i, /^connect$/i, /^done$/i, /^confirm$/i, /^continue$/i];
  for (const pattern of patterns) {
    const button = scope.getByRole("button", { name: pattern }).last();
    if (await button.count() && await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) return button;
  }
  let hint = "";
  try { hint = ((await scope.innerText()) || "").replace(/\s+/g, " ").slice(0, 300); } catch {}
  throw new Error("Could not identify the final submit button of the Add-custom-MCP-server dialog. Nothing was submitted." + (hint ? " Dialog shows: " + hint : ""));
}

// v1.1.2: the page-level "Add" button, found ROBUSTLY. The old one-shot
// requiredButton(page, ["Add"]) failed two ways the user actually hit:
//   (a) the strict full-string name "Add" misses renames like "+ Add" or
//       an icon button labelled "Add a plugin";
//   (b) there was NO retry - during hydration the page check can pass from
//       hidden HTML (page.content fallback) while the visible button is not
//       mounted yet, so the step threw instantly.
// This search accepts the known variants, polls instead of guessing once,
// and only reports failure after a reload attempt + a debug snapshot.
const ADD_BUTTON_RE = /^\s*(\+\s*)?add(\s+(a\s+)?(new\s+)?(plugin|server|mcp(\s+server)?|tool))?\s*$/i;
async function findAddButton(page) {
  // a) semantic roles with a flexible accessible name (getByRole ignores
  //    hidden pre-rendered markup on its own)
  for (const role of ["button", "link"]) {
    const items = page.getByRole(role, { name: ADD_BUTTON_RE });
    const n = await items.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = items.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if (!(await el.isEnabled().catch(() => false))) continue;
      return el;
    }
  }
  // b) custom widgets: clickable elements whose own text is exactly an
  //    "Add"-variant (innerText re-check keeps the hasText filter honest)
  const byText = page.locator("button, [role='button'], a").filter({ hasText: ADD_BUTTON_RE });
  const tn = await byText.count().catch(() => 0);
  for (let i = 0; i < Math.min(tn, 6); i++) {
    const el = byText.nth(i);
    const t = ((await el.innerText().catch(() => "")) || "").trim();
    if (!ADD_BUTTON_RE.test(t)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (!(await el.isEnabled().catch(() => false))) continue;
    return el;
  }
  return null;
}
// True when a REAL Add menu is open: a visible popup that carries the known
// entries (or menu items at all) - not just any stray popper/tooltip.
async function addMenuVisible(page) {
  const popups = page.locator(POPUP_SEL);
  const n = await popups.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 6); i++) {
    const popup = popups.nth(i);
    if (!(await popup.isVisible().catch(() => false))) continue;
    const t = (await popup.innerText().catch(() => "")) || "";
    if (/add\s+custom\s+mcp\s+server|create\s+plugin|upload\s+plugin/i.test(t)) return true;
    if ((await popup.getByRole("menuitem").count().catch(() => 0)) > 0) return true;
  }
  return false;
}

// The main v1.1.0 phase: Add -> Add custom MCP server -> fill the dialog ->
// submit -> verify. ALWAYS runs the full flow (even if the server already
// exists). Returns { created, alreadyExists?, name, confirmed? }.
async function addCustomMcpServer(page) {
  await log("Add-custom-MCP-server phase started (Add -> Add custom MCP server).");

  // ---- 0. v1.1.0: start clean and ALWAYS perform the full flow. The old
  //         "already exists -> skip" pre-check is gone: it misread the page
  //         and skipped real work, and the steps must repeat anyway.
  await resetToAddState(page);
  await log('Performing the FULL Add-custom-MCP-server flow (always, even if "' + SERVER_NAME + '" already exists).');

  // ---- 1. Click the page-level "Add" button (v1.1.2: robust + retried).
  const pollForAddButton = async (timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const btn = await findAddButton(page);
      if (btn) return btn;
      await wait(900);
    }
    return null;
  };
  let addBtn = await pollForAddButton(12000);
  if (!addBtn) {
    // The visible UI may still be hydrating (the page check can pass from
    // hidden HTML): re-load the Plugins page once, then keep polling.
    await log('No "Add" button visible yet; re-loading the Plugins page once.');
    await page.goto(TARGET_PAGE, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await wait(2500);
    if (loginRequired(page)) {
      throw new Error("The ChatGPT sign-in ended while reopening the Plugins page. Run Hadex again and complete the sign-in, then Retry this step.");
    }
    addBtn = await pollForAddButton(18000);
  }
  if (!addBtn) {
    await dumpDebug(page, "add-button-not-found");
    throw new Error('The "Add" button was not found on the Plugins page (searched for over thirty seconds, including one reload). A debug snapshot was saved to ' + DEBUG_DIR + " - if ChatGPT redesigned the page, send that snapshot so the search can be updated.");
  }
  // Click until the dropdown with its entries is REALLY open (a click can be
  // swallowed by a re-render; the button is re-found each attempt).
  const clickEnd = Date.now() + 20000;
  let opened = false, clickedAtLeastOnce = false;
  while (Date.now() < clickEnd && !opened) {
    const btn = (await findAddButton(page)) || addBtn;
    await scrollCenter(btn);
    try { await btn.click({ timeout: 5000 }); clickedAtLeastOnce = true; }
    catch { await btn.click({ force: true, timeout: 2000 }).catch(() => {}); }
    await wait(700);
    if (await addMenuVisible(page)) { opened = true; break; }
    await wait(600);
  }
  if (!opened) {
    await dumpDebug(page, "add-menu-not-open");
    throw new Error((clickedAtLeastOnce
      ? 'The "Add" button was clicked, but its dropdown did not open.'
      : 'The "Add" button could not be clicked.') + " A debug snapshot was saved to " + DEBUG_DIR + ". Nothing was changed.");
  }

  // ---- 2. Click "Add custom MCP server" in the opened dropdown.
  if (!(await waitPopup(page, 6000))) {
    await dumpDebug(page, "add-menu-not-open");
    throw new Error("The Add dropdown did not open after clicking the Add button. Nothing was changed.");
  }
  const itemRe = /add custom mcp server/i;
  const roles = ["menuitem", "menuitemradio", "menuitemcheckbox", "option", "button"];
  const popups = page.locator(POPUP_SEL);
  const popCount = await popups.count().catch(() => 0);
  let itemClicked = false;
  for (let p = 0; p < popCount && !itemClicked; p++) {
    const popup = popups.nth(p);
    if (!(await popup.isVisible().catch(() => false))) continue;
    for (const role of roles) {
      const items = popup.getByRole(role, { name: itemRe });
      const n = await items.count();
      for (let i = 0; i < n && !itemClicked; i++) {
        const it = items.nth(i);
        await scrollCenter(it);
        try { await it.click({ timeout: 4000 }); itemClicked = true; }
        catch { try { await it.click({ force: true, timeout: 2000 }); itemClicked = true; } catch {} }
      }
    }
    if (!itemClicked) {
      const t = popup.getByText(itemRe).last();
      if (await t.count() && await t.isVisible().catch(() => false)) {
        try { await t.click({ timeout: 4000 }); itemClicked = true; } catch {}
      }
    }
  }
  if (!itemClicked) {
    if (await popupOpen(page)) { await page.keyboard.press("Escape").catch(() => {}); await wait(400); }
    await dumpDebug(page, "add-custom-mcp-item-not-found");
    throw new Error('The "Add custom MCP server" entry was not found in the Add dropdown. The menu was searched for that exact entry (nothing else was clicked).');
  }

  // ---- 3. Wait for the dialog to really open (role=dialog, or the Name
  //         field for modals that do not expose the dialog role).
  const dialog = page.getByRole("dialog").first();
  await untilAvailable(async () => {
    if ((await dialog.count()) && (await dialog.isVisible().catch(() => false))) return true;
    if (await page.getByRole("textbox", { name: /^name\b/i }).first().isVisible().catch(() => false)) return true;
    throw new Error("dialog not open yet");
  }, "the Add-custom-MCP-server dialog", 15000);
  const scope = (await dialog.count() && await dialog.isVisible().catch(() => false)) ? dialog : page;
  await log("Add-custom-MCP-server dialog is open.");

  // ---- 4. Name (verified) + Description (best effort).
  const nameNote = await fillServerName(scope);
  const descNote = await fillServerDescription(scope);
  await log("Dialog: " + nameNote + "; " + descNote + ".");

  // ---- 5. Connection = Tunnel, then pick the "hadex-gpt" tunnel.
  const connNote = await clickConnectionTunnel(scope);
  await log("Dialog: " + connNote + ".");
  const chipNote = await selectTunnelChip(page, scope);
  await log("Dialog: " + chipNote + ".");

  // ---- 6. Authentication = No authentication.
  const authNote = await selectNoAuthentication(page, scope);
  await log("Dialog: " + authNote + ".");

  // ---- 7. Tick the risk-warning checkbox.
  const riskNote = await tickRiskCheckbox(scope);
  await log("Dialog: " + riskNote + ".");

  // ---- 8. Submit inside the dialog only.
  let submit = null;
  try {
    submit = await findServerSubmitButton(scope);
  } catch (e) {
    // The submit can be disabled by an inline validation error. If ChatGPT
    // itself says the name is taken, the full flow WAS performed and the
    // server's existence is now confirmed by ChatGPT - not by our guessing.
    const dialogText = (await scope.innerText().catch(() => "")) || "";
    if (alreadyExistsText(dialogText)) {
      await dumpDebug(page, "mcp-already-exists");
      await log('ChatGPT rejected the name: a server called "' + SERVER_NAME + '" already exists (reported after the full flow).');
      return { created: false, alreadyExists: true, name: SERVER_NAME };
    }
    throw e;
  }
  await submit.click({ timeout: 6000 }).catch(() => submit.click({ force: true, timeout: 2500 }).catch(() => {}));
  await log("Dialog submitted; waiting for ChatGPT to add the server...");

  // ---- 9. The dialog must close; surface ChatGPT's error message if shown.
  const deadline = Date.now() + 30000;
  let closed = false;
  while (Date.now() < deadline) {
    const stillOpen = (await dialog.count()) && (await dialog.isVisible().catch(() => false));
    if (!stillOpen) { closed = true; break; }
    // ChatGPT's own duplicate-name rejection (dialog first, then the page):
    // the full flow was performed, so this is a verified "already exists".
    const dialogText = (await dialog.innerText().catch(() => "")) || "";
    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    if (alreadyExistsText(dialogText) || alreadyExistsText(body)) {
      await dumpDebug(page, "mcp-already-exists");
      await log('ChatGPT says a server named "' + SERVER_NAME + '" already exists (reported after the full flow).');
      return { created: false, alreadyExists: true, name: SERVER_NAME };
    }
    const err = body.match(/(failed to|could not|unable to|something went wrong)[^\n]{0,180}/i);
    if (err) {
      await dumpDebug(page, "mcp-add-error");
      throw new Error("ChatGPT rejected adding the server: " + err[0].trim());
    }
    await wait(700);
  }
  if (!closed) {
    const stuckText = (await dialog.innerText().catch(() => "")) || "";
    if (alreadyExistsText(stuckText)) {
      await dumpDebug(page, "mcp-already-exists");
      await log('ChatGPT says a server named "' + SERVER_NAME + '" already exists (reported after the full flow).');
      return { created: false, alreadyExists: true, name: SERVER_NAME };
    }
    await dumpDebug(page, "mcp-dialog-stuck");
    throw new Error("The Add-custom-MCP-server dialog did not close after submitting. Nothing else was changed - check the Chrome window and Retry this step.");
  }

  // ---- 10. Best-effort confirmation that the server is now listed (the
  //          Personal tab is opened too, where custom MCP servers live).
  await wait(1500);
  const confirmed = await confirmServerListed(page);
  await log(confirmed
    ? 'Server "' + SERVER_NAME + '" is now visible on the Plugins page.'
    : 'Dialog closed without an error, but "' + SERVER_NAME + '" was not found on the page yet (it may sit under the Personal tab).');
  return { created: true, name: SERVER_NAME, confirmed };
}
// ═══════════════════ END HADEX v1.1.0: ADD-CUSTOM-MCP-SERVER PHASE ═══════════════════

export {
  TARGET_PAGE, PROFILE_DIR, DATA_DIR, LOG_FILE, DEBUG_DIR,
  wait, log, loginRequired, closeStaleProfileBrowsers, hideAutomationFlags,
  launch, navigate, visibleLogin, requiredButton,
  pageSignals, waitForPageReady, untilAvailable, dumpDebug,
  checkPluginsPage, addCustomMcpServer,
  ALREADY_EXISTS_RE, alreadyExistsText, confirmServerListed, resetToAddState,
  SERVER_NAME, SERVER_DESC
};