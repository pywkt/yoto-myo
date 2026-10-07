/**
 * lib/mqtt.js — live connection to a player over Yoto's MQTT broker (AWS IoT), using the
 * same public-JWT authoriser the official app uses. Needs the `mqtt` package.
 *
 *   const p = await connectPlayer(token, deviceId);
 *   p.onStatus((s) => ...);   // { fwVersion, batteryLevel, charging, freeDisk, bgDownload, cardInserted, activeCard, ... }
 *   p.onEvent((e) => ...);    // { playbackStatus, trackTitle, position, trackLength, streaming, source, cardId, ... }
 *   p.requestStatus(); p.requestEvents(); p.close();
 */

const MQTT_URL = 'wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt';

function loadMqtt() {
  try { return require('mqtt'); } catch { throw new Error('Run `npm install` once in this folder (needs the mqtt package).'); }
}

function connectPlayer(token, deviceId) {
  const mqtt = loadMqtt();
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(MQTT_URL, {
      keepalive: 300, port: 443, protocol: 'wss', clientId: 'DASH' + deviceId,
      username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`, password: token,
      ALPNProtocols: ['x-amzn-mqtt-ca'],
    });
    const statusFns = [], eventFns = [];
    c.on('message', (topic, msg) => {
      let m; try { m = JSON.parse(msg.toString()); } catch { return; }
      if (topic.endsWith('/data/status')) statusFns.forEach((f) => f(m.status || m));
      else if (topic.endsWith('/data/events')) eventFns.forEach((f) => f(m));
    });
    c.once('connect', () => {
      c.subscribe([`device/${deviceId}/data/status`, `device/${deviceId}/data/events`]);
      resolve({
        client: c,
        onStatus: (f) => statusFns.push(f),
        onEvent: (f) => eventFns.push(f),
        requestStatus: () => c.publish(`device/${deviceId}/command/status/request`, '{}'),
        requestEvents: () => c.publish(`device/${deviceId}/command/events/request`, '{}'),
        close: () => c.end(true),
      });
    });
    c.once('error', (e) => reject(new Error('mqtt: ' + e.message)));
  });
}

const gb = (kb) => (kb / 1024 / 1024).toFixed(1) + ' GB';
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

/**
 * Wait for the player to finish downloading new content. The player only downloads while
 * idle with no card inserted, so this nags about an inserted card. Resolves true when a
 * background download was observed starting and finishing (or the expected amount of
 * space was consumed), false on timeout or when nothing happens for a while.
 * opts: { expectedBytes, timeoutMin = 20, idleMin = 4, log }
 */
async function waitForDownload(token, deviceId, opts = {}) {
  const log = opts.log || console.log;
  const timeoutMs = (opts.timeoutMin || 20) * 60000;
  const idleMs = (opts.idleMin || 4) * 60000;
  const expected = opts.expectedBytes || 0;
  const p = await connectPlayer(token, deviceId);

  return new Promise((resolve) => {
    let baselineFree = null, lastFree = null, lastBg = null, sawBg = false, nagged = false;
    let lastChange = Date.now();
    const started = Date.now();
    const finish = (ok, msg) => { clearInterval(timer); p.close(); if (msg) log(msg); resolve(ok); };

    p.onStatus((s) => {
      if (baselineFree === null) {
        baselineFree = s.freeDisk;
        log(`Player online: ${gb(s.freeDisk)} free, background download ${s.bgDownload ? 'running' : 'not running'}.`);
      }
      if (s.cardInserted && !nagged) { log('  ⚠ A card is still in the slot. The player only downloads when it is empty; take the card out.'); nagged = true; }
      if (!s.cardInserted) nagged = false;
      const bg = Boolean(s.bgDownload);
      const downloaded = Math.max(0, (baselineFree - s.freeDisk) * 1024);
      if (bg !== lastBg || s.freeDisk !== lastFree) {
        lastChange = Date.now();
        const prog = expected ? `${mb(downloaded)} of ~${mb(expected)}` : mb(downloaded);
        log(`  ${new Date().toLocaleTimeString()}  download ${bg ? 'running' : 'idle'}, ${prog} written`);
      }
      if (bg) sawBg = true;
      if (sawBg && !bg) return finish(true, '\n✓ Download finished. The card will play from local storage now.');
      if (expected && !bg && downloaded >= expected * 0.9) return finish(true, '\n✓ Expected amount downloaded. The card will play from local storage now.');
      lastBg = bg; lastFree = s.freeDisk;
      if (Date.now() - lastChange > idleMs) {
        return finish(false, `\nNo download activity for ${opts.idleMin || 4} minutes. Either the player already had this content cached, or it is not idle.\n` +
          'Insert the card and run `node yoto-status.js` to check for "playing from local storage".');
      }
    });
    p.requestStatus();
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) return finish(false, `\nGave up after ${opts.timeoutMin || 20} minutes. Run \`node yoto-status.js\` later to check.`);
      p.requestStatus();
    }, 15000);
    setTimeout(() => { if (baselineFree === null) finish(false, '\nNo status from the player after 30 s. Is it on and on Wi-Fi?'); }, 30000);
  });
}

module.exports = { connectPlayer, waitForDownload, MQTT_URL, gb, mb };
