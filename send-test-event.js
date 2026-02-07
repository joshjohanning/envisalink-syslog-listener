#!/usr/bin/env node
//
// Sends a fake EVL4 syslog message to the listener for testing.
//
// Usage:
//   node send-test-event.js                    # sends a Zone Open for zone 9
//   node send-test-event.js "Zone Closed: 4"   # sends a custom message
//   node send-test-event.js --port 5514        # send to a different port
//   node send-test-event.js --host 192.168.1.5 # send to a remote host

const dgram = require('dgram');

const args = process.argv.slice(2);
let host = '127.0.0.1';
let port = 514;
let message = null;

// Parse args
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--host' && args[i + 1]) {
    host = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    message = args[i];
  }
}

if (!message) {
  message = 'Zone Open: 99';
}

// Wrap in EVL4 syslog format
const syslogMessage = `<166>ENVISALINK[001C2A02BB1F]:  ${message}`;

const client = dgram.createSocket('udp4');
const buffer = Buffer.from(syslogMessage);

client.send(buffer, 0, buffer.length, port, host, (err) => {
  if (err) {
    console.error(`Failed to send: ${err.message}`);
  } else {
    console.log(`Sent to ${host}:${port} -> ${syslogMessage}`);
  }
  client.close();
});
