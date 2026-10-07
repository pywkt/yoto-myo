#!/usr/bin/env node
/**
 * yoto-upload.js — turn a folder of audio files into a Yoto "Make Your Own" playlist.
 * Used by yoto.js; can also be run directly:
 *
 *   node yoto-upload.js <folder> [--dry-run] [--icons numbers|random|none]
 *
 * Folder layout (everything but the audio is optional):
 *   my-playlist/
 *     01 - First song.mp3        audio files, sorted by filename; .mp3 and .m4a accepted
 *     02 - Second song.m4a
 *     playlist.json              { "title": "...", "tracks": [{ "file": "...", "title": "...", "icon": "Lion" }] }
 *                                "icon" is the title of a public Yoto icon (see --list-icons)
 *     icons/01 - First song.png  16x16 PNG with the same basename as the audio file (custom icon)
 *     .yoto-card.json            written by this script; holds the cardId so re-runs update, not duplicate
 *
 * Icon rules, per track, first match wins:
 *   1. icons/<basename>.png  → uploaded as a custom icon
 *   2. "icon" in playlist.json → public icon by title
 *   3. --icons numbers (default) → Yoto's "Numbers - N" icon for track N (1..30)
 *      --icons random → a public icon picked by hashing the title (stable across runs)
 *      --icons none   → no icon
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getAccessToken, api } = require('./yoto-auth');

const CARD_FILE = '.yoto-card.json';
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---- Yoto media API ----
async function uploadAudio(token, filePath, contentType) {
  const buf = fs.readFileSync(filePath);
  // Yoto dedupes by SHA-256: if it already has this exact file, uploadUrl comes back
  // null and the existing transcode is reused, so re-runs skip unchanged tracks.
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const q = new URLSearchParams({ sha256, filename: path.basename(filePath) });
  const got = await api(token, 'GET', `/media/transcode/audio/uploadUrl?${q}`);
  const { uploadUrl, uploadId } = got.upload;

  if (uploadUrl) {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Blob([buf], { type: contentType }),
    });
    if (!put.ok) throw new Error(`Audio PUT failed: HTTP ${put.status}`);
  } else {
    log('   already on Yoto (same file hash), skipping upload');
  }

  for (let i = 0; i < 180; i++) {
    const data = await api(token, 'GET', `/media/upload/${uploadId}/transcoded?loudnorm=false`).catch(() => null);
    if (data?.transcode?.transcodedSha256) return data.transcode; // { transcodedSha256, transcodedInfo }
    await sleep(1000);
  }
  throw new Error('Transcoding timed out after 3 minutes');
}

async function uploadCustomIcon(token, iconPath) {
  const name = path.basename(iconPath, path.extname(iconPath));
  const url = `/media/displayIcons/user/me/upload?autoConvert=true&filename=${encodeURIComponent(name)}`;
  const res = await fetch(`https://api.yotoplay.com${url}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
    body: fs.readFileSync(iconPath),
  });
  if (!res.ok) throw new Error(`Icon upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.displayIcon.mediaId;
}

let publicIconsCache = null;
async function publicIcons(token) {
  if (!publicIconsCache) publicIconsCache = (await api(token, 'GET', '/media/displayIcons/user/yoto')).displayIcons || [];
  return publicIconsCache;
}

function findIconByTitle(icons, title) {
  const t = title.trim().toLowerCase();
  return icons.find((i) => (i.title || '').trim().toLowerCase() === t)
    || icons.find((i) => (i.title || '').toLowerCase().includes(t));
}

function numberIcon(icons, n) {
  return icons.find((i) => {
    const m = /^numbers?\s*-\s*(\d+)$/i.exec(i.title || '');
    return m && Number(m[1]) === n;
  });
}

function hashedIcon(icons, seed) {
  const pool = icons.filter((i) => i.title && !/^numbers?\s*-/i.test(i.title));
  const h = crypto.createHash('sha256').update(seed).digest();
  return pool[h.readUInt32BE(0) % pool.length];
}

async function resolveIcon(token, track, mode) {
  if (track.iconPath) return { ref: `yoto:#${await uploadCustomIcon(token, track.iconPath)}`, label: path.basename(track.iconPath) };
  if (mode === 'none' && !track.iconTitle) return null;
  const icons = await publicIcons(token);
  let icon = null;
  if (track.iconTitle) icon = findIconByTitle(icons, track.iconTitle);
  if (!icon && mode === 'numbers') icon = numberIcon(icons, track.n);
  if (!icon && mode !== 'none') icon = hashedIcon(icons, track.title);
  return icon ? { ref: `yoto:#${icon.mediaId}`, label: icon.title } : null;
}

// ---- planning: resolve the folder into an ordered track list ----
function titleFromFilename(file) {
  // "03 - Some Title.mp3" -> "Some Title"; "some_title.m4a" -> "some title"
  return path.basename(file, path.extname(file))
    .replace(/^\s*\d+\s*[-._)]*\s*/, '')
    .replace(/[_]+/g, ' ')
    .trim() || path.basename(file, path.extname(file));
}

