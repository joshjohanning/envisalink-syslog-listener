// EnvisaLink 4 Syslog Listener
//
// Listens for syslog messages (UDP port 514) from an EnvisaLink 4 module and
// logs zone events (door open/close, motion, faults, arm/disarm, etc.) to a
// file with timestamps and friendly zone names.
//
// Prerequisites:
//   1. In the EVL4 web interface (http://<EVL4-IP>/), set the Syslog Client:
//      - Server IP Address: your Raspberry Pi's IP
//      - Facility: any value 16-23 (e.g., 20) — 00 means OFF
//   2. Configure zones.json with your zone numbers and names
//
// Usage:
//   sudo node envisalink-syslog-listener.js [options]
//
//   Options:
//     --port              UDP port to listen on (default: 514, requires sudo)
//     --logPath           Path to the log file (default: ./envisalink-syslog-listener.log)
//     --zonesPath         Path to zones.json (default: ./zones.json)
//     --debug             Enable debug logging to console (default: false)
//     --dryRun            Skip sending emails (default: false)
//     --MAILGUN_API_KEY   Mailgun API key (or set env var)
//     --MAILGUN_DOMAIN    Mailgun domain (or set env var)
//     --emailOnOpen       Send email when a zone opens (default: false)
//     --emailOnAlarm      Send email on alarm events (default: true)
//     --GOOGLE_SHEETS_WEBHOOK  Google Apps Script URL for logging to Sheets
//
// Note: Port 514 requires root/sudo. Alternatively, use a higher port and
//       redirect with iptables:
//       sudo iptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-port 5514
//
// This does NOT use the TPI connection (port 4025) — it uses the EVL4's
// built-in syslog sender over UDP, so it will not conflict with Homebridge
// or any other TPI client.

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { parseSyslogMessage, getZoneName } = require('./parser');

const argv = yargs(hideBin(process.argv))
  .option('port', { type: 'number', default: 514, describe: 'UDP port to listen on' })
  .option('logPath', { type: 'string', default: path.join(__dirname, 'envisalink-syslog-listener.log'), describe: 'Log file path' })
  .option('zonesPath', { type: 'string', default: path.join(__dirname, 'zones.json'), describe: 'Path to zones.json' })
  .option('debug', { type: 'boolean', default: false, describe: 'Enable debug output' })
  .option('dryRun', { type: 'boolean', default: false, describe: 'Skip sending emails' })
  .option('MAILGUN_API_KEY', { type: 'string', default: '', describe: 'Mailgun API key' })
  .option('MAILGUN_DOMAIN', { type: 'string', default: '', describe: 'Mailgun domain' })
  .option('emailOnOpen', { type: 'boolean', default: false, describe: 'Send email when a zone opens' })
  .option('emailOnAlarm', { type: 'boolean', default: true, describe: 'Send email on alarm events' })
  .option('GOOGLE_SHEETS_WEBHOOK', { type: 'string', default: '', describe: 'Google Apps Script web app URL for logging to Google Sheets' })
  .option('NTFY_TOPIC', { type: 'string', default: '', describe: 'ntfy.sh topic for push notifications (e.g., my-envisalink-alerts)' })
  .option('rulesPath', { type: 'string', default: path.join(__dirname, 'rules.json'), describe: 'Path to alert rules config' })
  .argv;

// Resolve config
const PORT = argv.port;
const LOG_PATH = argv.logPath;
const ZONES_PATH = argv.zonesPath;
const DEBUG = argv.debug;
const DRY_RUN = argv.dryRun;
const MAILGUN_API_KEY = argv.MAILGUN_API_KEY || process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = argv.MAILGUN_DOMAIN || process.env.MAILGUN_DOMAIN || '';
const EMAIL_ON_OPEN = argv.emailOnOpen;
const EMAIL_ON_ALARM = argv.emailOnAlarm;
const GOOGLE_SHEETS_WEBHOOK = argv.GOOGLE_SHEETS_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || '';
const NTFY_TOPIC = argv.NTFY_TOPIC || process.env.NTFY_TOPIC || '';
const RULES_PATH = argv.rulesPath;

// Optional mailgun setup — only require if we need it
let mg = null;
if (!DRY_RUN && MAILGUN_API_KEY && MAILGUN_DOMAIN) {
  const Mailgun = require('mailgun.js');
  const formData = require('form-data');
  const mailgun = new Mailgun(formData);
  mg = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });
}

// Load zone names — auto-create zones.json from sample if it doesn't exist
const ZONES_SAMPLE_PATH = path.join(__dirname, 'zones.sample.json');
let zones = {};
if (!fs.existsSync(ZONES_PATH) && fs.existsSync(ZONES_SAMPLE_PATH)) {
  fs.copyFileSync(ZONES_SAMPLE_PATH, ZONES_PATH);
  logToFile(`Created ${ZONES_PATH} from ${ZONES_SAMPLE_PATH} — edit it with your actual zone names`);
}
try {
  const raw = fs.readFileSync(ZONES_PATH, 'utf8');
  zones = JSON.parse(raw);
  logToFile(`Loaded ${Object.keys(zones).length} zone(s) from ${ZONES_PATH}`);
} catch (err) {
  logToFile(`Warning: Could not load zones file (${ZONES_PATH}): ${err.message}. Zone numbers will be used as-is.`);
}

