/**
 * lib/manifest.js — turn a folder of audio into a playlist manifest: chapters and tracks,
 * titles, icons, stable keys. No Yoto API here; the same manifest can feed any player.
 *
 * Folder layouts understood:
 *
 *   flat/                               every file is one single-track chapter
 *     01 - First.mp3
 *     02 - Second.m4a
 *
 *   albums/                             every sub-folder is a chapter (album), files inside are its tracks
 *     01 Analord 02/01 Phonatacid.m4a
 *     02 Analord 03/01 Pitcard.m4a
 *     loose.mp3                         loose files still become single-track chapters
 *     icons/Analord 02.png              chapter icon (basename = sub-folder name or chapter title)
 *     icons/Phonatacid.png              track icon  (basename = audio file name)
 *     cover.jpg                         playlist cover (cover.png / cover.jpg / cover.jpeg)
 *     playlist.json                     optional explicit titles / order / icons
 *
 * playlist.json, either form:
 *   { "title": "...", "tracks":   [ { "file": "a.mp3", "title": "...", "icon": "Lion" } ] }
 *   { "title": "...", "chapters": [ { "folder": "01 Analord 02", "title": "...", "icon": "Moon",
 *                                     "tracks": [ { "file": "01 Phonatacid.m4a", "title": "...", "icon": "..." } ] } ] }
 *   In the chapters form, "folder" or "tracks" may be omitted (tracks default to the folder's
 *   files; omitting folder means the files are at the top level).
 *
 * Returned manifest:
 *   { title, folder, orderedBy, flat, cover: { path } | { embeddedFrom } | null,
 *     chapters: [ { n, title, key, dir, iconPath, iconTitle,
 *                   tracks: [ { n, title, key, sourcePath, needsConvert, contentType, iconPath, iconTitle, tags } ] } ] }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Formats Yoto accepts as-is, and formats we convert to m4a first (see lib/convert.js).
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
const CONVERTIBLE_TYPES = new Set(['.flac', '.ogg', '.oga', '.opus', '.wav', '.aac', '.wma', '.aiff', '.aif', '.mp4']);
const COVER_NAMES = ['cover.png', 'cover.jpg', 'cover.jpeg'];
const SKIP_DIRS = new Set(['icons', '.converted', 'node_modules']);

const isAudio = (f) => { const e = path.extname(f).toLowerCase(); return Boolean(AUDIO_TYPES[e]) || CONVERTIBLE_TYPES.has(e); };
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function titleFromFilename(file) {
  // "03 - Some Title.mp3" -> "Some Title"; "some_title.m4a" -> "some title"
  const base = path.basename(file, path.extname(file));
  return base.replace(/^\s*\d+\s*[-._)]*\s*/, '').replace(/[_]+/g, ' ').trim() || base;
}

// The player caches chapter audio by key. Keys derived from the title stay put when
// chapters are added, removed or reordered, so only genuinely new chapters get new keys.
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
    // Tags live on the container for mp3/m4a/flac and on the stream for ogg/opus; merge both.
    const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries',
      'format_tags=album,disc,track,title:stream_tags=album,disc,track,title', filePath], { encoding: 'utf8' });
    if (r.status !== 0) return {};
    const j = JSON.parse(r.stdout);
    const tags = { ...((j.streams || []).find((st) => st.tags)?.tags || {}), ...(j.format?.tags || {}) };
    const num = (s) => { const m = /^(\d+)/.exec(String(s ?? '')); return m ? Number(m[1]) : null; };
    return { album: tags.album || null, disc: num(tags.disc), track: num(tags.track), title: tags.title || null };
  } catch { return {}; }
}

// Does the file carry embedded cover art (an attached picture stream)?
function hasEmbeddedCover(filePath) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath], { encoding: 'utf8' });
    return r.status === 0 && /\b(mjpeg|png)\b/.test(r.stdout);
  } catch { return false; }
}

// Order audio files by (album, disc, track) when every file has an album and track tag;
// otherwise fall back to natural filename order. Returns { files: [{ file, tags }], by }.
function orderFiles(dir, audioFiles, mode) {
  const withTags = audioFiles.map((file) => ({ file, tags: mode === 'name' ? {} : readTags(path.join(dir, file)) }));
  const allTagged = mode !== 'name' && withTags.every((f) => f.tags.album && f.tags.track != null);
  if (!allTagged) { withTags.sort((a, b) => byName(a.file, b.file)); return { files: withTags, by: 'filename' }; }
  withTags.sort((a, b) =>
    a.tags.album.localeCompare(b.tags.album, undefined, { numeric: true }) ||
    (a.tags.disc ?? 1) - (b.tags.disc ?? 1) ||
    a.tags.track - b.tags.track ||
    byName(a.file, b.file));
  return { files: withTags, by: 'album + track tags' };
}

