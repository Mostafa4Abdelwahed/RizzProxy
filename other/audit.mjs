// Audit tool: opens every game in the Poki list through the proxy,
// samples the game frame, classifies each game as ok / stall / stall_unity / fail,
// and writes data/audit/report.json (+ optional screenshots).
//
// Usage:
//   node other/audit.mjs --limit 10            # first 10 games
//   node other/audit.mjs --only "Subway,1010"  # only games whose name contains these
//   node other/audit.mjs --start 100 --timeout 40 --screens
//   node other/audit.mjs --list                # count remaining games
//
// The server is started automatically (default port 8444) and killed at exit
// unless one is already running on that port.

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GAMES_JSON = path.join(REPO, "static", "public", "games", "games.json");
const AUDIT_DIR = path.join(REPO, "data", "audit");
const SCREENS_DIR = path.join(AUDIT_DIR, "screens");
const REPORT = path.join(AUDIT_DIR, "report.json");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => fs.existsSync(p));

// ---------------- args ----------------
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k) => args.includes(k);
const PORT = parseInt(get("--port", "8444"), 10);
const LIMIT = has("--limit") ? parseInt(get("--limit", "0"), 10) : null;
const START = parseInt(get("--start", "0"), 10);
const TIMEOUT_S = parseInt(get("--timeout", "35"), 10);
const PARALLEL = Math.min(16, parseInt(get("--parallel", "1"), 10));
const CHUNK = parseInt(get("--chunk", "15"), 10);
const SCREENS = has("--screens");
const FORCE = has("--force");
const ONLY = get("--only", get("--name", ""));
const LIST = has("--list");
const HEADFUL = has("--headful");

if (!CHROME) {
  console.error("Chrome not found. Pass a path or edit CHROME in other/audit.mjs");
  process.exit(1);
}
if (has("--help") || has("-h")) {
  console.log(
    [
      "Audit games:",
      "  --limit N       only check N games",
      "  --start N       skip the first N games (resume)",
      "  --only \"a,b\"    only games whose name contains any of a or b",
      "  --timeout S     seconds to watch each game (default 35)",
      "  --parallel N    browsers in parallel (default 1)",
      "  --chunk N       relaunch browser every N games (default 15)",
      "  --screens       save a screenshot per game to data/audit/screens",
      "  --force         re-check games already in the report",
      "  --port P        server port (default 8444)",
      "  --list          print how many games remain and exit",
      "  --headful       run Chrome visibly",
    ].join("\n")
  );
  process.exit(0);
}

fs.mkdirSync(SCREENS_DIR, { recursive: true });

const games = JSON.parse(fs.readFileSync(GAMES_JSON, "utf8"));

// ---------------- server ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitPort(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

let serverChild = null;
if (!(await waitPort(4000))) {
  console.log(`Starting server on port ${PORT}...`);
  serverChild = spawn(process.execPath, ["index.js"], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!(await waitPort(25000))) {
    console.error(`Server did not start on http://localhost:${PORT}`);
    process.exit(1);
  }
}
console.log(`Server: http://localhost:${PORT}`);

// ---------------- report state ----------------
const report = { running: true, generated: null, total: games.length, counts: {}, rows: [] };
const doneNames = new Set();
try {
  const existing = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  if (existing && Array.isArray(existing.rows)) {
    for (const r of existing.rows) if (r.status) doneNames.add(r.name);
  }
} catch {}

