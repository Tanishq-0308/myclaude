#!/usr/bin/env node
// Helper for driving Android devices and emulators with adb.
// Run with no arguments for usage.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exe = process.platform === "win32" ? ".exe" : "";
const sdkRoots = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : null,
  path.join(os.homedir(), "Library", "Android", "sdk"),
  path.join(os.homedir(), "Android", "Sdk"),
].filter(Boolean);

function findTool(sub, name) {
  for (const root of sdkRoots) {
    const p = path.join(root, sub, name + exe);
    if (fs.existsSync(p)) return p;
  }
  return name;
}

const ADB = findTool("platform-tools", "adb");
const EMULATOR = findTool("emulator", "emulator");

const args = process.argv.slice(2);
let serial = process.env.ANDROID_SERIAL;
const sIdx = args.indexOf("-s");
if (sIdx !== -1) {
  serial = args[sIdx + 1];
  args.splice(sIdx, 2);
}
const [cmd, ...rest] = args;

function adb(argv, opts = {}) {
  const full = serial ? ["-s", serial, ...argv] : argv;
  const r = spawnSync(ADB, full, { encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 60000 });
  if (r.error) throw new Error(`adb failed: ${r.error.message}`);
  return r;
}

function shell(command, opts) {
  return adb(["shell", command], opts);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function devices() {
  const out = spawnSync(ADB, ["devices"], { encoding: "utf8" }).stdout ?? "";
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0] && p[1])
    .map(([id, state]) => ({ id, state }));
}

// ---------- UI hierarchy ----------

function dumpUi() {
  let r = adb(["exec-out", "uiautomator", "dump", "/dev/tty"]);
  let xml = r.stdout ?? "";
  if (!xml.includes("<hierarchy")) {
    shell("uiautomator dump /sdcard/__ui.xml");
    xml = adb(["exec-out", "cat", "/sdcard/__ui.xml"]).stdout ?? "";
  }
  if (!xml.includes("<hierarchy")) die(`Could not read the UI hierarchy:\n${xml.trim() || r.stderr}`);
  const nodes = [];
  const re = /<node\s([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nodes.push({
      text: attrs.text ?? "",
      desc: attrs["content-desc"] ?? "",
      id: (attrs["resource-id"] ?? "").replace(/^.*:id\//, ""),
      cls: (attrs.class ?? "").split(".").pop(),
      clickable: attrs.clickable === "true",
      enabled: attrs.enabled !== "false",
      checked: attrs.checked === "true",
      focused: attrs.focused === "true",
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
      w: x2 - x1,
      h: y2 - y1,
      bounds: [x1, y1, x2, y2],
    });
  }
  return nodes;
}

function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, " ");
}

function label(n) {
  return n.text || n.desc || n.id || n.cls;
}

function describe(n, i) {
  const parts = [];
  if (n.text) parts.push(`"${n.text}"`);
  if (n.desc) parts.push(`desc="${n.desc}"`);
  if (n.id) parts.push(`id=${n.id}`);
  parts.push(n.cls);
  const flags = [n.clickable && "clickable", !n.enabled && "DISABLED", n.checked && "checked", n.focused && "focused"].filter(Boolean);
  return `${String(i).padStart(3)}  (${n.x},${n.y})  ${parts.join("  ")}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`;
}

function findNodes(nodes, q) {
  const ql = q.toLowerCase();
  const exact = nodes.filter((n) => [n.text, n.desc, n.id].some((v) => v && v.toLowerCase() === ql));
  if (exact.length) return exact;
  return nodes.filter((n) => [n.text, n.desc, n.id].some((v) => v && v.toLowerCase().includes(ql)));
}

function interesting(n) {
  return n.text || n.desc || n.id || n.clickable;
}

// ---------- input helpers ----------

