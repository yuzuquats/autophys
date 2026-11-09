// The drawings for the landing's case-study rows (studies.ts). Only disc plots recorded data:
// the Muse Spark 1.3 discovery pass, seed 0, held-out RMSE (the deck's evidence slide). Most of
// the rest are schematics of each case's identifiability story, captioned as such. Two rows are
// illustrations of the planned test rather than plots: slm draws a short factual sentence with a
// per-token logit-margin span under each token, and nrg draws the same lattice world twice,
// under a short sunlight pulse and a long step. Neither shows an outcome.
//
// Small schematic visuals for the Autophys "Case studies and experiments" rows.
// Dependency-free. Each function returns inner SVG markup for a w×h box
// (origin top-left); the caller wraps it in <svg viewBox="0 0 w h">.
//
// Family rules (shared by all nine):
//   ink  #141414, 2px   = the informative test / what Autophys adds
//   grey #b8b8b8, 1.5px = the easy test / the alternative
//   hairline #d9d9d9 baseline, #ebebeb guides; labels #8a8a8a, 9–10px system-ui,
//   haloed in white so they never fight a line. No numeric axes except on the
//   one recorded chart (disc). Set text (slm) is #424242 at 10–11px, each token
//   pinned to its measured slot with textLength so a wider font cannot overflow.

export type StudyId = "bat" | "disc" | "osc" | "th" | "lfp" | "bld" | "kin" | "slm" | "nrg";

const INK = "#141414";
const GREY = "#b8b8b8";
const RULE = "#d9d9d9";
const GUIDE = "#ebebeb";
const LABEL = "#8a8a8a";
const PAD = 3;

type Pt = [number, number];
type Fn = (t: number) => number;

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const fs = (h: number) => (h >= 90 ? 10 : 9);

/** Plot frame: maps t∈[0,1] → x and v∈[0,1] (1 = top) → y. */
function frame(w: number, h: number, top = PAD, bottom = PAD, left = PAD, right = PAD) {
  const x0 = left, x1 = w - right, y0 = top, y1 = h - bottom;
  return {
    x: (t: number) => x0 + (x1 - x0) * t,
    y: (v: number) => y1 - (y1 - y0) * v,
    x0, x1, y0, y1,
  };
}
type Frame = ReturnType<typeof frame>;

/** Sample piecewise segments [a, b, fn] into one polyline (vertical jumps stay sharp). */
function trace(F: Frame, segs: [number, number, Fn][], n = 60): Pt[] {
  const pts: Pt[] = [];
  for (const [a, b, fn] of segs) {
    for (let i = 0; i <= n; i++) {
      const t = a + ((b - a) * i) / n;
      pts.push([F.x(t), F.y(fn(t))]);
    }
  }
  return pts;
}

function path(pts: Pt[], color: string, width: number, extra = ""): string {
  const d = pts.map((p, i) => (i ? "L" : "M") + f1(p[0]) + "," + f1(p[1])).join("");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;
}
const ink = (pts: Pt[]) => path(pts, INK, 2);
const grey = (pts: Pt[]) => path(pts, GREY, 1.5);

function line(x1: number, y1: number, x2: number, y2: number, color = RULE, width = 1, extra = ""): string {
  return `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="${color}" stroke-width="${width}"${extra}/>`;
}
const ROUND = ` stroke-linecap="round"`;

const dot = (x: number, y: number, r: number, fill: string) =>
  `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${fill}"/>`;

function text(
  x: number, y: number, s: string, h: number,
  anchor: "start" | "middle" | "end" = "start", color = LABEL,
): string {
  return `<text x="${f1(x)}" y="${f1(y)}" font-size="${fs(h)}" font-family="system-ui,-apple-system,sans-serif" fill="${color}" text-anchor="${anchor}" stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${s}</text>`;
}

/** Rough rendered width of a label (system-ui, ~0.56em per glyph). */
const tw = (s: string, h: number) => s.length * fs(h) * 0.56;

const baseline = (F: Frame) => line(F.x0, F.y1 + 0.5, F.x1, F.y1 + 0.5);

/** Small bracket over a time window, with a label above it. */
function span(F: Frame, a: number, b: number, y: number, s: string, h: number, anchor: "start" | "middle" | "end" = "middle"): string {
  const xa = F.x(a), xb = F.x(b);
  const tx = anchor === "start" ? xa : anchor === "end" ? xb : (xa + xb) / 2;
  return `<path d="M${f1(xa)},${f1(y + 3)}V${f1(y)}H${f1(xb)}V${f1(y + 3)}" fill="none" stroke="${RULE}" stroke-width="1"/>` +
    text(tx, y - 2.5, s, h, anchor);
}

