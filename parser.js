// Parsing and helper functions for EnvisaLink syslog messages.
// Extracted into a separate module for testability.

/**
 * Ademco Contact ID (CID) event code lookup table.
 * Format: Q-EEE-PP-CCC where Q=qualifier, EEE=event, PP=partition, CCC=user/zone
 * Qualifier: 1 = new event (opening/disarm), 3 = restore (closing/arm)
 *
 * Note: Not all CID codes are confirmed to be sent via syslog by the EVL4.
 * Arm/disarm (441/442/443) are confirmed. Other codes are included for
 * completeness in case they appear, but some (e.g., zone bypass 570) are
 * known NOT to be sent via syslog.
 *
 * Reference: SIA DC-05-1999.09 (Ademco Contact ID Protocol)
 */
const CID_EVENT_CODES = {
  // Alarms
  '100': 'Medical Alarm',
  '110': 'Fire Alarm',
  '115': 'Fire Alarm (pull station)',
  '120': 'Panic Alarm',
  '121': 'Duress Alarm',
  '130': 'Burglary Alarm',
  '131': 'Perimeter Alarm',
  '132': 'Interior Alarm',
  '134': 'Entry/Exit Alarm',
  '137': 'Tamper Alarm',
  '140': 'General Alarm',
  // Supervisory / Trouble
  '301': 'AC Power Loss',
  '302': 'Low Battery',
  '305': 'System Reset',
  '350': 'Communication Failure',
  '373': 'Fire Trouble',
  '380': 'Sensor Trouble',
  '381': 'Loss of Supervision',
  '383': 'Sensor Tamper',
  // Open/Close (arm/disarm)
  '400': 'Open/Close',
  '401': 'Open/Close by User',
  '403': 'Open/Close (auto)',
  '407': 'Remote Arm/Disarm',
  '408': 'Quick Arm',
  '409': 'Keyswitch Arm/Disarm',
  '441': 'Armed Stay/Disarmed',
  '442': 'Armed Away/Disarmed',
  '443': 'Armed Night/Disarmed',
  // Test
  '601': 'Manual Test',
  '602': 'Periodic Test',
  '616': 'Service Request'
};

/**
 * Parses a CID (Contact ID) event string like "1441010020".
 * @param {string} cidStr - The raw CID numeric string (10 digits)
 * @returns {Object|null} Parsed CID data or null if invalid
 */
function parseCID(cidStr) {
  if (!cidStr || cidStr.length < 9) return null;

  const qualifier = cidStr[0];           // 1 = new event/disarm, 3 = restore/arm
  const eventCode = cidStr.substring(1, 4); // e.g., "441"
  const partition = parseInt(cidStr.substring(4, 6), 10); // e.g., 1
  const zoneOrUser = parseInt(cidStr.substring(6, 9), 10); // e.g., 2

  const codeInfo = CID_EVENT_CODES[eventCode];

  // Determine the friendly event name
  let event;
  const isArm = ['400', '401', '403', '407', '408', '409', '441', '442', '443'].includes(eventCode);
  const isAlarm = parseInt(eventCode, 10) >= 100 && parseInt(eventCode, 10) < 200;

  if (isArm) {
    if (qualifier === '1') {
      event = 'Disarmed';
    } else if (qualifier === '3') {
      if (eventCode === '441') event = 'Armed Stay';
      else if (eventCode === '442') event = 'Armed Away';
      else if (eventCode === '443') event = 'Armed Night';
      else event = 'Armed';
    } else {
      event = codeInfo || `CID ${eventCode}`;
    }
  } else if (isAlarm) {
    event = 'Alarm';
  } else {
    event = codeInfo || `CID ${eventCode}`;
  }

  return {
    qualifier,
    eventCode,
    event,
    partition,
    zoneOrUser,
    description: codeInfo || `Unknown (${eventCode})`
  };
}

/**
 * Returns a friendly zone name from a zones dictionary.
 * @param {Object} zones - Map of zone number (string) to friendly name
 * @param {number|string} zoneNumber - The zone number to look up
 * @returns {string} Friendly name like "Front Door (zone 3)" or "zone 3" if not found
 */
