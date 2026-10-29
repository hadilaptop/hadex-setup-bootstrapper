// core.js — Hadex Tunnels Setup automation engine (shared by console + wizard).
// Continuation of Hadex GPT Key Creator: same logic, same dedicated browser
// profile (so the OpenAI sign-in from the Key Creator is reused), now driving
// the organization Tunnels settings page.
// No side effects here: importing this module never starts a browser.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// v1.0.0 target: the organization Tunnels settings page.
const TARGET_PAGE = "https://platform.openai.com/settings/organization/tunnels";
const KEY_NAME = "Hadex gpt";
// Hadex keeps ONE shared Chrome profile for both apps. Reusing the Key
// Creator's profile means the OpenAI sign-in is already stored here - no
// second login. The two apps must not run at the same time (one profile
// lock); this app closes stale windows holding the profile automatically.
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Hadex", "GPTKeyCreator", "chrome-profile");
// This app keeps its OWN log/debug folder, separate from the Key Creator's.
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Hadex", "TunnelsSetup");
const LOG_FILE = path.join(DATA_DIR, "setup.log");
const DEBUG_DIR = path.join(DATA_DIR, "debug");
// Read-only reference to the key file produced by Hadex GPT Key Creator
// (v1.5.0 saves it to E:\hadex\Hadex gpt2). The Tunnels app only READS it to
// show its status; it never modifies or displays the full key.
const SAVED_KEY_DIR = process.env.HADEX_KEY_DIR
  ? path.resolve(process.env.HADEX_KEY_DIR)
  : "E:\\hadex\\Hadex gpt2";