function listAudio(dir) {
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.') && isAudio(f) && fs.statSync(path.join(dir, f)).isFile());
}
function listChapterDirs(dir) {
  return fs.readdirSync(dir).filter((f) => {
    if (f.startsWith('.') || SKIP_DIRS.has(f)) return false;
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory() && listAudio(p).length > 0;
  });
}

function makeTrack(dir, file, { title, iconTitle, tags, iconsDir }) {
  const ext = path.extname(file).toLowerCase();
  const iconPath = path.join(iconsDir, path.basename(file, ext) + '.png');
  return {
    title: title || tags?.title || titleFromFilename(file),
    sourcePath: path.join(dir, file),
    needsConvert: !AUDIO_TYPES[ext],
    contentType: AUDIO_TYPES[ext] || 'audio/mp4',
    iconPath: fs.existsSync(iconPath) ? iconPath : null,
    iconTitle: iconTitle || null,
    tags: tags || {},
  };
}

// Tracks for one directory, honouring an optional explicit list from playlist.json.
function tracksFor(dir, explicit, order, iconsDir) {
  const files = listAudio(dir);
  if (explicit) {
    return {
      by: 'playlist.json',
      tracks: explicit.map((t) => {
        if (!files.includes(t.file)) throw new Error(`playlist.json names "${t.file}" but it is not in ${dir}`);
        return makeTrack(dir, t.file, { title: t.title, iconTitle: t.icon, tags: readTags(path.join(dir, t.file)), iconsDir });
      }),
    };
  }
  const ordered = orderFiles(dir, files, order);
  return { by: ordered.by, tracks: ordered.files.map(({ file, tags }) => makeTrack(dir, file, { tags, iconsDir })) };
}

// Chapter title for a sub-folder: the album tag if every track agrees, else the folder name.
function chapterTitleFor(dirName, tracks) {
  const albums = new Set(tracks.map((t) => t.tags.album).filter(Boolean));
  if (albums.size === 1 && tracks.every((t) => t.tags.album)) return [...albums][0];
  return titleFromFilename(dirName);
}

function findCover(folder, firstTrack) {
  for (const name of COVER_NAMES) {
    const p = path.join(folder, name);
    if (fs.existsSync(p)) return { path: p };
  }
  if (firstTrack && hasEmbeddedCover(firstTrack.sourcePath)) return { embeddedFrom: firstTrack.sourcePath };
  return null;
}

/**
 * Build the manifest for a folder. opts: { order: 'tags'|'name', title }
 */
