// core.js — Hadex GPT Key Creator automation engine (shared by console + wizard).
// No side effects here: importing this module never starts a browser.
import { chromium } from "playwright";
import clipboard from "clipboardy";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const KEY_PAGE = "https://platform.openai.com/api-keys";
const KEY_NAME = "Hadex gpt";
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Hadex", "GPTKeyCreator");
// Hadex keeps its own Chrome profile. Never drive the everyday Chrome profile:
// Playwright cannot attach to a running Chrome and that is what produced about:blank.
const PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
const LOG_FILE = path.join(DATA_DIR, "setup.log");
const DEBUG_DIR = path.join(DATA_DIR, "debug");
// v1.5.0 (user request): the finished key file is saved to E:\hadex\Hadex gpt2.
// The location can be overridden with the HADEX_KEY_DIR environment variable.
// If the E: drive is missing or not writable, the key is saved to
// Documents\Hadex instead so a freshly created key is never lost - the
// wizard window always shows the path that was really used.
const PRIMARY_SECRET_DIR = process.env.HADEX_KEY_DIR
  ? path.resolve(process.env.HADEX_KEY_DIR)
  : "E:\\hadex\\Hadex gpt2";
const FALLBACK_SECRET_DIR = path.join(os.homedir(), "Documents", "Hadex");
const SECRET_DIR = PRIMARY_SECRET_DIR;
const SECRET_FILE = path.join(SECRET_DIR, "CONTROL_PLANE_API_KEY.txt");