const saveReport = () => {
  const counts = { ok: 0, stall: 0, stall_unity: 0, fail: 0, skipped: 0 };
  for (const r of report.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  report.counts = counts;
  try {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  } catch (e) {
    console.error("saveReport:", e.message);
  }
};

// ---------------- task list ----------------
const wanted = [];
for (let i = START; i < games.length; i++) {
  const g = games[i];
  if (ONLY && !ONLY.split(",").some((part) => part.trim() && g.name.toLowerCase().includes(part.trim().toLowerCase()))) continue;
  if (!FORCE && doneNames.has(g.name)) {
    report.rows.push({ index: i, name: g.name, status: "skipped", note: "already audited (use --force to redo)" });
    continue;
  }
  wanted.push(i);
}
if (LIMIT !== null) wanted.length = Math.min(LIMIT, wanted.length);

if (LIST) {
  console.log(`Remaining games to audit: ${wanted.length} (already done: ${doneNames.size})`);
  process.exit(0);
}

if (!wanted.length) {
  console.log("Nothing to audit (all done? use --force, or --limit with --start).");
  await finish();
  process.exit(0);
}

console.log(`Auditing ${wanted.length} games (parallel=${PARALLEL}, timeout=${TIMEOUT_S}s, chunk=${CHUNK})...`);
let nextTask = 0;
let completed = 0;
const startedAt = Date.now();

// ---------------- helpers ----------------
const pgLaunch = () =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : "new",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });

function sampleFrame(page) {
  return page
    .evaluate(() => {
      try {
        const f = document.getElementById("uv-frame");
        if (!f) return { none: true };
        const w = f.contentWindow;
        const d = f.contentDocument;
        const q = (sel) => (d ? d.querySelector(sel) : null);
        const txt = (el) => (el ? el.textContent || "" : "");
        const progress = q(".progress-comment") || q("#progress-comment") || q("[class*='loading-comment']");
        const bar = q("#progress") || q(".progress");
        return {
          none: false,
          href: String((w && w.location && w.location.href) || "").slice(0, 100),
          canvases: d ? d.querySelectorAll("canvas").length : 0,
          title: d && d.title ? d.title.slice(0, 60) : "",
          body: (d && d.body && d.body.innerText ? d.body.innerText : "").replace(/\s+/g, " ").slice(0, 260),
          progressText: txt(progress).trim().slice(0, 60),
          progressWidth: bar ? bar.style.width : "",
          unityGame: !!(w && w.unityGame),
          unityLoader: !!(w && w.UnityLoader),
          moduleCalledRun: !!(w && w.Module && w.Module.calledRun),
          pokiSDK: !!(w && w.PokiSDK),
        };
      } catch (e) {
        return { none: false, evalError: String(e).slice(0, 90) };
      }
    })
    .catch((e) => ({ none: false, evalError: String(e).slice(0, 90) }));
}

function finishable(s) {
  if (s.none || s.evalError) return false;
  const unity = s.unityGame || s.unityLoader;
  if (s.moduleCalledRun) return true;
  if (s.canvases > 0 && !unity) {
    const blob = (s.progressText || "") + " " + (s.body || "").slice(0, 120);
    if (!/loading|preparing|%|fetching/i.test(blob)) return true;
  }
  return false;
}

function classify(samples, pageErrors) {
  const can = samples.filter((s) => !s.none && s.canvases > 0);
  const unity = samples.some((s) => s.unityGame || s.unityLoader);
  const text = samples
    .map((s) => (s.body || "") + " " + (s.progressText || ""))
    .join(" ")
    .toLowerCase();
  const errs = pageErrors.map((e) => e.toLowerCase()).join(" ");
  const last = samples[samples.length - 1] || {};

  if (/preparing game\.\.\./.test(text))
    return { status: unity ? "stall_unity" : "stall", note: "stuck at 'Preparing game...'" };
  if (/sorry, game did not load properly|uh oh! there was an error|game did not load|requires additional permissions/i.test(text) && !can.length)
    return { status: "fail", note: "failure banner shown" };
  if (last.moduleCalledRun) return { status: "ok", note: "unity runtime initialized" };
  if (can.length) return { status: "ok", note: "canvas rendered" };
  if (/[0-9]{1,3}%|loading|preparing/i.test(text))
    return { status: "stall", note: "assets loading but no canvas" };
  if (!can.length && /failed to load resource|uncaught|referenceerror|typeerror/i.test(errs))
    return { status: "fail", note: "page errors, no canvas" };
  return { status: "fail", note: "nothing happened" };
}

const slugify = (s) =>
  s.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "game";

