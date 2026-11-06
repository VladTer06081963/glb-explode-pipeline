#!/usr/bin/env node
/**
 * capture.mjs — lean, deterministic frame capture for HyperFrames compositions.
 *
 * Why this exists: `hyperframes snapshot` re-creates the page and re-runs the
 * whole lint/check pipeline per frame (~10 s/frame). This tool keeps ONE page
 * alive, drives it by time and captures the composited result:
 *
 *   node tools/capture.mjs --recipe recipes/ct-anatomy.json --out out/anatomy
 *
 * Guarantees:
 *  - the frame is a pure function of its time (the composition renders from
 *    `hf-seek` / the block's own render(time) — never from the previous frame);
 *  - two runs produce byte-identical PNGs (verified by tools/verify.mjs);
 *  - every frame's sha256 is written to manifest.json.
 *
 * Options:
 *   --recipe <file>     recipe JSON: { composition, variables, duration, fps }
 *   --url <url>         explicit composition URL (overrides --recipe)
 *   --out <dir>         output directory (default: out/frames)
 *   --duration <sec>    override recipe duration
 *   --fps <n>           override recipe fps (default 30)
 *   --frames <a,b,c>    explicit frame indices instead of a range
 *   --at <seconds>      explicit timestamps in seconds, e.g. 0,1.5,3
 *   --width/--height    viewport size (default 1920x1080)
 *   --workers <n>       parallel browser instances (default 4)
 *   --browser <path>    Chrome/Chromium binary (default: autodetect)
 *   --cdp <url>         connect to an existing browser instead of launching one
 *   --jpeg <q>          write JPEG instead of PNG (faster, lossy)
 *   --contact-sheet     also write out/contact-sheet.png
 *   --ffmpeg <bin>      encode mp4 with this ffmpeg (optional)
 *   --no-launch-assets  do not copy assets into the served directory
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* ---------------------------------------------------------------- args ---- */
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const recipePath = arg("recipe");
const outDir = path.resolve(arg("out", "out/frames"));
const fps = Number(arg("fps", 30));
const durationArg = arg("duration");
const duration = durationArg != null ? Number(durationArg) : null;
const widthArg = arg("width");
const heightArg = arg("height");
const workers = Math.max(1, Number(arg("workers", 4)));
const browserPath = arg("browser");
const cdpUrl = arg("cdp");
const jpegQuality = arg("jpeg") ? Number(arg("jpeg")) : null;
const ffmpegBin = arg("ffmpeg", "ffmpeg");

let compositionUrl = arg("url");
let recipe = null;
let variables = {};

if (recipePath) {
  recipe = JSON.parse(fs.readFileSync(path.resolve(recipePath), "utf8"));
  variables = recipe.variables || {};
  if (!compositionUrl) {
    const page = recipe.composition || "compositions/glb-exploded-view.html";
    compositionUrl = `http://127.0.0.1:0/${page.replace(/^\//, "")}`;
  }
}
if (!compositionUrl) {
  console.error("capture: need --recipe or --url");
  process.exit(2);
}

/* Frame size: pinned by the recipe (or CLI), and passed to the composition as
   variables so the canvas matches the viewport exactly. A mismatch crops the
   frame to the top-left corner of a bigger canvas — silent, and very visible. */
const width = widthArg != null ? Number(widthArg) : Number(recipe?.width) || 1920;
const height = heightArg != null ? Number(heightArg) : Number(recipe?.height) || 1080;
if (variables.width == null) variables.width = width;
if (variables.height == null) variables.height = height;
if (Number(variables.width) !== width || Number(variables.height) !== height) {
  console.warn(
    `capture: viewport ${width}x${height} != composition ${variables.width}x${variables.height} — the frame will be cropped`
  );
}

/* -------------------------------------------------------- frame list ---- */
let frames; // array of { index, time }
if (arg("at")) {
  frames = arg("at")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .map((t, i) => ({ index: i, time: t }));
} else if (arg("frames")) {
  frames = arg("frames")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n, i) => ({ index: i, time: n / fps }));
} else {
  const dur = duration ?? (recipe ? recipe.duration : 6);
  const total = Math.max(1, Math.round(dur * fps));
  frames = Array.from({ length: total }, (_, i) => ({ index: i, time: i / fps }));
}

/* ------------------------------------------------------- static server ---- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".bin": "application/octet-stream",
};

function startServer(roots) {
  const server = http.createServer((req, res) => {
    const url = decodeURI((req.url || "/").split("?")[0]);
    for (const root of roots) {
      const file = path.join(root, url);
      if (!file.startsWith(root)) continue;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found: " + url);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/* ----------------------------------------------------------- browser ---- */