// Load alert rules -- auto-create rules.json from sample if it doesn't exist
const RULES_SAMPLE_PATH = path.join(__dirname, 'rules.sample.json');
let rules = [];
if (!fs.existsSync(RULES_PATH) && fs.existsSync(RULES_SAMPLE_PATH)) {
  fs.copyFileSync(RULES_SAMPLE_PATH, RULES_PATH);
  logToFile(`Created ${RULES_PATH} from ${RULES_SAMPLE_PATH} -- edit it with your alert rules`);
}
try {
  const raw = fs.readFileSync(RULES_PATH, 'utf8');
  rules = JSON.parse(raw);
  logToFile(`Loaded ${rules.length} alert rule(s) from ${RULES_PATH}`);
} catch (err) {
  logToFile(`No alert rules loaded (${RULES_PATH}): ${err.message}`);
}

// Zone state tracking for duration-based rules
const zoneOpenTimers = {};  // zone -> setTimeout ID
const zoneOpenTimes = {};   // zone -> Date when opened

// ---- Helpers ----

function formatLocalTime(date) {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
}

function logToFile(message) {
  const line = `${formatLocalTime(new Date())} - ${message}\n`;
  fs.appendFileSync(LOG_PATH, line);
  if (DEBUG) console.log(line.trim());
}

function getZoneNameLocal(zoneNumber) {
  return getZoneName(zones, zoneNumber);
}

// ---- Syslog message parsing ----

function parseMessage(raw) {
  return parseSyslogMessage(raw, zones);
}

// ---- Email ----

async function sendAlert(subject, text) {
  if (DRY_RUN || !mg) {
    logToFile(`[DRY RUN] Would send email: ${subject}`);
    return;
  }

  try {
    await mg.messages.create(MAILGUN_DOMAIN, {
      from: 'EnvisaLink Syslog <soccerjoshj07+no_reply@gmail.com>',
      to: ['soccerjoshj07@gmail.com'],
      subject: subject,
      text: text
    });
    logToFile(`Email sent: ${subject}`);
  } catch (err) {
    logToFile(`Failed to send email: ${err.message}`);
  }
}

// ---- Google Sheets webhook ----

async function postToGoogleSheets(parsed) {
  if (!GOOGLE_SHEETS_WEBHOOK) return;
  if (DRY_RUN) {
    logToFile(`[DRY RUN] Would post to Google Sheets: ${parsed.event}`);
    return;
  }

  const payload = JSON.stringify({
    timestamp: formatLocalTime(parsed.timestamp),
    event: parsed.event,
    zone: parsed.zone,
    zoneName: parsed.zoneName || '',
    message: parsed.message,
    raw: parsed.raw
  });

  try {
    const url = new URL(GOOGLE_SHEETS_WEBHOOK);
    const https = require('https');
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        // Google Apps Script redirects (302) on success - follow it
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, (r) => { r.resume(); resolve(); });
        } else {
          res.resume();
          resolve();
        }
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    if (DEBUG) logToFile('Posted to Google Sheets');
  } catch (err) {
    logToFile(`Failed to post to Google Sheets: ${err.message}`);
  }
}

// ---- ntfy.sh push notifications ----

async function sendNtfy(title, message, priority) {
  if (!NTFY_TOPIC) return;
  if (DRY_RUN) {
    logToFile(`[DRY RUN] Would send ntfy: ${title}`);
    return;
  }

  try {
    const https = require('https');
    const payload = message;
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'ntfy.sh',
        path: `/${encodeURIComponent(NTFY_TOPIC)}`,
        method: 'POST',
        headers: {
          'Title': title,
          'Priority': priority || 'default',
          'Tags': 'house'
        }
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    if (DEBUG) logToFile(`Sent ntfy: ${title}`);
  } catch (err) {
    logToFile(`Failed to send ntfy: ${err.message}`);
  }
}

// ---- Alert rules engine ----