const ex = (t: number, tau: number) => 1 - Math.exp(-t / tau);

// ---------------------------------------------------------------- battery

function bat(w: number, h: number): string {
  const lab = fs(h) + 5;
  const F = frame(w, h, lab + 4, PAD + 1, PAD + Math.ceil(tw("R0", h)) + 4);
  const rest = 0.97, r0 = 0.3, pol = 0.62, tau = 0.11;
  const on = 0.07, sOff = 0.15, lOff = 0.56;
  const rel = (end: number) => (t: number) => rest - pol * ex(end - on, tau) * Math.exp(-(t - end) / (tau * 0.9));
  const load = (t: number) => rest - r0 - pol * ex(t - on, tau);
  const shortP = trace(F, [[0, on, () => rest], [on, sOff, load], [sOff, 1, rel(sOff)]]);
  const longP = trace(F, [[0, on, () => rest], [on, lOff, load], [lOff, 1, rel(lOff)]]);
  const yDropMid = (F.y(rest) + F.y(rest - r0)) / 2;
  return baseline(F) +
    grey(shortP) + ink(longP) +
    text(F.x(on) - 3, yDropMid + 3, "R0", h, "end") +
    pair(F, h, lab, on, sOff, "short: R0", sOff + 0.03, "long + rest: R1, C1");
}

// ---------------------------------------------------------- mass-spring

/** Two test brackets over the top band: an easy one (left) and the informative one (right). */
function pair(F: Frame, h: number, lab: number, a: number, b: number, sl: string, c: number, ll: string): string {
  const after = F.x(a) + tw(sl, h) + 6;
  const start = Math.max(c, (after - F.x0) / (F.x1 - F.x0));
  return span(F, a, b, lab, sl, h, "start") + span(F, start, 1, lab, ll, h, "end");
}

function osc(w: number, h: number): string {
  const lab = fs(h) + 5;
  const F = frame(w, h, lab + 4, PAD + 1);
  const split = 0.44;
  const free = (t: number) => 0.5 + 0.48 * Math.exp(-t / 0.12) * Math.cos((t * 2 * Math.PI) / 0.085);
  const forced = (t: number) => {
    const u = t - split - 0.04;
    return 0.5 + 0.3 * ex(Math.max(0, u), 0.08) * Math.sin((u * 2 * Math.PI) / 0.14);
  };
  const mid = F.y(0.5);
  return line(F.x0, mid, F.x1, mid, GUIDE) +
    grey(trace(F, [[0, split - 0.03, free]], 120)) +
    ink(trace(F, [[split + 0.04, 1, forced]], 120)) +
    pair(F, h, lab, 0, split - 0.03, "free: c/m, k/m", split + 0.04, "forced: adds m");
}

// ------------------------------------------------------------- thermal RC

function th(w: number, h: number): string {
  const lab = fs(h) + 5;
  const F = frame(w, h, lab + 4, PAD + 1);
  const amb = 0.04, gain = 0.8, tau = 0.2, on = 0.05, sOff = 0.17;
  const heat = (t: number) => amb + gain * ex(t - on, tau);
  const cool = (end: number) => (t: number) => amb + gain * ex(end - on, tau) * Math.exp(-(t - end) / tau);
  const shortP = trace(F, [[0, on, () => amb], [on, sOff, heat], [sOff, 0.85, cool(sOff)]]);
  const longP = trace(F, [[0, on, () => amb], [on, 1, heat]]);
  const plateau = F.y(amb + gain);
  return baseline(F) +
    line(F.x(0.5), plateau, F.x1, plateau, GUIDE) +
    grey(shortP) + ink(longP) +
    text(F.x1, plateau + fs(h) + 3, "plateau sets R", h, "end") +
    pair(F, h, lab, on, sOff, "short: C", sOff + 0.04, "long: C and R");
}

// ------------------------------------------------------- LFP temperatures

function lfp(w: number, h: number): string {
  const lab = fs(h) + 5;
  const F = frame(w, h, lab + 4, PAD + 1);
  const temps: [string, number, number][] = [["10°C", 0.5, 0.16], ["25°C", 0.34, 0.1], ["40°C", 0.22, 0.07]];
  const gap = 0.04, wid = (1 - gap * 2) / 3;
  let out = baseline(F);
  temps.forEach(([name, drop, tau], i) => {
    const a = i * (wid + gap), on = a + wid * 0.06, off = a + wid * 0.22, b = a + wid;
    const rest = 0.94;
    const load = (t: number) => rest - drop - 0.38 * ex(t - on, tau * 0.25);
    const vOff = load(off);
    const relax = (t: number) => rest - (rest - vOff - drop) * Math.exp(-(t - off) / (tau * 0.5));
    out += ink(trace(F, [[a, on, () => rest], [on, off, load], [off, off, () => vOff + drop], [off, b, relax]], 40));
    out += span(F, a, b, lab, name, h, "middle");
  });
  return out;
}

