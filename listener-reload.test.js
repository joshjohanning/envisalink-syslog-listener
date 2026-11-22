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
      setTimeout(() => callback({ statusCode: 200, headers: {}, resume() {} }),
        Number(process.env.TEST_RESPONSE_DELAY || 0));
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

const durationRule = (zone, settings = {}) => ({
  zone: String(zone), condition: 'open_duration', minutes: 0.002, action: 'ntfy', ...settings
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRulesListener(initialRules, run, { dryRun = false, responseDelay = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-reload-'));
  const zonesPath = path.join(directory, 'zones.json');
  const rulesPath = path.join(directory, 'rules.json');
  const logPath = path.join(directory, 'listener.log');
  const requestsPath = path.join(directory, 'requests.jsonl');
  let listener;
  let output = '';
  const log = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const waitFor = async (condition, description) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (listener.exitCode !== null || Date.now() > deadline) {
        throw new Error(`Failed waiting for ${description}: ${output}`);
      }
      await pause(20);
    }
  };
  const write = value => {
    const temporaryPath = path.join(directory, 'rules.tmp');
    fs.writeFileSync(temporaryPath, typeof value === 'string' ? value : JSON.stringify(value));
    fs.renameSync(temporaryPath, rulesPath);
  };
  try {
    fs.writeFileSync(zonesPath, JSON.stringify({ 2: 'Back Door', 3: 'Front Door', 4: 'Garage Door' }));
    if (initialRules !== undefined) write(initialRules);
    const apiPort = await freePort();
    listener = spawn(process.execPath, [
      '-e', mockHttps, path.join(__dirname, 'envisalink-syslog-listener.js'),
      '--port=0', `--apiPort=${apiPort}`, `--zonesPath=${zonesPath}`,
      `--rulesPath=${rulesPath}`, `--logPath=${logPath}`,
      `--bypassPath=${path.join(directory, 'bypasses.json')}`, '--debug', `--dryRun=${dryRun}`
    ], {
      env: {
        ...process.env, MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', EMAIL_FROM: '', EMAIL_TO: '',
        NTFY_TOPIC: 'rules-reload-test', HEARTBEAT_MINUTES: '0', GOOGLE_SHEETS_WEBHOOK: '',
        TEST_REQUEST_LOG: requestsPath, TEST_RESPONSE_DELAY: String(responseDelay)
      }
    });
    listener.stdout.on('data', chunk => { output += chunk; });
    listener.stderr.on('data', chunk => { output += chunk; });
    await waitFor(() => /listener started on UDP port \d+/.test(output)
      && output.includes('Bypass API server listening'), 'startup');
    const udpPort = Number(output.match(/listener started on UDP port (\d+)/)[1]);
    await run({
      log, waitFor, write, rulesPath,
      send: message => sendMessage(udpPort, message),
      api: (method, route) => request(apiPort, method, route),
      reload: async value => {
        const before = (log().match(/Reloaded .* alert rule/g) || []).length;
        write(value);
        await waitFor(() => (log().match(/Reloaded .* alert rule/g) || []).length > before, 'rules reload');
      }
    });
  } finally {
    if (listener && listener.exitCode === null && listener.signalCode === null) {
      await new Promise(resolve => {
        listener.once('exit', resolve);
        listener.kill();
      });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('creates optional rules after startup, debounces writes, and retains valid rules on errors', async () => {
  await withRulesListener(undefined, async ({ send, log, waitFor, write, reload, rulesPath }) => {
    await send('Zone Open: 2');
    await send('Zone Open: 3');
    await waitFor(() => log().includes('Zone Open: Front Door'), 'open zones without rules');
    await send('Zone Close: 3');
    await waitFor(() => log().includes('Zone Close: Front Door'), 'closed zone');
    write('[');
    write([durationRule(2), durationRule(3)]);
    await waitFor(() => log().includes('Reloaded 2 alert rule(s)'), 'created file');
    await waitFor(() => log().includes('Alert rule triggered: Back Door'), 'already-open alert');
    expect(log()).not.toContain('Alert rule triggered: Front Door');
    expect(log()).not.toContain('Could not reload rules');
    expect((log().match(/Reloaded 2 alert rule/g) || []).length).toBe(1);
    for (const invalid of ['[', '{}', [{ ...durationRule(2), minutes: -1 }]]) {
      const before = (log().match(/Retaining the last valid rules/g) || []).length;
      write(invalid);
      await waitFor(() => (log().match(/Retaining the last valid rules/g) || []).length > before, 'invalid rules warning');
    }
    fs.unlinkSync(rulesPath);
    await waitFor(() => log().includes('ENOENT'), 'missing rules warning');
    await send('Zone Close: 2');
    await waitFor(() => log().includes('Zone closed notification: Back Door'), 'retained active alert');
    await reload([]);
    expect(log()).toContain('(0 enabled, 0 disabled)');
    await send('Zone Open: 2');
    await pause(200);
    expect((log().match(/Alert rule triggered: Back Door/g) || []).length).toBe(1);
  });
}, 15000);

test('edits pending timing, disables/removes timers, and preserves unrelated bypass state', async () => {
  const garage = durationRule(4, { repeatInterval: 0.004 });
  await withRulesListener([durationRule(2, { minutes: 0.008 }), durationRule(3, { minutes: 0.008 }), garage],
    async ({ send, log, waitFor, reload, api }) => {
      const bypass = await api('POST', '/bypass/4');
      for (const zone of [2, 3, 4]) await send(`Zone Open: ${zone}`);
      await waitFor(() => log().includes('Timer set: Garage Door'), 'initial timers');
      await reload([garage, durationRule(2, { minutes: 0.08, action: 'email' }),
        durationRule(3, { enabled: false })]);
      expect(log()).toContain('(2 enabled, 1 disabled)');
      await pause(650);
      expect(log()).not.toContain('Alert rule triggered: Back Door');
      expect(log()).not.toContain('Alert rule triggered: Front Door');
      expect(log()).toContain('Alert suppressed (bypass active): Garage Door');
      expect((await api('GET', '/bypasses'))['4']).toMatchObject({
        activatedAt: bypass.activatedAt, expiresAt: bypass.expiresAt
      });
      await reload([garage, durationRule(2, { repeatInterval: 0.01 })]);
      await waitFor(() => log().includes('Alert rule triggered: Back Door'), 'shortened overdue timer');
      await reload([garage]);
      await send('Zone Close: 2');
      await send('Zone Close: 3');
      await pause(700);
      expect((log().match(/Alert rule triggered: Back Door/g) || []).length).toBe(1);
      expect(log()).not.toContain('Zone closed notification: Back Door');
      await api('DELETE', '/bypass/4');
      await waitFor(() => log().includes('Alert rule triggered: Garage Door still open'), 'preserved bypass repeat');
      await send('Zone Close: 4');
      await waitFor(() => log().includes('Zone closed notification: Garage Door'), 'unrelated close notification');
    });
}, 15000);

test('updates repeat timing, limits, and notification settings without losing fired state', async () => {
  await withRulesListener([durationRule(2, { repeatInterval: 0.02 })],
    async ({ send, log, waitFor, reload }) => {
      await send('Zone Open: 2');
      await waitFor(() => log().includes('Would send ntfy: Back Door open'), 'initial notification');
      const updated = durationRule(2, { minutes: 0.05, repeatInterval: 0.003, maxRepeats: 1, action: 'email' });
      await reload([updated]);
      await waitFor(() => /Back Door still open.*repeat 1/.test(log())
        && log().includes('Would send email: ⚠️ Back Door still open'), 'updated repeat interval');
      await reload([durationRule(3), updated]);
      await pause(400);
      expect((log().match(/Alert rule triggered: Back Door/g) || []).length).toBe(2);
      expect(log()).not.toContain('Would send ntfy: Back Door still open');
      await send('Zone Close: 2');
      await waitFor(() => log().includes('Would send email: ✅ Back Door is now closed'), 'updated close channel');
      expect(log()).not.toContain('Would send ntfy: ✅ Back Door');
    }, { dryRun: true });
}, 15000);

test('removal during an in-flight notification cannot resurrect stale repeat timers', async () => {
  await withRulesListener([durationRule(2, { repeatInterval: 0.002 })],
    async ({ send, log, waitFor, reload }) => {
      await send('Zone Open: 2');
      await waitFor(() => log().includes('Alert rule triggered: Back Door'), 'in-flight alert');
      await reload([]);
      await pause(700);
      expect((log().match(/Alert rule triggered: Back Door/g) || []).length).toBe(1);
      await send('Zone Close: 2');
      await pause(100);
      expect(log()).not.toContain('Zone closed notification: Back Door');
    }, { responseDelay: 350 });
}, 15000);

test('enables already-open zones and disables active alerts without stale close notifications', async () => {
  await withRulesListener([durationRule(2, { enabled: false }), durationRule(3)],
    async ({ send, log, waitFor, reload }) => {
      await send('Zone Open: 2');
      await send('Zone Open: 3');
      await waitFor(() => log().includes('Alert rule triggered: Front Door'), 'unrelated active alert');
      expect(log()).not.toContain('Alert rule triggered: Back Door');
      await reload([durationRule(2), durationRule(3, { enabled: false })]);
      await waitFor(() => log().includes('Alert rule triggered: Back Door'), 'enabled already-open rule');
      await send('Zone Close: 3');
      await waitFor(() => log().includes('zone 3 closed'), 'disabled zone closed');
      expect(log()).not.toContain('Zone closed notification: Front Door');
      await reload([durationRule(2, { enabled: false })]);
      await reload([durationRule(2)]);
      await waitFor(() => (log().match(/Alert rule triggered: Back Door/g) || []).length === 2, 're-enabled open zone');
      await send('Zone Close: 2');
      await waitFor(() => log().includes('Zone closed notification: Back Door'), 'enabled close notification');
    });
}, 15000);

test('reordering same-zone rules and JSON fields preserves the correct active alert', async () => {
  const first = durationRule(2, { description: 'Short push alert' });
  const second = durationRule(2, { minutes: 0.08, action: 'email', description: 'Long email alert' });
  await withRulesListener([first, second], async ({ send, log, waitFor, reload }) => {
    await send('Zone Open: 2');
    await waitFor(() => log().includes('Would send ntfy: Back Door open'), 'short alert');
    const reverseFields = rule => Object.fromEntries(Object.entries(rule).reverse());
    await reload([reverseFields(second), reverseFields(first)]);
    await pause(200);
    expect((log().match(/Alert rule triggered: Back Door/g) || []).length).toBe(1);
    await send('Zone Close: 2');
    await waitFor(() => log().includes('Would send ntfy: ✅ Back Door'), 'preserved close channel');
    expect(log()).not.toContain('Would send email: ✅ Back Door');
  }, { dryRun: true });
}, 15000);

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