async function auditOne(page, idx) {
  const game = games[idx];
  const t0 = Date.now();
  const pageErrors = [];
  const onPageError = (e) => {
    if (pageErrors.length < 6) pageErrors.push("pageerror: " + String(e.message || e).slice(0, 120));
  };
  const onConsole = (m) => {
    if (m.type() === "error" && pageErrors.length < 6) pageErrors.push(m.text().slice(0, 120));
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("dialog", (d) => d.dismiss());

  const samples = [];
  try {
    await page.goto(`http://localhost:${PORT}/games/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.evaluate(() => registerSW().catch(() => {}));
    await page.evaluate(() => window.scramjetReady);
    await page.evaluate((u) => window.openGame(u), game.url);

    const dwellEnd = Math.min(TIMEOUT_S, 12);
    const maxT = TIMEOUT_S * 1000;
    const start = Date.now();
    let exitedEarly = false;
    while (Date.now() - start < maxT) {
      const s = await sampleFrame(page);
      samples.push(s);
      if (Date.now() - start > dwellEnd * 1000 && finishable(s)) {
        exitedEarly = true;
        break;
      }
      await sleep(2500);
    }
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    const verdict = classify(samples, pageErrors);
    const last = samples[samples.length - 1] || {};
    const maxProgress = Math.max(
      0,
      ...samples.map((s) => (s.progressWidth ? parseInt(s.progressWidth.replace(/%/g, ""), 10) || 0 : 0))
    );
    let screenshot = null;
    if (SCREENS && samples.some((s) => s.canvases > 0 || s.unityGame)) {
      const p = path.join(SCREENS_DIR, `${idx}_${slugify(game.name)}.png`);
      try {
        await page.screenshot({ path: p });
        screenshot = `${idx}_${slugify(game.name)}.png`;
      } catch {}
    }
    return {
      index: idx,
      name: game.name,
      url: game.url,
      status: verdict.status,
      note: verdict.note,
      time_s: exitedEarly ? took + " (early)" : took,
      canvases: last.canvases ?? 0,
      maxProgress,
      progress: last.progressText,
      title: last.title,
      unity: !!last.unityGame || !!last.unityLoader,
      errors: pageErrors.join(" | ").slice(0, 220),
      screenshot,
    };
  } catch (e) {
    return {
      index: idx,
      name: game.name,
      url: game.url,
      status: "fail",
      note: "exception: " + String(e.message || e).slice(0, 90),
      time_s: ((Date.now() - t0) / 1000).toFixed(1),
      errors: pageErrors.join(" | ").slice(0, 220),
    };
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("dialog");
  }
}

async function worker(id) {
  let browser = null;
  try {
    browser = await pgLaunch();
    let inChunk = 0;
    while (true) {
      const idx = nextTask++;
      if (idx >= wanted.length) break;
      const gameIdx = wanted[idx];
      let page = null;
      try {
        page = await browser.newPage();
        const row = await auditOne(page, gameIdx);
        pushRow(row);
      } catch (e) {
        pushRow({
          index: gameIdx,
          name: games[gameIdx].name,
          url: games[gameIdx].url,
          status: "fail",
          note: "worker exception: " + String(e.message || e).slice(0, 90),
        });
      } finally {
        if (page) await page.close().catch(() => {});
      }
      inChunk++;
      if (inChunk >= CHUNK && nextTask < wanted.length) {
        await browser.close().catch(() => {});
        browser = await pgLaunch();
        inChunk = 0;
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function pushRow(row) {
  report.rows.push(row);
  completed++;
  const counts = report.counts;
  const pct = ((completed / wanted.length) * 100).toFixed(1);
  console.log(`[${completed}/${wanted.length} ${pct}%] ${row.status.padEnd(11)} ${row.name} (${row.time_s || "?"}s) ${row.note || ""}`);
  saveReport();
}

function finish() {
  report.running = false;
  report.generated = new Date().toISOString();
  saveReport();
  if (serverChild) serverChild.kill();
  console.log("\nDone. Open the results at http://localhost:" + PORT + "/audit (report: data/audit/report.json)");
}

process.on("SIGINT", () => {
  report.running = false;
  saveReport();
  if (serverChild) serverChild.kill();
  process.exit(0);
});

const workers = [];
for (let w = 0; w < PARALLEL; w++) workers.push(worker(w));
await Promise.all(workers);
await finish();