function detectBrowser() {
  const envPath = process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const pw = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pw)) {
    const dirs = fs.readdirSync(pw).filter((d) => d.startsWith("chromium-"));
    for (const d of dirs) {
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = path.join(pw, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  const fixed = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  return null;
}

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-gpu-sandbox",
  "--enable-unsafe-swiftshader",
  "--hide-scrollbars",
  "--mute-audio",
  "--force-device-scale-factor=1",
  `--window-size=${width},${height}`,
];

async function openBrowser(puppeteer) {
  if (cdpUrl) return puppeteer.connect({ browserURL: cdpUrl });
  const executablePath = browserPath || detectBrowser();
  if (!executablePath) throw new Error("no Chrome/Chromium found — pass --browser or set CHROME_PATH");
  return puppeteer.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
}

/* ------------------------------------------------------------ capture ---- */
async function captureWorker(puppeteer, browser, url, list, dir, label) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(`[${label}] pageerror: ${String(e).slice(0, 200)}`));
  await page.goto(url, { waitUntil: "load", timeout: 120000 });

  // Wait until the composition signals it is ready to be drawn.
  await page.waitForFunction(
    () =>
      (window.__hf && window.__hf.buildReady && Object.keys(window.__hf.buildReady).length > 0) ||
      (window.__glbExplodedView && typeof window.__glbExplodedView.render === "function"),
    { timeout: 120000 }
  );
  await page.evaluate(async () => {
    if (window.__hf?.buildReady) {
      const keys = Object.keys(window.__hf.buildReady);
      await Promise.all(keys.map((k) => window.__hf.buildReady[k]));
    }
  });

  // The composition canvas must match the viewport, otherwise the capture is a
  // crop of a larger canvas instead of the frame.
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return c ? { w: c.width, h: c.height } : null;
  });
  if (canvasSize && (canvasSize.w !== width || canvasSize.h !== height)) {
    console.error(
      `[${label}] canvas ${canvasSize.w}x${canvasSize.h} != viewport ${width}x${height} — frames will be cropped`
    );
  }

  const results = [];
  for (const frame of list) {
    const t0 = Date.now();
    await page.evaluate((time) => {
      const host = window.__glbExplodedView;
      if (host && typeof host.render === "function") {
        host.render(time);
        return;
      }
      const tl = window.__timelines && Object.values(window.__timelines)[0];
      if (tl) tl.seek(time);
    }, frame.time);
    // Two frames so the DOM overlay (labels) is laid out before the capture.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const buf = jpegQuality
      ? await page.screenshot({ type: "jpeg", quality: jpegQuality })
      : await page.screenshot({ type: "png" });
    const name = `frame-${String(frame.index).padStart(5, "0")}.${jpegQuality ? "jpg" : "png"}`;
    fs.writeFileSync(path.join(dir, name), buf);
    results.push({
      index: frame.index,
      time: Number(frame.time.toFixed(6)),
      file: name,
      bytes: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      ms: Date.now() - t0,
    });
  }
  await page.close();
  return results;
}