// The player caches chapter audio by key. Keys derived from the title stay put when
// tracks are added, removed or reordered, so only genuinely new tracks get new keys.
function stableKey(title, used) {
  const hash = crypto.createHash('sha256').update(title).digest();
  let n = hash[0] % 99;
  let key = String(n + 1).padStart(2, '0');
  for (let offset = 1; used.has(key); offset++) {
    n = (n + hash[offset % hash.length] + offset) % 99;
    key = String(n + 1).padStart(2, '0');
  }
  used.add(key);
  return key;
}

// Read album / disc / track / title tags with ffprobe (if installed). Returns {} if unavailable.
function readTags(filePath) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries',
      'format_tags=album,disc,track,title', filePath], { encoding: 'utf8' });
    if (r.status !== 0) return {};
    const tags = JSON.parse(r.stdout).format?.tags || {};
    const num = (s) => { const m = /^(\d+)/.exec(String(s ?? '')); return m ? Number(m[1]) : null; };
    return { album: tags.album || null, disc: num(tags.disc), track: num(tags.track), title: tags.title || null };
  } catch { return {}; }
}

// Order audio files by (album, disc, track) when every file has an album and track tag;
// otherwise fall back to natural filename order. Returns [{ file, tags }].
function orderFiles(folder, audioFiles, mode) {
  const withTags = audioFiles.map((file) => ({ file, tags: mode === 'name' ? {} : readTags(path.join(folder, file)) }));
  const allTagged = mode !== 'name' && withTags.every((f) => f.tags.album && f.tags.track != null);
  if (!allTagged) return { files: withTags, by: 'filename' };
  withTags.sort((a, b) =>
    a.tags.album.localeCompare(b.tags.album, undefined, { numeric: true }) ||
    (a.tags.disc ?? 1) - (b.tags.disc ?? 1) ||
    a.tags.track - b.tags.track ||
    a.file.localeCompare(b.file));
  return { files: withTags, by: 'album + track tags' };
}

function readCardFile(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, CARD_FILE), 'utf8')); } catch { return {}; }
}
function writeCardFile(folder, obj) {
  fs.writeFileSync(path.join(folder, CARD_FILE), JSON.stringify(obj, null, 2) + '\n');
}

function buildPlan(folder, orderMode = 'tags', cardIdOverride = null) {
  const audioFiles = fs.readdirSync(folder)
    .filter((f) => AUDIO_TYPES[path.extname(f).toLowerCase()])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (audioFiles.length === 0) throw new Error(`No .mp3 or .m4a files in ${folder}`);

  let manifest = {};
  const manifestPath = path.join(folder, 'playlist.json');
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const title = manifest.title || path.basename(folder);
  const iconsDir = path.join(folder, 'icons');
  const usedKeys = new Set();

  const ordered = manifest.tracks ? null : orderFiles(folder, audioFiles, orderMode);
  const entries = manifest.tracks
    ? manifest.tracks.map((t) => {
        if (!audioFiles.includes(t.file)) throw new Error(`playlist.json names "${t.file}" but it is not in ${folder}`);
        return { file: t.file, title: t.title || titleFromFilename(t.file), iconTitle: t.icon || null, album: null };
      })
    : ordered.files.map(({ file, tags }) => ({ file, title: tags.title || titleFromFilename(file), iconTitle: null, album: tags.album || null }));
  const orderedBy = manifest.tracks ? 'playlist.json' : ordered.by;

  const tracks = entries.map((e, i) => {
    const ext = path.extname(e.file).toLowerCase();
    const iconPath = path.join(iconsDir, path.basename(e.file, ext) + '.png');
    return {
      n: i + 1,
      title: e.title,
      key: stableKey(e.title, usedKeys),
      audioPath: path.join(folder, e.file),
      contentType: AUDIO_TYPES[ext],
      iconPath: fs.existsSync(iconPath) ? iconPath : null,
      iconTitle: e.iconTitle,
      album: e.album,
    };
  });

  const card = readCardFile(folder);
  return { title, tracks, cardId: cardIdOverride || card.cardId || null, card, orderedBy };
}

