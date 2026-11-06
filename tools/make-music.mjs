#!/usr/bin/env node
/**
 * Procedural music for the assembly film.
 *
 * Nothing is sampled: the track is synthesised from the same clock as the
 * scene, so the beat grid, the bone landing times and the dance all share
 * one source of truth. The grid is written next to the WAV so an agent (or
 * the renderer) can read it.
 *
 *   node tools/make-music.mjs --bpm 120 --bars 8 --out assets/skeleton-dance.wav
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

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chamberlin state-variable filter: one instance per band. */
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

const A = 440;
const note = (semitonesFromA4) => A * Math.pow(2, semitonesFromA4 / 12);
const N = {
  A1: note(-33), C2: note(-28), D2: note(-26), E2: note(-24), F2: note(-25),
  G2: note(-22), A2: note(-21), C3: note(-16), D3: note(-14), E3: note(-12),
  F3: note(-13), G3: note(-11), A3: note(-9), B3: note(-7), C4: note(-4),
  D4: note(-2), E4: note(0), G4: note(2), A4: note(3),
};

/** One bar of the progression. */
const PROG = [
  { root: N.A1, tones: [N.A3, N.C4, N.E4] }, // Am
  { root: N.F2, tones: [N.F3, N.A3, N.C4] }, // F
  { root: N.C3, tones: [N.C4, N.E4, N.G4] }, // C
  { root: N.G2, tones: [N.G3, N.B3, N.D4] }, // G
];

function addKick(buf, at, gain = 1) {
  const start = Math.round(at * SR);
  const len = Math.round(SR * 0.5);
  let phase = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    const f = 120 * Math.exp(-t * 28) + 44;
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t * 7.5);
    let v = Math.sin(phase) * env;
    // the click of the beater
    v += (rng() * 2 - 1) * Math.exp(-t * 260) * 0.25;
    buf[start + i] += v * gain * 0.9;
  }
}

function addSnare(buf, at, gain = 1) {
  const start = Math.round(at * SR);
  const len = Math.round(SR * 0.35);
  const body = svf(190, 1.2);
  const snap = svf(1900, 1.1);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    const n = rng() * 2 - 1;
    const env = Math.exp(-t * 18);
    const v = snap(n).band * env * 0.8 + body(n).low * Math.exp(-t * 26) * 0.7;
    buf[start + i] += v * gain * 0.55;
  }
}

function addHat(buf, at, open = false, gain = 1) {
  const start = Math.round(at * SR);
  const decay = open ? 0.16 : 0.035;
  const len = Math.round(SR * decay * 5);
  const hp = svf(7200, 0.7);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    buf[start + i] += hp(rng() * 2 - 1).high * Math.exp(-t / decay) * gain * 0.22;
  }
}

/** Bass: a filtered saw with an envelope that opens and closes. */
function addBass(buf, at, freq, dur, gain = 1) {
  const start = Math.round(at * SR);
  const len = Math.round(dur * SR);
  const lp = svf(220, 1.4);
  let phase = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    phase += freq / SR;
    if (phase > 1) phase -= 1;
    const saw = phase * 2 - 1;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 3.2);
    const v = lp(saw).low;
    buf[start + i] += v * env * gain * 0.5;
  }
}

/** Pad: three detuned saws per chord tone, slow attack. */
function addPad(buf, at, freqs, dur, gain = 1, cutoff = 1200) {
  const start = Math.round(at * SR);
  const len = Math.round(dur * SR);
  const lp = svf(cutoff, 0.9);
  const phases = freqs.map(() => [rng(), rng(), rng()]);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    const attack = Math.min(1, t / 0.5);
    const release = Math.min(1, (dur - t) / 0.6);
    const env = attack * Math.max(0, release);
    let v = 0;
    phases.forEach((p, k) => {
      const f = freqs[k];
      for (let d = 0; d < 3; d++) {
        const detune = 1 + (d - 1) * 0.004;
        p[d] += (f * detune) / SR;
        if (p[d] > 1) p[d] -= 1;
        v += p[d] * 2 - 1;
      }
    });
    v /= freqs.length * 3;
    buf[start + i] += lp(v).low * env * gain * 0.5;
  }
}

/** Pluck: a short triangle-ish arpeggio note. */
function addPluck(buf, at, freq, gain = 1) {
  const start = Math.round(at * SR);
  const len = Math.round(SR * 0.4);
  const lp = svf(2600, 1.1);
  let phase = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    phase += freq / SR;
    if (phase > 1) phase -= 1;
    const tri = 4 * Math.abs(phase - 0.5) - 1;
    const env = Math.exp(-t * 7);
    buf[start + i] += lp(tri).band * env * gain * 0.3;
  }
}

/** A noise riser into the next bar. */
function addRiser(buf, at, dur, gain = 1) {
  const start = Math.round(at * SR);
  const len = Math.round(dur * SR);
  const bp = svf(400, 0.8);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    const k = t / dur;
    const cut = 300 * Math.pow(24, k);
    const v = bp(rng() * 2 - 1).band;
    buf[start + i] += v * k * k * gain * 0.25;
    void cut;
  }
}

/* ------------------------------------------------------------------- main */

