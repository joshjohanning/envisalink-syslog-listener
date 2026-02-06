# envisalink-syslog

Syslog listener for the [EyezOn EnvisaLink 4 (EVL4)](https://www.eyezon.com/evl4.html) module. Logs zone events (door open/close, arm/disarm, alarms) over UDP with friendly zone names and optional Mailgun email alerts.

This uses the EVL4's built-in **syslog sender** (UDP port 514) — it does **not** use the TPI connection (port 4025), so it won't conflict with Homebridge, Home Assistant, or any other TPI client.

## EVL4 Configuration

1. Browse to `http://<EVL4-IP>/`
2. Under **Syslog Client**, set:
   - **Server IP Address**: your server's IP (e.g., Raspberry Pi)
   - **Facility**: any value `16`–`23` (e.g., `20`). `00` = OFF.
3. Click **CHANGE**

## Setup

```sh
# Install dependencies
npm install

# Edit zones.json with your actual zone numbers and friendly names
nano zones.json

# Test it (debug mode, no emails)
sudo node envisalink-syslog.js --debug --dryRun
```

Open a door — you should see a log entry appear.

## Usage

```sh
# Basic — just log to file
sudo node envisalink-syslog.js

# With email alerts on alarm events
sudo node envisalink-syslog.js \
  --MAILGUN_API_KEY=your_key \
  --MAILGUN_DOMAIN=your_domain

# Also email on every zone open (e.g., door opens)
sudo node envisalink-syslog.js \
  --MAILGUN_API_KEY=your_key \
  --MAILGUN_DOMAIN=your_domain \
  --emailOnOpen

# Debug mode (verbose console output)
sudo node envisalink-syslog.js --debug --dryRun
```

### Options

| Option | Default | Description |
|---|---|---|
| `--port` | `514` | UDP port to listen on (514 requires `sudo`) |
| `--logPath` | `./envisalink-syslog.log` | Path to the log file |
| `--zonesPath` | `./zones.json` | Path to zone name mappings |
| `--debug` | `false` | Enable verbose console output |
| `--dryRun` | `false` | Skip sending emails |
| `--MAILGUN_API_KEY` | env var | Mailgun API key |
| `--MAILGUN_DOMAIN` | env var | Mailgun domain |
| `--emailOnOpen` | `false` | Send email when any zone opens |
| `--emailOnAlarm` | `true` | Send email on alarm events |

> **Note:** Port 514 requires root/`sudo`. Alternatively, use a higher port and redirect with iptables:
> ```sh
> sudo iptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-port 5514
> node envisalink-syslog.js --port 5514
> ```

## Zone Configuration

Edit `zones.json` to map zone numbers to friendly names:

```json
{
  "1": "Front Door",
  "2": "Back Door",
  "3": "Garage Door",
  "4": "Living Room Motion",
  "5": "Master Bedroom Window"
}
```

## Running as a systemd service

```sh
sudo nano /etc/systemd/system/envisalink-syslog.service
```

```ini
[Unit]
Description=EnvisaLink Syslog Listener
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pi/envisalink-syslog/envisalink-syslog.js
WorkingDirectory=/home/pi/envisalink-syslog
Restart=always
RestartSec=10
Environment=MAILGUN_API_KEY=your_key
Environment=MAILGUN_DOMAIN=your_domain

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable envisalink-syslog
sudo systemctl start envisalink-syslog
systemctl status envisalink-syslog
```

## How it works

The EnvisaLink 4 has a built-in syslog client that sends zone events over UDP. This is completely separate from the TPI (Third Party Interface) on TCP port 4025. The syslog approach:

- **No TPI conflict** — won't interfere with Homebridge, Home Assistant, or other TPI clients
- **No connection limit** — UDP is fire-and-forget; any number of listeners can receive
- **Zero impact on panel** — the EVL4 sends these passively alongside normal operations

Events captured include zone open/close, arm/disarm, and alarm events.
