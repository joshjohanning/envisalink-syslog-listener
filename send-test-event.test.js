const dgram = require('dgram');
const { spawn } = require('child_process');
const path = require('path');
const { parseSyslogMessage } = require('./parser');
const zones = require('./zones.sample.json');

describe('send-test-event', () => {
  test('sends a simulated Zone Open for zone 999 by default', async () => {
    const server = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.bind(0, '127.0.0.1', resolve);
    });

    const { port } = server.address();
    const message = new Promise((resolve) => {
      server.once('message', (buffer) => resolve(buffer.toString()));
    });
    const sender = spawn(process.execPath, [
      path.join(__dirname, 'send-test-event.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ]);
    const exit = new Promise((resolve, reject) => {
      sender.once('error', reject);
      sender.once('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Test sender exited with code ${code}`));
        }
      });
    });

    try {
      const [payload] = await Promise.all([message, exit]);
      expect(payload).toContain('Zone Open: 999');
      const event = parseSyslogMessage(payload, zones);
      expect(event.event).toBe('Zone Open');
      expect(event.zone).toBe(999);
      expect(event.zoneName).toBe('Syslog Test Zone');
    } finally {
      server.close();
    }
  });
});
