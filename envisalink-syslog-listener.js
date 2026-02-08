// EnvisaLink 4 Syslog Listener
//
// Listens for syslog messages (UDP port 514) from an EnvisaLink 4 module and
// logs zone events (door open/close, motion, faults, arm/disarm, etc.) to a
// file with timestamps and friendly zone names.
//
// Prerequisites:
//   1. In the EVL4 web interface (http://<EVL4-IP>/), set the Syslog Client:
//      - Server IP Address: your Raspberry Pi's IP
//      - Facility: any value 16-23 (e.g., 20) -- 00 means OFF
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
//     --emailFrom         From address for email alerts (or set env var EMAIL_FROM)
//     --emailTo           Comma-separated recipient list (or set env var EMAIL_TO)
//     --GOOGLE_SHEETS_WEBHOOK  Google Apps Script URL for logging to Sheets
//     --NTFY_TOPIC        ntfy.sh topic for push notifications
//     --rulesPath         Path to alert rules config (default: ./rules.json)
//     --heartbeatMinutes  Alert if no syslog activity for N minutes (0 = disabled)
//
// Note: Port 514 requires root/sudo. Alternatively, use a higher port and
//       redirect with iptables:
//       sudo iptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-port 5514
//
// This does NOT use the TPI connection (port 4025) -- it uses the EVL4's
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
  .option('emailFrom', { type: 'string', default: '', describe: 'From address for email alerts (e.g., "EnvisaLink <alerts@example.com>")' })
  .option('emailTo', { type: 'string', default: '', describe: 'Comma-separated list of email recipients' })
  .option('rulesPath', { type: 'string', default: path.join(__dirname, 'rules.json'), describe: 'Path to alert rules config' })
  .option('heartbeatMinutes', { type: 'number', default: 0, describe: 'Alert if no syslog activity for this many minutes (0 = disabled)' })
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
const EMAIL_FROM = argv.emailFrom || process.env.EMAIL_FROM || '';
const EMAIL_TO = (argv.emailTo || process.env.EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const RULES_PATH = argv.rulesPath;
const HEARTBEAT_MINUTES = argv.heartbeatMinutes || parseInt(process.env.HEARTBEAT_MINUTES, 10) || 0;

// Optional mailgun setup -- only require if we need it
let mg = null;
if (!DRY_RUN && MAILGUN_API_KEY && MAILGUN_DOMAIN) {
  const Mailgun = require('mailgun.js');
  const formData = require('form-data');
  const mailgun = new Mailgun(formData);
  mg = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });
}

// Load zone names -- auto-create zones.json from sample if it doesn't exist
const ZONES_SAMPLE_PATH = path.join(__dirname, 'zones.sample.json');
let zones = {};
if (!fs.existsSync(ZONES_PATH) && fs.existsSync(ZONES_SAMPLE_PATH)) {
  fs.copyFileSync(ZONES_SAMPLE_PATH, ZONES_PATH);
  logToFile(`Created ${ZONES_PATH} from ${ZONES_SAMPLE_PATH} -- edit it with your actual zone names`);
}
try {
  const raw = fs.readFileSync(ZONES_PATH, 'utf8');
  zones = JSON.parse(raw);
  logToFile(`Loaded ${Object.keys(zones).length} zone(s) from ${ZONES_PATH}`);
} catch (err) {
  logToFile(`Warning: Could not load zones file (${ZONES_PATH}): ${err.message}. Zone numbers will be used as-is.`);
}

// Load alert rules (optional - no auto-create)
let rules = [];
if (fs.existsSync(RULES_PATH)) {
  try {
    const raw = fs.readFileSync(RULES_PATH, 'utf8');
    rules = JSON.parse(raw);
    logToFile(`Loaded ${rules.length} alert rule(s) from ${RULES_PATH}`);
  } catch (err) {
    logToFile(`Warning: Could not load rules file (${RULES_PATH}): ${err.message}`);
  }
}

