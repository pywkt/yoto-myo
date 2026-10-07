/**
 * lib/convert.js — local ffmpeg helpers. Yoto accepts mp3 and m4a; anything else is
 * converted to m4a (AAC 256 kb/s) into <folder>/.converted/ first. Yoto still transcodes
 * to Opus on its side; this only changes the container/codec it is handed.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONVERTED_DIR = '.converted';

function haveFfmpeg() {
  try { return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}

function run(args) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').pop() || 'unknown error'}`);
}

/**
 * Upload-ready file for a track: the source itself, or a cached m4a conversion.
 * Returns { path, converted } where converted is true if ffmpeg ran this time.
 */
function ensureUploadable(track, folder) {
  if (!track.needsConvert) return { path: track.sourcePath, converted: false };
  if (!haveFfmpeg()) throw new Error(`${path.basename(track.sourcePath)} needs converting to m4a, but ffmpeg is not installed.`);
  const outDir = path.join(folder, CONVERTED_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  // Keep the source basename so icons/ and playlist.json entries still line up.
  const out = path.join(outDir, path.basename(track.sourcePath, path.extname(track.sourcePath)) + '.m4a');
  const fresh = fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(track.sourcePath).mtimeMs;
  if (!fresh) run(['-i', track.sourcePath, '-vn', '-map_metadata', '0', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', out]);
  return { path: out, converted: !fresh };
}

/** Extract embedded cover art to <folder>/.converted/cover.jpg. Returns the path, or null. */
function extractCover(audioPath, folder) {
  if (!haveFfmpeg()) return null;
  const outDir = path.join(folder, CONVERTED_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'cover.jpg');
  try {
    run(['-i', audioPath, '-an', '-map', '0:v:0', '-frames:v', '1', '-update', '1', out]);
    return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : null;
  } catch { return null; }
}

module.exports = { ensureUploadable, extractCover, haveFfmpeg, CONVERTED_DIR };