const bpm = Number(arg("bpm", 120));
const bars = Number(arg("bars", 8));
const beatsPerBar = 4;
const spb = 60 / bpm;
const duration = Number(arg("duration", bars * beatsPerBar * spb));
const outPath = path.resolve(ROOT, arg("out", "assets/skeleton-dance.wav"));
const rng = mulberry32(Number(arg("seed", "2040")) | 0);

const frames = Math.ceil(duration * SR);
const buf = new Float32Array(frames);

const beatTimes = [];
for (let b = 0; b < bars * beatsPerBar; b++) beatTimes.push(b * spb);

/**
 * The arrangement. Everything is a function of the bar, so the section
 * boundaries are readable at a glance.
 */
function levelOf(bar) {
  if (bar === 0) return { hats: 1, pad: 0.35, kick: 0, snare: 0, bass: 0, pluck: 0, cutoff: 700 };
  if (bar === 1) return { hats: 1, pad: 0.5, kick: 0, snare: 0, bass: 0, pluck: 0, cutoff: 1100 };
  if (bar === 2) return { hats: 1, pad: 0.6, kick: 0.75, snare: 0, bass: 0.6, pluck: 0, cutoff: 1400 };
  if (bar <= 4) return { hats: 1, pad: 0.55, kick: 1, snare: 0.8, bass: 0.9, pluck: 0, cutoff: 1600 };
  if (bar <= 7) return { hats: 1, pad: 0.8, kick: 1, snare: 0.9, bass: 1, pluck: 0.7, cutoff: 2600 };
  /* A longer film needs somewhere to fall back to. The drums drop out and the
     pad carries the last section - that is where the bones fall back into
     the heap, and the clatter sits in the empty space. The last bar is the
     crash that ends the film. */
  if (bar >= bars - 1) return { hats: 1, pad: 0.85, kick: 1, snare: 0.95, bass: 1, pluck: 0.8, cutoff: 2600 };
  return { hats: 0.6, pad: 0.7, kick: 0, snare: 0, bass: 0.25, pluck: 0.3, cutoff: 900 };
}

for (let bar = 0; bar < bars; bar++) {
  const L = levelOf(bar);
  const chord = PROG[bar % PROG.length];
  const barStart = bar * beatsPerBar * spb;
  const barEnd = barStart + beatsPerBar * spb;

  // pad
  addPad(buf, barStart, chord.tones, beatsPerBar * spb, L.pad, L.cutoff);
  // hats on every eighth, open hat on the "and" of 4
  for (let e = 0; e < beatsPerBar * 2; e++) {
    const at = barStart + e * (spb / 2);
    addHat(buf, at, e === 7, L.hats * (e % 2 === 0 ? 1 : 0.72));
  }
  // kick on every beat
  for (let b = 0; b < beatsPerBar; b++) {
    if (L.kick > 0) addKick(buf, barStart + b * spb, L.kick);
  }
  // snare on 2 and 4
  if (L.snare > 0) {
    addSnare(buf, barStart + 1 * spb, L.snare);
    addSnare(buf, barStart + 3 * spb, L.snare);
  }
  // bass: root on the beat, fifth on the "and" of 3
  if (L.bass > 0) {
    addBass(buf, barStart, chord.root, spb * 0.9, L.bass);
    addBass(buf, barStart + 2.5 * spb, chord.root * 1.5, spb * 0.45, L.bass * 0.7);
  }
  // pluck arpeggio in the drop
  if (L.pluck > 0) {
    for (let e = 0; e < beatsPerBar * 2; e++) {
      const tone = chord.tones[e % chord.tones.length] * (e % 4 === 3 ? 2 : 1);
      addPluck(buf, barStart + e * (spb / 2), tone, L.pluck * (e % 2 === 0 ? 1 : 0.6));
    }
  }
  // riser into the next bar
  if (bar === 1 || bar === 4) addRiser(buf, barEnd - spb, spb, 0.8);
}

// Master: soft clip and normalise.
let peak = 0;
for (let i = 0; i < frames; i++) {
  buf[i] = Math.tanh(buf[i] * 1.15);
  peak = Math.max(peak, Math.abs(buf[i]));
}
const norm = peak > 0 ? 0.89 / peak : 1;
for (let i = 0; i < frames; i++) buf[i] *= norm;

/* ------------------------------------------------------------------- WAV */

function writeWav(filePath, data, sampleRate = SR) {
  const bytes = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    bytes.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(data[i] * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, bytes]));
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
writeWav(outPath, buf);

// The grid, readable by the scene and by an agent.
const map = {
  bpm,
  beats_per_bar: beatsPerBar,
  seconds_per_beat: spb,
  bars,
  duration,
  beat_times: beatTimes,
  sections: beatTimes
    .filter((_, i) => i % beatsPerBar === 0)
    .map((t, i) => ({ bar: i, start: t, level: levelOf(i) })),
  progression: PROG.map((c, i) => ({ bar: i, root: Number(c.root.toFixed(3)), tones: c.tones.map((t) => Number(t.toFixed(3))) })),
};
fs.writeFileSync(outPath.replace(/\.wav$/, ".map.json"), JSON.stringify(map, null, 2) + "\n");

console.log(
  `music: ${bars} bars @ ${bpm} bpm (${spb.toFixed(3)} s/beat, ${duration}s) -> ${path.relative(ROOT, outPath)}`
);