// Zone state tracking for duration-based rules
const zoneOpenTimers = {};    // "zone:ruleIndex" -> setTimeout ID
const zoneOpenTimes = {};     // zone -> Date when opened
const zoneRepeatCounts = {};  // "zone:ruleIndex" -> number of repeat alerts sent

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
  if (DRY_RUN) {
    logToFile(`[DRY RUN] Would send email: ${subject}`);
    return;
  }
  if (!mg) {
    if (DEBUG) logToFile(`Mailgun not configured, skipping email: ${subject}`);
    return;
  }
  if (!EMAIL_FROM || EMAIL_TO.length === 0) {
    logToFile(`Email skipped (no --emailFrom/--emailTo configured): ${subject}`);
    return;
  }

  try {
    const result = await mg.messages.create(MAILGUN_DOMAIN, {
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: subject,
      text: text
    });
    logToFile(`Email sent: ${subject} | Response: ${JSON.stringify(result)}`);
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

function startRuleTimer(zoneKey, rule, ruleIndex, delayMs, repeatCount) {
  const timerKey = `${zoneKey}:${ruleIndex}`;
  const zoneName = getZoneNameLocal(zoneKey);

  zoneOpenTimers[timerKey] = setTimeout(async () => {
    const openedAt = zoneOpenTimes[zoneKey];
    const totalMs = Date.now() - openedAt.getTime();
    const totalMinutes = Math.round(totalMs / (60 * 1000));
    const isRepeat = repeatCount > 0;
    const label = isRepeat ? 'still open' : 'has been open';

    logToFile(`Alert rule triggered: ${zoneName} ${label} for ${totalMinutes}+ minutes${isRepeat ? ` (repeat ${repeatCount})` : ''}`);

    if (rule.action === 'email' || rule.action === 'both') {
      await sendAlert(
        `⚠️ ${zoneName} ${isRepeat ? 'still ' : ''}open for ${totalMinutes}+ minutes`,
        `${zoneName} ${label} since ${formatLocalTime(openedAt)}.\n\nRule: ${rule.description || 'Open duration alert'}\nZone: ${zoneKey}\nDuration: ${totalMinutes}+ minutes${isRepeat ? `\nRepeat: ${repeatCount}` : ''}`
      );
    }
    if (rule.action === 'ntfy' || rule.action === 'both') {
      await sendNtfy(
        `${zoneName} ${isRepeat ? 'still ' : ''}open ${totalMinutes}+ min`,
        `${isRepeat ? 'Still open' : 'Open'} since ${formatLocalTime(openedAt)}`,
        'high'
      );
    }

    // Schedule repeat alert if configured
    const repeatIntervalMs = (rule.repeatInterval || 0) * 60 * 1000;
    const nextRepeat = repeatCount + 1;
    const maxRepeats = rule.maxRepeats || 0;  // 0 = unlimited

    if (repeatIntervalMs > 0 && (maxRepeats === 0 || nextRepeat <= maxRepeats)) {
      zoneRepeatCounts[timerKey] = nextRepeat;
      startRuleTimer(zoneKey, rule, ruleIndex, repeatIntervalMs, nextRepeat);
      if (DEBUG) logToFile(`Repeat timer set: ${zoneName} (rule ${ruleIndex}) will alert again in ${rule.repeatInterval} min`);
    } else {
      delete zoneOpenTimers[timerKey];
      delete zoneRepeatCounts[timerKey];
    }
  }, delayMs);
}

function evaluateRules(parsed) {
  if (rules.length === 0 || parsed.zone === null) return;

  const zoneKey = String(parsed.zone);

  if (parsed.event === 'Zone Open') {
    // Find any open_duration rules for this zone
    const matchingRules = rules.filter(r => r.condition === 'open_duration' && String(r.zone) === zoneKey);

    zoneOpenTimes[zoneKey] = new Date();

    for (let i = 0; i < matchingRules.length; i++) {
      const rule = matchingRules[i];
      const ruleIndex = rules.indexOf(rule);
      const timerKey = `${zoneKey}:${ruleIndex}`;
      const delayMs = (rule.minutes || 20) * 60 * 1000;

      // Clear any existing timer and repeat count for this specific rule
      if (zoneOpenTimers[timerKey]) {
        clearTimeout(zoneOpenTimers[timerKey]);
      }
      delete zoneRepeatCounts[timerKey];

      startRuleTimer(zoneKey, rule, ruleIndex, delayMs, 0);

      if (DEBUG) logToFile(`Timer set: ${getZoneNameLocal(zoneKey)} (rule ${ruleIndex}) will alert in ${rule.minutes} min if not closed`);
    }
  }

  if (parsed.event === 'Zone Close') {
    // Cancel all pending timers for this zone
    for (const key of Object.keys(zoneOpenTimers)) {
      if (key.startsWith(`${zoneKey}:`)) {
        clearTimeout(zoneOpenTimers[key]);
        delete zoneOpenTimers[key];
        delete zoneRepeatCounts[key];
      }
    }
    delete zoneOpenTimes[zoneKey];
    if (DEBUG) logToFile(`Timer(s) cleared: zone ${zoneKey} closed before alert`);
  }
}

// ---- Heartbeat monitoring ----

let lastMessageTime = Date.now();
let heartbeatAlertSent = false;

function startHeartbeat() {
  if (HEARTBEAT_MINUTES <= 0) return;

  const checkIntervalMs = 60 * 1000;  // Check every minute
  const thresholdMs = HEARTBEAT_MINUTES * 60 * 1000;

  setInterval(async () => {
    const elapsed = Date.now() - lastMessageTime;
    if (elapsed >= thresholdMs && !heartbeatAlertSent) {
      const hours = Math.round(elapsed / (60 * 60 * 1000) * 10) / 10;
      logToFile(`Heartbeat alert: no syslog activity for ${hours} hours`);

      await sendAlert(
        '\uD83D\uDC93 EnvisaLink heartbeat -- no activity',
        `No syslog messages received for ${hours} hours (threshold: ${HEARTBEAT_MINUTES} minutes).\n\nThis could indicate:\n- The EVL4 is offline or unreachable\n- The syslog client is misconfigured\n- Network issues between the EVL4 and this server\n\nLast message received: ${formatLocalTime(new Date(lastMessageTime))}`
      );

      await sendNtfy(
        `No EVL4 activity for ${hours}h`,
        `No syslog messages since ${formatLocalTime(new Date(lastMessageTime))}`,
        'high'
      );

      heartbeatAlertSent = true;
    }
  }, checkIntervalMs);

  logToFile(`Heartbeat monitoring enabled: alert after ${HEARTBEAT_MINUTES} minutes of inactivity`);
}

// ---- Main UDP server ----

const server = dgram.createSocket('udp4');

server.on('error', (err) => {
  logToFile(`Server error: ${err.message}`);
  if (err.code === 'EACCES') {
    logToFile('Permission denied -- port 514 requires sudo. Try: sudo node envisalink-syslog-listener.js');
    logToFile('Or use a higher port with --port 5514 and redirect with iptables.');
  }
  server.close();
  process.exit(1);
});

server.on('message', async (msg, rinfo) => {
  const raw = msg.toString('utf8');

  if (DEBUG) {
    logToFile(`[RAW] from ${rinfo.address}:${rinfo.port} -- ${raw.trim()}`);
  }

  const parsed = parseMessage(raw);

  // Reset heartbeat tracker
  lastMessageTime = Date.now();
  heartbeatAlertSent = false;

  // Build a friendly log line
  let logLine;
  if (parsed.zone !== null) {
    logLine = `${parsed.event}: ${parsed.zoneName} -- ${parsed.message}`;
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
    if (EMAIL_FROM && EMAIL_TO.length > 0) {
      console.log(`Mailgun: configured (from: ${EMAIL_FROM}, to: ${EMAIL_TO.join(', ')})`);
    } else {
      console.log('Mailgun: API key set but no --emailFrom/--emailTo configured -- email alerts disabled');
    }
  } else if (DRY_RUN) {
    console.log('Mailgun: dry-run mode (emails will be skipped)');
  } else {
    console.log('Mailgun: not configured (no API key/domain -- email alerts disabled)');
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
  if (HEARTBEAT_MINUTES > 0) {
    console.log(`Heartbeat: alert after ${HEARTBEAT_MINUTES} minutes of inactivity`);
  }

  startHeartbeat();
});

server.bind(PORT);
