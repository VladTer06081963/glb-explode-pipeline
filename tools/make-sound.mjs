#!/usr/bin/env node
/**
 * Synthesise the sound of a skeleton assembling.
 *
 * The clicks are not decoration: every hit is placed at the moment the bone
 * actually lands, and the order comes from the same rule the scene uses
 * (anatomical height, feet first). So the sound is derived from the recipe
 * and the asset, not from a sample library - and it stays reproducible.
 *
 *   node tools/make-sound.mjs --recipe recipes/skeleton-pile.json --out assets/skeleton-pile.wav
 *
 * Writes a 16-bit stereo WAV and a .hits.json manifest (the landing times).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SR = 48000;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
const flag = (name) => process.argv.includes("--" + name);

/* ---------------------------------------------------------------- helpers */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chamberlin state-variable filter - one instance per band. */
function svf(cutoff, q) {
  const f = 2 * Math.sin((Math.PI * cutoff) / SR);
  const damp = 1 / q;
  let low = 0;
  let band = 0;
  return (x) => {
    low += f * band;
    const high = x - low - damp * band;
    band += f * high;
    return { low, band, high };
  };
}

function decodeNodeTransform(node) {
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return { t, r, s };
}

/** World position of a node's local point (column-major quaternion math). */
function transformPoint(tf, p) {
  const [x, y, z, w] = tf.r;
  // q * v * q^-1
  const ix = w * p[0] + y * p[2] - z * p[1];
  const iy = w * p[1] + z * p[0] - x * p[2];
  const iz = w * p[2] + x * p[1] - y * p[0];
  const iw = -x * p[0] - y * p[1] - z * p[2];
  const rx = ix * w + iw * -x + iy * -z - iz * -y;
  const ry = iy * w + iw * -y + iz * -x - ix * -z;
  const rz = iz * w + iw * -z + ix * -y - iy * -x;
  return [
    tf.t[0] + (rx * tf.s[0]),
    tf.t[1] + (ry * tf.s[1]),
    tf.t[2] + (rz * tf.s[2]),
  ];
}

function compose(parent, child) {
  const p = transformPoint(parent, child.t);
  // rotation: parent * child (quaternion multiply)
  const [ax, ay, az, aw] = parent.r;
  const [bx, by, bz, bw] = child.r;
  const r = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const s = [parent.s[0] * child.s[0], parent.s[1] * child.s[1], parent.s[2] * child.s[2]];
  return { t: p, r, s };
}

/* ------------------------------------------------------------------- GLB */

function parseGltfJson(buffer) {
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error("not a GLB file");
  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) throw new Error("GLB without a JSON chunk");
  return JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength));
}

/**
 * The parts of one body system, with the world position of each bone's centre.
 * Mirrors the scene: the system's descendants are the parts, ordered by height.
 */
