// watch.mjs - CDP observability watcher. Writes one file per stream into a run folder.
//
//   node watch.mjs --port 9223 --dir "D:\dev\sandbox\<pod>\<run>"
//
// Streams -> files in <dir>:
//   console.txt      console.* + exceptions + Log entries
//   network.txt      requests/responses + failures (non-/api)
//   api.txt          requests/responses to /api/*
//   convex.txt       convex HTTP + WebSocket frames (mutations/queries)
//   performance.txt  DOM nodes / JS heap / listeners, sampled every 3s
//
// Stop with Ctrl+C (or kill the process). Requires: npm i -g chrome-remote-interface.

import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const CDP = require("chrome-remote-interface");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const port = parseInt(arg("--port", "9222"), 10);
const dir = arg("--dir", process.cwd());

// Fail LOUD if the log dir is missing/unwritable — a black-box recorder must never
// silently drop evidence (this exact silent-fail lost a capture on 2026-06-13).
fs.mkdirSync(dir, { recursive: true });
fs.accessSync(dir, fs.constants.W_OK);

const stamp = () => new Date().toISOString();   // full ISO — runs can span long windows
const line = (file, s) => fs.appendFileSync(path.join(dir, file), `[${stamp()}] ${s}\n`);
const isApi = (u) => /\/api\//.test(u || "");
const isConvex = (u) => /convex/i.test(u || "");
const streamFor = (u) => isConvex(u) ? "convex.txt" : (isApi(u) ? "api.txt" : "network.txt"); // convex BEFORE api

(async () => {
  const client = await CDP({ port });
  const { Runtime, Network, Performance, Log } = client;
  await Runtime.enable();
  await Network.enable({});
  try { await Log.enable(); } catch {}
  try { await Performance.enable(); } catch {}

  Runtime.consoleAPICalled(({ type, args }) => {
    const msg = args.map((a) => a.value ?? a.description ?? "").join(" ");
    line("console.txt", `[${type.toUpperCase()}] ${msg}`);
  });
  Runtime.exceptionThrown(({ exceptionDetails }) =>
    line("console.txt", `[EXCEPTION] ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`));
  Log.entryAdded?.(({ entry }) => line("console.txt", `[${entry.level.toUpperCase()}] ${entry.text}`));

  Network.requestWillBeSent(({ request }) => line(streamFor(request.url), `> ${request.method} ${request.url}`));
  Network.responseReceived(({ response }) => line(streamFor(response.url), `< ${response.status} ${response.url}`));
  Network.loadingFailed(({ errorText, type }) => line("network.txt", `[FAIL] ${type} ${errorText}`));
  Network.webSocketFrameReceived?.(({ response }) => {
    const txt = (response.payloadData || "").slice(0, 400);
    if (txt) line("convex.txt", `WS< ${txt}`);
  });

  if (Performance) {
    setInterval(async () => {
      try {
        const { metrics } = await Performance.getMetrics();
        const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
        line("performance.txt",
          `Nodes=${m.Nodes} JSHeapMB=${Math.round((m.JSHeapUsedSize || 0) / 1e6)} Docs=${m.Documents} Listeners=${m.JSEventListeners} LayoutCount=${m.LayoutCount}`);
      } catch {}
    }, 3000);
  }

  line("console.txt", `watcher attached on port ${port}`);
  const bye = () => { try { client.close(); } catch {}; process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
})().catch((e) => { line("console.txt", `WATCHER ERROR: ${e.message}`); process.exit(1); });
