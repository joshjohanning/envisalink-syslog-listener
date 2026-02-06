# envisalink-syslog-listener

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

# Copy the sample zones file and edit with your actual zone numbers and friendly names
cp zones.sample.json zones.json
nano zones.json

# Test it (debug mode, no emails)
sudo node envisalink-syslog-listener.js --debug --dryRun
```

Open a door — you should see a log entry appear.

## Usage

```sh
# Basic — just log to file
sudo node envisalink-syslog-listener.js

# With email alerts on alarm events
sudo node envisalink-syslog-listener.js \
  --MAILGUN_API_KEY=your_key \
  --MAILGUN_DOMAIN=your_domain

# Also email on every zone open (e.g., door opens)
sudo node envisalink-syslog-listener.js \
  --MAILGUN_API_KEY=your_key \
  --MAILGUN_DOMAIN=your_domain \
  --emailOnOpen

# Debug mode (verbose console output)
sudo node envisalink-syslog-listener.js --debug --dryRun
```

### Options

| Option | Default | Description |
|---|---|---|
| `--port` | `514` | UDP port to listen on (514 requires `sudo`) |
| `--logPath` | `./envisalink-syslog-listener.log` | Path to the log file |
| `--zonesPath` | `./zones.json` | Path to zone name mappings |
| `--debug` | `false` | Enable verbose console output |
| `--dryRun` | `false` | Skip sending emails |
| `--MAILGUN_API_KEY` | env var | Mailgun API key |
| `--MAILGUN_DOMAIN` | env var | Mailgun domain |
| `--emailOnOpen` | `false` | Send email when any zone opens |
| `--emailOnAlarm` | `true` | Send email on alarm events |
| `--GOOGLE_SHEETS_WEBHOOK` | env var | Google Apps Script web app URL for logging to Sheets |

> **Note:** Port 514 requires root/`sudo`. Alternatively, use a higher port and redirect with iptables:
>
> ```sh
> sudo iptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-port 5514
> node envisalink-syslog-listener.js --port 5514
> ```

## Zone Configuration

Copy `zones.sample.json` to `zones.json` and edit with your actual zone numbers and friendly names:

```sh
cp zones.sample.json zones.json
nano zones.json
```

> **Note:** If `zones.json` doesn't exist on startup, the app automatically creates it from `zones.sample.json` as a fallback.

```json
{
  "1": "Front Door",
  "2": "Back Door",
  "3": "Garage Door",
  "4": "Living Room Motion",
  "5": "Master Bedroom Window"
}
```

## Google Sheets Logging

You can log all events to a Google Sheet for easy access from anywhere - no SSH or VPN required.

### Sheets Setup

1. Create a new [Google Sheet](https://sheets.new)
2. Add headers in **Row 1**: `Timestamp` | `Event` | `Zone` | `Zone Name` | `Message`
3. Open **Extensions > Apps Script**
4. Paste the contents of [`google-apps-script.js`](google-apps-script.js) (replacing any existing code)
5. Click **Deploy > New deployment**
6. Set type to **Web app**
7. Set "Who has access" to **Anyone**
8. Click **Deploy** and copy the web app URL
9. Pass the URL to the listener:

```sh
sudo node envisalink-syslog-listener.js \
  --GOOGLE_SHEETS_WEBHOOK=https://script.google.com/macros/s/ABC.../exec
```

Or set it as an environment variable in the systemd service file:

```ini
Environment=GOOGLE_SHEETS_WEBHOOK=https://script.google.com/macros/s/ABC.../exec
```

## Running as a systemd service

A service file is included in the repo. Copy it and adjust the paths if needed:

```sh
# Review/edit the service file — update paths if your repo is not at /home/pi/envisalink-syslog-listener
# Also uncomment the MAILGUN environment lines if you want email alerts
nano envisalink-syslog-listener.service

# Copy to systemd
sudo cp envisalink-syslog-listener.service /etc/systemd/system/

# Reload systemd, enable on boot, and start
sudo systemctl daemon-reload
sudo systemctl enable envisalink-syslog-listener
sudo systemctl start envisalink-syslog-listener
```

### Managing the service

```sh
# Check status
systemctl status envisalink-syslog-listener

# View logs (live)
journalctl -u envisalink-syslog-listener -f

# View recent logs
journalctl -u envisalink-syslog-listener --since "1 hour ago"

# Restart after config changes
sudo systemctl restart envisalink-syslog-listener

# Stop
sudo systemctl stop envisalink-syslog-listener
```

> **Note:** If you edit the `.service` file after copying, re-copy it and run `sudo systemctl daemon-reload` before restarting.

## How it works

The EnvisaLink 4 has a built-in syslog client that sends zone events over UDP. This is completely separate from the TPI (Third Party Interface) on TCP port 4025. The syslog approach:

- **No TPI conflict** — won't interfere with Homebridge, Home Assistant, or other TPI clients
- **No connection limit** — UDP is fire-and-forget; any number of listeners can receive
- **Zero impact on panel** — the EVL4 sends these passively alongside normal operations

Events captured include zone open/close, arm/disarm, and alarm events.
