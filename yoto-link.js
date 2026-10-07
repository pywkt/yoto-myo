#!/usr/bin/env node
/**
 * yoto-link.js — link a MYO playlist to the physical card sitting in your player,
 * without the Yoto phone app. Used by yoto.js; can also be run directly:
 *
 *   node yoto-link.js <folder-or-cardId> [--device NAME] [--yes]
 *   node yoto-link.js --devices                 # just list players
 *
 * This sends the same "link card via player" command the official app sends
 * (POST /device-v2/{deviceId}/command/card-link). The player reads the card in
 * its slot, asks Yoto's servers for a signed URL, and writes it to the tag.
 * You should see a red record icon and then a green tick on the player.
 */

const fs = require('fs');
const path = require('path');
const { getAccessToken, api, ask, closePrompt } = require('./yoto-auth');
const { readCardFile, writeCardFile } = require('./yoto-upload');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getDevices(token) {
  const devs = await api(token, 'GET', '/device-v2/devices/mine');
  const devices = devs.devices || devs;
  if (!Array.isArray(devices) || devices.length === 0) throw new Error('No players found on this account.');
  return devices;
}

async function listDevices(token) {
  const devices = await getDevices(token);
  log('\nPlayers:');
  devices.forEach((d) => log(`  ${d.online ? '●' : '○'} ${d.name}  (${d.deviceFamily || d.deviceType || '?'}${d.online ? ', online' : ', offline'})`));
  return devices;
}

function pickDevice(devices, filter) {
  let pick = devices;
  if (filter) pick = devices.filter((d) => d.name?.toLowerCase().includes(filter.toLowerCase()) || d.deviceId === filter);
  pick = pick.filter((d) => d.online);
  if (pick.length === 0) throw new Error('No matching online player. Is it on and connected to Wi-Fi?');
  if (pick.length > 1) throw new Error(`Several online players match; pick one with --device NAME:\n  ${pick.map((d) => d.name).join('\n  ')}`);
  return pick[0];
}

/** The one online player, or the one matching `filter` (name substring or deviceId). */
async function chooseDevice(token, filter) {
  return pickDevice(await getDevices(token), filter);
}

/**
 * Link cardId to the card in the player. opts: { device, yes, folder, token }
 * Returns { ok, deviceName }.
 */
async function linkCard(cardId, opts = {}) {
  const token = opts.token || await getAccessToken();
  const devices = await listDevices(token);
  const device = pickDevice(devices, opts.device);

  const card = await api(token, 'GET', `/card/${cardId}`).catch(() => null);
  const title = card?.card?.title || cardId;
  log(`\nLinking "${title}" (${cardId}) using player "${device.name}".`);

  if (!opts.yes) await ask('\nInsert the blank MYO card into the player, wait a second, then press Enter… ');

  const res = await api(token, 'POST', `/device-v2/${device.deviceId}/command/card-link`, { cardId, deviceId: device.deviceId });
  log('Command accepted:', JSON.stringify(res));
  log('Watch the player: a red record icon, then a green tick, means the card was written.');

  let ok = false;
  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    const st = await api(token, 'GET', `/device-v2/${device.deviceId}/status`).catch(() => null);
    const active = st?.activeCard || st?.status?.activeCard;
    if (active === cardId) { log(`Player reports active card ${active}  ✓`); ok = true; break; }
  }
  if (!ok) log('Could not confirm from player status; trust the green tick on the display.');

  if (opts.folder) {
    const existing = readCardFile(opts.folder);
    writeCardFile(opts.folder, { ...existing, cardId, linkedAt: new Date().toISOString(), linkedWith: device.name });
  }
  log('\nRemove the card so the player can download the audio while idle; then it plays offline.');
  return { ok, deviceName: device.name };
}

function resolveCardId(t) {
  const asFolder = path.resolve(t);
  if (fs.existsSync(asFolder) && fs.statSync(asFolder).isDirectory()) {
    const id = readCardFile(asFolder).cardId;
    if (!id) throw new Error(`No .yoto-card.json with a cardId in ${asFolder}; upload it first`);
    return { cardId: id, folder: asFolder };
  }
  return { cardId: t, folder: null };
}

module.exports = { linkCard, listDevices, getDevices, pickDevice, chooseDevice };

if (require.main === module) {
  const args = process.argv.slice(2);
  const devIdx = args.indexOf('--device');
  const target = args.find((a, i) => !a.startsWith('--') && i !== devIdx + 1);
  (async () => {
    if (args.includes('--devices')) { await listDevices(await getAccessToken()); return; }
    if (!target) throw new Error('Usage: node yoto-link.js <folder-or-cardId> [--device NAME] [--yes] [--devices]');
    const { cardId, folder } = resolveCardId(target);
    await linkCard(cardId, { device: devIdx >= 0 ? args[devIdx + 1] : null, yes: args.includes('--yes'), folder });
  })().then(closePrompt, (e) => { console.error('\n✖ ' + (e.message || e)); process.exit(1); });
}
