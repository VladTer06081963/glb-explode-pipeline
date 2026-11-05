/**
 * Inventory of a Hugging Face dataset of GLB assets.
 *
 * For every file it reports the things that decide whether the asset is
 * usable for the "take it apart" workflow:
 *
 *   - how many nodes, and how many of them are named (a named node is a part)
 *   - how many distinct materials (a material slot is a fallback "part")
 *   - whether the mesh is compressed (EXT_meshopt_compression)
 *   - the bounding box in metres, and whether the asset stands on Y = 0
 *   - the file size
 *
 * Only the GLB JSON chunk is parsed — the binary buffer is never decoded —
 * so a thousand files are scanned in seconds.
 *
 * Usage:
 *   node scripts/glb-inventory.mjs --repo codepawl/scanned-objects-glb --path objects --limit 20
 *   node scripts/glb-inventory.mjs --repo codepawl/ct-anatomy-glb --path bodies --limit 10
 *   node scripts/glb-inventory.mjs --repo codepawl/scanned-objects-glb --path objects --sample 40 --out /tmp/inventory.json
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const repo = opt('repo', 'codepawl/scanned-objects-glb');
const pathPrefix = opt('path', '');
const limit = parseInt(opt('limit', '0'), 10);
const sample = parseInt(opt('sample', '0'), 10);
const out = opt('out', '');
const useManifest = args.includes('--manifest');
const prefix = pathPrefix ? `${pathPrefix}/` : '';

const HF = 'https://huggingface.co';

/** Fetches with retries — the HF API rate-limits directory listings. */
const fetchWithRetry = async (url, attempts = 5) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    const response = await fetch(url);
    if (response.status === 429) {
      lastError = new Error(`HTTP 429 (rate limited): ${url}`);
      continue;
    }
    return response;
  }
  throw lastError;
};

const listFiles = async (repo, prefix) => {
  const files = [];
  const queue = [prefix];
  while (queue.length) {
    const dir = queue.shift();
    const url = `${HF}/api/datasets/${repo}/tree/main/${dir}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) throw new Error(`tree ${dir}: HTTP ${response.status}`);
    const entries = await response.json();
    for (const entry of entries) {
      if (entry.type === 'directory') {
        queue.push(entry.path);
      } else if (entry.path.toLowerCase().endsWith('.glb')) {
        files.push({ path: entry.path, size: entry.size ?? null });
      }
    }
    // The listing API is the rate-limited part; pace the requests.
    await new Promise((r) => setTimeout(r, 400));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
};

/** Parses the JSON chunk of a GLB and returns the glTF JSON. */
export const parseGltfJson = (buffer) => {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const chunkLength = buffer.readUInt32LE(12);
  const chunkType = buffer.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  return JSON.parse(buffer.toString('utf8', 20, 20 + chunkLength));
};

/** Summary of what the asset offers to a "disassemble" workflow. */
export const inspectGltf = (gltf) => {
  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];
  const materials = gltf.materials || [];

  const namedMeshes = nodes.filter((n) => n.mesh !== undefined && n.name);
  const namedNodes = nodes.filter((n) => n.name);

  const usedMaterials = new Set();
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives || []) {
      if (primitive.material !== undefined) usedMaterials.add(primitive.material);
    }
  }

  const extensions = gltf.extensionsUsed || [];

  // Bounding box from accessor min/max of POSITION, in node space.
  let min = null;
  let max = null;
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives || []) {
      const accessor = (gltf.accessors || [])[primitive.attributes?.POSITION];
      if (!accessor || !accessor.min || !accessor.max) continue;
      if (!min) {
        min = [accessor.min[0], accessor.min[1], accessor.min[2]];
        max = [accessor.max[0], accessor.max[1], accessor.max[2]];
        continue;
      }
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], accessor.min[i]);
        max[i] = Math.max(max[i], accessor.max[i]);
      }
    }
  }

  const scales = nodes
    .filter((n) => n.scale)
    .map((n) => Math.max(...n.scale));

  return {
    nodes: nodes.length,
    namedNodes: namedNodes.length,
    namedMeshNodes: namedMeshes.length,
    meshes: meshes.length,
    materials: materials.length,
    usedMaterials: usedMaterials.size,
    meshopt: extensions.includes('EXT_meshopt_compression'),
    quantization: extensions.includes('KHR_mesh_quantization'),
    min,
    max,
    maxScale: scales.length ? Math.max(...scales) : 1
  };
};

const fetchJson = async (url) => {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

/**
 * Reads the dataset's own metadata.jsonl, which lists every asset path.
 * Preferred over walking the tree API: the listing API is rate-limited
 * hard, the manifest is a single file.
 */
const listFromManifest = async (repo, prefix) => {
  const response = await fetchWithRetry(
    `https://huggingface.co/datasets/${repo}/resolve/main/metadata.jsonl`
  );
  if (!response.ok) throw new Error(`metadata.jsonl: HTTP ${response.status}`);
  const text = await response.text();
  const files = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const file = entry.file || entry.path;
    if (!file || !file.toLowerCase().endsWith('.glb')) continue;
    if (prefix && !file.startsWith(prefix)) continue;
    files.push({ path: file, size: entry.pack_bytes ?? null, meta: entry });
  }
  return files;
};

const main = async () => {
  const files = useManifest
    ? await listFromManifest(repo, prefix)
    : await listFiles(repo, prefix);
  let picked = files;
  if (sample > 0 && files.length > sample) {
    // Evenly spaced sample so the set spans the whole catalog.
    const step = files.length / sample;
    picked = Array.from({ length: sample }, (_, i) => files[Math.floor(i * step)]);
  }
  if (limit > 0) picked = picked.slice(0, limit);

  console.error(`Scanning ${picked.length} of ${files.length} files in ${repo}/${pathPrefix}`);

  const results = [];
  for (const file of picked) {
    const response = await fetchWithRetry(`${HF}/datasets/${repo}/resolve/main/${file.path}`);
    if (!response.ok) {
      results.push({ path: file.path, error: `HTTP ${response.status}` });
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    try {
      const gltf = parseGltfJson(buffer);
      const info = inspectGltf(gltf);
      results.push({
        path: file.path,
        bytes: buffer.length,
        ...info
      });
    } catch (error) {
      results.push({ path: file.path, error: String(error.message || error) });
    }
  }

  const usable = results.filter((r) => !r.error);
  const withParts = usable.filter((r) => r.namedMeshNodes > 1);
  const summary = {
    repo,
    path: pathPrefix,
    scanned: results.length,
    total: files.length,
    errors: results.length - usable.length,
    withMultipleNamedParts: withParts.length,
    avgBytes: usable.length
      ? Math.round(usable.reduce((sum, r) => sum + r.bytes, 0) / usable.length)
      : 0,
    maxNamedMeshNodes: usable.reduce((max, r) => Math.max(max, r.namedMeshNodes), 0),
    meshoptShare: usable.length
      ? +(usable.filter((r) => r.meshopt).length / usable.length).toFixed(3)
      : 0
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log('\nfile | namedMeshNodes | meshes | materials | meshopt | bytes');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.path} | ERROR ${r.error}`);
      continue;
    }
    console.log(
      `${r.path} | ${r.namedMeshNodes} | ${r.meshes} | ${r.materials} | ${r.meshopt} | ${r.bytes}`
    );
  }

  if (out) {
    fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
    console.error(`\nWritten to ${out}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