const SAVED_KEY_FILE = path.join(SAVED_KEY_DIR, "CONTROL_PLANE_API_KEY.txt");
// Kept from the Key Creator engine for the upcoming automation phases on the
// Tunnels page (forms/dropdowns there will be driven the same way).
const MANUAL_CREATE_WAIT_MS = 15 * 60 * 1000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const OPENAI_HOST = /^https:\/\/(platform|auth)\.openai\.com\//i;

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
// so the user's normal Chrome/Edge windows are never touched. This is what fixes
// the "about:blank + black window" symptom when a previous Hadex window (or a
// double-started run.bat) still owns the profile: Chrome hands the new start
// over to the old instance, Playwright never attaches, and the tab stays blank.
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
  await log("Opening target URL: " + TARGET_PAGE);
  const page = await context.newPage();
  for (const other of context.pages()) {
    if (other !== page && !other.isClosed() && other.url() === "about:blank") {
      await other.close().catch(() => {});
    }
  }
  await page.bringToFront().catch(() => {});

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // "commit" resolves as soon as navigation is accepted; the final URL is then
      // polled, because the platform -> auth.openai.com -> platform redirect chain can
      // leave the tab reporting about:blank while domcontentloaded is still pending.
      await page.goto(TARGET_PAGE, { waitUntil: "commit", timeout: 90000 });
      lastError = null;
    } catch (error) {
      lastError = error;
      await log(`Navigation attempt ${attempt} threw: ${error.message}`);
    }
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (OPENAI_HOST.test(page.url())) break;
      if (page.isClosed()) break;
      await wait(500);
    }
    const url = page.url();
    if (OPENAI_HOST.test(url)) {
      await wait(1500);
      await page.bringToFront().catch(() => {});
      await log("Target navigation completed. Current URL: " + page.url());
      return page;
    }
    await log(`Attempt ${attempt} ended at URL: ${url}`);
    if (page.isClosed()) break;
    await wait(2000);
  }
  const finalUrl = page.isClosed() ? "(tab closed)" : page.url();
  if (/^about:blank/i.test(finalUrl)) {
    throw new Error(
      "Chrome opened but stayed on about:blank. This means Playwright could not attach to the browser it started. " +
      "Most common causes: (1) another Hadex browser window was still open - close every window whose title or taskbar icon belongs to Hadex and run again; " +
      "(2) the Hadex profile is locked - restart Windows once and run again. " +
      "If it still fails, delete the folder %LOCALAPPDATA%\\Hadex\\GPTKeyCreator\\chrome-profile and run again."
    );
  }
  throw new Error("Chrome opened, but navigation did not reach the OpenAI Tunnels settings page. Current URL: " + finalUrl +
    (lastError ? " | last error: " + lastError.message : ""));
}
async function visibleLogin(page) {
  if (loginRequired(page)) return true;
  const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 2500);
  return /sign in to openai|log in to openai|continue with google|enter your email/i.test(text);
}
async function requiredButton(scope, names, description) {
  for (const name of names) {
    const item = scope.getByRole("button", { name }).first();
    if (await item.count() && await item.isVisible().catch(() => false)) return item;
  }
  throw new Error(`Could not identify ${description}. The app stopped without guessing.`);
}
// The create-key dialog is scrollable: Expiration, the three permission
// choices and the Tunnels row can sit below the fold. Playwright clicks
// auto-scroll, but custom dropdown widgets and visibility checks need the
// element brought into view first - this helper does that without throwing.
async function scrollIntoView(loc) {
  try { await loc.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
}
// True when a dropdown popup (menu/listbox) is currently open on the page.
const POPUP_SEL = "[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [data-radix-menu-content], [data-radix-dropdown-menu-content], [data-radix-select-content]";
async function popupOpen(scope) {
  return (await scope.locator(POPUP_SEL).count().catch(() => 0)) > 0;
}
// Scroll an element to the MIDDLE of the view. scrollIntoViewIfNeeded uses
// "nearest", which can leave the Tunnels row hidden behind the dialog's
// sticky footer; a centered scroll keeps the control away from overlays that
// would steal the click.
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
async function fillName(scope) {
  // The Name field is the first text input of the create-key dialog. Every
  // candidate is verified by reading the value back after filling.
  const dialog = scope.getByRole("dialog").first();
  const choices = [];
  if (await dialog.count()) {
    choices.push(
      dialog.getByRole("textbox", { name: /^name\b/i }).first(),
      dialog.getByLabel(/^name$/i).first(),
      dialog.locator('input[type="text"]:visible').first(),
      dialog.locator('input[name="name"]:visible').first()
    );
  }
  choices.push(
    scope.getByRole("textbox", { name: /^name\b/i }).first(),
    scope.getByLabel(/^name$/i).first(),
    scope.getByPlaceholder(/name/i).first(),
    scope.locator('input[name="name"]:visible').first()
  );
  for (const field of choices) {
    if (!(await field.count())) continue;
    if (!(await field.isVisible().catch(() => false))) continue;
    try {
      await field.fill(KEY_NAME, { timeout: 8000 });
      const value = (await field.inputValue().catch(() => "")).trim();
      if (value === KEY_NAME) return "value verified";
    } catch {}
  }
  throw new Error("Could not find the key name field.");
}
async function selectNever(scope) {
  const neverRe = /^(never|no expiration|does not expire)\b/i;
  // 1. A plain, VISIBLE <select> that offers Never. Hidden helper selects
  // (Radix/sr-only) are deliberately skipped: selecting them succeeds but
  // nothing changes on screen - exactly the silent no-op this version fixes.
  const selects = scope.locator("select");
  const total = await selects.count();
  for (let i = 0; i < total; i++) {
    const select = selects.nth(i);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator("option").allTextContents().catch(() => []);
    const never = options.find(x => neverRe.test(x.trim()));
    if (never) { await select.selectOption({ label: never }); return "via visible select"; }
  }
  // 2. Custom dropdown (Expiration is a LIST, not a text field): find the
  // Expiration label, walk up to the row that holds the trigger, open it,
  // scroll the option list, click "Never", verify the trigger text.
  const labels = scope.getByText(/^\s*expiration\b/i);
  const labelTotal = await labels.count();
  let label = null;
  for (let i = 0; i < labelTotal; i++) {
    const cand = labels.nth(i);
    if (await cand.isVisible().catch(() => false)) { label = cand; break; }
  }
  if (!label) throw new Error("Expiration control was not found.");
  const container = label.locator("xpath=ancestor::*[.//button or .//*[@role='combobox']][1]").first();
  let control = container.getByRole("combobox").first();
  if (!(await control.count()) || !(await control.isVisible().catch(() => false))) {
    control = container.getByRole("button").last();
  }
  if (!(await control.count()) || !(await control.isVisible().catch(() => false))) {
    throw new Error("The Expiration dropdown trigger was not found.");
  }
  await scrollIntoView(control);
  const before = (await control.innerText().catch(() => "")).trim();
  if (/never/i.test(before)) return "already: " + before;
  if (await popupOpen(scope)) { await scope.keyboard.press("Escape").catch(() => {}); await wait(400); }
  await control.click({ timeout: 5000 }).catch(() => control.click({ force: true, timeout: 2000 }).catch(() => {}));
  await wait(900);
  // 3. Search EVERY open popup (menu/listbox/Radix portal). "Never" usually
  // sits below the fold of the scrolled list, so each candidate is scrolled
  // into view before the click instead of being skipped as "invisible".
  const roles = ["option", "menuitemradio", "menuitemcheckbox", "menuitem"];
  const popups = scope.locator("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]");
  const popCount = await popups.count().catch(() => 0);
  const clickOpt = async opt => {
    try { await opt.click({ timeout: 4000 }); return true; }
    catch { try { await opt.click({ force: true, timeout: 2000 }); return true; } catch { return false; } }
  };
  let clicked = false;
  for (let p = 0; p < popCount && !clicked; p++) {
    for (const role of roles) {
      const opts = popups.nth(p).getByRole(role, { name: neverRe });
      const n = await opts.count();
      for (let i = 0; i < n && !clicked; i++) {
        const opt = opts.nth(i);
        await scrollIntoView(opt);
        clicked = await clickOpt(opt);
      }
    }
  }
  for (let p = 0; p < popCount && !clicked; p++) {
    const opt = popups.nth(p).getByText(neverRe).last();
    if (await opt.count()) {
      await scrollIntoView(opt);
      clicked = await clickOpt(opt);
    }
  }
  // 4. Keyboard type-ahead fallback: type "n" to jump the highlight to "Never",
  // then confirm with Enter ONLY if the highlighted item really is Never -
  // never a blind Enter, that could pick "1 day" by mistake.
  if (!clicked && popCount) {
    await scope.keyboard.type("n", { delay: 80 }).catch(() => {});
    await wait(400);
    const hi = scope.locator("[data-highlighted]").first();
    if (await hi.count()) {
      const t = (await hi.innerText().catch(() => "")).trim();
      if (neverRe.test(t)) {
        await scope.keyboard.press("Enter").catch(() => {});
        clicked = true;
      }
    }
  }
  await wait(600);
  if (await popupOpen(scope)) { await scope.keyboard.press("Escape").catch(() => {}); }
  await wait(400);
  const after = (await control.innerText().catch(() => "")).trim();
  if (/never/i.test(after)) return "trigger now shows: " + after;
  throw new Error('The "Never" expiration could not be selected (trigger shows: ' + (after || "?") + ").");
}
async function selectRestricted(scope) {
  // The Permissions section offers exactly THREE choices (Read only /
  // Restricted / All) and "Restricted" is the middle one. The section sits
  // further down in the scrollable dialog, so every candidate is scrolled
  // into view first.
  const restrictedRe = /^restricted\b/i;
  const readChecked = async el => {
    const aria = await el.getAttribute("aria-checked").catch(() => null);
    const pressed = await el.getAttribute("aria-pressed").catch(() => null);
    const state = await el.getAttribute("data-state").catch(() => null);
    return aria === "true" || pressed === "true" || state === "checked";
  };
  const candidates = [];
  for (const role of ["radio", "menuitemradio", "tab", "button", "combobox", "switch"]) {
    const items = scope.getByRole(role, { name: restrictedRe });
    const n = await items.count();
    for (let i = 0; i < n; i++) candidates.push({ el: items.nth(i), via: role });
  }
  const texts = scope.getByText(restrictedRe);
  const textTotal = await texts.count();
  for (let i = 0; i < Math.min(textTotal, 5); i++) candidates.push({ el: texts.nth(i), via: "text" });

  for (const c of candidates) {
    if (!(await c.el.count())) continue;
    await scrollIntoView(c.el);
    if (!(await c.el.isVisible().catch(() => false))) continue;
    if (await readChecked(c.el)) return c.via + " (already selected)";
    await c.el.click({ timeout: 5000 }).catch(() => c.el.click({ force: true, timeout: 2000 }).catch(() => {}));
    await wait(800);
    if (await readChecked(c.el)) return c.via + " clicked (verified)";
    // No state attribute to read? Accept when the per-resource permission
    // rows (Prompts / Batch / Tunnels / ...) appeared - that panel only shows
    // up once "Restricted" is actually selected.
    const rowsVisible = await scope.getByText(/^\s*tunnels?\b/i).count().catch(() => 0);
    if (rowsVisible) return c.via + " clicked (permission rows visible)";
  }
  // Group fallback: find a choice group with exactly three options and click
  // the middle one, but only when the middle option really is "Restricted".
  const groups = scope.locator("[role='radiogroup'], [role='listbox'], [role='tablist']");
  const groupTotal = await groups.count();
  for (let g = 0; g < groupTotal; g++) {
    const items = groups.nth(g).locator("[role='radio'], [role='option'], [role='tab'], button, label");
    const n = await items.count();
    if (n !== 3) continue;
    const middle = items.nth(1);
    await scrollIntoView(middle);
    if (!(await middle.isVisible().catch(() => false))) continue;
    const midText = (await middle.innerText().catch(() => "")).trim();
    if (!/restricted/i.test(midText)) continue;
    await middle.click({ timeout: 5000 }).catch(() => middle.click({ force: true, timeout: 2000 }).catch(() => {}));
    await wait(800);
    if (await readChecked(middle)) return "middle of three clicked (verified)";
    return "middle of three clicked (" + midText.slice(0, 40) + ")";
  }
  throw new Error("Restricted permission option was not found (the middle choice of the three permission options was looked for too).");
}
// The permission panel is a list of rows (Prompts, Batch, Tunnels, Datasets, ...).
// Each row has a dropdown trigger showing its current value ("None", "All selected")
// that opens a menu with checkable options (for Tunnels: "Read" and "Use").
// v1.4.2 assumed the row was a tr/li/[role=row] or a div that also contains a
// <button>; the real rows matched none of those shapes reliably, so the step
// failed with "Could not locate the Tunnels permission row" even though the
// row was clearly on screen. The strategy now (v1.4.3):
//   1. find the label TEXT itself (exact "Tunnels" first, then a loose match)
//   2. walk UP from the text to the nearest ancestor that contains a control
//      (button / combobox / aria-haspopup) - that ancestor is the row; it is
//      tagged with data-hadex-row so Playwright can address it afterwards
//   3. if the label is not in the DOM yet (the panel renders after Restricted
//      is picked, and long lists can be virtualised), scroll the dialog's
//      scrollable containers and search again, for up to ten seconds
async function clearRowMarks(scope) {
  await scope.evaluate(() => {
    document.querySelectorAll("[data-hadex-row]").forEach(el => el.removeAttribute("data-hadex-row"));
  }).catch(() => {});
}
async function findPermissionRow(scope, name) {
  const re = new RegExp("\\b" + name + "\\b", "i");
  const deadline = Date.now() + 8000;
  let sawText = false;
  while (Date.now() < deadline) {
    await clearRowMarks(scope);
    const passes = [
      scope.getByText(new RegExp("^\\s*" + name + "\\s*$", "i")), // exact label
      scope.getByText(re)                                          // loose match
    ];
    for (const pass of passes) {
      const n = Math.min(await pass.count().catch(() => 0), 8);
      for (let i = 0; i < n; i++) {
        const anchor = pass.nth(i);
        sawText = true;
        if (!(await anchor.isVisible().catch(() => false))) continue;
        // Walk up from the label to the closest ancestor that holds a control
        // (the row's dropdown trigger). The first hit is the smallest one,
        // because ancestor boxes only get bigger as we climb.
        const marked = await anchor.evaluate(el => {
          const ctrlSel = "button, [role='combobox'], [aria-haspopup]";
          for (let a = el; a && a !== document.body; a = a.parentElement) {
            if (a.querySelector && a.querySelector(ctrlSel)) {
              const h = a.getBoundingClientRect().height;
              if (h > 0 && h <= 320) { a.setAttribute("data-hadex-row", "1"); return true; }
              return false; // climbed into a dialog-sized wrapper: not a row
            }
          }
          return false;
        }).catch(() => false);
        if (!marked) continue;
        const row = scope.locator("[data-hadex-row='1']").first();
        const t = ((await row.innerText().catch(() => "")) || "").trim();
        if (re.test(t) && t.length <= 1200) return row;
      }
    }
    // Label not rendered (yet): scroll every scrollable container inside the
    // dialog - and the page itself when there is no dialog - then search again.
    const dlg = scope.getByRole("dialog").first();
    if (await dlg.count()) {
      await dlg.evaluate(el => {
        const tryScroll = node => {
          const s = getComputedStyle(node);
          if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
              node.scrollHeight > node.clientHeight + 60 && node.clientHeight > 120) {
            node.scrollTop += Math.max(240, node.clientHeight * 0.7);
          }
        };
        tryScroll(el);
        el.querySelectorAll("*").forEach(tryScroll);
      }).catch(() => {});
    } else {
      await scope.mouse.wheel(0, 350).catch(() => {});
    }
    await wait(350);
  }
  await clearRowMarks(scope);
  throw new Error("Could not locate the " + name + " permission row" +
    (sawText
      ? " (a '" + name + "' label exists but no row dropdown trigger could be verified next to it)."
      : " (the panel was scrolled and searched for ten seconds; the label never rendered).") +
    " Check that Permissions = Restricted is selected so the per-resource rows are visible.");
}
async function findRowDropdown(scope, row) {
  // Strongest signal first: an explicit aria-haspopup trigger (the arrow).
  const haspopup = row.locator("[aria-haspopup]");
  const hn = await haspopup.count();
  for (let i = hn - 1; i >= 0; i--) {
    const b = haspopup.nth(i);
    if (await b.isVisible().catch(() => false)) return b;
  }
  const buttons = row.getByRole("button");
  const total = await buttons.count();
  for (let i = total - 1; i >= 0; i--) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const t = (await b.innerText().catch(() => "")).trim();
    if (/none|all selected|selected|custom|partial|read|use|edit|write/i.test(t)) return b;
  }
  if (total > 0) return buttons.nth(total - 1);
  const combo = row.getByRole("combobox").first();
  if (await combo.count()) return combo;
  // Last resort: the trigger is a plain element that just shows the current
  // value ("None") without any button/combobox role. Clicking the text itself
  // opens the dropdown in these widgets too.
  const value = row.getByText(/^(none|all selected|custom|partial|read|use|\d+\s+selected)$/i).last();
  if (await value.count() && await value.isVisible().catch(() => false)) return value;
  throw new Error("Could not find the Tunnels dropdown control in its row.");
}
// Reads an option's checked state WITHOUT guessing:
//   true  -> explicitly checked (aria-checked / data-state / real input)
//   false -> explicitly UNCHECKED (safe to click)
//   null  -> unreadable. Clicking again on "null" is a coin flip that can
//            toggle a freshly-applied tick back OFF - that was exactly the
//            v1.4.3 bug ("selects Read, selects Use, then unselects"). When
//            the state is unreadable the row trigger text decides instead.
async function readCheckedState(item) {
  const aria = await item.getAttribute("aria-checked").catch(() => null);
  const state = await item.getAttribute("data-state").catch(() => null);
  if (aria === "true" || state === "checked") return true;
  if (aria === "false" || state === "unchecked") return false;
  try { if (await item.isChecked()) return true; } catch {}
  return null;
}
// Finds the option spelled EXACTLY like this word inside an OPEN popup (the
// Tunnels menu). "Read only" and friends can never match, and anything
// outside the popup is never clicked - an earlier fallback searched the whole
// page and could hit the "Read only" permission card, silently unselecting
// Restricted. That must never happen again.
async function findExactMenuOption(popup, word) {
  const exact = new RegExp("^\\s*" + word + "\\s*[.!]?$", "i");
  const loose = new RegExp("\\b" + word + "\\b", "i"); // safe: inside the popup only
  const norm = t => String(t || "").replace(/\s+/g, " ").trim();
  const roles = ["menuitemcheckbox", "menuitemradio", "option", "menuitem", "checkbox", "radio"];
  for (const re of [exact, loose]) {
    for (const role of roles) {
      const items = popup.getByRole(role);
      const n = await items.count();
      for (let i = 0; i < n; i++) {
        const item = items.nth(i);
        if (re.test(norm(await item.innerText().catch(() => "")))) return item;
      }
    }
    const generic = popup.locator("*").filter({ hasText: re }).last();
    if (await generic.count() && re.test(norm(await generic.innerText().catch(() => "")))) return generic;
  }
  // Real <input type="checkbox"> elements with a label inside the popup.
  const boxes = popup.locator("input[type='checkbox']");
  const bn = await boxes.count();
  for (let i = 0; i < bn; i++) {
    const box = boxes.nth(i);
    let t = (await box.getAttribute("aria-label").catch(() => null)) || "";
    if (!t) t = (await box.locator("xpath=ancestor::label[1]").innerText().catch(() => "")) || "";
    if (!t) t = (await box.locator("xpath=..").innerText().catch(() => "")) || "";
    if (exact.test(norm(t))) return box;
  }
  return null;
}
async function checkMenuOption(scope, name) {
  const popups = scope.locator(POPUP_SEL);
  const popCount = await popups.count().catch(() => 0);
  for (let p = 0; p < popCount; p++) {
    const popup = popups.nth(p);
    if (!(await popup.isVisible().catch(() => false))) continue;
    const item = await findExactMenuOption(popup, name);
    if (!item) continue;
    await scrollCenter(item);
    if ((await readCheckedState(item)) === true) return "already checked";
    try { await item.click({ timeout: 4000 }); }
    catch { await item.click({ force: true, timeout: 2000 }).catch(() => {}); }
    // Poll instead of a single read: the checked attribute can land slightly
    // after the click, and one early "false" used to trigger a second click
    // that toggled the tick back OFF.
    for (let i = 0; i < 4; i++) {
      await wait(300);
      if ((await readCheckedState(item)) === true) return "checked (verified)";
    }
    // ONE deliberate re-click, only when the option explicitly reports
    // "unchecked". An unreadable state (null) never triggers a re-click.
    if ((await readCheckedState(item)) === false) {
      try { await item.click({ timeout: 3000 }); } catch {}
      for (let i = 0; i < 4; i++) {
        await wait(300);
        if ((await readCheckedState(item)) === true) return "checked (verified on retry)";
      }
    }
    return "clicked (row text decides)";
  }
  // Diagnostics for the error message: what does the open menu actually show?
  let menuText = "";
  for (let p = 0; p < popCount; p++) {
    const t = ((await popups.nth(p).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (t) menuText = (menuText ? menuText + " | " : "") + t.slice(0, 160);
  }
  throw new Error('The "' + name + '" option was not found in the Tunnels dropdown menu.' +
    (menuText ? " Menu contains: " + menuText : " No open dropdown menu was detected."));
}
async function setTunnelsPermissions(scope) {
  let row = await findPermissionRow(scope, "Tunnels");
  await scrollCenter(row); // Tunnels sits low in the dialog; center it so no
  // sticky footer/overlay can steal the click.
  // React may re-render the panel between locating and clicking (the marked
  // row element gets replaced); re-find it once in that case.
  if (!(await row.count())) row = await findPermissionRow(scope, "Tunnels");
  // The row trigger text is the ground truth the user sees:
  //   "None" -> nothing yet, "Read" -> only Read ticked, "All selected" -> done.
  const rowText = async () => {
    if (!(await row.count())) return "";
    return ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  };
  const progress = async () => {
    const t = await rowText();
    if (/all selected/i.test(t) || (/\bread\b/i.test(t) && /\buse\b/i.test(t))) return "all";
    if (/\bread\b/i.test(t)) return "read";
    if (/\buse\b/i.test(t)) return "use";
    return "none";
  };
  if ((await progress()) === "all") {
    await log("Tunnels permissions already: Read + Use selected.");
    return "already: all selected";
  }
  // Close any popup left open by a previous attempt before starting.
  if (await popupOpen(scope)) { await scope.keyboard.press("Escape").catch(() => {}); await wait(400); }
  const openMenu = async attempt => {
    try {
      if (await waitPopup(scope, 700)) return true; // already open
      // Re-find the row/trigger each time: React may have re-rendered them.
      if (!(await row.count())) row = await findPermissionRow(scope, "Tunnels");
      const trig = await findRowDropdown(scope, row);
      await scrollCenter(trig);
      try { await trig.click({ timeout: 5000 }); }
      catch { await trig.click({ force: true, timeout: 2000 }).catch(() => {}); }
      if (await waitPopup(scope, 4000)) return true;
      // Keyboard fallback: focus the arrow and open with the keyboard.
      try { await trig.focus(); await scope.keyboard.press("ArrowDown"); } catch {}
      return await waitPopup(scope, 2500);
    } catch { return false; }
  };
  // Tick ONE missing option inside the already-open menu - exactly one click,
  // and never when the item itself reports being checked already.
  const tickOnce = async name => {
    const popups = scope.locator(POPUP_SEL);
    const popCount = await popups.count().catch(() => 0);
    for (let p = 0; p < popCount; p++) {
      const popup = popups.nth(p);
      if (!(await popup.isVisible().catch(() => false))) continue;
      const item = await findExactMenuOption(popup, name);
      if (!item) continue;
      await scrollCenter(item);
      if ((await readCheckedState(item)) === true) return "already checked";
      try { await item.click({ timeout: 4000 }); }
      catch { await item.click({ force: true, timeout: 2000 }).catch(() => {}); }
      await wait(700); // let the widget commit the tick (and close, if it does)
      return "clicked";
    }
    return "option not found in menu";
  };
  // Reconcile in rounds: read the trigger, tick ONLY the options that are
  // still missing (ONE click per option per round), close the menu, re-read
  // the trigger. A selection the trigger already confirms is NEVER clicked
  // again, so the ticks can no longer be toggled back off.
  let lastMenu = "";
  for (let round = 1; round <= 3; round++) {
    const before = await progress();
    if (before === "all") {
      if (await popupOpen(scope)) { await scope.keyboard.press("Escape").catch(() => {}); await wait(300); }
      await log("Tunnels permissions verified: Read + Use selected.");
      return "verified (round " + round + ")";
    }
    const need = { Read: before === "none" || before === "use", Use: before === "none" || before === "read" };
    if (!(await popupOpen(scope)) && !(await openMenu(round))) {
      throw new Error("The Tunnels dropdown did not open (round " + round + "). Nothing else was changed.");
    }
    for (const [name, wanted] of [["Read", need.Read], ["Use", need.Use]]) {
      if (!wanted) continue;
      if (!(await popupOpen(scope)) && !(await openMenu(1))) {
        throw new Error('The Tunnels dropdown closed and would not reopen before ticking "' + name + '".');
      }
      await tickOnce(name);
      await wait(300);
    }
    // Capture menu content for diagnostics, THEN close (some widgets only
    // commit their value when the menu closes).
    const pops = scope.locator(POPUP_SEL);
    const pc = await pops.count().catch(() => 0);
    for (let p = 0; p < pc; p++) {
      const t = ((await pops.nth(p).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (t) lastMenu = t.slice(0, 160);
    }
    if (await popupOpen(scope)) { await scope.keyboard.press("Escape").catch(() => {}); await wait(500); }
    if (!(await row.count())) row = await findPermissionRow(scope, "Tunnels");
    if ((await progress()) === "all") {
      await log("Tunnels permissions verified: Read + Use selected.");
      return "verified (round " + round + " after close)";
    }
  }
  const t = await rowText();
  throw new Error("Tunnels could not be verified as Read + Use after selection (row shows: " + (t || "?") + "." +
    (lastMenu ? " Last menu contained: " + lastMenu + "." : "") + " The key was not submitted.");
}
async function pageSignals(page) {
  const title = await page.title().catch(() => "");
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
  const securityCheck = /just a moment|checking your browser|verify you are human|performing security verification|complete the security check/i.test(title + "\n" + body);
  const googleBlock = /browser or app may not be secure|try using a different browser|couldn.t sign you in/i.test(body);
  const login = loginRequired(page) || /sign in to openai|log in to openai|continue with google|enter your email/i.test(body);
  return { title, body, securityCheck, googleBlock, login };
}
// onState (optional) reports live progress to GUI callers:
//   { kind: "login" | "securityCheck" | "googleBlock" | "ready" }
async function waitForPageReady(context, page, onState = null) {
  console.log("\nA visible Chrome window is open.");
  console.log("If asked, sign in to OpenAI and complete the security check yourself in that window.");
  console.log("TIP: if \"Continue with Google\" is rejected as an insecure browser, use the email");
  console.log("     one-time code instead, or run login-once.bat first and then Hadex again.");
  console.log("The app will wait for the real Tunnels settings page; it does not bypass verification or read passwords/cookies.");
  const start = Date.now();
  let notifiedSecurity = false;
  let notifiedLogin = false;
  let notifiedGoogle = false;
  while (Date.now() - start < 10 * 60 * 1000) {
    if (!context.pages().length || page.isClosed()) throw new Error("Chrome was closed before the Tunnels settings page became ready.");
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
        console.log("Please sign in to your OpenAI account in the visible Chrome window.");
        await log("Waiting for user sign-in in visible Chrome.");
        notifiedLogin = true;
      }
      onState?.({ kind: "login" });
      await wait(2000);
      continue;
    }
    if (page.url().includes("platform.openai.com")) {
      // Signed in and on the platform: make sure the tab ends up on the
      // Tunnels settings page itself (the sign-in redirect can land elsewhere).
      if (!/^https:\/\/platform\.openai\.com\/settings\/organization\/tunnels/i.test(page.url())) {
        await page.goto(TARGET_PAGE, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        await wait(1200);
        continue;
      }
      onState?.({ kind: "ready" });
      return;
    }
    await wait(1500);
  }
  throw new Error("The Tunnels settings page did not become ready within ten minutes. Nothing was changed on your OpenAI account.");
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
async function keepProjectDefault(scope) {
  // Project must stay on its Default value. If the selector is a plain <select>
  // and a "Default" option is offered but not active, select it; otherwise the
  // control is left completely untouched.
  try {
    const selects = scope.locator("select");
    const total = await selects.count();
    for (let i = 0; i < total; i++) {
      const select = selects.nth(i);
      if (!(await select.isVisible().catch(() => false))) continue;
      const options = await select.locator("option").allTextContents().catch(() => []);
      const defaultOption = options.find(x => /default/i.test(x));
      if (!defaultOption) continue;
      const current = ((await select.locator("option:checked").first().textContent().catch(() => "")) || "").trim();
      if (!/default/i.test(current)) {
        await select.selectOption({ label: defaultOption }).catch(() => {});
        await log("Project selector set to: " + defaultOption.trim());
        return "Project = " + defaultOption.trim() + " (default)";
      }
      return "Project stays: " + (current || defaultOption.trim());
    }
  } catch {}
  await log("Project control is a custom dropdown; left untouched on its default value.");
  return "Project left untouched (default)";
}
async function findSubmitButton(scope) {
  const patterns = [/^create$/i, /^create secret key$/i, /^create key$/i, /^create api key$/i, /^save$/i];
  for (const pattern of patterns) {
    const button = scope.getByRole("button", { name: pattern }).last();
    if (await button.count() && await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) return button;
  }
  throw new Error("Could not identify the final Create button of the form. Nothing was submitted.");
}
// --------------------------------------------------------- Tunnels helpers
// Verifies that the browser really shows the organization Tunnels settings
// page (URL + page content), so the wizard never reports success on a
// redirect, a promo screen or an error page.
// v1.1.2 FIX: the old check looked for the single literal word "tunnels" in
// the first 8000 chars of body.innerText() - but the REAL page (confirmed
// from the user's screenshot) only says "Create tunnel" (singular!),
// "Download tunnel-client" and shows existing tunnel_ rows, and innerText()
// can transiently fail/return little while React is hydrating. The check now
// accepts ANY of several independent signals, falls back to the raw HTML
// when innerText is empty, and retries a few times before giving up.
function tunnelsPageSignal(hay) {
  const s = String(hay || "");
  if (/tunnels/i.test(s)) return "Tunnels heading/nav text";
  if (/create\s+tunnel/i.test(s)) return "'Create tunnel' button";
  if (/download\s+tunnel-?client|tunnel-?client/i.test(s)) return "'tunnel-client' download button";
  if (/tunnel_[0-9a-f]{6,}/i.test(s)) return "existing tunnel rows (tunnel_ ids)";
  if (/workspace\s+id/i.test(s)) return "tunnel table columns (Workspace ID)";
  return null;
}
async function checkTunnelsPage(page) {
  const url = page.url();
  if (!/^https:\/\/platform\.openai\.com\/settings\/organization\/tunnels/i.test(url)) {
    throw new Error("The Tunnels settings page is not open. Current URL: " + url);
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
    signal = tunnelsPageSignal(await collect());
  }
  if (!signal) {
    await dumpDebug(page, "tunnels-page-unrecognized");
    throw new Error("The Tunnels page is open, but none of its known elements (Create tunnel button, tunnel-client download, tunnel rows) was found in its content. A debug snapshot was saved to " + DEBUG_DIR + " - if OpenAI redesigned the page, send that snapshot so the check can be updated.");
  }
  await log("Tunnels settings page verified (URL + content: " + signal + ").");
  return "Tunnels settings page verified (" + signal + ")";
}

// Read-only status of the API key file created by Hadex GPT Key Creator
// (v1.5.0 saves it to E:\hadex\Hadex gpt2\CONTROL_PLANE_API_KEY.txt).
// The full key is NEVER returned, shown or logged - only a masked preview.
async function readSavedKeyFile() {
  try {
    const content = (await fs.readFile(SAVED_KEY_FILE, "utf8")).trim();
    if (!content) return { exists: true, empty: true, file: SAVED_KEY_FILE, preview: null };
    const preview = content.length > 14
      ? content.slice(0, 8) + "..." + content.slice(-4)
      : content.slice(0, 3) + "...";
    return { exists: true, empty: false, file: SAVED_KEY_FILE, preview };
  } catch {
    return { exists: false, empty: false, file: SAVED_KEY_FILE, preview: null };
  }
}

// ═══════════════ HADEX v1.1.0/v1.1.1: CREATE-TUNNEL PHASE (new) ═══════════════════
// The organization Tunnels page has a "Create tunnel" button. Its dialog
// fields (confirmed from the real page):
//   Name               -> filled with TUNNEL_NAME  ("hadex-gpt")
//   Description        -> filled with TUNNEL_DESC  ("bridge for hadex-gpt")
//   Organizations      -> dropdown, exactly ONE option -> click field, select it
//   ChatGPT workspaces -> dropdown, exactly ONE option -> click field, select it
// After submit, the tunnels TABLE shows the new row with its tunnel_id in the
// ID column. That id is captured (truncation-safe) and saved to
// CONTROL_PLANE_TUNNEL_ID.txt next to the API key file. tunnel-client later
// uses BOTH values:
//   CONTROL_PLANE_API_KEY    (from Key Creator: CONTROL_PLANE_API_KEY.txt)
//   CONTROL_PLANE_TUNNEL_ID  (from this phase: CONTROL_PLANE_TUNNEL_ID.txt)
const TUNNEL_NAME = "hadex-gpt";
const TUNNEL_DESC = "bridge for hadex-gpt";
const TUNNEL_ID_FILE = process.env.HADEX_TUNNEL_ID_FILE ? path.resolve(process.env.HADEX_TUNNEL_ID_FILE) : path.join(SAVED_KEY_DIR, "CONTROL_PLANE_TUNNEL_ID.txt");
const TUNNEL_ID_RE = /tunnel_[0-9a-f]{8,64}/i;

// Extracts the most complete tunnel_id from a text. Truncated UI values
// (e.g. the table shows "tunnel_6ad60de19ee..." with literal dots) are
// REJECTED: saving a partial id would break tunnel-client later. When the
// page contains several ids (several tunnel rows), the LONGEST one wins.
function extractTunnelId(text) {
  if (!text) return null;
  const source = String(text);
  const re = /tunnel_[0-9a-f]{8,64}/gi;
  const found = [];
  let m;
  while ((m = re.exec(source))) {
    // v1.1.2: the table cuts long ids with "..." OR the Unicode ellipsis
    // character "…" (exactly like the workspace id "d088f310-b0de-435…"
    // in the real UI). Both truncation styles are rejected so a partial id
    // can never be saved - a partial id would break tunnel-client.
    const after = source.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (after.startsWith(".") || /^[\u2026\u22EF\u2025]/.test(after)) continue; // truncated display
    found.push(m[0]);
  }
  if (!found.length) return null;
  found.sort((a, b) => b.length - a.length);
  return found[0];
}

// Saves the captured tunnel_id next to the API key file. The id is validated
// first: a truncated or unrelated value is never written to disk.
async function saveTunnelIdFile(tunnelId) {
  const id = String(tunnelId || "").trim();
  if (!TUNNEL_ID_RE.test(id)) {
    throw new Error("Refusing to save: the captured value does not look like a tunnel_id (" + id.slice(0, 48) + ").");
  }
  await fs.mkdir(SAVED_KEY_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(TUNNEL_ID_FILE, id + "\n", "utf8");
  await log("Tunnel id saved to " + TUNNEL_ID_FILE + " (" + id + ")");
  return TUNNEL_ID_FILE;
}

// Read-only status of the tunnel id file (same masked-preview idea as the
// key file status: the id itself is not a secret, but keep the shape equal).
async function readSavedTunnelIdFile() {
  try {
    const content = (await fs.readFile(TUNNEL_ID_FILE, "utf8")).trim();
    if (!content) return { exists: true, empty: true, file: TUNNEL_ID_FILE, tunnelId: null, valid: false };
    const m = content.match(TUNNEL_ID_RE);
    return { exists: true, empty: false, file: TUNNEL_ID_FILE, tunnelId: m ? m[0] : content, valid: !!m };
  } catch {
    return { exists: false, empty: false, file: TUNNEL_ID_FILE, tunnelId: null, valid: false };
  }
}

// Scans the page for a tunnel_id: visible text first, then input/textarea
// values (some UIs render the id inside a read-only field that innerText
// does not include). Uses extractTunnelId so truncated values are skipped.
async function findTunnelIdOnPage(page) {
  let best = null;
  const consider = text => {
    const id = extractTunnelId(text);
    if (id && (!best || id.length > best.length)) best = id;
  };
  consider((await page.locator("body").innerText().catch(() => "")) || "");
  const fields = page.locator("input, textarea");
  const total = await fields.count().catch(() => 0);
  for (let i = 0; i < Math.min(total, 40); i++) {
    consider((await fields.nth(i).inputValue().catch(() => "")) || "");
  }
  return best;
}

// Finds an EXISTING tunnel row named TUNNEL_NAME (from an earlier run).
// Same ancestor-walk trick as findPermissionRow: from the name label up to
// the closest row-sized ancestor that holds a control, tagged with
// data-hadex-tunnel-row so it can be clicked afterwards. Returns null when
// no such row exists - never guesses.
async function findExistingTunnelRow(page) {
  await page.evaluate(() => {
    document.querySelectorAll("[data-hadex-tunnel-row]").forEach(el => el.removeAttribute("data-hadex-tunnel-row"));
  }).catch(() => {});
  const re = new RegExp("^\\s*" + TUNNEL_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
  const texts = page.getByText(re);
  const total = await texts.count().catch(() => 0);
  for (let i = 0; i < total; i++) {
    const anchor = texts.nth(i);
    if (!(await anchor.isVisible().catch(() => false))) continue;
    const marked = await anchor.evaluate(el => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const box = a.getBoundingClientRect();
        if (box.height > 24 && box.height <= 220 && a.querySelector && a.querySelector("button, [aria-haspopup]")) {
          a.setAttribute("data-hadex-tunnel-row", "1");
          return true;
        }
      }
      return false;
    }).catch(() => false);
    if (marked) return page.locator("[data-hadex-tunnel-row='1']").first();
  }
  return null;
}

// Fills the Name field of the Create-tunnel dialog (first visible textbox),
// verified by reading the value back - same strategy as fillName().
async function fillTunnelName(dialog) {
  const candidates = [
    dialog.getByRole("textbox", { name: /^name\b/i }).first(),
    dialog.getByLabel(/^name/i).first(),
    dialog.locator('input[name="name"]:visible').first(),
    dialog.locator('input[type="text"]:visible').first()
  ];
  for (const field of candidates) {
    if (!(await field.count())) continue;
    if (!(await field.isVisible().catch(() => false))) continue;
    try {
      await field.fill(TUNNEL_NAME, { timeout: 8000 });
      const value = (await field.inputValue().catch(() => "")).trim();
      if (value === TUNNEL_NAME) return "name filled (verified)";
    } catch {}
  }
  throw new Error("Could not find the tunnel Name field in the dialog. Nothing was submitted.");
}

// Description (v1.1.1 target text: "bridge for hadex-gpt"): prefer a field
// labeled "Description", then any textarea, then the second text input.
// Never fatal - an unfilled description must not stop the step.
async function fillTunnelDescription(dialog) {
  const candidates = [
    dialog.getByRole("textbox", { name: /description/i }).first(),
    dialog.getByLabel(/description/i).first(),
    dialog.locator("textarea:visible").first()
  ];
  for (const field of candidates) {
    if (!(await field.count())) continue;
    if (!(await field.isVisible().catch(() => false))) continue;
    try {
      await field.fill(TUNNEL_DESC, { timeout: 6000 });
      const value = (await field.inputValue().catch(() => "")).trim();
      if (value === TUNNEL_DESC) return "description filled (verified)";
    } catch {}
  }
  try {
    const boxes = dialog.locator('input[type="text"]:visible');
    const total = await boxes.count();
    if (total >= 2) {
      await boxes.nth(1).fill(TUNNEL_DESC, { timeout: 5000 });
      return "description filled (second text field)";
    }
  } catch {}
  return "description left empty (optional)";
}

// The submit button of the tunnel dialog, searched ONLY inside the dialog so
// the page-level "Create tunnel" button can never be clicked again by mistake.
async function findTunnelSubmitButton(dialog) {
  const patterns = [/^create( tunnel)?$/i, /^add( tunnel)?$/i, /^save$/i];
  for (const pattern of patterns) {
    const button = dialog.getByRole("button", { name: pattern }).last();
    if (await button.count() && await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) return button;
  }
  throw new Error("Could not identify the final Create button of the tunnel dialog. Nothing was submitted.");
}

// ═══ v1.1.1: dropdown fields of the Create-tunnel dialog ═══
// The dialog has TWO dropdown fields - "Organizations" and "ChatGPT
// workspaces". In this org each shows exactly ONE option and that option
// must be selected. Radix portals the popup to document.body, so the popup
// is searched on the PAGE while the label/field are searched in the DIALOG.
async function clearFieldMarks(page) {
  await page.evaluate(() => {
    document.querySelectorAll("[data-hadex-field]").forEach(el => el.removeAttribute("data-hadex-field"));
  }).catch(() => {});
}

async function selectOnlyDropdownOption(page, dialog, labelText) {
  const esc = labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const passes = [
    dialog.getByText(new RegExp("^\\s*" + esc + "\\s*:?\\s*$", "i")), // exact label
    dialog.getByText(new RegExp("\\b" + esc + "\\b", "i"))            // loose match
  ];
  for (const pass of passes) {
    await clearFieldMarks(page);
    const n = Math.min(await pass.count().catch(() => 0), 8);
    for (let i = 0; i < n; i++) {
      const anchor = pass.nth(i);
      if (!(await anchor.isVisible().catch(() => false))) continue;
      // Walk up from the label to the closest ancestor that holds the
      // dropdown trigger (same trick as findPermissionRow).
      const marked = await anchor.evaluate(el => {
        const ctrlSel = "button, [role='combobox'], [aria-haspopup]";
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          if (a.querySelector && a.querySelector(ctrlSel)) {
            const h = a.getBoundingClientRect().height;
            if (h > 0 && h <= 320) { a.setAttribute("data-hadex-field", "1"); return true; }
            return false; // climbed into a dialog-sized wrapper: not the field
          }
        }
        return false;
      }).catch(() => false);
      if (!marked) continue;
      const field = page.locator("[data-hadex-field='1']").first();
      let trig = field.locator("[aria-haspopup]").first();
      if (!(await trig.count()) || !(await trig.isVisible().catch(() => false))) trig = field.getByRole("combobox").first();
      if (!(await trig.count()) || !(await trig.isVisible().catch(() => false))) trig = field.getByRole("button").last();
      if (!(await trig.count()) || !(await trig.isVisible().catch(() => false))) continue;
      await scrollCenter(trig);
      // Close any popup left open by the previous field before clicking.
      if (await popupOpen(page)) { await page.keyboard.press("Escape").catch(() => {}); await wait(400); }
      try { await trig.click({ timeout: 5000 }); }
      catch { await trig.click({ force: true, timeout: 2000 }).catch(() => {}); }
      if (!(await waitPopup(page, 5000))) continue; // trigger opened nothing; try the next anchor
      // Pick the single option inside the open popup.
      const roles = ["option", "menuitemradio", "menuitemcheckbox", "menuitem"];
      const popups = page.locator(POPUP_SEL);
      const popCount = await popups.count().catch(() => 0);
      let outcome = "";
      for (let p = 0; p < popCount && !outcome; p++) {
        const popup = popups.nth(p);
        if (!(await popup.isVisible().catch(() => false))) continue;
        for (const role of roles) {
          const opts = popup.getByRole(role);
          const on = await opts.count();
          for (let k = 0; k < on && !outcome; k++) {
            const opt = opts.nth(k);
            if (!(await opt.isVisible().catch(() => false))) continue;
            if ((await readCheckedState(opt)) === true) { outcome = "already selected"; break; }
            const optText = ((await opt.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
            await scrollCenter(opt);
            try { await opt.click({ timeout: 4000 }); }
            catch { await opt.click({ force: true, timeout: 2000 }).catch(() => {}); }
            await wait(700);
            let state = await readCheckedState(opt);
            if (state === false) { // explicitly unchecked: ONE deliberate re-click
              try { await opt.click({ timeout: 3000 }); } catch {}
              await wait(700);
              state = await readCheckedState(opt);
            }
            outcome = state === true ? "selected (verified)" : "clicked";
            // Close the popup, then verify the field itself shows the option.
            if (await popupOpen(page)) { await page.keyboard.press("Escape").catch(() => {}); await wait(500); }
            const fieldText = ((await field.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
            const probe = optText.slice(0, 24);
            if (probe && fieldText.includes(probe)) outcome = "selected (field shows the option)";
          }
        }
        // Keyboard fallback for custom widgets without option roles: exactly
        // one option exists here, so highlight it and confirm with Enter.
        if (!outcome && (await popup.isVisible().catch(() => false))) {
          try { await page.keyboard.press("ArrowDown"); } catch {}
          await wait(300);
          if ((await page.locator("[data-highlighted]").first().count())) {
            await page.keyboard.press("Enter").catch(() => {});
            await wait(600);
            outcome = "selected via keyboard";
          }
        }
      }
      if (outcome) {
        await clearFieldMarks(page);
        return outcome + " (" + labelText + ")";
      }
      // The popup opened but nothing selectable was found in it.
      let popupText = "";
      for (let p = 0; p < popCount; p++) {
        const t = ((await popups.nth(p).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (t) popupText = (popupText ? popupText + " | " : "") + t.slice(0, 140);
      }
      if (await popupOpen(page)) { await page.keyboard.press("Escape").catch(() => {}); await wait(400); }
      await clearFieldMarks(page);
      throw new Error('The "' + labelText + '" dropdown opened, but no selectable option was found in it.' + (popupText ? " Popup contains: " + popupText : ""));
    }
  }
  await clearFieldMarks(page);
  throw new Error('The "' + labelText + '" field was not found in the Create-tunnel dialog. Nothing was submitted.');
}

// The main v1.1.0 phase: click "Create tunnel", fill the dialog, submit,
// capture the tunnel_id and save it to CONTROL_PLANE_TUNNEL_ID.txt.
// Idempotent: when a tunnel named TUNNEL_NAME already exists (earlier run),
// it is reused and only the id is captured - a duplicate is never created.
async function createTunnel(page) {
  await log("Create-tunnel phase started (button: 'Create tunnel').");

  // ---- 0. A Hadex tunnel from an earlier run? Reuse it, never duplicate.
  const existing = await findExistingTunnelRow(page);
  if (existing) {
    await scrollCenter(existing);
    await existing.click({ timeout: 4000 }).catch(() => existing.click({ force: true, timeout: 1500 }).catch(() => {}));
    await wait(1200);
    // v1.1.1: the table shows the id in the row's ID column - read the row
    // text first (exact), then fall back to the page-wide scan.
    const reusedId = extractTunnelId((await existing.innerText().catch(() => "")) || "") || await findTunnelIdOnPage(page);
    if (reusedId) {
      const file = await saveTunnelIdFile(reusedId);
      await log("Existing Hadex tunnel reused; id captured: " + reusedId);
      return { created: false, reused: true, tunnelId: reusedId, file };
    }
    await dumpDebug(page, "tunnel-exists-no-id");
    throw new Error('A tunnel named "' + TUNNEL_NAME + '" already exists on the page, but its tunnel_id is not visible. Open that tunnel row in Chrome so the id is shown, then Retry this step (it reuses the existing tunnel). No duplicate was created.');
  }

  // ---- 1. Click the page-level "Create tunnel" button.
  const createBtn = await requiredButton(page, ["Create tunnel", "New tunnel", "Add tunnel"], "the Create tunnel button on the Tunnels page");
  await scrollCenter(createBtn);
  try { await createBtn.click({ timeout: 6000 }); }
  catch { await createBtn.click({ force: true, timeout: 2500 }).catch(() => {}); }
  await wait(800);

  // ---- 2. Wait for the dialog to really open.
  const dialog = page.getByRole("dialog").first();
  await untilAvailable(async () => {
    if (!(await dialog.count()) || !(await dialog.isVisible().catch(() => false))) {
      throw new Error("dialog not open yet");
    }
    return true;
  }, "the Create-tunnel dialog", 15000);
  await log("Create-tunnel dialog is open.");

  // ---- 3. Fill Name (verified) and Description (best effort).
  const nameNote = await fillTunnelName(dialog);
  const descNote = await fillTunnelDescription(dialog);
  await log("Tunnel dialog: " + nameNote + "; " + descNote + ".");

  // ---- 3b. v1.1.1: the two dropdown fields - Organizations and ChatGPT
  //          workspaces. Each shows exactly ONE option in this org and that
  //          option must be selected. Organizations FIRST: the workspace
  //          list can depend on the selected organization.
  const orgNote = await selectOnlyDropdownOption(page, dialog, "Organizations");
  await log("Tunnel dialog: " + orgNote + ".");
  await wait(800); // let the workspace list load after the org is picked
  const wsLabels = ["ChatGPT workspaces", "ChatGPT workspace", "Workspaces"];
  let wsNote = "";
  for (const label of wsLabels) {
    try { wsNote = await selectOnlyDropdownOption(page, dialog, label); break; }
    catch (e) { wsNote = e.message; }
  }
  if (!/^(selected|clicked|already)/.test(wsNote)) {
    await dumpDebug(page, "tunnel-workspaces-failed");
    throw new Error("The ChatGPT workspaces option could not be selected. " + wsNote);
  }
  await log("Tunnel dialog: " + wsNote + ".");

  // ---- 4. Submit inside the dialog only.
  const submit = await findTunnelSubmitButton(dialog);
  await submit.click({ timeout: 6000 }).catch(() => submit.click({ force: true, timeout: 2500 }).catch(() => {}));
  await log("Tunnel dialog submitted; waiting for OpenAI to create the tunnel...");

  // ---- 5. The dialog must close; surface OpenAI's error toast if it appears
  //         (e.g. "Failed to create tunnel. Please try again." / tenant 403).
  const deadline = Date.now() + 30000;
  let closed = false;
  while (Date.now() < deadline) {
    const stillOpen = (await dialog.count()) && (await dialog.isVisible().catch(() => false));
    if (!stillOpen) { closed = true; break; }
    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    const err = body.match(/(failed to create|could not create|unable to create)[^\n]{0,180}/i);
    if (err) {
      await dumpDebug(page, "tunnel-create-error");
      throw new Error("OpenAI rejected the tunnel creation: " + err[0].trim() +
        " (if the message mentions 'tenant context missing', the organization needs to be allowlisted by OpenAI - contact OpenAI support; this is not an app error).");
    }
    await wait(700);
  }
  if (!closed) {
    await dumpDebug(page, "tunnel-dialog-stuck");
    throw new Error("The Create-tunnel dialog did not close after submitting. Nothing else was changed - check the Chrome window and Retry this step.");
  }

  // ---- 6. Capture the tunnel_id. v1.1.1: the tunnels table shows the id in
  //         the new row's ID column - read THAT row's text first (exact),
  //         then the page-wide scan, then a copy button / clipboard.
  await wait(1500);
  let tunnelId = null;
  const idDeadline = Date.now() + 30000;
  while (Date.now() < idDeadline && !tunnelId) {
    const newRow = await findExistingTunnelRow(page);
    if (newRow) {
      tunnelId = extractTunnelId((await newRow.innerText().catch(() => "")) || "");
      if (tunnelId) break;
      // Some UIs only reveal the id after the row is opened - try once per round.
      await scrollCenter(newRow);
      await newRow.click({ timeout: 3000 }).catch(() => newRow.click({ force: true, timeout: 1500 }).catch(() => {}));
      await wait(900);
      tunnelId = extractTunnelId((await newRow.innerText().catch(() => "")) || "");
      if (tunnelId) break;
    }
    tunnelId = await findTunnelIdOnPage(page);
    if (tunnelId) break;
    // Last resort: a "copy" button that puts the full id on the clipboard.
    const copyBtn = page.getByRole("button", { name: /copy/i }).first();
    if (await copyBtn.count() && await copyBtn.isVisible().catch(() => false)) {
      try {
        await copyBtn.click({ timeout: 3000 });
        await wait(500);
        const clip = await page.evaluate(() => navigator.clipboard ? navigator.clipboard.readText().catch(() => "") : "");
        const m = String(clip || "").match(TUNNEL_ID_RE);
        if (m) { tunnelId = m[0]; break; }
      } catch {}
    }
    await wait(900);
  }
  if (!tunnelId) {
    await dumpDebug(page, "tunnel-id-not-found");
    throw new Error('The tunnel was created (the dialog closed), but no tunnel_id (tunnel_...) was found on the page. Open the new "' + TUNNEL_NAME + '" row in Chrome so its id is visible, then Retry this step - it will reuse the existing tunnel and save the id.');
  }

  const file = await saveTunnelIdFile(tunnelId);
  await log("Tunnel created and id captured: " + tunnelId + " -> " + file);
  return { created: true, reused: false, tunnelId, file };
}
// ═══════════════════ END HADEX v1.1.0: CREATE-TUNNEL PHASE ═══════════════════

export {
  TARGET_PAGE, KEY_NAME, DATA_DIR, PROFILE_DIR, LOG_FILE, DEBUG_DIR, SAVED_KEY_DIR, SAVED_KEY_FILE,
  MANUAL_CREATE_WAIT_MS, LAUNCH_ARGS, IGNORE_DEFAULT_ARGS,
  wait, log, loginRequired, closeStaleProfileBrowsers, hideAutomationFlags,
  launch, navigate, visibleLogin, requiredButton,
  fillName, selectNever, selectRestricted, setTunnelsPermissions, keepProjectDefault,
  findPermissionRow, findRowDropdown, checkMenuOption, findSubmitButton,
  pageSignals, waitForPageReady, untilAvailable, dumpDebug,
  checkTunnelsPage, readSavedKeyFile,
  TUNNEL_NAME, TUNNEL_DESC, TUNNEL_ID_FILE, createTunnel, saveTunnelIdFile, readSavedTunnelIdFile
};