// --------------------------------------------------------------- building

function bld(w: number, h: number): string {
  const lab = fs(h) + 5;
  const F = frame(w, h, lab + 4, PAD + 1);
  const days = 4;
  const outdoor = (t: number) => 0.13 + 0.1 * Math.sin(2 * Math.PI * days * t - Math.PI / 2);
  const on = 0.5, off = 0.75;
  const room = (t: number) => {
    let v = 0.52 + 0.07 * Math.sin(2 * Math.PI * days * t - Math.PI / 2 - 0.8);
    if (t > on) v += 0.32 * ex(Math.min(t, off) - on, 0.06) * (t > off ? Math.exp(-(t - off) / 0.07) : 1);
    return v;
  };
  let out = "";
  for (let d = 1; d < days; d++) out += line(F.x(d / days), F.y0, F.x(d / days), F.y1, GUIDE);
  out += baseline(F);
  out += grey(trace(F, [[0, 1, outdoor]], 160)) + ink(trace(F, [[0, 1, room]], 160));
  out += text(F.x0, F.y(room(0.02)) - 7, "room", h);
  out += text(F.x(0.25), (F.y(0.25) + F.y(0.46)) / 2 + fs(h) * 0.35, "outdoor", h, "middle");
  out += span(F, on, off, lab, "planned heating step", h, "middle");
  return out;
}

// ---------------------------------------------------------------- kinetics

function kin(w: number, h: number): string {
  const s = fs(h);
  const F = frame(w, h, PAD, s + 7, s + 7, PAD);
  const cx = F.x(0.52), cy = F.y(0.5);
  const sx = F.x1 - F.x0, sy = F.y1 - F.y0;
  // The valley lies along a diagonal of the plot box in screen space.
  const ang = (Math.atan2(sy * 0.8, sx * 0.8) * 180) / Math.PI;
  const len = Math.hypot(sx * 0.8, sy * 0.8) / 2;
  const big = `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(len)}" ry="${f1(Math.max(3, sy * 0.07))}" transform="rotate(${f1(-ang)} ${f1(cx)} ${f1(cy)})" fill="none" stroke="${GREY}" stroke-width="1.5"/>`;
  const r = Math.max(4, sy * 0.1);
  const small = `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(r * 1.3)}" ry="${f1(r)}" fill="#fff" stroke="${INK}" stroke-width="2"/>` +
    `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="1.5" fill="${INK}"/>`;
  const axes = line(F.x0, F.y1 + 0.5, F.x1, F.y1 + 0.5) + line(F.x0 - 0.5, F.y0, F.x0 - 0.5, F.y1);
  const ylab = `<text transform="translate(${f1(F.x0 - 5)} ${f1(F.y1)}) rotate(-90)" font-size="${s}" font-family="system-ui,-apple-system,sans-serif" fill="${LABEL}">rate k</text>`;
  return axes + big + small + ylab +
    text(F.x1, h - PAD - 2, "diffusion D", h, "end") +
    text(F.x1, F.y(0.22), "one batch", h, "end") +
    text(cx - r * 1.3 - 5, cy - r + 1, "+ 2nd condition", h, "end");
}

// ---------------------------------------------------- model self-monitoring
// A short factual sentence set as real text. Under each token, a grey span runs as far as that
// token's logit margin (top choice over the runner-up), so the gaps between spans mark token
// boundaries. The one low-margin token is the year; it alone carries a faint full-width track
// with its short margin in ink. Each token's advance is estimated from Helvetica-like widths and
// pinned with textLength, so a wider or narrower system font cannot overflow the box or drift
// off its span.

const TEXT_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',Helvetica,Arial,sans-serif";
const DARK = "#424242";
const EM: Record<string, number> = { f: 0.3, i: 0.24, j: 0.24, l: 0.24, r: 0.35, t: 0.3, m: 0.84, w: 0.74, ".": 0.28 };
const em = (c: string) => EM[c] ?? (/[A-Z]/.test(c) ? (c === "W" ? 0.94 : c === "I" ? 0.28 : 0.68) : 0.56);

type Tok = { s: string; x: number; w: number };

/** Lay tokens out on one line centred on cx; a token that starts with punctuation attaches
 * to the previous one. */