async function main() {
  const puppeteer = (await import("puppeteer-core")).default;
  const framesDir = path.join(outDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  /* Stale frames from a previous, longer render would silently end up in the
     next video: the encoder reads a numbered sequence, so leftovers look like
     extra frames of this film. */
  for (const file of fs.readdirSync(framesDir)) {
    if (/^frame-\d+\.(png|jpg)$/.test(file)) fs.unlinkSync(path.join(framesDir, file));
  }

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(variables)) query.set(k, String(v));

  let server = null;
  let url = compositionUrl;
  if (url.includes("127.0.0.1:0")) {
    server = await startServer([ROOT]);
    const port = server.address().port;
    const rel = url.split("/").slice(3).join("/");
    url = `http://127.0.0.1:${port}/${rel}`;
  }
  if (query.toString()) url += (url.includes("?") ? "&" : "?") + query.toString();

  const t0 = Date.now();
  const buckets = Array.from({ length: workers }, () => []);
  frames.forEach((f, i) => buckets[i % workers].push(f));

  const all = [];
  if (cdpUrl) {
    const browser = await openBrowser(puppeteer);
    all.push(...(await captureWorker(puppeteer, browser, url, frames, framesDir, "cdp")));
    await browser.disconnect();
  } else {
    const tasks = buckets
      .filter((b) => b.length > 0)
      .map((bucket, i) => async () => {
        const browser = await openBrowser(puppeteer);
        try {
          const res = await captureWorker(puppeteer, browser, url, bucket, framesDir, `w${i}`);
          all.push(...res);
        } finally {
          await browser.close();
        }
      });
    await Promise.all(tasks.map((t) => t()));
  }
  if (server) server.close();

  all.sort((a, b) => a.index - b.index);
  const manifest = {
    composition: compositionUrl,
    url,
    fps,
    width,
    height,
    frames: all.length,
    durationSec: Number((all.length / fps).toFixed(3)),
    elapsedMs: Date.now() - t0,
    msPerFrame: Number(((Date.now() - t0) / Math.max(1, all.length)).toFixed(1)),
    recipe: recipePath ? path.relative(ROOT, path.resolve(recipePath)) : null,
    variables,
    frames: all,
  };
  // Dead time: a frame that is byte-identical to the previous one. A recipe
  // whose animation ends before the declared duration produces a long run of
  // them — the render is paid for, but nothing moves.
  const staticRuns = [];
  let runStart = 0;
  for (let i = 1; i <= all.length; i++) {
    // Only consecutive frame numbers count: in a sparse capture (--at) two
    // neighbouring entries can be seconds apart, and an unchanged picture
    // there is not dead time.
    const consecutive = i < all.length && all[i].index === all[i - 1].index + 1;
    const same = consecutive && all[i].sha256 === all[i - 1].sha256;
    if (same) continue;
    if (i - 1 > runStart) {
      staticRuns.push({
        fromIndex: all[runStart].index,
        toIndex: all[i - 1].index,
        fromSec: Number((all[runStart].index / fps).toFixed(3)),
        toSec: Number((all[i - 1].index / fps).toFixed(3)),
        frames: i - runStart,
      });
    }
    runStart = i;
  }
  const staticFrames = staticRuns.reduce((n, r) => n + r.frames, 0);
  manifest.static = {
    frames: staticFrames,
    ratio: Number((staticFrames / Math.max(1, all.length)).toFixed(3)),
    runs: staticRuns.slice(0, 10),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (staticFrames > 0) {
    const longest = staticRuns.reduce((a, b) => (b.frames > a.frames ? b : a), staticRuns[0]);
    console.log(
      `capture: static frames ${staticFrames}/${all.length} (${(manifest.static.ratio * 100).toFixed(1)}%) — ` +
        `longest run ${longest.fromSec}s..${longest.toSec}s (${longest.frames} frames)`
    );
  }

  if (flag("contact-sheet")) await writeContactSheet(puppeteer, framesDir, outDir, all, width, height);

  if (ffmpegBin) {
    const probe = spawnSync("which", [ffmpegBin], { encoding: "utf8" });
    if (probe.status === 0) {
      const out = path.join(outDir, "film.mp4");
      const args = [
        "-y",
        "-framerate",
        String(fps),
        "-i",
        path.join(framesDir, "frame-%05d." + (jpegQuality ? "jpg" : "png")),
        "-frames:v",
        String(all.length),
      ];
      if (jpegQuality) args.push("-q:v", "4");
      else args.push("-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "18");
      args.push(out);
      const r = spawnSync(ffmpegBin, args, { encoding: "utf8" });
      if (r.status === 0) console.log("capture: wrote", out);
      else console.error("capture: ffmpeg failed\n" + (r.stderr || "").slice(-800));
    } else {
      console.warn("capture: ffmpeg not found — frames only");
    }
  }

  console.log(
    `capture: ${all.length} frames in ${manifest.elapsedMs} ms (${manifest.msPerFrame} ms/frame, ${workers} worker(s)) -> ${outDir}`
  );
}

async function writeContactSheet(puppeteer, framesDir, outDir, all, w, h) {
  /* A sheet with every frame of a long film is a document no browser can
     hold, so the sheet samples the film evenly. */
  const max = Number(flag("sheet-max", 36));
  const stride = Math.max(1, Math.ceil(all.length / Math.max(1, max)));
  const sampled = all.filter((f, i) => i % stride === 0 || i === all.length - 1);
  const cells = sampled
    .map(
      (f) =>
        `<figure><img src="file://${path.join(framesDir, f.file)}"><figcaption>frame ${f.index} · t=${f.time.toFixed(2)}s · ${f.sha256.slice(
          0,
          8
        )}</figcaption></figure>`
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0b0e14;font:12px/1.4 system-ui,sans-serif;color:#e8ecf5}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px}
    figure{margin:0}img{width:100%;display:block;border:1px solid #232a38}
    figcaption{padding:4px 2px;color:#9fb0c8}
  </style><div class="grid">${cells}</div>`;
  const tmp = path.join(outDir, "contact-sheet.html");
  fs.writeFileSync(tmp, html);

  const executablePath = browserPath || detectBrowser();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: LAUNCH_ARGS.filter((a) => !a.startsWith("--window-size")),
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.goto("file://" + tmp, { waitUntil: "load" });
  await page.screenshot({ path: path.join(outDir, "contact-sheet.png"), fullPage: true });
  await browser.close();
  console.log("capture: wrote", path.join(outDir, "contact-sheet.png"));
}

main().catch((e) => {
  console.error("capture: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