function collectSystemParts(gltf, systemName) {
  const nodes = gltf.nodes || [];
  const root = nodes.find((n) => n.name === systemName);
  if (!root) throw new Error(`system "${systemName}" not found in the asset`);
  const identity = { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  const parts = [];

  const walk = (index, parentTf) => {
    const node = nodes[index];
    if (!node) return;
    const tf = compose(parentTf, decodeNodeTransform(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      const primitive = mesh?.primitives?.[0];
      const accessor = primitive ? gltf.accessors?.[primitive.attributes?.POSITION] : null;
      let centre = [0, 0, 0];
      let size = 0;
      if (accessor?.min && accessor?.max) {
        centre = [0, 1, 2].map((i) => (accessor.min[i] + accessor.max[i]) / 2);
        size = Math.hypot(
          accessor.max[0] - accessor.min[0],
          accessor.max[1] - accessor.min[1],
          accessor.max[2] - accessor.min[2]
        );
      }
      const world = transformPoint(tf, centre);
      parts.push({
        name: node.name || `node-${index}`,
        world,
        size,
        meshIndex: node.mesh,
      });
    }
    for (const child of node.children || []) walk(child, tf);
  };

  for (const child of root.children || []) walk(child, identity);
  return parts;
}

/* --------------------------------------------------------------- synthesis */

/** One bone-on-bone clack: a transient plus two short resonances. */
function renderClack(rng, size) {
  const length = Math.round(SR * 0.22);
  const out = new Float32Array(length);
  const low = svf(900 + rng() * 250, 3.2);
  const high = svf(2600 + rng() * 900, 4.5);
  const thud = svf(95 + rng() * 40, 2.4);
  const mass = Math.min(1, Math.max(0.25, size));
  for (let i = 0; i < length; i++) {
    const t = i / SR;
    const n = rng() * 2 - 1;
    const env = Math.exp(-t * (95 - mass * 45));
    const envHi = Math.exp(-t * 210);
    const out2 = low(n);
    const outHi = high(n);
    const outThud = thud(n);
    let v = out2.band * env * 1.6 + outHi.band * envHi * 0.9;
    // heavier bones land with a low body thud
    v += outThud.low * Math.exp(-t * 26) * mass * 1.5;
    // the very first milliseconds are the strike itself
    v += n * Math.exp(-t * 900) * 0.5;
    out[i] = v;
  }
  return out;
}

function writeWav(filePath, left, right, sampleRate = SR) {
  const frames = left.length;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(left[i] * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(right[i] * 32767))), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

/* ------------------------------------------------------------------- main */

const recipePath = path.resolve(ROOT, arg("recipe", "recipes/skeleton-pile.json"));
const outPath = path.resolve(ROOT, arg("out", "assets/skeleton-pile.wav"));
const recipe = JSON.parse(fs.readFileSync(recipePath, "utf8"));
const vars = recipe.variables || {};
const systems = String(vars.systems || "skeleton")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const modelUrl = String(vars.model_url || "/assets/s1045_lod3.glb");
const assetPath = path.resolve(ROOT, modelUrl.replace(/^\/+/, ""));
const gltf = parseGltfJson(fs.readFileSync(assetPath));

const assembleStart = Number(vars.assemble_start ?? 0.8);
const step = Number(vars.sequence_step ?? 0.045);
const flight = Number(vars.sequence_duration ?? 0.3);
const duration = Number(recipe.duration ?? 4.2);

let parts = [];
for (const system of systems) {
  parts = parts.concat(collectSystemParts(gltf, system));
}
// The scene orders the bones by anatomical height: feet first, skull last.
// The same comparator the scene uses, so a click always lands on the bone
// that actually lands at that moment.
parts.sort((a, b) => a.world[1] - b.world[1] || (a.name < b.name ? -1 : 1));

const rng = mulberry32(Number(arg("seed", "2040")) | 0);
const frames = Math.ceil(duration * SR);
const left = new Float32Array(frames);
const right = new Float32Array(frames);

const hits = [];
parts.forEach((part, index) => {
  const landAt = assembleStart + index * step + flight;
  if (landAt > duration) return;
  const clack = renderClack(rng, part.size);
  const start = Math.round(landAt * SR);
  // A little stereo spread, deterministic per bone.
  const pan = (rng() * 2 - 1) * 0.45;
  const gain = 0.34 + Math.min(0.3, part.size * 0.06);
  for (let i = 0; i < clack.length && start + i < frames; i++) {
    const v = clack[i] * gain;
    left[start + i] += v * (0.5 - pan * 0.5) * 2 * 0.5;
    right[start + i] += v * (0.5 + pan * 0.5) * 2 * 0.5;
  }
  hits.push({ name: part.name, at: Number(landAt.toFixed(4)), size: Number(part.size.toFixed(4)) });
});

// Room tone: a very quiet bed of filtered noise so the silence is not digital.
{
  const bed = svf(420, 0.9);
  const air = svf(3200, 0.7);
  for (let i = 0; i < frames; i++) {
    const n = rng() * 2 - 1;
    const t = i / SR;
    const swell = 0.35 + 0.65 * Math.min(1, t / Math.max(0.001, assembleStart));
    const v = bed(n).low * 0.05 * swell + air(n).band * 0.008;
    left[i] += v;
    right[i] += v * 0.92;
  }
}

// Master: soft clip, then normalise to -1.5 dBFS.
let peak = 0;
for (let i = 0; i < frames; i++) {
  left[i] = Math.tanh(left[i] * 1.1);
  right[i] = Math.tanh(right[i] * 1.1);
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}
const target = 0.84;
const norm = peak > 0 ? target / peak : 1;
for (let i = 0; i < frames; i++) {
  left[i] *= norm;
  right[i] *= norm;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
writeWav(outPath, left, right);
fs.writeFileSync(
  outPath.replace(/\.wav$/, ".hits.json"),
  JSON.stringify(
    {
      recipe: path.relative(ROOT, recipePath),
      asset: path.relative(ROOT, assetPath),
      systems,
      bones: parts.length,
      hits: hits.length,
      assemble_start: assembleStart,
      sequence_step: step,
      sequence_duration: flight,
      duration,
      events: hits,
    },
    null,
    2
  ) + "\n"
);

console.log(
  `sound: ${hits.length} hits for ${parts.length} bones -> ${path.relative(ROOT, outPath)} ` +
    `(${duration}s, ${SR} Hz, first hit ${hits[0]?.at ?? "-"}s, last ${hits[hits.length - 1]?.at ?? "-"}s)`
);
