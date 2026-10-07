#!/usr/bin/env node
/**
 * yoto-status.js — what is the player doing right now?
 * Shows the card in the slot, whether it is streaming or playing from local storage,
 * free space, background download, battery and Wi-Fi strength.
 *
 *   node yoto-status.js            one snapshot (needs `npm install` once, for mqtt)
 *   node yoto-status.js --watch    keep printing playback events until Ctrl-C
 */
const { getAccessToken, api } = require('./yoto-auth');
let mqtt;
try { mqtt = require('mqtt'); } catch { console.error('Run `npm install` once in this folder (needs the mqtt package).'); process.exit(1); }

const WATCH = process.argv.includes('--watch');
const gb = (kb) => (kb / 1024 / 1024).toFixed(1) + ' GB';

(async () => {
  const token = await getAccessToken();
  const d = (await api(token, 'GET', '/device-v2/devices/mine')).devices.find((x) => x.online)
    || (() => { throw new Error('No player online.'); })();
  const id = d.deviceId;
  const totalDisk = (await api(token, 'GET', `/device-v2/${id}/config`).catch(() => null))?.device?.status?.totalDisk || 0;
  const c = mqtt.connect('wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt', {
    keepalive: 300, port: 443, protocol: 'wss', clientId: 'DASH' + id,
    username: `${id}?x-amz-customauthorizer-name=PublicJWTAuthorizer`, password: token,
    ALPNProtocols: ['x-amzn-mqtt-ca'],
  });
  let gotStatus = false, gotEvent = false;
  const finish = () => { if (!WATCH && gotStatus && gotEvent) { c.end(); process.exit(0); } };
  c.on('connect', () => {
    c.subscribe([`device/${id}/data/status`, `device/${id}/data/events`]);
    c.publish(`device/${id}/command/status/request`, '{}');
    c.publish(`device/${id}/command/events/request`, '{}');
    if (WATCH) setInterval(() => c.publish(`device/${id}/command/events/request`, '{}'), 295000);
  });
  c.on('message', (topic, msg) => {
    const m = JSON.parse(msg.toString());
    if (topic.endsWith('/status')) {
      const s = m.status;
      console.log(`\nPlayer "${d.name || 'Yoto'}"  fw ${s.fwVersion}  battery ${s.batteryLevel}%${s.charging ? ' (charging)' : ''}`);
      console.log(`  storage: ${gb(s.freeDisk)} free${totalDisk ? ' of ' + gb(totalDisk) : ''}   background download: ${s.bgDownload ? 'yes' : 'no'}`);
      console.log(`  card in slot: ${s.cardInserted ? s.activeCard : 'none'}`);
      gotStatus = true; finish();
    } else {
      const where = m.streaming ? 'STREAMING from cloud' : 'playing from local storage';
      console.log(`  ${m.playbackStatus}: "${m.trackTitle}" ${m.position}s / ${m.trackLength}s  (${where}, source=${m.source})`);
      gotEvent = true; finish();
    }
  });
  c.on('error', (e) => { console.error('mqtt error:', e.message); process.exit(1); });
  setTimeout(() => { if (!WATCH) { console.log(gotStatus ? '' : 'No status received (player asleep?)'); c.end(); process.exit(0); } }, 20000);
})().catch((e) => { console.error('\n✖ ' + (e.message || e)); process.exit(1); });