function buildManifest(folder, opts = {}) {
  folder = path.resolve(folder);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Folder not found: ${folder}`);
  const order = opts.order || 'tags';
  const iconsDir = path.join(folder, 'icons');

  let pj = {};
  const pjPath = path.join(folder, 'playlist.json');
  if (fs.existsSync(pjPath)) pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));

  const chapters = [];   // [{ title, dir, iconTitle, tracks, byLabel }]
  let orderedBy;

  if (pj.chapters) {
    orderedBy = 'playlist.json';
    for (const c of pj.chapters) {
      const dir = c.folder ? path.join(folder, c.folder) : folder;
      if (!fs.existsSync(dir)) throw new Error(`playlist.json names folder "${c.folder}" but it is not in ${folder}`);
      const { tracks } = tracksFor(dir, c.tracks, order, iconsDir);
      chapters.push({ title: c.title || (c.folder ? chapterTitleFor(c.folder, tracks) : null), dir: c.folder ? dir : null, iconTitle: c.icon || null, tracks });
    }
  } else if (pj.tracks) {
    orderedBy = 'playlist.json';
    for (const t of tracksFor(folder, pj.tracks, order, iconsDir).tracks) chapters.push({ title: null, dir: null, iconTitle: null, tracks: [t] });
  } else {
    const subdirs = listChapterDirs(folder);
    const loose = listAudio(folder);
    if (subdirs.length === 0) {
      // Flat folder: one chapter per file, ordered by tags across the whole folder.
      const r = tracksFor(folder, null, order, iconsDir);
      orderedBy = r.by;
      for (const t of r.tracks) chapters.push({ title: null, dir: null, iconTitle: null, tracks: [t] });
    } else {
      // Album folder: sub-folders and loose files interleave by name; tracks inside a sub-folder by tags.
      orderedBy = 'sub-folder name' + (order === 'name' ? ', tracks by filename' : ', tracks by track tags');
      const entries = [...subdirs.map((d) => ({ name: d, dir: true })), ...loose.map((f) => ({ name: f, dir: false }))].sort((a, b) => byName(a.name, b.name));
      for (const e of entries) {
        if (e.dir) {
          const dir = path.join(folder, e.name);
          const { tracks } = tracksFor(dir, null, order, iconsDir);
          chapters.push({ title: chapterTitleFor(e.name, tracks), dir, iconTitle: null, tracks });
        } else {
          chapters.push({ title: null, dir: null, iconTitle: null, tracks: [makeTrack(folder, e.name, { tags: readTags(path.join(folder, e.name)), iconsDir })] });
        }
      }
    }
  }

  if (chapters.length === 0) throw new Error(`No audio files in ${folder} (accepted: ${[...Object.keys(AUDIO_TYPES), ...CONVERTIBLE_TYPES].join(' ')})`);
  if (chapters.length > 99) throw new Error(`${chapters.length} chapters; the key scheme allows at most 99. Group tracks into sub-folders.`);

  // Number everything, assign keys, resolve chapter icons.
  const usedKeys = new Set();
  const flat = chapters.every((c) => c.dir === null && c.tracks.length === 1);
  chapters.forEach((c, ci) => {
    c.n = ci + 1;
    c.tracks.forEach((t, ti) => { t.n = ti + 1; t.key = String(ti + 1).padStart(2, '0'); });
    const single = c.dir === null && c.tracks.length === 1;
    if (!c.title) c.title = single ? c.tracks[0].title : `Chapter ${c.n}`;
    c.key = stableKey(c.title, usedKeys);
    if (single) {
      // A single-track chapter carries its track's icon, so flat folders behave as before.
      c.iconPath = c.tracks[0].iconPath;
      c.iconTitle = c.iconTitle || c.tracks[0].iconTitle;
      c.single = true;
    } else {
      // Chapter icon: icons/<sub-folder name>.png or icons/<chapter title>.png
      const candidates = [c.dir ? path.basename(c.dir) : null, c.title].filter(Boolean).map((b) => path.join(iconsDir, b + '.png'));
      c.iconPath = candidates.find((p) => fs.existsSync(p)) || null;
      c.single = false;
    }
  });

  const title = opts.title || pj.title || path.basename(folder);
  const firstTrack = chapters[0].tracks[0];
  return { title, folder, orderedBy, flat, cover: findCover(folder, firstTrack), chapters };
}

/** Pretty tree for --dry-run and the upload log. */
function formatManifest(m) {
  const lines = [];
  const rel = (p) => path.relative(m.folder, p);
  const iconNote = (x) => (x.iconPath ? `  [icon: ${rel(x.iconPath)}]` : x.iconTitle ? `  [icon: ${x.iconTitle}]` : '');
  for (const c of m.chapters) {
    if (c.single) {
      const t = c.tracks[0];
      lines.push(`  ${String(c.n).padStart(2)}. ${c.title}  ←  ${rel(t.sourcePath)}${t.needsConvert ? '  (convert to m4a)' : ''}${iconNote(c)}`);
    } else {
      lines.push(`  ${String(c.n).padStart(2)}. ${c.title}/${iconNote(c)}`);
      for (const t of c.tracks) lines.push(`        ${String(t.n).padStart(2)}. ${t.title}  ←  ${rel(t.sourcePath)}${t.needsConvert ? '  (convert to m4a)' : ''}${iconNote(t)}`);
    }
  }
  if (m.cover) lines.push(m.cover.path ? `  cover: ${rel(m.cover.path)}` : `  cover: embedded art from ${rel(m.cover.embeddedFrom)}`);
  return lines.join('\n');
}

module.exports = { buildManifest, formatManifest, titleFromFilename, stableKey, readTags, orderFiles, AUDIO_TYPES, CONVERTIBLE_TYPES };