function getZoneName(zones, zoneNumber) {
  const key = String(zoneNumber);
  if (zones[key]) {
    return zones[key];
  }
  return `Zone ${key}`;
}

/**
 * Parses a raw syslog message from the EnvisaLink 4.
 *
 * Syslog messages from the EVL4 look roughly like:
 *   <priority>timestamp hostname ENVISALINK[pid]: message content
 *
 * Common messages include:
 *   Zone Open: 003       (zone 3 opened)
 *   Zone Close: 003      (zone 3 closed/restored)
 *   Alarm: ...           (alarm triggered)
 *   Armed: ...           (system armed)
 *   Disarmed: ...        (system disarmed)
 *
 * @param {string} raw - The raw syslog message string
 * @param {Object} zones - Map of zone number (string) to friendly name
 * @returns {Object} Parsed result with event, zone, zoneName, message, raw
 */
function parseSyslogMessage(raw, zones) {
  zones = zones || {};

  const result = {
    raw: raw.trim(),
    timestamp: new Date(),
    event: null,
    zone: null,
    zoneName: null,
    message: null
  };

  // Strip syslog header - find the content after "]: " or after the app name
  let content = raw;

  // Try to extract content after "]: "
  const bracketIdx = raw.indexOf(']: ');
  if (bracketIdx >= 0) {
    content = raw.substring(bracketIdx + 3).trim();
  } else {
    // Try to find content after "ENVISALINK" or similar marker
    const markers = ['ENVISALINK', 'envisalink', 'EVL4', 'evl4'];
    for (const marker of markers) {
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        content = raw.substring(idx + marker.length).trim();
        // Strip leading colon or brackets
        content = content.replace(/^[\[:\]\s]+/, '').trim();
        break;
      }
    }
  }

  result.message = content;

  // Parse zone events: "Zone Open: 003", "Zone Closed: 003", "Zone Close: 003"
  const zoneMatch = content.match(/Zone\s+(Open(?:ed)?|Close[d]?|Alarm|Trouble|Tamper|Restore[d]?):\s*(\d+)/i);
  if (zoneMatch) {
    // Normalize: "Closed" -> "Close", "Opened" -> "Open", "Restored" -> "Restore"
    let action = zoneMatch[1].replace(/ed$/i, 'e').replace(/ee$/i, 'e');
    // Handle "Opene" -> "Open" (from "Opened" -> "Opene")
    if (action.toLowerCase() === 'opene') action = 'Open';
    result.event = `Zone ${action}`;
    result.zone = parseInt(zoneMatch[2], 10);
    result.zoneName = getZoneName(zones, result.zone);
    return result;
  }

  // Parse alarm events (check before arm/disarm since "alarm" contains "arm")
  if (/alarm/i.test(content)) {
    result.event = 'Alarm';
    return result;
  }

  // Parse arm/disarm events
  if (/arm/i.test(content)) {
    if (/disarm/i.test(content)) {
      result.event = 'Disarmed';
    } else if (/stay/i.test(content)) {
      result.event = 'Armed Stay';
    } else if (/away/i.test(content)) {
      result.event = 'Armed Away';
    } else if (/night|instant/i.test(content)) {
      result.event = 'Armed Night';
    } else {
      result.event = 'Armed';
    }
    return result;
  }

  // Parse CID (Contact ID) events: "CID Event: 1441010020"
  const cidMatch = content.match(/CID\s+Event:\s*(\d{9,10})/i);
  if (cidMatch) {
    const cid = parseCID(cidMatch[1]);
    if (cid) {
      result.event = cid.event;
      result.partition = cid.partition;
      result.user = cid.zoneOrUser;
      const userStr = cid.zoneOrUser ? `, user ${cid.zoneOrUser}` : '';
      const partStr = cid.partition ? `partition ${cid.partition}` : '';
      result.message = `${content} (${cid.description}${partStr ? ', ' + partStr : ''}${userStr})`;
      return result;
    }
  }

  // Catch-all - still log it
  result.event = 'Other';
  return result;
}

module.exports = { parseSyslogMessage, getZoneName, parseCID, CID_EVENT_CODES };
