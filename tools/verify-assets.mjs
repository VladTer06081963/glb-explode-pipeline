#!/usr/bin/env node
/**
 * verify-assets.mjs — check local assets against assets.manifest.json.
 *
 *   node tools/verify-assets.mjs
 *
 * Exit code 1 on any mismatch: a changed sha256 means the asset was replaced
 * upstream and every frame that used it must be re-rendered.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "assets.manifest.json"), "utf8"));

let bad = 0;
for (const a of manifest.assets) {
  const file = path.join(ROOT, a.file);
  if (!fs.existsSync(file)) {
    console.error(`MISSING  ${a.file} — run: node tools/fetch-assets.mjs`);
    bad++;
    continue;
  }
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const bytesOk = buf.length === a.bytes;
  const shaOk = sha === a.sha256;
  if (shaOk && bytesOk) {
    console.log(`OK       ${a.file}  ${buf.length} B  sha256 ${sha.slice(0, 16)}…  (${a.license})`);
  } else {
    console.error(`MISMATCH ${a.file}  bytes ${buf.length}/${a.bytes}  sha256 ${sha} != ${a.sha256}`);
    bad++;
  }
}
if (bad) {
  console.error(`verify-assets: ${bad} problem(s)`);
  process.exit(1);
}
console.log("verify-assets: all assets match the manifest");