// How long the app watches the page for the secret key after the fields are
// filled (waiting for the user to click Create manually).
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
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 10000 });
  } catch (error) {
    throw new Error(
      "Hadex Chromium is not reachable on 127.0.0.1:9223. Start Hadex Chromium first, then run the Key Creator again. Details: " +
      String(error?.message || error)
    );
  }
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error("Hadex Chromium connected, but its browser context was not available.");
  }
  // Keep a reference to the CDP connection for diagnostics without closing
  // the user's Hadex Chromium window when the automation finishes.
  context.__hadexCdpBrowser = browser;
  browser.on("disconnected", () => {
    log("The Hadex Chromium CDP connection was disconnected.").catch(() => {});
  });
  await hideAutomationFlags(context);
  await log("Connected to Hadex Chromium. Existing page count: " + context.pages().length);
  return context;
}
async function navigate(context) {
  await log("Opening target URL in the Hadex Chromium window: " + KEY_PAGE);
  const deadline = Date.now() + 15000;
  let appPage = null;

  while (Date.now() < deadline) {
    const pages = context.pages();
    const existingOpenAiPage = pages.find(page => OPENAI_HOST.test(page.url()));
    if (existingOpenAiPage) {
      await existingOpenAiPage.bringToFront().catch(() => {});
      await log("Reusing OpenAI page in Hadex Chromium: " + existingOpenAiPage.url());
      return existingOpenAiPage;
    }
    appPage = pages.find(page => /file:\/\/\/E:\/hadex\/Hadex%20Chromium\/index\.html/i.test(page.url()));
    if (appPage) break;
    await wait(250);
  }

  if (!appPage) {
    throw new Error("Could not find the main Hadex Chromium window through CDP. Keep Hadex Chromium open and try again.");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Navigate the Electron window itself, rather than opening a separate
      // Chrome window or trying to control the embedded webview as a page.
      await appPage.goto(KEY_PAGE, { waitUntil: "commit", timeout: 90000 });
      lastError = null;
    } catch (error) {
      lastError = error;
      await log("OpenAI navigation attempt " + attempt + " threw: " + String(error?.message || error));
    }

    const navDeadline = Date.now() + 45000;
    while (Date.now() < navDeadline) {
      if (OPENAI_HOST.test(appPage.url())) {
        await wait(1500);
        await appPage.bringToFront().catch(() => {});
        await log("OpenAI page is ready in the Hadex Chromium window: " + appPage.url());
        return appPage;
      }
      if (appPage.isClosed()) break;
      await wait(500);
    }

    await log("OpenAI navigation attempt " + attempt + " ended at: " + (appPage.isClosed() ? "(window closed)" : appPage.url()));
    if (appPage.isClosed()) break;
    await wait(1500);
  }

  const finalUrl = appPage.isClosed() ? "(window closed)" : appPage.url();
  throw new Error(
    "Hadex Chromium did not reach the OpenAI page. Current URL: " + finalUrl +
    (lastError ? " | last error: " + String(lastError?.message || lastError) : "")
  );
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
  console.log("The app will wait for the real API keys page; it does not bypass verification or read passwords/cookies.");
  const start = Date.now();
  let notifiedSecurity = false;
  let notifiedLogin = false;
  let notifiedGoogle = false;
  while (Date.now() - start < 10 * 60 * 1000) {
    if (!context.pages().length || page.isClosed()) throw new Error("Chrome was closed before the API keys page became ready.");
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
    if (page.url().includes("platform.openai.com") && /api.?keys|secret key|api key/i.test(state.title + "\n" + state.body)) {
      if (!page.url().startsWith(KEY_PAGE)) {
        await page.goto(KEY_PAGE, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        await wait(1200);
        continue;
      }
      onState?.({ kind: "ready" });
      return;
    }
    await wait(1500);
  }
  throw new Error("The API keys page did not become ready within ten minutes. No key creation was attempted.");
}
const SECRET_PATTERN = /^(rk|sk|sk-proj|sk-org|sk-admin)[_-][A-Za-z0-9_-]{20,}$/;
// v1.4.5: the key is copied from the "Save your key" dialog ITSELF - the Copy
// button right next to the key field - instead of scanning the whole page.
// Order of attempts:
//   1. find the visible dialog that has a Copy button
//   2. snapshot the clipboard BEFORE clicking, so a stale key from an earlier
//      run can never be mistaken for the freshly created one
//   3. click the dialog's Copy button, read the clipboard, validate it
//   4. fallback: read the key straight from the key field inside the dialog
//   5. LAST RESORT only (no such dialog found): the old page-wide scan
async function getSecretFromPage(page) {
  const readDialogField = async dlg => {
    const fields = dlg.locator("input, textarea, code, pre");
    const n = await fields.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = fields.nth(i);
      const value = (await el.inputValue().catch(async () => await el.innerText().catch(() => ""))).trim();
      if (SECRET_PATTERN.test(value)) return value;
    }
    return null;
  };
  const dialogs = page.getByRole("dialog");
  const dn = await dialogs.count().catch(() => 0);
  // Newest/topmost dialog first - the "Save your key" modal is the last one.
  for (let i = dn - 1; i >= 0; i--) {
    const dlg = dialogs.nth(i);
    if (!(await dlg.isVisible().catch(() => false))) continue;
    let copy = dlg.getByRole("button", { name: /^\s*copy\s*$/i }).last();
    if (!(await copy.count())) copy = dlg.getByRole("button", { name: /copy/i }).last();
    if (!(await copy.count())) continue;
    let prev = null;
    try { prev = (await clipboard.read()).trim(); } catch {}
    try { await copy.click({ timeout: 4000 }); }
    catch { await copy.click({ force: true, timeout: 2000 }).catch(() => {}); }
    await wait(800);
    try {
      const value = (await clipboard.read()).trim();
      // Accept when the clipboard changed to a valid key - or when it equals
      // the previous clipboard content but the dialog's own key field proves
      // this really is the new key (e.g. the user copied it manually first).
      if (SECRET_PATTERN.test(value) &&
          (prev === null || value !== prev || (await readDialogField(dlg)) === value)) {
        await log("Secret key copied via the Save-your-key dialog Copy button.");
        return value;
      }
    } catch {}
    const fromField = await readDialogField(dlg);
    if (fromField) {
      await log("Secret key read from the Save-your-key dialog key field.");
      return fromField;
    }
  }
  // LAST RESORT: no visible dialog with a Copy button was found (older flow
  // or the dialog already closed) - fall back to the page-wide scan.
  const reveal = await requiredButton(page, [/show key/i, /show secret/i, /reveal/i], "key reveal control").catch(() => null);
  if (reveal) await reveal.click().catch(() => {});
  const elements = page.locator("input, textarea, code, pre");
  const count = await elements.count();
  for (let i = 0; i < count; i++) {
    const el = elements.nth(i);
    const value = (await el.inputValue().catch(async () => await el.innerText().catch(() => ""))).trim();
    if (SECRET_PATTERN.test(value)) return value;
  }
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
async function waitForSecret(page) {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const secret = await getSecretFromPage(page);
    if (secret) return secret;
    await wait(2000);
  }
  throw new Error("The form was submitted, but no secret key appeared on screen within two minutes. Check the page now: if the key was created, copy it manually - it might not be shown again.");
}
// Watches the page (NEVER submits anything) and returns as soon as the newly
// created secret key shows up - normally right after the user clicks the final
// "Create secret key" button themselves. getSecretFromPage only ever clicks
// show/reveal/copy controls, which exist solely on the success screen, so the
// review process of the open form is never disturbed.
async function waitForManualCreateSecret(page, timeoutMs) {
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) throw new Error("Chrome was closed before a secret key appeared.");
    const secret = await getSecretFromPage(page);
    if (secret) return secret;
    if (!announced) {
      const dialogOpen = await page.getByRole("dialog").count().catch(() => 1);
      if (!dialogOpen) {
        announced = true;
        console.log("The form dialog is no longer open. Looking for the secret key on the page...");
      }
    }
    await wait(2000);
  }
  throw new Error("No secret key appeared on screen within the waiting time.");
}
async function saveSecret(secret, opts = {}) {
  // Clipboard FIRST: even if every disk operation fails, the freshly created
  // key is already on the clipboard and can never be lost.
  await clipboard.write(secret);

  // Try the requested location (E:\hadex\Hadex gpt2) first; if the drive is
  // missing or not writable, fall back to Documents\Hadex so the new key is
  // never lost. The caller reports which location was really used.
  const dirs = [PRIMARY_SECRET_DIR, FALLBACK_SECRET_DIR];
  let targetDir = null;
  let usedFallback = false;
  let lastError = null;
  for (let i = 0; i < dirs.length; i++) {
    try { await fs.mkdir(dirs[i], { recursive: true }); targetDir = dirs[i]; usedFallback = i > 0; break; }
    catch (e) { lastError = e; }
  }
  if (!targetDir) {
    throw new Error("Could not create the key folder (tried " + dirs.join(" and ") + "): " + (lastError ? lastError.message : "unknown error"));
  }
  const targetFile = path.join(targetDir, "CONTROL_PLANE_API_KEY.txt");
  try {
    await fs.writeFile(targetFile, secret + os.EOL, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (opts && opts.backup) {
      // GUI mode: there is no console prompt, so keep the previous key as a
      // backup file and overwrite. Nothing is lost.
      const backup = targetFile.replace(/\.txt$/i, ".backup.txt");
      await fs.copyFile(targetFile, backup).catch(() => {});
      await fs.writeFile(targetFile, secret + os.EOL, { encoding: "utf8", mode: 0o600 });
    } else {
      const rl = readline.createInterface({ input, output });
      try {
        const answer = await rl.question(`Key file already exists: ${targetFile}\nType REPLACE to overwrite it: `);
        if (answer.trim() !== "REPLACE") throw new Error("Existing key file preserved; new key was not saved.");
        await fs.writeFile(targetFile, secret + os.EOL, { encoding: "utf8", mode: 0o600 });
      } finally { rl.close(); }
    }
  }
  // Restrict Windows permissions when the drive supports it. On non-NTFS
  // drives (exFAT/FAT32) icacls cannot work - keep the file with a note
  // instead of deleting a perfectly good key file.
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const acl = spawnSync("icacls.exe", [targetFile, "/inheritance:r", "/grant:r", `${user}:(R,W)`, "SYSTEM:(F)"], { encoding: "utf8", windowsHide: true });
  if (acl.status !== 0) {
    await log("NOTE: Windows ACL hardening was skipped for " + targetFile + " (drive may not be NTFS). The key file was kept.");
  }
  if (usedFallback) {
    await log("Primary key folder was not available; the key was saved to the fallback location: " + targetFile);
  }
  return { file: targetFile, dir: targetDir, usedFallback };
}
// Finds the page's "Create new secret key" button (with a 2-minute deadline) and
// clicks it, opening the create-key dialog. Extracted from the old inline main()
// flow so both console mode and the wizard use the exact same logic.
async function openCreateForm(page) {
  // If the create dialog is already open (e.g. the user opened it or a retry
  // happened after the click), do NOT click again - just proceed.
  if (await page.getByRole("dialog").count().catch(() => 0)) {
    const looksLikeForm = (await page.getByRole("textbox", { name: /^name\b/i }).count().catch(() => 0))
      || (await page.getByText(/^\s*expiration\b/i).count().catch(() => 0));
    if (looksLikeForm) {
      console.log("The create-key dialog is already open.");
      await log("Create-key dialog already open; skipping the Create button click.");
      return "already open";
    }
  }
  console.log("API keys page is ready. Waiting for the Create key button...");
  await log("API keys page is ready; waiting for Create key button.");
  const patterns = [
    /create new runtime api key/i, /create runtime api key/i,
    /create new key/i, /create new api key/i, /create new secret key/i,
    /create api key/i, /create key/i
  ];
  let createButton = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !createButton) {
    for (const pattern of patterns) {
      const candidate = page.getByRole("button", { name: pattern }).first();
      if (await candidate.count() && await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) {
        createButton = candidate;
        break;
      }
    }
    if (!createButton) await wait(1000);
  }
  if (!createButton) throw new Error("The page loaded, but the Create key button did not appear within two minutes. No button was clicked.");
  const btnText = (await createButton.innerText().catch(() => "")).trim();
  console.log('Create key button found: "' + btnText + '". Clicking...');
  await createButton.click();
  await log("Create key button clicked: " + btnText);
  await wait(1500);
  console.log((await page.getByRole("dialog").count())
    ? "The create-key dialog is open. Filling fields one by one..."
    : "Dialog role not detected; trying field detection anyway...");
  return btnText;
}

export {
  KEY_PAGE, KEY_NAME, DATA_DIR, PROFILE_DIR, LOG_FILE, DEBUG_DIR, SECRET_DIR, SECRET_FILE, FALLBACK_SECRET_DIR,
  MANUAL_CREATE_WAIT_MS, SECRET_PATTERN, LAUNCH_ARGS, IGNORE_DEFAULT_ARGS,
  wait, log, loginRequired, closeStaleProfileBrowsers, hideAutomationFlags,
  launch, navigate, visibleLogin, requiredButton,
  fillName, selectNever, selectRestricted, setTunnelsPermissions, keepProjectDefault,
  findPermissionRow, findRowDropdown, checkMenuOption, findSubmitButton,
  pageSignals, waitForPageReady, getSecretFromPage, untilAvailable, dumpDebug,
  waitForSecret, waitForManualCreateSecret, saveSecret, openCreateForm
};