#!/usr/bin/env node
/**
 * yoto-upload.js — turn a folder of audio files into a Yoto "Make Your Own" playlist.
 * Used by yoto.js; can also be run directly:
 *
 *   node yoto-upload.js <folder> [--dry-run] [--icons numbers|random|none] [--order tags|name] [--title "..."]
 *
 * Folder layout: see lib/manifest.js. In short: audio files, or sub-folders of audio
 * files (one chapter per sub-folder), optional icons/, cover.jpg and playlist.json.
 * .yoto-card.json is written here and holds the cardId so re-runs update, not duplicate.
 *
 * Icon rules, per chapter and per track, first match wins:
 *   1. icons/<basename>.png  → uploaded as a custom icon (basename of the audio file, or of the sub-folder)
 *   2. "icon" in playlist.json → public icon by title
 *   3. --icons numbers (default) → Yoto's "Numbers - N" icon (chapter number, or track number within the chapter)
 *      --icons random → a public icon picked by hashing the title (stable across runs)
 *      --icons none   → no icon
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAccessToken, api, API } = require('./yoto-auth');
const { buildManifest, formatManifest } = require('./lib/manifest');
const { ensureUploadable, extractCover } = require('./lib/convert');

const CARD_FILE = '.yoto-card.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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

  // Poll for the transcode with gentle backoff (1 s → 5 s), up to 10 minutes. Transient
  // errors from the poll endpoint are retried rather than treated as failure.
  const deadline = Date.now() + 10 * 60000;
  let delay = 1000, lastErr = null;
  while (Date.now() < deadline) {
    try {
      const data = await api(token, 'GET', `/media/upload/${uploadId}/transcoded?loudnorm=false`);
      if (data?.transcode?.transcodedSha256) return data.transcode; // { transcodedSha256, transcodedInfo }
      lastErr = null;
    } catch (e) { lastErr = e; }
    await sleep(delay);
    delay = Math.min(delay + 500, 5000);
  }
  throw new Error(`Transcoding timed out after 10 minutes${lastErr ? ` (last error: ${lastErr.message.split('\n')[0]})` : ''}`);
}

async function uploadBinary(token, urlPath, filePath, contentType) {
  const res = await fetch(`${API}${urlPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: fs.readFileSync(filePath),
  });
  if (!res.ok) throw new Error(`POST ${urlPath} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function uploadCustomIcon(token, iconPath) {
  const name = path.basename(iconPath, path.extname(iconPath));
  const data = await uploadBinary(token, `/media/displayIcons/user/me/upload?autoConvert=true&filename=${encodeURIComponent(name)}`, iconPath, 'image/png');
  return data.displayIcon.mediaId;
}

// Cover image for the playlist. Yoto resizes to its MYO cover size when autoconvert is on.
async function uploadCover(token, coverPath) {
  const type = /\.png$/i.test(coverPath) ? 'image/png' : 'image/jpeg';
  const data = await uploadBinary(token, '/media/coverImage/user/me/upload?autoconvert=true&coverType=default', coverPath, type);
  const url = data.coverImage?.mediaUrl;
  if (!url) throw new Error('Cover upload returned no mediaUrl');
  return url;
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

// item: { iconPath, iconTitle, title, n }. Custom icons are uploaded once per path per run.
const customIconCache = new Map();
async function resolveIcon(token, item, mode) {
  if (item.iconPath) {
    if (!customIconCache.has(item.iconPath)) customIconCache.set(item.iconPath, await uploadCustomIcon(token, item.iconPath));
    return { ref: `yoto:#${customIconCache.get(item.iconPath)}`, label: path.basename(item.iconPath) };
  }
  if (mode === 'none' && !item.iconTitle) return null;
  const icons = await publicIcons(token);
  let icon = null;
  if (item.iconTitle) icon = findIconByTitle(icons, item.iconTitle);
  if (!icon && mode === 'numbers') icon = numberIcon(icons, item.n);
  if (!icon && mode !== 'none') icon = hashedIcon(icons, item.title);
  return icon ? { ref: `yoto:#${icon.mediaId}`, label: icon.title } : null;
}

// ---- card file ----
function readCardFile(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, CARD_FILE), 'utf8')); } catch { return {}; }
}
function writeCardFile(folder, obj) {
  fs.writeFileSync(path.join(folder, CARD_FILE), JSON.stringify(obj, null, 2) + '\n');
}

// ---- content listing / deletion ----
async function listContent(token) {
  const mine = (await api(token, 'GET', '/content/mine')).cards || [];
  mine.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return mine;
}
function printContent(cards) {
  if (cards.length === 0) log('  (none)');
  cards.forEach((c, i) => {
    const secs = c.metadata?.media?.duration || 0;
    const mins = secs ? `${Math.round(secs / 60)} min` : '';
    log(`  ${String(i + 1).padStart(2)}. ${c.title}  (${c.cardId}${mins ? ', ' + mins : ''}, updated ${(c.updatedAt || '').slice(0, 10)})`);
  });
}
async function deleteContent(token, cardId) {
  return api(token, 'DELETE', `/content/${cardId}`);
}

/**
 * Upload a folder and create/update its playlist.
 * opts: { dryRun, icons: 'numbers'|'random'|'none', order: 'tags'|'name', title, cardId (override), reset }
 * Returns { cardId, title, created, folder, transcodedBytes, dryRun }.
 */