function evaluateRules(parsed) {
  if (rules.length === 0 || parsed.zone === null) return;

  const zoneKey = String(parsed.zone);

  if (parsed.event === 'Zone Open') {
    // Find any open_duration rules for this zone
    const matchingRules = rules.filter(r => r.condition === 'open_duration' && String(r.zone) === zoneKey);

    for (const rule of matchingRules) {
      const delayMs = (rule.minutes || 20) * 60 * 1000;
      const zoneName = getZoneNameLocal(zoneKey);

      // Clear any existing timer for this zone
      if (zoneOpenTimers[zoneKey]) {
        clearTimeout(zoneOpenTimers[zoneKey]);
      }

      zoneOpenTimes[zoneKey] = new Date();

      zoneOpenTimers[zoneKey] = setTimeout(async () => {
        const openedAt = zoneOpenTimes[zoneKey];
        logToFile(`Alert rule triggered: ${zoneName} has been open for ${rule.minutes} minutes`);

        if (rule.action === 'email') {
          await sendAlert(
            `⚠️ ${zoneName} open for ${rule.minutes}+ minutes`,
            `${zoneName} has been open since ${formatLocalTime(openedAt)}.\n\nRule: ${rule.description || 'Open duration alert'}\nZone: ${zoneKey}\nDuration: ${rule.minutes} minutes`
          );
        }
        if (rule.action === 'ntfy' || rule.action === 'both') {
          await sendNtfy(
            `${zoneName} open ${rule.minutes}+ min`,
            `Open since ${formatLocalTime(openedAt)}`,
            'high'
          );
        }

        if (rule.action === 'both') {
          await sendAlert(
            `\u26a0\ufe0f ${zoneName} open for ${rule.minutes}+ minutes`,
            `${zoneName} has been open since ${formatLocalTime(openedAt)}.\n\nRule: ${rule.description || 'Open duration alert'}\nZone: ${zoneKey}\nDuration: ${rule.minutes} minutes`
          );
        }
        delete zoneOpenTimers[zoneKey];
        delete zoneOpenTimes[zoneKey];
      }, delayMs);

      if (DEBUG) logToFile(`Timer set: ${zoneName} will alert in ${rule.minutes} min if not closed`);
    }
  }

  if (parsed.event === 'Zone Close') {
    // Cancel any pending timer for this zone
    if (zoneOpenTimers[zoneKey]) {
      clearTimeout(zoneOpenTimers[zoneKey]);
      delete zoneOpenTimers[zoneKey];
      delete zoneOpenTimes[zoneKey];
      if (DEBUG) logToFile(`Timer cleared: zone ${zoneKey} closed before alert`);
    }
  }
}

// ---- Main UDP server ----

const server = dgram.createSocket('udp4');

server.on('error', (err) => {
  logToFile(`Server error: ${err.message}`);
  if (err.code === 'EACCES') {
    logToFile('Permission denied — port 514 requires sudo. Try: sudo node envisalink-syslog-listener.js');
    logToFile('Or use a higher port with --port 5514 and redirect with iptables.');
  }
  server.close();
  process.exit(1);
});

server.on('message', async (msg, rinfo) => {
  const raw = msg.toString('utf8');

  if (DEBUG) {
    logToFile(`[RAW] from ${rinfo.address}:${rinfo.port} — ${raw.trim()}`);
  }

  const parsed = parseMessage(raw);

  // Build a friendly log line
  let logLine;
  if (parsed.zone !== null) {
    logLine = `${parsed.event}: ${parsed.zoneName} — ${parsed.message}`;
  } else {
    logLine = `${parsed.event}: ${parsed.message}`;
  }

  logToFile(logLine);

  // Post to Google Sheets
  await postToGoogleSheets(parsed);

  // Evaluate alert rules (e.g., zone open too long)
  evaluateRules(parsed);

  // Send email alerts based on configuration
  if (EMAIL_ON_ALARM && parsed.event === 'Alarm') {
    await sendAlert(
      `🚨 EnvisaLink Alarm: ${parsed.zoneName || 'System'}`,
      `An alarm event was detected.\n\nDetails:\n- Event: ${parsed.event}\n- Zone: ${parsed.zoneName || 'N/A'}\n- Raw message: ${parsed.message}\n- Time: ${formatLocalTime(parsed.timestamp)}`
    );
  }

  if (EMAIL_ON_OPEN && parsed.event === 'Zone Open') {
    await sendAlert(
      `🚪 Zone Opened: ${parsed.zoneName}`,
      `A zone was opened.\n\nDetails:\n- Zone: ${parsed.zoneName}\n- Time: ${formatLocalTime(parsed.timestamp)}\n- Raw message: ${parsed.message}`
    );
  }
});

server.on('listening', () => {
  const addr = server.address();
  logToFile(`EnvisaLink syslog listener started on UDP port ${addr.port}`);
  console.log(`EnvisaLink syslog listener started on UDP port ${addr.port}`);
  console.log(`Logging to: ${LOG_PATH}`);
  console.log(`Zones config: ${ZONES_PATH} (${Object.keys(zones).length} zone(s) loaded)`);
  if (mg) {
    console.log('Mailgun: configured');
  } else if (DRY_RUN) {
    console.log('Mailgun: dry-run mode (emails will be skipped)');
  } else {
    console.log('Mailgun: not configured (no API key/domain - email alerts disabled)');
  }
  if (GOOGLE_SHEETS_WEBHOOK) {
    console.log('Google Sheets: configured');
  } else {
    console.log('Google Sheets: not configured (no webhook URL)');
  }
  if (NTFY_TOPIC) {
    console.log(`ntfy: configured (topic: ${NTFY_TOPIC})`);
  } else {
    console.log('ntfy: not configured (no topic)');
  }
  if (rules.length > 0) {
    console.log(`Alert rules: ${rules.length} rule(s) loaded from ${RULES_PATH}`);
  } else {
    console.log('Alert rules: none loaded');
  }
});

server.bind(PORT);
