#!/usr/bin/env node
/**
 * yoto-status.js — what is the player doing right now?
 * Shows the card in the slot, whether it is streaming or playing from local storage,
 * free space, background download, battery and firmware.
 *
 *   node yoto-status.js                   one snapshot (needs `npm install` once, for mqtt)
 *   node yoto-status.js --watch           keep printing playback events until Ctrl-C
 *   node yoto-status.js --device NAME     choose the player when you have several
 *   node yoto-status.js --wait            wait for a background download to finish (same as yoto.js --wait)
 */
const { getAccessToken, api } = require('./yoto-auth');
const { chooseDevice } = require('./yoto-link');
const { connectPlayer, waitForDownload, gb } = require('./lib/mqtt');

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const devIdx = args.indexOf('--device');

(async () => {
  const token = await getAccessToken();
  const d = await chooseDevice(token, devIdx >= 0 ? args[devIdx + 1] : undefined);
  const id = d.deviceId;

  if (args.includes('--wait')) {
    console.log(`Waiting for "${d.name}" to finish downloading. Take the card out and leave it on. Ctrl-C to stop.`);
    const ok = await waitForDownload(token, id, {});
    process.exit(ok ? 0 : 1);
  }

  const totalDisk = (await api(token, 'GET', `/device-v2/${id}/config`).catch(() => null))?.device?.status?.totalDisk || 0;
  const p = await connectPlayer(token, id);
  let gotStatus = false, gotEvent = false;
  const finish = () => { if (!WATCH && gotStatus && gotEvent) { p.close(); process.exit(0); } };

  p.onStatus((s) => {
    console.log(`\nPlayer "${d.name || 'Yoto'}"  fw ${s.fwVersion}  battery ${s.batteryLevel}%${s.charging ? ' (charging)' : ''}`);
    console.log(`  storage: ${gb(s.freeDisk)} free${totalDisk ? ' of ' + gb(totalDisk) : ''}   background download: ${s.bgDownload ? 'yes' : 'no'}`);
    console.log(`  card in slot: ${s.cardInserted ? s.activeCard : 'none'}`);
    gotStatus = true; finish();
  });
  p.onEvent((m) => {
    const where = m.streaming ? 'STREAMING from cloud' : 'playing from local storage';
    console.log(`  ${m.playbackStatus}: "${m.trackTitle}" ${m.position}s / ${m.trackLength}s  (${where}, source=${m.source})`);
    gotEvent = true; finish();
  });
  p.requestStatus();
  p.requestEvents();
  if (WATCH) setInterval(() => p.requestEvents(), 295000);
  setTimeout(() => { if (!WATCH) { console.log(gotStatus ? '' : 'No status received (player asleep?)'); p.close(); process.exit(0); } }, 20000);
})().catch((e) => { console.error('\n✖ ' + (e.message || e)); process.exit(1); });
