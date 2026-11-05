#!/usr/bin/env node
/**
 * fetch-assets.mjs — download the assets listed in assets.manifest.json.
 *
 *   node tools/fetch-assets.mjs
 *
 * Sources are Hugging Face dataset URLs. The sha256 in the manifest is checked
 * after the download; a mismatch aborts.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "assets.manifest.json"), "utf8"));

const HF = (source) => {
  const m = /^hf:\/\/datasets\/([^/]+)\/(.+)$/.exec(source);
  if (!m) return null;
  return `https://huggingface.co/datasets/${m[1]}/resolve/main/${m[2]}`;
};

for (const a of manifest.assets) {
  const url = HF(a.source);
  const file = path.join(ROOT, a.file);
  if (fs.existsSync(file)) {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (sha === a.sha256) {
      console.log(`SKIP     ${a.file} (already matches)`);
      continue;
    }
    console.warn(`STALE    ${a.file} (sha256 differs) — re-downloading`);
  }
  if (!url) {
    console.error(`SKIP     ${a.file} — no hf:// source in manifest`);
    continue;
  }
  console.log(`FETCH    ${a.file} ← ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    console.error(`FAILED   ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== a.sha256) {
    console.error(`SHA FAIL ${a.file}: ${sha} != ${a.sha256}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`OK       ${a.file}  ${buf.length} B`);
}