function layout(raw: string[], size: number, cx: number): Tok[] {
  const ws = raw.map((s) => [...s].reduce((a, c) => a + em(c), 0) * size);
  const sp = raw.map((s, i) => (i === 0 ? 0 : /^[.,]/.test(s) ? 0.1 * size : 0.32 * size));
  let x = cx - (ws.reduce((a, b) => a + b, 0) + sp.reduce((a, b) => a + b, 0)) / 2;
  return raw.map((s, i) => {
    x += sp[i];
    const t = { s, x, w: ws[i] };
    x += ws[i];
    return t;
  });
}

const SLM_TOKENS: Record<"short" | "long", [string, number][]> = {
  short: [["The", 0.92], ["Eiffel", 0.95], ["Tower", 0.9], ["opened", 0.78], ["in", 0.9], ["1889", 0.24], [".", 0]],
  long: [
    ["The", 0.92], ["Eiffel", 0.95], ["Tower", 0.9], ["in", 0.88], ["Paris", 0.93],
    ["opened", 0.78], ["in", 0.9], ["1889", 0.24], [".", 0],
  ],
};

function slm(w: number, h: number): string {
  const size = h >= 90 ? 11 : 10;
  const toks = SLM_TOKENS[w >= 300 ? "long" : "short"];
  const t = layout(toks.map(([s]) => s), size, w / 2);
  const focus = toks.findIndex(([s]) => s === "1889");
  const y = h / 2 + size * 0.3, uy = y + 5;
  let out = t.map((k) =>
    `<text x="${f1(k.x)}" y="${f1(y)}" font-size="${size}" font-family="${TEXT_FONT}" fill="${DARK}" textLength="${f1(k.w)}" lengthAdjust="spacingAndGlyphs">${k.s}</text>`
  ).join("");
  t.forEach((k, i) => {
    if (/^[.,]/.test(k.s)) return;
    const x0 = k.x + 0.75, x1 = k.x + k.w - 0.75, len = Math.max(2, (x1 - x0) * toks[i][1]);
    out += i === focus
      ? line(x0, uy, x1, uy, GUIDE, 2, ROUND) + line(x0, uy, x0 + len, uy, INK, 2, ROUND)
      : line(x0, uy, x0 + len, uy, GREY, 1.5, ROUND);
  });
  return out;
}

// ------------------------------------------------------ particle world energy
// The same lattice world twice, side by side: grey field sites and two creatures, each drawing
// on the same neighbouring sites (equal inflow in both panels, so nothing reads as a result).
// Above each lattice a hairline baseline carries the sunlight forcing as a raised segment, as
// bat and lfp draw a test: a short grey pulse on the left, a long ink step on the right.

/** Small open chevron pointing along angle a, tip at (x, y). */
function chevron(x: number, y: number, a: number, color: string, width: number, size: number): string {
  const p = (da: number) => `${f1(x - size * Math.cos(a + da))},${f1(y - size * Math.sin(a + da))}`;
  return `<path d="M${p(0.65)}L${f1(x)},${f1(y)}L${p(-0.65)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function nrg(w: number, h: number): string {
  const big = w >= 300;
  const sp = big ? 15 : 12, gap = big ? 24 : 14, half = w / 2;
  const cr = big ? 2.5 : 2.2, lift = 3.5;
  const yRaised = PAD + 1.5, yBase = yRaised + lift, top = yBase + 5, bottom = h - PAD - 2;
  const rows = Math.floor((bottom - top) / sp) + 1;
  const oy = top + (bottom - top - (rows - 1) * sp) / 2;

  const panel = (x0: number, x1: number, end: number, color: string, width: number) => {
    const cols = Math.floor((x1 - x0) / sp) + 1;
    const ox = (x0 + x1 - (cols - 1) * sp) / 2;
    const at = (c: number, r: number): Pt => [ox + c * sp, oy + r * sp];
    // Two creatures, each fed from two sites in one half-plane (opposite halves, so the strokes
    // never line up through a creature and there is no global direction).
    const creatures: [number, number, [number, number][]][] = [
      [Math.round((cols - 1) * 0.25), 1, [[-1, 0], [-1, -1]]],
      [Math.round((cols - 1) * 0.72), rows - 2, [[1, 0], [1, 1]]],
    ];
    const taken = new Set<string>();
    let marks = "";
    for (const [c, r, from] of creatures) {
      taken.add(`${c},${r}`);
      const [cx, cy] = at(c, r);
      for (const [dc, dr] of from) {
        taken.add(`${c + dc},${r + dr}`);
        const [x, y] = at(c + dc, r + dr);
        const d = Math.hypot(cx - x, cy - y), ux = (cx - x) / d, uy = (cy - y) / d, stop = d - cr - 2.5;
        marks += line(x, y, x + ux * stop, y + uy * stop, GREY, 1.2, ROUND) +
          chevron(x + ux * stop, y + uy * stop, Math.atan2(uy, ux), GREY, 1.2, 2.5);
      }
      marks += dot(cx, cy, cr, GREY);
    }
    let field = "";
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) if (!taken.has(`${c},${r}`)) field += dot(...at(c, r), 0.9, GREY);
    }
    const bx0 = ox - 2, bx1 = ox + (cols - 1) * sp + 2, bw = bx1 - bx0;
    const xa = bx0 + bw * 0.2, xb = bx0 + bw * end;
    const forcing = line(bx0, yBase, bx1, yBase) +
      `<path d="M${f1(xa)},${f1(yBase)}V${f1(yRaised)}H${f1(xb)}V${f1(yBase)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    return { forcing, body: field + marks };
  };

  const pw = (half - gap / 2) - (PAD + 4);
  const pulseEnd = 0.2 + (big ? 10 : 7) / (pw + 4);
  const left = panel(PAD + 4, half - gap / 2, pulseEnd, GREY, 1.5);
  const right = panel(half + gap / 2, w - PAD - 4, 0.8, INK, 2);
  return left.forcing + right.forcing + left.body + right.body;
}

