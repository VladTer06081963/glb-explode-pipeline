#!/usr/bin/env node
/**
 * verify.mjs — determinism check for a captured film.
 *
 * Runs the same capture twice and compares the per-frame sha256 digests.
 * Two identical runs are the acceptance criterion for every change to the
 * block, the recipe or the capture tool: a frame must be a pure function of
 * its time, never of the previous frame or of machine timing.
 *
 *   node tools/verify.mjs --recipe recipes/ct-anatomy.json --at 0,1,2,3
 *   node tools/verify.mjs --dir out/anatomy            # re-verify a capture
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

function digests(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  return manifest.frames.map((f) => f.sha256);
}

function runCapture(outDir, extra) {
  const args = [path.join(HERE, "capture.mjs"), "--out", outDir, ...extra];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout || "", r.stderr || "");
    throw new Error("capture failed");
  }
  return r.stdout.trim();
}

/* Compare two existing captures: the acceptance criterion is that every frame
   of both runs has the same sha256. */
const dirA = arg("a");
const dirB = arg("b");
if (dirA && dirB) {
  const ma = JSON.parse(fs.readFileSync(path.join(dirA, "manifest.json"), "utf8"));
  const mb = JSON.parse(fs.readFileSync(path.join(dirB, "manifest.json"), "utf8"));
  if (ma.frames.length !== mb.frames.length) {
    console.error(`MISMATCH: ${ma.frames.length} vs ${mb.frames.length} frames`);
    process.exit(1);
  }
  let bad = 0;
  for (let i = 0; i < ma.frames.length; i++) {
    if (ma.frames[i].sha256 !== mb.frames[i].sha256) {
      if (bad < 5) console.error(`MISMATCH frame ${i}: ${ma.frames[i].sha256} != ${mb.frames[i].sha256}`);
      bad++;
    }
  }
  console.log(
    bad === 0
      ? `verify: ${ma.frames.length} frames, both runs byte-identical`
      : `verify: ${bad}/${ma.frames.length} frames differ`
  );
  process.exit(bad === 0 ? 0 : 1);
}

const dir = arg("dir");
if (dir) {
  // Verify an existing capture against the digests stored in its manifest.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  let bad = 0;
  for (const f of manifest.frames) {
    const buf = fs.readFileSync(path.join(dir, "frames", f.file));
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    if (h !== f.sha256) {
      console.error(`MISMATCH frame ${f.index}: ${h} != ${f.sha256}`);
      bad++;
    }
  }
  console.log(bad === 0 ? `verify: ${manifest.frames.length} frame digests OK` : `verify: ${bad} mismatches`);
  process.exit(bad === 0 ? 0 : 1);
}

const recipe = arg("recipe");
if (!recipe) {
  console.error("verify: need --recipe <file> or --dir <dir>");
  process.exit(2);
}

const extra = ["--recipe", recipe];
for (const k of ["at", "frames", "duration", "fps", "width", "height", "workers"]) {
  const v = arg(k);
  if (v) extra.push(`--${k}`, v);
}

const tmp = path.join(ROOT, "out", "verify");
fs.mkdirSync(tmp, { recursive: true });
console.log("verify: run A…");
runCapture(path.join(tmp, "a"), extra);
console.log("verify: run B…");
runCapture(path.join(tmp, "b"), extra);

const a = digests(path.join(tmp, "a"));
const b = digests(path.join(tmp, "b"));
const same = a.length === b.length && a.every((h, i) => h === b[i]);
console.log(
  same
    ? `verify: OK — ${a.length} frames, both runs byte-identical (${a[0]?.slice(0, 12)}…)`
    : `verify: FAILED — divergence at ${a.findIndex((h, i) => h !== b[i])}`
);
process.exit(same ? 0 : 1);
