# glb-explode-pipeline

Deterministic **exploded view / cutaway** video from any GLB that has named
mesh nodes. Built on [HyperFrames](https://github.com/heygen-com/hyperframes)
(composition HTML + JS), with our own capture tool because
`hyperframes snapshot` re-runs the whole check pipeline per frame (~10 s/frame).

The block itself lives in our HyperFrames fork:
[`VladTer06081963/hyperframes`](https://github.com/VladTer06081963/hyperframes)
→ `registry/blocks/glb-exploded-view/` (branch `feature/glb-exploded-view-block`).

## Why it is deterministic

* a frame is a **pure function of its time** — the composition draws from the
  `hf-seek` time (or `host.render(t)`), never from the previous frame;
* no `Date.now()`, `Math.random()`, `performance.now()`, no `mixer.update(dt)`
  (use `mixer.setTime(t)`);
* `renderer.setPixelRatio(1)` — Retina ×4 would otherwise change every pixel;
* the composition signals readiness via `window.__hf.buildReady["<key>"]`, so
  the capture never grabs a half-built scene (this was the original bug: the
  first captured frame was blank);
* GSAP's ticker is **not** a clock: in headless capture it is frozen, and
  `tl.seek(t)` does not fire the tween's `onUpdate`. The block listens to
  `hf-seek` instead.

Verification: two runs of the same recipe must produce byte-identical frames.

```bash
node tools/verify.mjs --recipe recipes/ct-anatomy.json --at 0,1,2,3
# verify: OK — 3 frames, both runs byte-identical
```

## Usage

```bash
npm install                # puppeteer-core only; uses a system Chrome

# 1. cheap feedback loop — 3 frames + contact sheet
node tools/capture.mjs --recipe recipes/ct-anatomy.json --at 0,1.5,3 --out out/preview --contact-sheet

# 2. full film — frames + manifest + contact sheet + mp4
node tools/capture.mjs --recipe recipes/ct-anatomy.json --out out/anatomy --contact-sheet --ffmpeg ffmpeg
```

`make setup | preview | render | verify | inventory | assets`

The recipe is the API an agent edits:

```json
{
  "composition": "compositions/glb-exploded-view.html",
  "duration": 6, "fps": 30,
  "variables": {
    "model_url": "assets/s1045_lod3.glb",
    "explode_field": "radial",     // radial | hierarchical | symmetric-fan
    "explode_amount": 1.1,
    "explode_start": 0.5, "explode_duration": 1.5,
    "camera_orbit": 0, "camera_fov": 38,
    "cutaway": "none",             // none | x | z
    "labels": "brain,spinal_cord,aorta,liver,stomach,femur_left,femur_right"
  }
}
```

## Block variables

| variable | default | meaning |
|---|---|---|
| `model_url` | — | GLB/glTF URL (meshopt-compressed GLB is supported) |
| `explode_field` | `radial` | direction field: `radial`, `hierarchical`, `symmetric-fan` |
| `explode_amount` | `0.8` | explode amplitude (scale relative to the object's own size) |
| `explode_start` / `explode_duration` | `0.5` / `1.5` | seconds |
| `camera_orbit` | `0` | degrees of orbit around the subject over the timeline |
| `camera_fov` | `38` | vertical FOV |
| `cutaway` | `none` | `x` or `z` — clipping plane through the object |
| `cutaway_position` | `0` | plane position, −1…1 |
| `labels` | — | comma-separated part names to label |
| `background` | `#05070d` | background colour |

## Assets

`assets.manifest.json` pins every asset by `sha256` + `bytes` + `source` +
`author` + `license` + `attribution`. `make assets` downloads and verifies.

Current asset: `s1045_lod3.glb` — TotalSegmentator CT (Wasserthal et al.,
Universitätsspital Basel, CC BY 4.0), 115 named anatomical parts, meshopt +
KHR_mesh_quantization, 265 KB.

## Catalog reality check

`node tools/glb-inventory.mjs --repo codepawl/scanned-objects-glb --sample 20`
shows that furniture catalogs (Google Scanned Objects, ABO) contain **one
merged mesh per file** — no named parts to explode. Two consequences:

* for those assets use `cutaway` (needs no parts);
* auto-decomposition (SAM/DINOv2 clustering) is a separate experimental track
  with its own kill criterion, not part of this pipeline.

## Repository layout

```
compositions/glb-exploded-view.html   the composition (copy of the block)
blocks/glb-exploded-view/              registry item for `hyperframes add`
recipes/*.json                         what an agent edits
assets/                                pinned GLB files
assets.manifest.json                   sha256 / license / attribution
tools/capture.mjs                      deterministic frame capture (+ mp4, contact sheet)
tools/verify.mjs                       determinism check (two runs)
tools/fetch-assets.mjs, verify-assets.mjs
tools/glb-inventory.mjs                catalog measurement
skills/glb-exploded-view/SKILL.md      agent skill: recipe → preview → look → fix → render
```

## Frame size is part of the recipe

The composition pins its canvas size through the `width`/`height` variables;
the capture tool passes the same values and warns when the viewport and the
canvas disagree. A mismatch does not fail — it silently crops the frame to the
top-left corner of a bigger canvas, which is why the tool now checks the
canvas size of the loaded page before the first frame.

## Determinism, measured

| Check | Result |
| --- | --- |
| Two runs of the same recipe, same machine | 180/180 frames byte-identical (`tools/verify.mjs --a out/det1 --b out/det2`) |
| Same recipe, different GPU backend (VPS SwiftShader vs MBP Apple/Metal) | bytes differ; SSIM 0.984, 0.79 % of pixels differ by > 8/255 (antialiasing on edges) |

So: byte-identity is a **per-backend** invariant. Golden frames are pinned to
a machine + GPU combination; across backends the invariant is perceptual
equality, not equality of bytes.

## DaVinci Resolve stage (verified 2026-11-06)

The film leaves this pipeline as a single video file, not as a PNG sequence.
Verified rules against DaVinci Resolve 18.6.6 (Mac App Store build, sandbox):

| Rule | Why |
| --- | --- |
| Deliver **mp4**, not a PNG sequence | a PNG sequence imports but fails to decode at render time (`... не удалось правильно декодировать`) |
| Deliver into **`~/Movies`** on the Mac | Resolve's sandbox imports only from its allowed roots; the same file elsewhere returns `{"imported": 0}` with no error |
| Source must be in the **project frame rate** (24 by default) | the project frame rate cannot be changed through the API (`SetSetting` → False, readback 24.0) |
| Set the **project resolution** before creating the timeline | the render output takes the project resolution; `FormatWidth/FormatHeight` are ignored |
| `safe_set_project_settings` needs **`restore: false`** | the helper restores the original value by default |
| MCP arguments with arrays must be a **JSON string** | an object argument loses nested arrays (`INVALID_CLIP_IDS`) |
| `render.start` returning success is a **hint** | the proof is `render.verify_output` |

```bash
make deliver NAME=ct-anatomy     # render + transcode to 24 fps + copy into ~/Movies
```

The script prints the exact MCP calls to follow (project settings → timeline →
import → append → render → verify).