function escapeText(t) {
  return t.replace(/([\\"'`$&|;<>()*~#?!\[\]{}])/g, "\\$1").replace(/ /g, "%s");
}

const KEYS = { back: 4, home: 3, enter: 66, menu: 82, recent: 187, recents: 187, del: 67, delete: 67, backspace: 67, tab: 61, up: 19, down: 20, left: 21, right: 22, power: 26, escape: 111, search: 84 };

function parsePoints(list) {
  return list.map((p) => {
    const [x, y] = p.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) die(`Bad point "${p}". Use x,y`);
    return [Math.round(x), Math.round(y)];
  });
}

function supportsMotionEvent() {
  const r = shell("input 2>&1");
  return /motionevent/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

let geometryCache = null;
// Natural (physical) panel size, current rotation (0-3) and the size in the current orientation.
function screenGeometry() {
  if (geometryCache) return geometryCache;
  const out = shell("wm size").stdout ?? "";
  const m = /Physical size:\s*(\d+)x(\d+)/.exec(out);
  const [nw, nh] = m ? [Number(m[1]), Number(m[2])] : [1080, 1920];
  const o = shell("dumpsys input | grep -m1 -E 'SurfaceOrientation|orientation='").stdout ?? "";
  const om = /SurfaceOrientation:\s*(\d)|orientation=(\d)/.exec(o);
  const rot = om ? Number(om[1] ?? om[2]) : 0;
  const swapped = rot === 1 || rot === 3;
  geometryCache = { nw, nh, rot, w: swapped ? nh : nw, h: swapped ? nw : nh };
  return geometryCache;
}

function screenSize() {
  const g = screenGeometry();
  return { w: g.w, h: g.h };
}

// Find the multi-touch input device and its coordinate range (for Android < 10).
function touchDevice() {
  const out = shell("getevent -pl").stdout ?? "";
  let dev = null;
  for (const block of out.split(/add device \d+:\s*/).slice(1)) {
    const devPath = block.split(/\s/)[0];
    const mx = /ABS_MT_POSITION_X\s*:.*max (\d+)/.exec(block);
    const my = /ABS_MT_POSITION_Y\s*:.*max (\d+)/.exec(block);
    if (mx && my) {
      dev = {
        path: devPath,
        maxX: Number(mx[1]),
        maxY: Number(my[1]),
        btnTouch: /BTN_TOUCH/.test(block),
        toolType: /ABS_MT_TOOL_TYPE/.test(block),
        pressure: /ABS_MT_PRESSURE/.test(block),
        major: /ABS_MT_TOUCH_MAJOR/.test(block),
        slot: /ABS_MT_SLOT/.test(block),
      };
      break;
    }
  }
  return dev;
}

// Maps a point in screen coordinates (current orientation) to raw touch-panel coordinates.
function rawMapper(dev) {
  const { nw, nh, rot } = screenGeometry();
  return (x, y) => {
    let px = x, py = y;
    if (rot === 1) [px, py] = [nw - y, x];
    else if (rot === 2) [px, py] = [nw - x, nh - y];
    else if (rot === 3) [px, py] = [y, nh - x];
    const rx = Math.max(0, Math.min(dev.maxX, Math.round((px / nw) * dev.maxX)));
    const ry = Math.max(0, Math.min(dev.maxY, Math.round((py / nh) * dev.maxY)));
    return [rx, ry];
  };
}

// Streams raw multi-touch events straight into the touch device through one adb connection.
// Hundreds of times faster than `sendevent` (one process per event) or `input motionevent`
// (one app_process per point), and gives real continuous strokes on every Android version.
function evdevWritable(dev) {
  const r = shell(`sendevent ${dev.path} 0 0 0 2>&1; echo rc=$?`);
  return /rc=0/.test(r.stdout ?? "") && !/denied|not permitted/i.test(r.stdout ?? "");
}

// Android 12+: register a virtual touchscreen with the built-in `uinput` tool and replay the strokes.
// All timing happens on the device, so it's fast and smooth regardless of the host.
// Pause after each stroke. A pen is never palm-rejected, so short gaps are fine. Fingers: many drawing
// apps reject a touch that starts within ~150 ms of the previous one (palm rejection), so keep
// stroke starts at least ~220 ms apart.
function gapAfter(stroke, perPointMs, { strokeGap, tool }) {
  if (strokeGap != null && !Number.isNaN(strokeGap)) return Math.round(strokeGap);
  if (tool !== "finger") return 60;
  const duration = stroke.length * perPointMs;
  return Math.round(Math.max(90, 220 - duration));
}

function uinputStrokes(strokes, { slow = 0, strokeGap, tool = "pen" } = {}) {
  const { nw, nh } = screenGeometry();
  const map = rawMapper({ maxX: nw - 1, maxY: nh - 1 });
  const lines = [
    JSON.stringify({
      id: 1, command: "register", name: "myclaude-touch", vid: 0x18d1, pid: 0x4ee1, bus: "usb",
      configuration: [
        { type: 100, data: [1, 3] },
        { type: 101, data: [330] },
        { type: 103, data: [47, 48, 53, 54, 55, 57, 58] },
        { type: 110, data: [1] },
      ],
      abs_info: [
        { code: 47, info: { value: 0, minimum: 0, maximum: 9, fuzz: 0, flat: 0, resolution: 0 } },
        { code: 48, info: { value: 0, minimum: 0, maximum: 255, fuzz: 0, flat: 0, resolution: 0 } },
        { code: 53, info: { value: 0, minimum: 0, maximum: nw - 1, fuzz: 0, flat: 0, resolution: 0 } },
        { code: 54, info: { value: 0, minimum: 0, maximum: nh - 1, fuzz: 0, flat: 0, resolution: 0 } },
        { code: 55, info: { value: 0, minimum: 0, maximum: 2, fuzz: 0, flat: 0, resolution: 0 } },
        { code: 57, info: { value: 0, minimum: 0, maximum: 65535, fuzz: 0, flat: 0, resolution: 0 } },
        { code: 58, info: { value: 0, minimum: 0, maximum: 255, fuzz: 0, flat: 0, resolution: 0 } },
      ],
    }),
    JSON.stringify({ id: 1, command: "delay", duration: 400 }),
  ];
  const inject = (events) => lines.push(JSON.stringify({ id: 1, command: "inject", events }));
  const delay = (ms) => lines.push(JSON.stringify({ id: 1, command: "delay", duration: ms }));
  let id = 1;
  for (const stroke of strokes) {
    const pts = stroke.map(([x, y]) => map(x, y));
    if (pts.length === 1) pts.push([pts[0][0] + 1, pts[0][1] + 1]);
    let ev = [3, 47, 0, 3, 57, id++, 3, 55, tool === "finger" ? 0 : 1, 3, 48, 6, 1, 330, 1];
    pts.forEach(([x, y], i) => {
      ev.push(3, 53, x, 3, 54, y, 3, 58, 60, 0, 0, 0);
      if (slow || (i + 1) % 2 === 0 || i === pts.length - 1) {
        inject(ev);
        ev = [];
        delay(slow || 4);
      }
    });
    inject([3, 57, -1, 1, 330, 0, 0, 0, 0]);
    delay(gapAfter(pts, slow || 2.5, { strokeGap, tool }));
  }
  delay(700);
  const local = path.join(os.tmpdir(), `myclaude-touch-${process.pid}.json`);
  fs.writeFileSync(local, lines.join("\n") + "\n");
  const remote = "/data/local/tmp/myclaude-touch.json";
  const pushed = adb(["push", local, remote]);
  fs.rmSync(local, { force: true });
  if (pushed.status !== 0) return false;
  const r = shell(`uinput ${remote} 2>&1; echo rc=$?; rm -f ${remote}`, { timeout: 600000 });
  return /rc=0/.test(r.stdout ?? "");
}

async function injectStrokes(strokes, opts = {}) {
  const dev = touchDevice();
  if (dev && evdevWritable(dev) && (await streamEvdev(dev, strokes, opts))) return "touch stream";
  if (/uinput/.test(shell("which uinput").stdout ?? "") && uinputStrokes(strokes, opts)) return "virtual touchscreen";
  return null;
}

async function streamEvdev(dev, strokes, { chunk = 3, chunkDelay = 5, strokeGap, slow = 0, tool = "pen" } = {}) {
  const is64 = /64/.test(shell("getprop ro.product.cpu.abi").stdout ?? "");
  const size = is64 ? 24 : 16;
  const map = rawMapper(dev);
  const ev = (type, code, value) => {
    const b = Buffer.alloc(size);
    const off = size - 8;
    b.writeUInt16LE(type, off);
    b.writeUInt16LE(code, off + 2);
    b.writeInt32LE(value, off + 4);
    return b;
  };
  const child = spawn(ADB, [...(serial ? ["-s", serial] : []), "exec-in", `cat > ${dev.path}`], { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const closed = new Promise((r) => child.on("close", r));
  const write = (bufs) => new Promise((r) => child.stdin.write(Buffer.concat(bufs), r));
  let batch = [];
  const flush = async (delay) => {
    if (batch.length) await write(batch);
    batch = [];
    if (delay) await sleep(delay);
  };
  let id = 1;
  for (const stroke of strokes) {
    const pts = stroke.map(([x, y]) => map(x, y));
    if (pts.length === 1) pts.push([pts[0][0] + 1, pts[0][1] + 1]);
    if (dev.slot) batch.push(ev(3, 47, 0));
    batch.push(ev(3, 57, (id = (id % 10) + 1)));
    if (dev.toolType) batch.push(ev(3, 55, tool === "finger" ? 0 : 1));
    if (dev.major) batch.push(ev(3, 48, 6));
    for (let i = 0; i < pts.length; i++) {
      batch.push(ev(3, 53, pts[i][0]), ev(3, 54, pts[i][1]));
      if (dev.pressure) batch.push(ev(3, 58, 60));
      if (i === 0 && dev.btnTouch) batch.push(ev(1, 330, 1));
      batch.push(ev(0, 0, 0));
      if (slow) await flush(slow);
      else if ((i + 1) % chunk === 0) await flush(chunkDelay);
    }
    batch.push(ev(3, 57, -1));
    if (dev.btnTouch) batch.push(ev(1, 330, 0));
    batch.push(ev(0, 0, 0));
    await flush(gapAfter(pts, slow || chunkDelay / chunk, { strokeGap, tool }));
  }
  child.stdin.end();
  await closed;
  if (/denied|not permitted|No such file/i.test(err)) return false;
  return true;
}

function drawStrokeFallback(points, tool = "pen") {
  if (supportsMotionEvent()) {
    const src = tool === "finger" ? "" : "stylus ";
    const cmds = [`input ${src}motionevent DOWN ${points[0][0]} ${points[0][1]}`];
    for (const [x, y] of points.slice(1)) cmds.push(`input ${src}motionevent MOVE ${x} ${y}`);
    const [lx, ly] = points[points.length - 1];
    cmds.push(`input ${src}motionevent UP ${lx} ${ly}`);
    if (tool === "finger") cmds.push("sleep 0.25");
    shell(cmds.join("; "), { timeout: 120000 });
    return "motionevent";
  }
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    shell(`input swipe ${x1} ${y1} ${x2} ${y2} 60`);
  }
  return "swipes";
}

function touchSlopPx() {
  const m = /(\d+)\s*$/.exec((shell("wm density").stdout ?? "").trim());
  const dpi = m ? Number(m[1]) : 320;
  return Math.ceil((8 * dpi) / 160);
}

// Makes injected strokes behave like a real finger:
// - densify: points every few pixels (sparse jumps get swallowed by gesture detectors)
// - lead-in: many apps (anything using Compose drag gestures) only start drawing once the finger has moved
//   past the "touch slop" (~8dp). We first travel a little along the stroke and come back, so those apps
//   start drawing at the real starting point; apps that draw immediately just retrace the same line.
function prepareStrokes(strokes, { step = 4, leadIn } = {}) {
  const slop = leadIn ?? Math.round(touchSlopPx() * 1.5);
  return strokes.map((s) => {
    const dense = [s[0]];
    for (let i = 1; i < s.length; i++) {
      const [x0, y0] = s[i - 1];
      const [x1, y1] = s[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 1; k <= n; k++) dense.push([Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n)]);
    }
    const xs = dense.map((p) => p[0]);
    const ys = dense.map((p) => p[1]);
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (extent < 4) {
      // A dot: a tiny circle traced twice, so it shows up as a round dot.
      const [x, y] = dense[0];
      const ring = Array.from({ length: 9 }, (_, i) => [Math.round(x + 3 * Math.cos((i * Math.PI) / 4)), Math.round(y + 3 * Math.sin((i * Math.PI) / 4))]);
      return [[x, y], ...ring, ...ring, [x, y]];
    }
    if (!slop || extent < slop) return dense;
    let travelled = 0;
    const lead = [dense[0]];
    for (let i = 1; i < dense.length && travelled < slop; i++) {
      travelled += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
      lead.push(dense[i]);
    }
    if (travelled < slop) {
      const [x, y] = dense[0];
      return [...dense, ...[...dense].reverse(), [x + 1, y]];
    }
    return [...lead, ...lead.slice(0, -1).reverse(), ...dense.slice(1)];
  });
}

async function drawStrokes(strokes, opts = {}) {
  strokes = strokes.filter((s) => s.length);
  if (!strokes.length) return "nothing";
  strokes = prepareStrokes(strokes, opts);
  const fast = await injectStrokes(strokes, opts);
  if (fast) return fast;
  let how = "";
  for (const s of strokes) how = drawStrokeFallback(s.filter((_, i) => i % 3 === 0 || i === s.length - 1), opts.tool);
  return how;
}

// ---------- single-stroke fonts (for writing text) ----------

const FONT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "fonts");
const FONTS = {
  print: "HersheySans1.svg",
  neat: "EMSReadability.svg",
  cursive: "HersheyScript1.svg",
  elegant: "EMSAllure.svg",
};

function parsePath(d) {
  const toks = d.match(/[MLCQZHVmlcqzhv]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const strokes = [];
  let cur = null, x = 0, y = 0, cmd = "M", i = 0, sx = 0, sy = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const relative = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") {
      if (cur) cur.push([sx, sy]);
      x = sx; y = sy;
      continue;
    }
    if (C === "M") {
      const nx = num() + (relative ? x : 0), ny = num() + (relative ? y : 0);
      x = nx; y = ny; sx = x; sy = y;
      cur = [[x, y]];
      strokes.push(cur);
      cmd = relative ? "l" : "L";
    } else if (C === "L") {
      x = num() + (relative ? x : 0); y = num() + (relative ? y : 0);
      cur?.push([x, y]);
    } else if (C === "H") {
      x = num() + (relative ? x : 0);
      cur?.push([x, y]);
    } else if (C === "V") {
      y = num() + (relative ? y : 0);
      cur?.push([x, y]);
    } else if (C === "C" || C === "Q") {
      const n = C === "C" ? 3 : 2;
      const p = [[x, y]];
      for (let k = 0; k < n; k++) p.push([num() + (relative ? x : 0), num() + (relative ? y : 0)]);
      for (let s = 1; s <= 8; s++) {
        const t = s / 8, u = 1 - t;
        const q = C === "C"
          ? [u ** 3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t ** 3 * p[3][0], u ** 3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t ** 3 * p[3][1]]
          : [u * u * p[0][0] + 2 * u * t * p[1][0] + t * t * p[2][0], u * u * p[0][1] + 2 * u * t * p[1][1] + t * t * p[2][1]];
        cur?.push(q);
      }
      [x, y] = p[n];
    } else {
      i++;
    }
  }
  return strokes;
}

const fontCache = {};
function loadFont(name) {
  const file = FONTS[name];
  if (!file) die(`Unknown font "${name}". Use one of: ${Object.keys(FONTS).join(", ")}`);
  if (fontCache[name]) return fontCache[name];
  const svg = fs.readFileSync(path.join(FONT_DIR, file), "utf8");
  const glyphs = new Map();
  for (const m of svg.matchAll(/<glyph\s([\s\S]*?)\/>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    if (attrs.unicode === undefined) continue;
    const ch = decode(attrs.unicode.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))));
    glyphs.set(ch, { adv: Number(attrs["horiz-adv-x"] ?? 500), strokes: attrs.d ? parsePath(attrs.d) : [] });
  }
  return (fontCache[name] = glyphs);
}

