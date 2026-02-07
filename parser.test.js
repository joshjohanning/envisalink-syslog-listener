const { parseSyslogMessage, getZoneName, parseCID } = require('./parser');

// Sample zones config for testing
const testZones = {
  '1': 'Front Door',
  '2': 'Back Door',
  '3': 'Garage Door',
  '4': 'Living Room Motion',
  '9': 'Master Bedroom Window'
};

// ---- getZoneName ----

describe('getZoneName', () => {
  test('returns friendly name for a known zone', () => {
    expect(getZoneName(testZones, 1)).toBe('Front Door');
    expect(getZoneName(testZones, 3)).toBe('Garage Door');
  });

  test('returns friendly name when zone number is a string', () => {
    expect(getZoneName(testZones, '9')).toBe('Master Bedroom Window');
  });

  test('returns generic name for an unknown zone', () => {
    expect(getZoneName(testZones, 99)).toBe('Zone 99');
  });

  test('returns generic name when zones dictionary is empty', () => {
    expect(getZoneName({}, 1)).toBe('Zone 1');
  });
});

// ---- parseSyslogMessage: zone events ----

describe('parseSyslogMessage - zone events', () => {
  test('parses Zone Open with syslog header', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Open: 003';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(3);
    expect(result.zoneName).toBe('Garage Door');
  });

  test('parses Zone Close with syslog header', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Close: 001';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Close');
    expect(result.zone).toBe(1);
    expect(result.zoneName).toBe('Front Door');
  });

  test('parses Zone Open without syslog header', () => {
    const raw = 'Zone Open: 002';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(2);
    expect(result.zoneName).toBe('Back Door');
  });

  test('parses Zone Closed (with trailing d) as Zone Close', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  Zone Closed: 9';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Close');
    expect(result.zone).toBe(9);
    expect(result.zoneName).toBe('Master Bedroom Window');
  });

  test('parses real EVL4 Zone Open message', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  Zone Open: 9';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(9);
    expect(result.zoneName).toBe('Master Bedroom Window');
  });

  test('parses zone with leading zeros', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Open: 009';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.zone).toBe(9);
    expect(result.zoneName).toBe('Master Bedroom Window');
  });

  test('parses unknown zone number gracefully', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Open: 042';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(42);
    expect(result.zoneName).toBe('Zone 42');
  });

  test('parses Zone Alarm', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Alarm: 001';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Alarm');
    expect(result.zone).toBe(1);
  });

  test('parses Zone Trouble', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Trouble: 004';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Trouble');
    expect(result.zone).toBe(4);
  });

  test('parses Zone Restore', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Restore: 002';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Restore');
    expect(result.zone).toBe(2);
  });
});

// ---- parseSyslogMessage: arm/disarm events ----

describe('parseSyslogMessage - arm/disarm events', () => {
  test('parses Armed Away', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Armed Away';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Armed Away');
    expect(result.zone).toBeNull();
  });

  test('parses Armed Stay', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Armed Stay';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Armed Stay');
  });

  test('parses Armed Night / Instant', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Armed Instant';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Armed Night');
  });

  test('parses Disarmed', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Disarmed';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Disarmed');
  });

  test('parses generic Armed', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Armed';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Armed');
  });
});

// ---- parseSyslogMessage: alarm events ----

describe('parseSyslogMessage - alarm events', () => {
  test('parses generic Alarm', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Alarm Activated';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Alarm');
  });
});

// ---- parseSyslogMessage: syslog header stripping ----

describe('parseSyslogMessage - header stripping', () => {
  test('strips syslog header with bracket format', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Open: 001';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.message).toBe('Zone Open: 001');
  });

  test('strips ENVISALINK marker without brackets', () => {
    const raw = 'ENVISALINK: Zone Close: 002';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.message).toBe('Zone Close: 002');
    expect(result.event).toBe('Zone Close');
  });

  test('strips EVL4 marker', () => {
    const raw = 'EVL4: Zone Open: 003';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(3);
  });

  test('handles raw message with no recognizable header', () => {
    const raw = 'Zone Open: 001';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(1);
  });
});

// ---- parseSyslogMessage: edge cases ----

