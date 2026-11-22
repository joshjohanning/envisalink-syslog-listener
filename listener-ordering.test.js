const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// The Zone Open webhook responds slowly while Zone Close responds immediately.
const mockHttps = `
  const https = require('https');
  const fs = require('fs');
  const { EventEmitter } = require('events');
  https.request = (options, callback) => {
    const request = new EventEmitter();
    let payload = '';
    request.write = chunk => { payload += chunk; };
    request.end = () => {
      fs.appendFileSync(process.env.TEST_REQUEST_LOG, JSON.stringify({ hostname: options.hostname, payload }) + '\\n');
      const delay = options.hostname === 'sheets.test' && JSON.parse(payload).event === 'Zone Open' ? 1000 : 0;
      setTimeout(() => callback({ statusCode: 200, headers: {}, resume() {} }), delay);
    };
    return request;
  };
  require(process.argv[1]);
`;

test('a slow Google Sheets response does not reorder zone open and close rule handling', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-ordering-'));
  const logPath = path.join(directory, 'listener.log');
  const requestsPath = path.join(directory, 'requests.jsonl');
  const rulesPath = path.join(directory, 'rules.json');
  let listener;
  let output = '';

  const log = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const sheetsEvents = () => (fs.existsSync(requestsPath) ? fs.readFileSync(requestsPath, 'utf8') : '')
    .trim().split('\n').filter(Boolean).map(JSON.parse)
    .filter(request => request.hostname === 'sheets.test')
    .map(request => JSON.parse(request.payload).event);
  const waitFor = async (condition, description) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (listener && listener.exitCode !== null) throw new Error(`Listener exited early: ${output}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  try {
    fs.writeFileSync(path.join(directory, 'zones.json'), JSON.stringify({ '2': 'Back Door' }));
    fs.writeFileSync(rulesPath, JSON.stringify([
      { zone: '2', condition: 'open_duration', minutes: 0.025, action: 'ntfy' }
    ]));
    const apiPort = await freePort();
    listener = spawn(process.execPath, [
      '-e', mockHttps, path.join(__dirname, 'envisalink-syslog-listener.js'),
      '--port=0', `--apiPort=${apiPort}`, `--zonesPath=${path.join(directory, 'zones.json')}`,
      `--rulesPath=${rulesPath}`, `--logPath=${logPath}`,
      `--bypassPath=${path.join(directory, 'bypasses.json')}`, '--debug'
    ], {
      env: {
        ...process.env,
        MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', EMAIL_FROM: '', EMAIL_TO: '',
        NTFY_TOPIC: 'ordering-test', HEARTBEAT_MINUTES: '0',
        GOOGLE_SHEETS_WEBHOOK: 'https://sheets.test/events', TEST_REQUEST_LOG: requestsPath
      }
    });
    listener.stdout.on('data', chunk => { output += chunk; });
    listener.stderr.on('data', chunk => { output += chunk; });

    await waitFor(() => /listener started on UDP port \d+/.test(output)
      && log().includes(`Bypass API server listening on 127.0.0.1:${apiPort}`), 'listener startup');
    const udpPort = Number(output.match(/listener started on UDP port (\d+)/)[1]);

    await sendMessage(udpPort, 'Zone Open: 2');
    await waitFor(() => sheetsEvents().includes('Zone Open'), 'open posted to Sheets');
    await sendMessage(udpPort, 'Zone Close: 2');
    await waitFor(() => log().includes('Timer(s) cleared: zone 2 closed before alert'), 'close handled');

    // Wait past the slow Sheets response and the 1.5s rule duration.
    await new Promise(resolve => setTimeout(resolve, 2500));

    expect(sheetsEvents()).toEqual(['Zone Open', 'Zone Close']);
    expect(log().indexOf('Timer set: Back Door')).toBeLessThan(log().indexOf('Timer(s) cleared: zone 2'));
    expect(log()).not.toContain('Alert rule triggered');
  } finally {
    if (listener && listener.exitCode === null && listener.signalCode === null) {
      await new Promise(resolve => {
        listener.once('exit', resolve);
        listener.kill();
      });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function sendMessage(port, message) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.send(message, port, '127.0.0.1', err => {
      socket.close();
      if (err) reject(err);
      else resolve();
    });
  });
}