// Lays text out in screen coordinates. size = capital-letter height in pixels; (x, y) = top-left.
function layoutText(text, { font = "neat", x, y, size, width, lineHeight }) {
  const glyphs = loadFont(font);
  const scale = size / 500;
  const space = (glyphs.get(" ")?.adv ?? 300) * scale;
  const adv = (ch) => (glyphs.get(ch)?.adv ?? 400) * scale;
  const maxX = x + width;
  const lh = lineHeight ?? size * 2.1;
  const strokes = [];
  let baseline = y + size;
  for (const para of text.split(/\r?\n|\\n/)) {
    let cx = x;
    for (const word of para.split(/ +/)) {
      const w = [...word].reduce((s, ch) => s + adv(ch), 0);
      if (cx > x && cx + w > maxX) {
        cx = x;
        baseline += lh;
      }
      for (const ch of word) {
        const g = glyphs.get(ch);
        if (g) {
          for (const s of g.strokes) {
            const pts = [];
            for (const [gx, gy] of s) {
              const p = [Math.round(cx + gx * scale), Math.round(baseline - gy * scale)];
              const last = pts[pts.length - 1];
              if (!last || Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) >= 2) pts.push(p);
            }
            if (pts.length) strokes.push(pts);
          }
        }
        cx += adv(ch);
      }
      cx += space;
    }
    baseline += lh;
  }
  return strokes;
}