async function uploadFolder(folderArg, opts = {}) {
  const folder = path.resolve(folderArg);
  const iconMode = opts.icons || 'numbers';
  const card = readCardFile(folder);
  // An explicit --title sticks for later runs (stored in .yoto-card.json as titleOverride).
  const titleOverride = opts.title || card.titleOverride || undefined;
  const m = buildManifest(folder, { order: opts.order || 'tags', title: titleOverride });
  const cardId = opts.cardId || card.cardId || null;
  const nTracks = m.chapters.reduce((n, c) => n + c.tracks.length, 0);

  log(`\nPlaylist: "${m.title}"  (${m.chapters.length} chapter${m.chapters.length === 1 ? '' : 's'}, ${nTracks} track${nTracks === 1 ? '' : 's'})`);
  log(cardId ? `Updating existing playlist ${cardId}` : 'Creating a new playlist');
  log(`Order: ${m.orderedBy}`);
  log(formatManifest(m));
  if (opts.dryRun) { log(`\n(dry run, nothing uploaded; icon mode: ${iconMode})`); return { cardId, title: m.title, dryRun: true, folder }; }

  const token = await getAccessToken({ reset: opts.reset });

  const chapters = [];
  let totalDuration = 0, totalFileSize = 0, done = 0;

  for (const c of m.chapters) {
    const tracks = [];
    for (const t of c.tracks) {
      done++;
      log(`\n[${done}/${nTracks}] ${c.single ? '' : c.title + ' / '}${t.title}`);
      const up = ensureUploadable(t, folder);
      if (t.needsConvert) log(up.converted ? `   converted ${path.extname(t.sourcePath)} → m4a with ffmpeg` : '   using cached m4a conversion');
      const file = up.path;
      log('   uploading audio and waiting for transcode…');
      const tr = await uploadAudio(token, file, t.contentType);
      const info = tr.transcodedInfo || {};
      const icon = c.single ? null : await resolveIcon(token, t, iconMode);
      if (icon) log(`   icon: ${icon.label}`);
      tracks.push({
        key: t.key,
        title: t.title,
        trackUrl: `yoto:#${tr.transcodedSha256}`,
        type: 'audio',
        format: info.format,
        duration: info.duration,
        fileSize: info.fileSize,
        channels: info.channels,
        overlayLabel: String(c.single ? c.n : t.n),
        ...(icon ? { display: { icon16x16: icon.ref } } : {}),
      });
      totalDuration += info.duration || 0;
      totalFileSize += info.fileSize || 0;
      log(`   ✓ done (${info.duration ? Math.round(info.duration) + 's' : 'duration unknown'})`);
    }
    const icon = await resolveIcon(token, c, iconMode);
    if (icon) {
      log(`   chapter icon for "${c.title}": ${icon.label}`);
      // A single-track chapter shows the same icon on its track, as before.
      if (c.single) tracks[0].display = { icon16x16: icon.ref };
    }
    chapters.push({
      key: c.key,
      title: c.title,
      overlayLabel: String(c.n),
      ...(icon ? { display: { icon16x16: icon.ref } } : {}),
      tracks,
    });
  }

  // Cover: cover.* in the folder, else art embedded in the first track. Re-uploaded only when it changes.
  let cover = card.cover || null;
  let coverPath = m.cover?.path || null;
  if (!coverPath && m.cover?.embeddedFrom) coverPath = extractCover(m.cover.embeddedFrom, folder);
  if (coverPath) {
    const sha = sha256File(coverPath);
    if (cover?.sha256 === sha && cover?.mediaUrl) log('\nCover unchanged, reusing.');
    else { log(`\nUploading cover ${path.relative(folder, coverPath)}…`); cover = { sha256: sha, mediaUrl: await uploadCover(token, coverPath) }; }
  }

  // When updating, keep whatever metadata/content settings the playlist already has
  // (e.g. a cover set in the app) and only replace what this tool owns.
  const existing = cardId ? (await api(token, 'GET', `/card/${cardId}`).catch(() => null))?.card : null;
  const metadata = {
    ...(existing?.metadata || {}),
    media: {
      duration: totalDuration,
      fileSize: totalFileSize,
      readableFileSize: Math.round((totalFileSize / 1024 / 1024) * 10) / 10,
    },
    ...(cover?.mediaUrl ? { cover: { imageL: cover.mediaUrl } } : {}),
  };

  const created = await api(token, 'POST', '/content', {
    ...(cardId ? { cardId } : {}),
    title: m.title,
    content: { ...(existing?.content || {}), chapters },
    metadata,
  });

  const newCardId = cardId || created.cardId || created.card?.cardId || created.contentId || null;
  if (!newCardId) throw new Error('Yoto did not return a cardId; check the Yoto app for the playlist.');
  writeCardFile(folder, { ...card, cardId: newCardId, title: m.title, ...(titleOverride ? { titleOverride } : {}), ...(cover ? { cover } : {}), updatedAt: new Date().toISOString() });

  log(cardId ? '\n✅ Playlist updated on your Yoto account.' : '\n✅ Playlist created on your Yoto account.');
  log(`   Title:  ${m.title}\n   cardId: ${newCardId}\n   size:   ${(totalFileSize / 1024 / 1024).toFixed(1)} MB after transcoding`);
  return { cardId: newCardId, title: m.title, created: !cardId, folder, transcodedBytes: totalFileSize };
}

async function listIcons() {
  const token = await getAccessToken();
  const icons = await publicIcons(token);
  const byTitle = icons.filter((i) => i.title).sort((a, b) => a.title.localeCompare(b.title));
  for (const i of byTitle) log(`${i.title.padEnd(28)} ${(i.publicTags || []).join(', ')}`);
  log(`\n${byTitle.length} public icons. Use the title as "icon" in playlist.json.`);
}

module.exports = { uploadFolder, listIcons, listContent, printContent, deleteContent, readCardFile, writeCardFile, CARD_FILE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueFlags = ['--icons', '--order', '--title'];
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const folderArg = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
  (async () => {
    if (args.includes('--list-icons')) return listIcons();
    if (!folderArg) throw new Error('Usage: node yoto-upload.js <folder> [--dry-run] [--icons numbers|random|none] [--order tags|name] [--title "..."] [--list-icons]');
    await uploadFolder(folderArg, { dryRun: args.includes('--dry-run'), icons: opt('--icons'), order: opt('--order'), title: opt('--title'), reset: args.includes('--reset-auth') });
  })().catch((e) => { console.error('\n✖ ' + (e.message || e)); process.exit(1); });
}
