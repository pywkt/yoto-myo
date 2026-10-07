#!/usr/bin/env node
/**
 * yoto.js — one command from a folder of audio to a working Yoto card.
 *
 *   node yoto.js <folder>                 upload (or update), then offer to link a card
 *                                         (a folder with no card yet asks: new playlist, or replace an existing one?)
 *   node yoto.js <folder> --new           skip that question and always create a new playlist
 *   node yoto.js <folder> --no-link       upload/update only
 *   node yoto.js <folder> --relink        force the link step even if already linked
 *   node yoto.js <folder> --icons random  picture icons instead of numbers (or: none)
 *   node yoto.js <folder> --order name    sort by filename instead of album/track tags
 *   node yoto.js <folder> --device NAME   choose the player when you have several
 *   node yoto.js <folder> --dry-run       preview the plan, no network
 *   node yoto.js --devices                list players
 *   node yoto.js --list-icons             list public icon titles for playlist.json
 *   node yoto.js --reset-auth             sign in again
 *
 * Flow:
 *   1. Audio in <folder> is uploaded, transcoded, and assembled into a playlist.
 *      Re-running on the same folder updates the same playlist (tracked in .yoto-card.json).
 *      Every card already linked to it picks up the change with no re-link.
 *   2. If the playlist has never been linked, you're asked to put the blank MYO card in
 *      the player; the player writes the card itself. No phone app needed.
 *   3. Play it once while online so the player caches it; after that it works offline.
 */

const path = require('path');
const { getAccessToken, api, ask: askRaw, closePrompt } = require('./yoto-auth');
const { uploadFolder, listIcons, readCardFile, writeCardFile } = require('./yoto-upload');
const { linkCard, listDevices } = require('./yoto-link');

const args = process.argv.slice(2);
const flagVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const valueFlags = new Set(['--icons', '--device', '--order']);
const folderArg = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));

const log = (...a) => console.log(...a);
const ask = async (q) => (await askRaw(q)).toLowerCase();

(async () => {
  if (args.includes('--reset-auth') && !folderArg) { await getAccessToken({ reset: true }); log('✓ Signed in.'); return; }
  if (args.includes('--devices')) { await listDevices(await getAccessToken()); return; }
  if (args.includes('--list-icons')) { await listIcons(); return; }
  if (!folderArg) throw new Error('Usage: node yoto.js <folder> [--new] [--no-link] [--relink] [--icons numbers|random|none] [--order tags|name] [--device NAME] [--dry-run]');

  // No card file yet: ask whether this folder is a brand-new playlist or should replace
  // the content of an existing card (which stays linked, no re-write needed).
  const folderPath = path.resolve(folderArg);
  let chosenCardId = null;
  if (!readCardFile(folderPath).cardId && !args.includes('--new')) {
    const token = await getAccessToken({ reset: args.includes('--reset-auth') });
    const mine = (await api(token, 'GET', '/content/mine')).cards || [];
    mine.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    log('\nThis folder has no card yet. Existing playlists on your account:');
    if (mine.length === 0) log('  (none)');
    mine.forEach((c, i) => {
      const secs = c.metadata?.media?.duration || 0;
      const mins = secs ? `${Math.round(secs / 60)} min` : '';
      log(`  ${String(i + 1).padStart(2)}. ${c.title}  (${c.cardId}${mins ? ', ' + mins : ''}, updated ${(c.updatedAt || '').slice(0, 10)})`);
    });
    const choice = await ask('\nEnter a number to REPLACE that playlist\'s tracks with this folder (its card keeps working),\nor press Enter to create a NEW playlist: ');
    const idx = Number(choice);
    if (choice && (!Number.isInteger(idx) || idx < 1 || idx > mine.length)) throw new Error(`"${choice}" is not a number in the list.`);
    if (choice) {
      const pick = mine[idx - 1];
      chosenCardId = pick.cardId;
      const sure = await ask(`Replace "${pick.title}" (${pick.cardId}) with the contents of ${path.basename(folderPath)}? [y/N] `);
      if (sure !== 'y' && sure !== 'yes') { log('Cancelled.'); return; }
      if (!args.includes('--dry-run')) {
        writeCardFile(folderPath, { cardId: pick.cardId, title: pick.title, reusedFrom: pick.title, linkedAt: new Date().toISOString(), linkedWith: 'existing card (reused)' });
        log(`Will update ${pick.cardId}. If that playlist was never linked to a physical card, run with --relink afterwards.`);
      } else {
        log(`(dry run) would update ${pick.cardId}`);
      }
    } else {
      log('Creating a new playlist.');
    }
  }

  const result = await uploadFolder(folderArg, {
    dryRun: args.includes('--dry-run'),
    icons: flagVal('--icons'),
    order: flagVal('--order'),
    cardId: chosenCardId,
    reset: args.includes('--reset-auth'),
  });
  if (result.dryRun) return;

  const card = readCardFile(result.folder);
  if (args.includes('--no-link')) return;

  if (card.linkedAt && !args.includes('--relink')) {
    log(`\nThis playlist was linked to a card on ${card.linkedAt.slice(0, 10)} (via "${card.linkedWith}").`);
    log('The card already plays the updated content. Use --relink to write another card.');
    return;
  }

  const answer = await ask('\nLink this playlist to a card now? [Y/n] ');
  if (answer && answer !== 'y' && answer !== 'yes') { log('Skipped linking. Run again with --relink when ready.'); return; }

  await linkCard(result.cardId, { device: flagVal('--device'), folder: result.folder });
  log('\n🎉 Done.');
})().then(closePrompt, (e) => { console.error('\n✖ ' + (e.message || e)); process.exit(1); });