function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}

// ---------- commands ----------

const USAGE = `android.mjs – drive an Android device/emulator with adb

Usage: node android.mjs [-s SERIAL] <command> [args]

Devices & emulators
  devices                       List connected devices
  avds                          List emulators (AVDs) you can start
  start <avd> [--headless]      Start an emulator in the background and wait until it has booted
                                (--headless: no window; you still see it via screenshots)
  stop [serial]                 Shut an emulator down
  wait-boot [seconds]           Wait until the device has finished booting

Seeing the screen
  screenshot [name|path]        Save a screenshot (a bare name goes in ./screenshots/, folders are
                                created automatically) and print its full path; then view the PNG
  ui [--all]                    List on-screen elements with their tap coordinates
  find <text|id|desc>           Find elements matching text, resource id or content description
  size                          Screen size in pixels
  current                       The app/activity currently in front

Acting
  tap <text|id|desc>            Find an element and tap its centre (never guess coordinates)
  tap <x> <y>                   Tap a point
  longpress <text|x y> [ms]     Long-press an element or point
  type <text>                   Type text into the focused field
  key <back|home|enter|del|tab|menu|recent|N>
  swipe <x1> <y1> <x2> <y2> [ms]
  scroll <up|down|left|right>   Scroll the screen
  write "<text>" [--font neat|print|cursive|elegant] [--size px] [--x px] [--y px] [--width px]
                                Handwrite text with a real single-stroke font (fast, wraps lines).
                                size = capital letter height; x,y = top-left. Default font: neat
  draw <x,y> <x,y> [...] [| <x,y> <x,y> ...] [--slow ms]
                                Draw continuous strokes through the points; | starts a new stroke
  draw-path "<SVG path d>" [--x px] [--y px] [--scale n]
                                Draw an SVG path (M/L/C/Q/H/V/Z) - best for pictures and logos
  draw-shape <circle|rect|line> <args>
                                circle cx cy r · rect x1 y1 x2 y2 · line x1 y1 x2 y2

Apps
  launch <package>              Launch an app
  stop-app <package>            Force-stop an app
  clear <package>               Clear an app's data
  install <apk>                 Install or update an APK
  logcat [tag:level ...]        Recent errors (default: AndroidRuntime:E *:E)
`;