/**
 * Upload a folder and create/update its playlist. Returns { cardId, title, created, folder }.
 * opts: { dryRun, icons: 'numbers'|'random'|'none', order: 'tags'|'name', cardId (override), reset }
 */
async function uploadFolder(folderArg, opts = {}) {
  const folder = path.resolve(folderArg);
  if (!fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`);
  const iconMode = opts.icons || 'numbers';
  const { title, tracks, cardId, card, orderedBy } = buildPlan(folder, opts.order || 'tags', opts.cardId || null);

  log(`\nPlaylist: "${title}"  (${tracks.length} track${tracks.length === 1 ? '' : 's'})`);
  log(cardId ? `Updating existing playlist ${cardId}` : 'Creating a new playlist');
  log(`Track order: ${orderedBy}`);
  tracks.forEach((t) => log(`  ${String(t.n).padStart(2)}. ${t.title}${t.album ? `  [${t.album}]` : ''}  ←  ${path.basename(t.audioPath)}${t.iconPath ? '  [custom icon]' : t.iconTitle ? `  [icon: ${t.iconTitle}]` : ''}`));
  if (opts.dryRun) { log(`\n(dry run, nothing uploaded; icon mode: ${iconMode})`); return { cardId, title, dryRun: true, folder }; }

  const token = await getAccessToken({ reset: opts.reset });

  const chapters = [];
  let totalDuration = 0;
  let totalFileSize = 0;

  for (const t of tracks) {
    log(`\n[${t.n}/${tracks.length}] ${t.title}`);
    log('   uploading audio and waiting for transcode…');
    const tr = await uploadAudio(token, t.audioPath, t.contentType);
    const info = tr.transcodedInfo || {};
    const icon = await resolveIcon(token, t, iconMode);
    if (icon) log(`   icon: ${icon.label}`);
    const display = icon ? { icon16x16: icon.ref } : undefined;
    chapters.push({
      key: t.key,
      title: t.title,
      overlayLabel: String(t.n),
      ...(display ? { display } : {}),
      tracks: [{
        key: '01',
        title: t.title,
        trackUrl: `yoto:#${tr.transcodedSha256}`,
        type: 'audio',
        format: info.format,
        duration: info.duration,
        fileSize: info.fileSize,
        channels: info.channels,
        overlayLabel: String(t.n),
        ...(display ? { display } : {}),
      }],
    });
    totalDuration += info.duration || 0;
    totalFileSize += info.fileSize || 0;
    log(`   ✓ done (${info.duration ? Math.round(info.duration) + 's' : 'duration unknown'})`);
  }

  const created = await api(token, 'POST', '/content', {
    ...(cardId ? { cardId } : {}),
    title,
    content: { chapters },
    metadata: {
      media: {
        duration: totalDuration,
        fileSize: totalFileSize,
        readableFileSize: Math.round((totalFileSize / 1024 / 1024) * 10) / 10,
      },
    },
  });

  const newCardId = cardId || created.cardId || created.card?.cardId || created.contentId || null;
  if (!newCardId) throw new Error('Yoto did not return a cardId; check the Yoto app for the playlist.');
  writeCardFile(folder, { ...card, cardId: newCardId, title, updatedAt: new Date().toISOString() });

  log(cardId ? '\n✅ Playlist updated on your Yoto account.' : '\n✅ Playlist created on your Yoto account.');
  log(`   Title:  ${title}\n   cardId: ${newCardId}`);
  return { cardId: newCardId, title, created: !cardId, folder };
}

async function listIcons() {
  const token = await getAccessToken();
  const icons = await publicIcons(token);
  const byTitle = icons.filter((i) => i.title).sort((a, b) => a.title.localeCompare(b.title));
  for (const i of byTitle) log(`${i.title.padEnd(28)} ${(i.publicTags || []).join(', ')}`);
  log(`\n${byTitle.length} public icons. Use the title as "icon" in playlist.json.`);
}

module.exports = { uploadFolder, listIcons, readCardFile, writeCardFile, CARD_FILE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const folderArg = args.find((a, i) => !a.startsWith('--') && !['--icons', '--order'].includes(args[i - 1]));
  (async () => {
    if (args.includes('--list-icons')) return listIcons();
    if (!folderArg) throw new Error('Usage: node yoto-upload.js <folder> [--dry-run] [--icons numbers|random|none] [--order tags|name] [--list-icons]');
    await uploadFolder(folderArg, { dryRun: args.includes('--dry-run'), icons: opt('--icons'), order: opt('--order'), reset: args.includes('--reset-auth') });
  })().catch((e) => { console.error('\n✖ ' + (e.message || e)); process.exit(1); });
}