describe('parseSyslogMessage - edge cases', () => {
  test('handles empty string', () => {
    const result = parseSyslogMessage('', testZones);
    expect(result.event).toBe('Other');
    expect(result.zone).toBeNull();
  });

  test('handles unknown message content', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Something unexpected happened';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Other');
    expect(result.message).toBe('Something unexpected happened');
  });

  test('handles message with no zones config', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Open: 001';
    const result = parseSyslogMessage(raw, {});
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(1);
    expect(result.zoneName).toBe('Zone 1');
  });

  test('handles message with null zones config', () => {
    const raw = 'Zone Open: 005';
    const result = parseSyslogMessage(raw, null);
    expect(result.event).toBe('Zone Open');
    expect(result.zone).toBe(5);
    expect(result.zoneName).toBe('Zone 5');
  });

  test('preserves raw message', () => {
    const raw = '<134>Jan  1 12:00:00 evl4 ENVISALINK[1234]: Zone Open: 001';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.raw).toBe(raw.trim());
  });

  test('includes a timestamp', () => {
    const before = new Date();
    const result = parseSyslogMessage('Zone Open: 001', testZones);
    const after = new Date();
    expect(result.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ---- parseCID ----

describe('parseCID', () => {
  test('parses Armed Stay (qualifier 3, code 441)', () => {
    const cid = parseCID('3441010020');
    expect(cid.event).toBe('Armed Stay');
    expect(cid.qualifier).toBe('3');
    expect(cid.eventCode).toBe('441');
    expect(cid.partition).toBe(1);
    expect(cid.zoneOrUser).toBe(2);
  });

  test('parses Disarmed from Stay (qualifier 1, code 441)', () => {
    const cid = parseCID('1441010020');
    expect(cid.event).toBe('Disarmed');
    expect(cid.partition).toBe(1);
    expect(cid.zoneOrUser).toBe(2);
  });

  test('parses Armed Away (qualifier 3, code 442)', () => {
    const cid = parseCID('3442010010');
    expect(cid.event).toBe('Armed Away');
  });

  test('parses Armed Night (qualifier 3, code 443)', () => {
    const cid = parseCID('3443010010');
    expect(cid.event).toBe('Armed Night');
  });

  test('parses fire alarm (code 110)', () => {
    const cid = parseCID('1110010050');
    expect(cid.event).toBe('Alarm');
    expect(cid.description).toBe('Fire Alarm');
  });

  test('parses burglary alarm (code 130)', () => {
    const cid = parseCID('1130010030');
    expect(cid.event).toBe('Alarm');
    expect(cid.description).toBe('Burglary Alarm');
  });

  test('parses AC power loss (code 301)', () => {
    const cid = parseCID('1301010000');
    expect(cid.event).toBe('AC Power Loss');
    expect(cid.description).toBe('AC Power Loss');
  });

  test('returns null for short strings', () => {
    expect(parseCID('1234')).toBeNull();
    expect(parseCID('')).toBeNull();
    expect(parseCID(null)).toBeNull();
  });

  test('handles unknown event codes', () => {
    const cid = parseCID('1999010010');
    expect(cid.event).toBe('CID 999');
    expect(cid.description).toBe('Unknown (999)');
  });
});

// ---- parseSyslogMessage: CID events ----

describe('parseSyslogMessage - CID events', () => {
  test('parses CID Armed Stay from real EVL4 message', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  CID Event: 3441010020';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Armed Stay');
    expect(result.user).toBe(2);
    expect(result.partition).toBe(1);
    expect(result.message).toContain('Armed Stay/Disarmed');
    expect(result.message).toContain('user 2');
  });

  test('parses CID Disarmed from real EVL4 message', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  CID Event: 1441010020';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Disarmed');
    expect(result.user).toBe(2);
    expect(result.partition).toBe(1);
  });

  test('parses CID Armed Away', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  CID Event: 3442010010';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Armed Away');
    expect(result.user).toBe(1);
  });

  test('parses CID alarm event', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  CID Event: 1130010030';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('Alarm');
    expect(result.message).toContain('Burglary Alarm');
  });

  test('parses CID with unknown code as Other', () => {
    const raw = '<166>ENVISALINK[001C2A02BB1F]:  CID Event: 1999010010';
    const result = parseSyslogMessage(raw, testZones);
    expect(result.event).toBe('CID 999');
  });
});
