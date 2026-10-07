// paint-probe.mjs — measure whether a triggered restyle paints ATOMICALLY.
//
//   node paint-probe.mjs --port 9223 --trigger "<js that causes the restyle>" [opts]
//
// Throttles the CPU, fires YOUR restyle via the app's real code path, and
// snapshots getComputedStyle at the exact style recalc (a MutationObserver on a
// marker attribute), plus a screenshot burst. Optionally deletes a CSS rule
// first to capture the pre-fix "bug" baseline on the same page. Prints the
// snapshots as JSON so the caller can diff them.
//
// Why: a one-frame repaint stagger ("backgrounds snap, borders lag") is a real
// UI-perf bug that's invisible to vibes. This turns it into a number: at the
// swap recalc, is transition-duration 0s and the value already final (atomic),
// or still live and mid-animation (the wave)?
//
//   --port <n>         CDP port (default 9222)
//   --url <substr>     pick the target whose URL contains this (default: first page)
//   --trigger <js>     JS run in the page to cause the restyle (REQUIRED)
//   --throttle <n>     CPU throttle rate, e.g. 6 = 6x slower (default 6)
//   --sample <sel>     element to snapshot each frame (default "body")
//   --props <csv>      kebab-case computed props to record
//                      (default "transition-duration,background-color,color")
//   --watch-attr <a>   attribute on <html> whose add/remove marks the swap;
//                      snapshot fires at each mutation (e.g. data-theme-switching)
//   --burst <csv ms>   screenshot offsets after the trigger (default "40,90,150,250")
//   --settle <ms>      wait before the final "settled" snapshot (default 500)
//   --disable-rule <s> delete CSS rules whose selectorText contains <s> BEFORE the
//                      run — captures the pre-fix baseline for an honest before/after
//   --out <dir>        screenshot output dir (default "./paint-probe-out")
//   --label <s>        screenshot filename prefix (default "probe")
//
// Requires: npm i -g chrome-remote-interface.

import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const CDP = require("chrome-remote-interface");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

const port = parseInt(arg("--port", "9222"), 10);
const urlMatch = arg("--url", "");
const trigger = arg("--trigger", "");
const throttle = parseFloat(arg("--throttle", "6"));
const sample = arg("--sample", "body");
const props = arg("--props", "transition-duration,background-color,color").split(",").map((s) => s.trim()).filter(Boolean);
const watchAttr = arg("--watch-attr", "");
const burst = arg("--burst", "40,90,150,250").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const settle = parseInt(arg("--settle", "500"), 10);
const disableRule = arg("--disable-rule", "");
const out = arg("--out", "./paint-probe-out");
const label = arg("--label", "probe");

if (has("--help") || !trigger) {
  // Fail loud — no trigger means nothing to measure.
  console.error("paint-probe: --trigger <js> is required. See the header of this file for options.");
  process.exit(has("--help") ? 0 : 2);
}
fs.mkdirSync(out, { recursive: true });
fs.accessSync(out, fs.constants.W_OK);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page snapshot fn (string): reads `props` off `sample` via getComputedStyle.
const SNAP_FN = `(label) => {
  const el = document.querySelector(${JSON.stringify(sample)});
  const cs = el ? getComputedStyle(el) : null;
  const out = { label, t: performance.now(), marker: ${watchAttr ? `document.documentElement.hasAttribute(${JSON.stringify(watchAttr)})` : "null"} };
  ${JSON.stringify(props)}.forEach((p) => { out[p] = cs ? cs.getPropertyValue(p).trim() : null; });
  window.__pp.snaps.push(out);
  return out;
}`;

const INSTALL = `(() => {
  window.__pp = { snaps: [] };
  window.__ppSnap = ${SNAP_FN};
  ${watchAttr ? `new MutationObserver(() => window.__ppSnap(document.documentElement.hasAttribute(${JSON.stringify(watchAttr)}) ? 'MARKER_ADDED' : 'MARKER_REMOVED'))
      .observe(document.documentElement, { attributes: true, attributeFilter: [${JSON.stringify(watchAttr)}] });` : ""}
  return 'installed';
})()`;

const DISABLE = `(() => {
  let n = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    for (let i = rules.length - 1; i >= 0; i--) {
      if (rules[i].selectorText && rules[i].selectorText.includes(${JSON.stringify(disableRule)})) { sheet.deleteRule(i); n++; }
    }
  }
  return 'deleted ' + n + ' rule(s) matching ' + ${JSON.stringify(disableRule)};
})()`;

(async () => {
  const targets = await CDP.List({ port });
  const pages = targets.filter((t) => t.type === "page" && (!urlMatch || (t.url || "").includes(urlMatch)));
  if (!pages.length) {
    console.error(`paint-probe: no page target on port ${port}${urlMatch ? ` matching "${urlMatch}"` : ""}.`);
    console.error("(Pod isolated-context pages can be absent from the list — open the page in a normal tab, or pass --url.)");
    process.exit(3);
  }
  const client = await CDP({ port, target: pages[0].id });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  const runJs = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(path.join(out, `${label}-${name}.png`), Buffer.from(r.data, "base64"));
  };

  await Emulation.setCPUThrottlingRate({ rate: throttle });
  await runJs(INSTALL);
  if (disableRule) console.error(await runJs(DISABLE));

  await runJs("window.__ppSnap('PRE')");
  await shot("00-pre");
  await runJs(trigger);

  let last = 0;
  for (const t of burst) { await sleep(Math.max(0, t - last)); last = t; await shot(`+${t}ms`); }
  await sleep(settle);
  await runJs("window.__ppSnap('SETTLED')");
  await shot("99-settled");

  const snaps = await runJs("window.__pp.snaps");
  fs.writeFileSync(path.join(out, `${label}-snapshots.json`), JSON.stringify(snaps, null, 2));
  console.log(JSON.stringify({ port, target: pages[0].url, throttle, sample, snaps }, null, 2));

  await Emulation.setCPUThrottlingRate({ rate: 1 });
  await client.close();
  process.exit(0);
})().catch((e) => { console.error("paint-probe FATAL:", e.message || e); process.exit(1); });