// --------------------------------------------------------------- discovery
// Recorded held-out RMSE, one seed. Calibration alone (grey) → Spark + Autophys (ink).

const DISC: [string, number, number][] = [
  ["lag", 0.57, 0.05],
  ["delay", 0.35, 0.07],
  ["quantized", 0.32, 0.25],
  ["null twin", 0.05, 0.05],
  ["off-grammar", 0.29, 0.39],
  ["offset", 0.3, 7.08],
];

function disc(w: number, h: number): string {
  const s = fs(h);
  const nameW = Math.ceil(tw("off-grammar", h) * 1.04) + PAD + 6;
  const axisBand = s + 4;
  const F = frame(w, h, PAD + 1, axisBand + 1, nameW, PAD + 4);
  const lo = Math.log10(0.035), hi = Math.log10(10);
  const x = (v: number) => F.x((Math.log10(v) - lo) / (hi - lo));
  const rowH = (F.y1 - F.y0) / DISC.length;
  let out = "";
  for (const t of [0.1, 1]) out += line(x(t), F.y0, x(t), F.y1, GUIDE);
  out += line(F.x0, F.y1 + 0.5, F.x1, F.y1 + 0.5);
  DISC.forEach(([name, before, after], i) => {
    const y = F.y0 + rowH * (i + 0.5);
    const r = rowH >= 11 ? 3.5 : 3;
    out += text(nameW - 5, y + s * 0.35, name, h, "end");
    out += line(x(before), y, x(after), y, RULE, 1.5);
    out += `<circle cx="${f1(x(before))}" cy="${f1(y)}" r="${r}" fill="${GREY}" stroke="#fff" stroke-width="1"/>`;
    out += `<circle cx="${f1(x(after))}" cy="${f1(y)}" r="${r}" fill="${INK}" stroke="#fff" stroke-width="1"/>`;
  });
  const ty = h - PAD - 2;
  out += text(x(0.1), ty, "0.1", h, "middle") + text(x(1), ty, "1", h, "middle") + text(x(10) + 2, ty, "10", h, "end");
  // Legend in the axis row under the names: grey → black dot, "Spark".
  const ky = ty - s * 0.35, k0 = PAD + 3;
  out += `<circle cx="${f1(k0)}" cy="${f1(ky)}" r="3" fill="${GREY}"/>` +
    line(k0 + 5, ky, k0 + 11, ky, RULE, 1.5) +
    `<path d="M${f1(k0 + 9)},${f1(ky - 2)}L${f1(k0 + 11.5)},${f1(ky)}L${f1(k0 + 9)},${f1(ky + 2)}" fill="none" stroke="${RULE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${f1(k0 + 16)}" cy="${f1(ky)}" r="3" fill="${INK}"/>` +
    text(k0 + 22, ty, "+ Spark", h);
  return out;
}

export const VISUALS: Record<StudyId, (w: number, h: number) => string> = { bat, disc, osc, th, lfp, bld, kin, slm, nrg };

export const CAPTIONS: Record<StudyId, string> = {
  bat: "schematic, not data",
  disc: "recorded held-out RMSE, seed 0",
  osc: "schematic, not data",
  th: "schematic, not data",
  lfp: "schematic, planned test",
  bld: "schematic, planned test",
  kin: "schematic, planned test",
  slm: "illustration, planned test",
  nrg: "illustration, planned test",
};
