const fs = require('fs');
const path = require('path');
const http = require('http');
const BypassServer = require('./bypass-server');

const TEST_BYPASS_PATH = path.join(__dirname, '.test-bypasses.json');

function cleanup() {
  try { fs.unlinkSync(TEST_BYPASS_PATH); } catch {}
}

function makeRequest(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers: { 'Connection': 'close' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('BypassServer', () => {
  let server;
  const PORT = 9876;

  beforeEach(() => {
    cleanup();
    server = new BypassServer({
      port: PORT,
      bypassPath: TEST_BYPASS_PATH,
      debug: false,
      logFn: () => {},
      zones: { '3': 'Garage Door', '2': 'Back Door' }
    });
  });

  afterEach(() => {
    server.stop();
    cleanup();
  });

  describe('isBypassed', () => {
    test('returns false for non-bypassed zone', () => {
      expect(server.isBypassed('3')).toBe(false);
    });

    test('returns true after activation', () => {
      server.activate('3');
      expect(server.isBypassed('3')).toBe(true);
    });

    test('returns false after deactivation', () => {
      server.activate('3');
      server.deactivate('3');
      expect(server.isBypassed('3')).toBe(false);
    });

    test('returns false for expired bypass', () => {
      server.bypasses['3'] = { activatedAt: Date.now() - 100000, expiresAt: Date.now() - 1000 };
      expect(server.isBypassed('3')).toBe(false);
    });

    test('returns true for indefinite bypass', () => {
      server.activate('3', null);
      expect(server.isBypassed('3')).toBe(true);
    });
  });

  describe('activate/deactivate', () => {
    test('activate with minutes sets expiresAt', () => {
      const before = Date.now();
      server.activate('3', 60);
      const entry = server.bypasses['3'];
      expect(entry.expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 100);
      expect(entry.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 100);
    });

    test('activate without minutes sets expiresAt to null', () => {
      server.activate('3');
      expect(server.bypasses['3'].expiresAt).toBeNull();
    });

    test('deactivate returns true if existed', () => {
      server.activate('3');
      expect(server.deactivate('3')).toBe(true);
    });

    test('deactivate returns false if did not exist', () => {
      expect(server.deactivate('99')).toBe(false);
    });
  });

  describe('toggle', () => {
    test('toggle on then off', () => {
      expect(server.toggle('3')).toBe(true);
      expect(server.isBypassed('3')).toBe(true);
      expect(server.toggle('3')).toBe(false);
      expect(server.isBypassed('3')).toBe(false);
    });
  });

  describe('persistence', () => {
    test('saves to file on activate', () => {
      server.activate('3');
      const raw = fs.readFileSync(TEST_BYPASS_PATH, 'utf8');
      const data = JSON.parse(raw);
      expect(data['3']).toBeDefined();
      expect(data['3'].expiresAt).toBeNull();
    });

    test('loads active bypasses on construction', () => {
      const futureExpiry = Date.now() + 999999;
      fs.writeFileSync(TEST_BYPASS_PATH, JSON.stringify({
        '3': { activatedAt: Date.now(), expiresAt: futureExpiry },
        '2': { activatedAt: Date.now() - 100000, expiresAt: Date.now() - 1000 }
      }));

      const server2 = new BypassServer({
        port: PORT + 1,
        bypassPath: TEST_BYPASS_PATH,
        debug: false,
        logFn: () => {},
        zones: {}
      });

      expect(server2.isBypassed('3')).toBe(true);
      expect(server2.isBypassed('2')).toBe(false);
    });
  });

  describe('HTTP API', () => {
    beforeEach((done) => {
      const srv = server.start();
      srv.on('listening', done);
    });

    test('GET /bypasses returns empty object initially', async () => {
      const res = await makeRequest(PORT, 'GET', '/bypasses');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    test('POST /bypass/:zone activates bypass', async () => {
      const res = await makeRequest(PORT, 'POST', '/bypass/3');
      expect(res.status).toBe(200);
      expect(res.body.bypassed).toBe(true);
      expect(res.body.zone).toBe('3');
      expect(res.body.zoneName).toBe('Garage Door');
      expect(server.isBypassed('3')).toBe(true);
    });

    test('POST /bypass/:zone?minutes=30 sets expiry', async () => {
      const res = await makeRequest(PORT, 'POST', '/bypass/3?minutes=30');
      expect(res.status).toBe(200);
      expect(res.body.expiresAt).not.toBeNull();
    });

    test('DELETE /bypass/:zone deactivates bypass', async () => {
      server.activate('3');
      const res = await makeRequest(PORT, 'DELETE', '/bypass/3');
      expect(res.status).toBe(200);
      expect(res.body.bypassed).toBe(false);
      expect(res.body.existed).toBe(true);
      expect(server.isBypassed('3')).toBe(false);
    });

    test('GET /bypass/:zone/status returns bypass state', async () => {
      const res = await makeRequest(PORT, 'GET', '/bypass/3/status');
      expect(res.status).toBe(200);
      expect(res.body.bypassed).toBe(false);

      server.activate('3');
      const res2 = await makeRequest(PORT, 'GET', '/bypass/3/status');
      expect(res2.body.bypassed).toBe(true);
    });

    test('POST /bypass/:zone/toggle toggles state', async () => {
      const res1 = await makeRequest(PORT, 'POST', '/bypass/3/toggle');
      expect(res1.body.bypassed).toBe(true);

      const res2 = await makeRequest(PORT, 'POST', '/bypass/3/toggle');
      expect(res2.body.bypassed).toBe(false);
    });

    test('GET /unknown returns 404', async () => {
      const res = await makeRequest(PORT, 'GET', '/unknown');
      expect(res.status).toBe(404);
    });

    test('GET /bypasses lists active with zone names', async () => {
      server.activate('3');
      const res = await makeRequest(PORT, 'GET', '/bypasses');
      expect(res.status).toBe(200);
      expect(res.body['3'].zoneName).toBe('Garage Door');
      expect(res.body['3'].remainingMinutes).toBeNull();
    });

    test('POST /bypass/:zone?minutes=0 returns 400', async () => {
      const res = await makeRequest(PORT, 'POST', '/bypass/3?minutes=0');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/positive integer/);
    });

    test('POST /bypass/:zone?minutes=abc returns 400', async () => {
      const res = await makeRequest(PORT, 'POST', '/bypass/3?minutes=abc');
      expect(res.status).toBe(400);
    });

    test('POST /bypass/:zone?minutes=-5 returns 400', async () => {
      const res = await makeRequest(PORT, 'POST', '/bypass/3?minutes=-5');
      expect(res.status).toBe(400);
    });
  });
});
