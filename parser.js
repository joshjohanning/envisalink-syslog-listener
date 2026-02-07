// Parsing and helper functions for EnvisaLink syslog messages.
// Extracted into a separate module for testability.

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

  // Catch-all - still log it
  result.event = 'Other';
  return result;
}

module.exports = { parseSyslogMessage, getZoneName };
