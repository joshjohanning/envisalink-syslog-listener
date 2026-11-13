const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const mockHttps = `
  const https = require('https');
  const fs = require('fs');
  const { EventEmitter } = require('events');
  https.request = (options, callback) => {
    const request = new EventEmitter();
    let payload = '';
    request.write = chunk => { payload += chunk; };
    request.end = () => {
      fs.appendFileSync(process.env.TEST_REQUEST_LOG, JSON.stringify({
        hostname: options.hostname, title: options.headers.Title, payload
      }) + '\\n');
      process.nextTick(() => callback({ statusCode: 200, headers: {}, resume() {} }));
    };
    return request;
  };
  require(process.argv[1]);
`;

test('reloads names throughout the running listener without resetting alert or bypass state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-reload-'));
  const zonesPath = path.join(directory, 'zones.json');
  const logPath = path.join(directory, 'listener.log');
  const requestsPath = path.join(directory, 'requests.jsonl');
  const rulesPath = path.join(directory, 'rules.json');
  let listener;
  let output = '';

  const writeZones = (zones) => {
    const temporaryPath = path.join(directory, 'zones.tmp');
    fs.writeFileSync(temporaryPath, JSON.stringify(zones));
    fs.renameSync(temporaryPath, zonesPath);
  };
  const log = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const requests = () => fs.existsSync(requestsPath)
    ? fs.readFileSync(requestsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const sheetsEvent = (event, name) => requests().some(request => {
    if (request.hostname !== 'sheets.test') return false;
    const payload = JSON.parse(request.payload);
    return payload.event === event && payload.zoneName === name;
  });
  const ntfyRequest = (title) => requests().find(request =>
    request.hostname === 'ntfy.sh' && decodeTitle(request.title).includes(title)
  );
  const waitFor = async (condition, description) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (listener && listener.exitCode !== null) throw new Error(`Listener exited early: ${output}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  try {
    writeZones({ '2': 'Back Door', '3': 'Garage Door' });
    fs.writeFileSync(rulesPath, JSON.stringify([{
      zone: '2', condition: 'open_duration', minutes: 0.05,
      action: 'ntfy', repeatInterval: 0.04, maxRepeats: 1
    }]));
    const apiPort = await freePort();
    listener = spawn(process.execPath, [
      '-e', mockHttps, path.join(__dirname, 'envisalink-syslog-listener.js'),
      '--port=0', `--apiPort=${apiPort}`, `--zonesPath=${zonesPath}`,
      `--rulesPath=${rulesPath}`, `--logPath=${logPath}`,
      `--bypassPath=${path.join(directory, 'bypasses.json')}`, '--debug'
    ], {
      env: {
        ...process.env,
        MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', EMAIL_FROM: '', EMAIL_TO: '',
        NTFY_TOPIC: 'zone-reload-test', NTFY_ON_ALARM: 'true', HEARTBEAT_MINUTES: '0',
        GOOGLE_SHEETS_WEBHOOK: 'https://sheets.test/events', TEST_REQUEST_LOG: requestsPath
      }
    });
    listener.stdout.on('data', chunk => { output += chunk; });
    listener.stderr.on('data', chunk => { output += chunk; });

    await waitFor(() => /listener started on UDP port \d+/.test(output)
      && output.includes('Bypass API server listening'), 'listener startup');
    const udpPort = Number(output.match(/listener started on UDP port (\d+)/)[1]);
    const bypass = await request(apiPort, 'POST', '/bypass/3');

    await sendMessage(udpPort, 'Zone Open: 2');
    await waitFor(() => log().includes('Timer set: Back Door') && sheetsEvent('Zone Open', 'Back Door'), 'initial open');

    writeZones({ '2': 'Kitchen Back Door', '3': 'New Garage Door' });
    await waitFor(() => log().includes('Reloaded 2 zone(s)'), 'first reload');
    const active = await request(apiPort, 'GET', '/bypasses');
    expect(active['3']).toMatchObject({
      zoneName: 'New Garage Door', activatedAt: bypass.activatedAt, expiresAt: bypass.expiresAt
    });
    expect(await request(apiPort, 'GET', '/bypass/3/status')).toMatchObject({
      bypassed: true, zoneName: 'New Garage Door'
    });

    await sendMessage(udpPort, 'Alarm Zone: 2');
    await waitFor(() => sheetsEvent('Alarm', 'Kitchen Back Door')
      && ntfyRequest('Alarm: Kitchen Back Door'), 'updated alarm');
    await waitFor(() => log().includes('Alert rule triggered: Kitchen Back Door has been open')
      && ntfyRequest('Kitchen Back Door open'), 'duration alert');

    writeZones({ '2': 'Garden Back Door', '3': 'New Garage Door' });
    await waitFor(() => (log().match(/Reloaded 2 zone\(s\)/g) || []).length === 2, 'second reload');
    await waitFor(() => /Alert rule triggered: Garden Back Door still open.*\(repeat 1\)/.test(log())
      && ntfyRequest('Garden Back Door still open'), 'repeat alert');

    await sendMessage(udpPort, 'Zone Close: 2');
    await waitFor(() => sheetsEvent('Zone Close', 'Garden Back Door')
      && ntfyRequest('Garden Back Door now closed'), 'close notification');
    expect(ntfyRequest('Garden Back Door now closed').payload).toContain('was open since');
    expect(log()).toContain('Zone Open: Back Door');
    expect(sheetsEvent('Zone Open', 'Back Door')).toBe(true);
    expect((await request(apiPort, 'GET', '/bypass/3/status')).bypassed).toBe(true);
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

function decodeTitle(title) {
  const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(title);
  return encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : title;
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: requestPath }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
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
