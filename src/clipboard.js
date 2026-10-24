import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MEDIA_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_EDGE = 1568; // Claude downsizes larger images anyway; smaller uploads are faster
const MAX_BYTES = 5 * 1024 * 1024;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// PowerShell: take a bitmap from the clipboard (a screenshot, or an image file copied in Explorer),
// shrink it to MAX_EDGE and save it as PNG.
function windowsScript(outFile, srcFile) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = $null
$src = '${srcFile ? srcFile.replace(/'/g, "''") : ""}'
if ($src) { $img = [System.Drawing.Image]::FromFile($src) }
elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) { $img = [System.Windows.Forms.Clipboard]::GetImage() }
elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $f = [System.Windows.Forms.Clipboard]::GetFileDropList() | Where-Object { $_ -match '\\.(png|jpe?g|gif|bmp)$' } | Select-Object -First 1
  if ($f) { $img = [System.Drawing.Image]::FromFile($f) }
}
if (-not $img) { 'NONE'; exit }
$w = $img.Width; $h = $img.Height
$s = [Math]::Min(1.0, ${MAX_EDGE} / [Math]::Max($w, $h))
if ($s -lt 1.0) {
  $nw = [int]($w * $s); $nh = [int]($h * $s)
  $bmp = New-Object System.Drawing.Bitmap $nw, $nh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $g.Dispose()
  $img = $bmp
}
$img.Save('${outFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
"OK $w $h $($img.Width) $($img.Height)"
`;
}

async function viaPowerShell(srcFile) {
  const out = path.join(os.tmpdir(), `myclaude-paste-${process.pid}-${Date.now()}.png`);
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", windowsScript(out, srcFile)]);
  const line = r.out.trim().split(/\r?\n/).pop() ?? "";
  if (line === "NONE") return null;
  if (!line.startsWith("OK") || !fs.existsSync(out)) return { error: (r.err || r.out || "could not read the image").trim().split("\n")[0] };
  const [, ow, oh, w, h] = line.split(" ").map(Number);
  const data = fs.readFileSync(out).toString("base64");
  fs.rmSync(out, { force: true });
  return { data, mediaType: "image/png", width: w, height: h, originalWidth: ow, originalHeight: oh };
}

async function viaMac() {
  const out = path.join(os.tmpdir(), `myclaude-paste-${process.pid}-${Date.now()}.png`);
  const script = `try
  set png to (the clipboard as «class PNGf»)
  set f to open for access POSIX file "${out}" with write permission
  write png to f
  close access f
  return "OK"
on error
  return "NONE"
end try`;
  const r = await run("osascript", ["-e", script]);
  if (!r.out.includes("OK") || !fs.existsSync(out)) return null;
  const data = fs.readFileSync(out).toString("base64");
  fs.rmSync(out, { force: true });
  return { data, mediaType: "image/png" };
}

async function viaLinux() {
  for (const [cmd, args] of [
    ["wl-paste", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ]) {
    const chunks = [];
    const ok = await new Promise((resolve) => {
      const p = spawn(cmd, args);
      p.stdout.on("data", (d) => chunks.push(d));
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    });
    if (ok && chunks.length) return { data: Buffer.concat(chunks).toString("base64"), mediaType: "image/png" };
  }
  return null;
}

/** Puts text on the clipboard. Resolves to true when it worked. */
export async function copyText(text) {
  const tools =
    process.platform === "win32"
      ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [cmd, args] of tools) {
    const ok = await new Promise((resolve) => {
      const p = spawn(cmd, args, { windowsHide: true });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      p.stdin.on("error", () => {});
      p.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}

/** Reads an image from the clipboard. Returns null when there is none, or { error }. */
export async function readClipboardImage() {
  try {
    let img;
    if (process.platform === "win32") img = await viaPowerShell();
    else if (process.platform === "darwin") img = await viaMac();
    else img = await viaLinux();
    if (img?.data && Buffer.byteLength(img.data, "base64") > MAX_BYTES) return { error: "image is larger than 5 MB" };
    return img;
  } catch (e) {
    return { error: e.message };
  }
}

/** Loads an image file (e.g. a path dragged into the terminal). */
export async function readImageFile(file) {
  try {
    if (!fs.existsSync(file)) return { error: `file not found: ${file}` };
    const ext = path.extname(file).slice(1).toLowerCase();
    const size = fs.statSync(file).size;
    if (process.platform === "win32" && (size > 1_500_000 || ext === "bmp")) {
      const img = await viaPowerShell(file);
      if (img) return img;
    }
    if (!MEDIA_TYPES[ext]) return { error: `unsupported image type .${ext}` };
    if (size > MAX_BYTES) return { error: "image is larger than 5 MB" };
    return { data: fs.readFileSync(file).toString("base64"), mediaType: MEDIA_TYPES[ext] };
  } catch (e) {
    return { error: e.message };
  }
}

/** If pasted text is just the path of an image file (optionally quoted), returns that path. */
export function imagePathFromPaste(text) {
  const t = text.trim().replace(/^["']|["']$/g, "").replace(/^file:\/\/\/?/, "");
  if (!t || t.includes("\n") || !IMAGE_FILE_RE.test(t)) return null;
  const p = path.resolve(t);
  return fs.existsSync(p) ? p : null;
}