async function waitBoot(seconds = 180) {
  const end = Date.now() + seconds * 1000;
  spawnSync(ADB, [...(serial ? ["-s", serial] : []), "wait-for-device"], { timeout: seconds * 1000 });
  let booted = false;
  while (Date.now() < end && !booted) {
    const r = shell("getprop sys.boot_completed", { timeout: 10000 });
    booted = (r.stdout ?? "").trim() === "1";
    if (!booted) await sleep(2000);
  }
  if (!booted) return false;
  // boot_completed fires while Android still shows "Phone is starting…" (FallbackHome); wait for the real home screen.
  const homeEnd = Math.min(end, Date.now() + 90000);
  while (Date.now() < homeEnd) {
    const focus = shell("dumpsys window | grep -m1 mCurrentFocus", { timeout: 10000 }).stdout ?? "";
    if (focus.trim() && !/FallbackHome|null|StatusBar/i.test(focus)) return true;
    await sleep(2000);
  }
  return true;
}

async function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;

    case "devices": {
      const list = devices();
      if (!list.length) return console.log("No devices connected. Start an emulator with: start <avd>");
      for (const d of list) {
        const model = d.state === "device" ? spawnSync(ADB, ["-s", d.id, "shell", "getprop", "ro.product.model"], { encoding: "utf8" }).stdout.trim() : "";
        console.log(`${d.id}  ${d.state}${model ? "  " + model : ""}`);
      }
      return;
    }

    case "avds": {
      const out = spawnSync(EMULATOR, ["-list-avds"], { encoding: "utf8" }).stdout ?? "";
      const avds = out.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("INFO"));
      console.log(avds.length ? avds.join("\n") : "No AVDs found. Create one in Android Studio > Device Manager.");
      return;
    }

    case "start": {
      const avd = rest.find((a) => !a.startsWith("--"));
      if (!avd) die("Usage: start <avd> [--headless]");
      const headless = rest.includes("--headless");
      const before = new Set(devices().map((d) => d.id));
      const emuArgs = ["-avd", avd, "-no-snapshot-save", "-no-audio", "-no-boot-anim"];
      if (headless) emuArgs.push("-no-window");
      const child = spawn(EMULATOR, emuArgs, { detached: true, stdio: "ignore", windowsHide: headless });
      child.unref();
      console.log(`Starting ${avd}${headless ? " (headless, no window)" : ""}…`);
      let id = null;
      const end = Date.now() + 120000;
      while (!id && Date.now() < end) {
        await sleep(2000);
        id = devices().find((d) => d.id.startsWith("emulator-") && !before.has(d.id))?.id ?? null;
      }
      if (!id) die("The emulator did not appear in `adb devices` within 2 minutes.");
      serial = id;
      const ok = await waitBoot(240);
      console.log(ok ? `Booted: ${id}. Use -s ${id} if more than one device is connected.` : `Started as ${id}, but boot did not finish in time.`);
      return;
    }

    case "stop": {
      if (rest[0]) serial = rest[0];
      adb(["emu", "kill"]);
      console.log(`Stopping ${serial ?? "emulator"}`);
      return;
    }

    case "wait-boot": {
      const ok = await waitBoot(Number(rest[0] ?? 180));
      console.log(ok ? "Device is ready" : "Timed out waiting for boot");
      if (!ok) process.exit(1);
      return;
    }

    case "screenshot": {
      let file = rest[0] ?? `screenshot-${Date.now()}.png`;
      if (!/[\\/]/.test(file)) file = path.join("screenshots", file);
      if (!/\.png$/i.test(file)) file += ".png";
      const r = adb(["exec-out", "screencap", "-p"], { binary: true });
      if (!r.stdout?.length) die(`Screenshot failed: ${r.stderr?.toString()}`);
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, r.stdout);
      console.log(path.resolve(file));
      return;
    }

    case "size": {
      console.log((shell("wm size").stdout ?? "").trim());
      return;
    }

    case "current": {
      const out = shell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -1").stdout ?? "";
      console.log(out.trim() || "(unknown)");
      return;
    }

    case "ui": {
      const nodes = dumpUi();
      const list = rest.includes("--all") ? nodes : nodes.filter(interesting);
      list.forEach((n, i) => console.log(describe(n, i)));
      if (!list.length) console.log("(no labelled elements; take a screenshot to see the screen)");
      return;
    }

    case "find": {
      const q = rest.join(" ");
      if (!q) die("Usage: find <text|id|desc>");
      const hits = findNodes(dumpUi(), q);
      if (!hits.length) return console.log(`Nothing matches "${q}". Run "ui" to see what's on screen.`);
      hits.forEach((n, i) => console.log(describe(n, i)));
      return;
    }

    case "tap":
    case "longpress": {
      const ms = cmd === "longpress" ? Number(rest.find((a, i) => i > 0 && /^\d+$/.test(a) && rest.length === 2) ?? 800) : 0;
      let x, y, what;
      if (rest.length >= 2 && /^\d+$/.test(rest[0]) && /^\d+$/.test(rest[1])) {
        [x, y] = [Number(rest[0]), Number(rest[1])];
        what = `(${x},${y})`;
      } else {
        const q = (cmd === "longpress" && /^\d+$/.test(rest[rest.length - 1]) ? rest.slice(0, -1) : rest).join(" ");
        if (!q) die(`Usage: ${cmd} <text|id|desc> | ${cmd} <x> <y>`);
        const nodes = dumpUi();
        const hits = findNodes(nodes, q);
        if (!hits.length) {
          const near = nodes.filter(interesting).slice(0, 15).map((n) => `  ${label(n)}`).join("\n");
          die(`Nothing on screen matches "${q}". Visible elements include:\n${near}`);
        }
        const target = hits.find((n) => n.clickable && n.enabled) ?? hits[0];
        if (hits.length > 1) console.log(`${hits.length} matches; using "${label(target)}" at (${target.x},${target.y})`);
        if (!target.enabled) console.log(`Warning: "${label(target)}" is DISABLED, the tap may do nothing.`);
        [x, y] = [target.x, target.y];
        what = `"${label(target)}" at (${x},${y})`;
      }
      if (cmd === "tap") shell(`input tap ${x} ${y}`);
      else shell(`input swipe ${x} ${y} ${x} ${y} ${ms || 800}`);
      console.log(`${cmd === "tap" ? "Tapped" : "Long-pressed"} ${what}`);
      return;
    }

    case "type": {
      const text = rest.join(" ");
      if (!text) die("Usage: type <text>");
      shell(`input text "${escapeText(text)}"`);
      console.log(`Typed ${JSON.stringify(text)}`);
      return;
    }

    case "key": {
      const k = rest[0]?.toLowerCase();
      const code = KEYS[k] ?? (/^\d+$/.test(k ?? "") ? Number(k) : null);
      if (code == null) die(`Unknown key "${rest[0]}". Use one of: ${Object.keys(KEYS).join(", ")} or a keycode number`);
      shell(`input keyevent ${code}`);
      console.log(`Pressed ${k}`);
      return;
    }

    case "swipe": {
      const [x1, y1, x2, y2, ms = 300] = rest.map(Number);
      if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) die("Usage: swipe x1 y1 x2 y2 [ms]");
      shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
      console.log(`Swiped (${x1},${y1}) → (${x2},${y2})`);
      return;
    }

    case "scroll": {
      const size = /(\d+)x(\d+)/.exec(shell("wm size").stdout ?? "") ?? [0, 1080, 1920];
      const [w, h] = [Number(size[1]), Number(size[2])];
      const dir = rest[0] ?? "down";
      const cx = Math.round(w / 2), cy = Math.round(h / 2);
      const d = { down: [cx, h * 0.75, cx, h * 0.25], up: [cx, h * 0.25, cx, h * 0.75], left: [w * 0.25, cy, w * 0.75, cy], right: [w * 0.75, cy, w * 0.25, cy] }[dir];
      if (!d) die("Usage: scroll up|down|left|right");
      shell(`input swipe ${d.map(Math.round).join(" ")} 300`);
      console.log(`Scrolled ${dir}`);
      return;
    }

    case "write": {
      const { w, h } = screenSize();
      const font = flag("font", "neat");
      const size = Number(flag("size", Math.round(h / 14)));
      const x = Number(flag("x", Math.round(w * 0.08)));
      const y = Number(flag("y", Math.round(h * 0.3)));
      const width = Number(flag("width", w - x - Math.round(w * 0.05)));
      const slow = Number(flag("slow", 0));
      const gapArg = flag("gap", null);
      const strokeGap = gapArg == null ? undefined : Number(gapArg);
      const tool = flag("tool", "pen");
      const leadArg = flag("leadin", null);
      const leadIn = leadArg == null ? undefined : Number(leadArg);
      const text = rest.join(" ");
      if (!text) die('Usage: write "text" [--font neat|print|cursive|elegant] [--size px] [--x px] [--y px] [--width px]');
      const t0 = Date.now();
      const strokes = layoutText(text, { font, x, y, size, width });
      const how = await drawStrokes(strokes, { slow, strokeGap, leadIn, tool });
      const ys = strokes.flat().map((p) => p[1]);
      console.log(
        `Wrote ${JSON.stringify(text)} in ${strokes.length} strokes (font ${font}, ${size}px) via ${how} in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
          (ys.length ? `; text spans y ${Math.min(...ys)}–${Math.max(...ys)}` : ""),
      );
      return;
    }

    case "draw": {
      const slow = Number(flag("slow", flag("step", 0)));
      const strokes = rest
        .join(" ")
        .split("|")
        .map((s) => parsePoints(s.trim().split(/\s+/).filter((a) => a.includes(","))))
        .filter((s) => s.length);
      if (!strokes.length) die("Usage: draw x,y x,y [...] [| x,y x,y ...]   (| separates strokes)");
      const leadArg = flag("leadin", null);
      const gapArg = flag("gap", null);
      const how = await drawStrokes(strokes, {
        slow,
        strokeGap: gapArg == null ? undefined : Number(gapArg),
        leadIn: leadArg == null ? undefined : Number(leadArg),
        tool: flag("tool", "pen"),
      });
      console.log(`Drew ${strokes.length} stroke${strokes.length > 1 ? "s" : ""} (${strokes.reduce((n, s) => n + s.length, 0)} points) via ${how}`);
      return;
    }

    case "draw-path": {
      const ox = Number(flag("x", 0));
      const oy = Number(flag("y", 0));
      const scale = Number(flag("scale", 1));
      const d = rest.join(" ");
      if (!d) die('Usage: draw-path "<SVG path d>" [--x px] [--y px] [--scale n]');
      const strokes = parsePath(d).map((s) => s.map(([px, py]) => [Math.round(ox + px * scale), Math.round(oy + py * scale)]));
      const how = await drawStrokes(strokes, { tool: flag("tool", "pen") });
      console.log(`Drew ${strokes.length} strokes from the path via ${how}`);
      return;
    }

    case "draw-shape": {
      const toolArg = flag("tool", "pen");
      rest.push("--tool", toolArg);
      const [shape, ...n] = rest.slice(0, rest.indexOf("--tool"));
      const v = n.map(Number);
      let pts;
      if (shape === "circle") {
        const [cx, cy, r] = v;
        pts = Array.from({ length: 37 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 18), cy + r * Math.sin((i * Math.PI) / 18)].map(Math.round));
      } else if (shape === "rect") {
        const [x1, y1, x2, y2] = v;
        pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
      } else if (shape === "line") {
        const [x1, y1, x2, y2] = v;
        pts = Array.from({ length: 11 }, (_, i) => [x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10].map(Math.round));
      } else die("Usage: draw-shape circle cx cy r | rect x1 y1 x2 y2 | line x1 y1 x2 y2");
      if (pts.flat().some((x) => !Number.isFinite(x))) die("Shape needs numeric arguments");
      const how = await drawStrokes([pts], { tool: flag("tool", "pen") });
      console.log(`Drew a ${shape} (${how})`);
      return;
    }

    case "launch": {
      const pkg = rest[0] ?? die("Usage: launch <package>");
      const r = shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      console.log(/No activities found|Error/i.test(r.stdout ?? "") ? `Could not launch ${pkg}:\n${r.stdout}` : `Launched ${pkg}`);
      return;
    }

    case "stop-app": {
      shell(`am force-stop ${rest[0] ?? die("Usage: stop-app <package>")}`);
      console.log(`Stopped ${rest[0]}`);
      return;
    }

    case "clear": {
      console.log((shell(`pm clear ${rest[0] ?? die("Usage: clear <package>")}`).stdout ?? "").trim());
      return;
    }

    case "install": {
      const r = adb(["install", "-r", rest[0] ?? die("Usage: install <apk>")], { timeout: 300000 });
      console.log(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim());
      return;
    }

    case "logcat": {
      const filters = rest.length ? rest : ["AndroidRuntime:E", "*:E"];
      const r = adb(["logcat", "-d", "-t", "300", ...filters.flatMap((f) => (f.includes(":") ? ["-s", f] : [f]))]);
      const lines = (r.stdout ?? "").trim().split(/\r?\n/);
      console.log(lines.slice(-80).join("\n") || "(no matching log lines)");
      return;
    }

    default:
      die(`Unknown command "${cmd}".\n\n${USAGE}`);
  }
}

main().catch((e) => die(e.message));
