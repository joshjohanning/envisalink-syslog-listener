# envisalink-syslog-listener

Syslog listener for the [EyezOn EnvisaLink 4 (EVL4)](https://www.eyezon.com/evl4.html) module. Logs zone events (door open/close, arm/disarm, alarms, CID events) over UDP with friendly zone names, optional email alerts (Mailgun), push notifications ([ntfy.sh](https://ntfy.sh)), Google Sheets logging, and configurable alert rules.

This uses the EVL4's built-in **syslog sender** (UDP port 514) -- it does **not** use the TPI connection (port 4025), so it won't conflict with Homebridge, Home Assistant, or any other TPI client.

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

Open a door -- you should see a log entry appear.

## Usage

```sh
# Basic -- just log to file
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
| `--ntfyOnAlarm` | `true` | Send ntfy push notification on alarm events |
| `--emailFrom` | env var | From address for email alerts (e.g., `"EnvisaLink <alerts@example.com>"`) |
| `--emailTo` | env var | Comma-separated list of email recipients |
| `--GOOGLE_SHEETS_WEBHOOK` | env var | Google Apps Script web app URL for logging to Sheets |
| `--NTFY_TOPIC` | env var | [ntfy.sh](https://ntfy.sh) topic for push notifications |
| `--rulesPath` | `./rules.json` | Path to alert rules config |
| `--heartbeatMinutes` | `0` | Alert if no syslog activity for N minutes (0 = disabled) |
| `--heartbeatChannel` | `all` | Heartbeat alert channel: `all`, `email`, or `ntfy` |

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

> **Note:** Changes to `zones.json` require a restart of the app or service to take effect:
>
> ```sh
> sudo systemctl restart envisalink-syslog-listener
> ```

```json
{
  "1": "Front Door",
  "2": "Back Door",
  "3": "Garage Door",
  "4": "Living Room Motion",
  "5": "Master Bedroom Window"
}
```

## Alert Rules

You can define rules that trigger email alerts based on zone behavior. Copy the sample file and customize:

```sh
cp rules.sample.json rules.json
nano rules.json
```

> **Note:** Unlike `zones.json`, `rules.json` is **not** auto-created on startup. Rules are optional -- the app works fine without them.

> **Note:** Changes to `rules.json` require a restart of the app or service to take effect.

### Supported conditions

#### `open_duration`

Send an alert if a zone stays open for longer than a specified number of minutes. The alert is cancelled if the zone closes before the timer expires. If the zone closes **after** an alert has already been sent, a final "now closed" notification is sent via the same channel so you know the zone has been secured.

The `action` field controls how you're notified:

| Action | Description |
|---|---|
| `email` | Send an email via Mailgun |
| `ntfy` | Send a push notification via [ntfy.sh](https://ntfy.sh) |
| `both` | Send both email and push notification |

Optional fields:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to disable a rule without removing it |
| `repeatInterval` | -- | Minutes between repeat alerts while the zone stays open |
| `maxRepeats` | `0` (unlimited) | Maximum number of repeat alerts (0 = no limit) |

Repeat alerts include "still open" in the message and show the total time the zone has been open. When the zone finally closes, a "now closed" notification is sent with the total duration it was open.

```json
[
  {
    "description": "Push notification if garage doors are left open 20+ minutes, repeat every 30 min",
    "enabled": true,
    "zone": "3",
    "condition": "open_duration",
    "minutes": 20,
    "action": "ntfy",
    "repeatInterval": 30,
    "maxRepeats": 3
  },
  {
    "description": "Email if back door is left open 10+ minutes",
    "enabled": false,
    "zone": "2",
    "condition": "open_duration",
    "minutes": 10,
    "action": "email"
  }
]
```

Requires Mailgun for `email`/`both` actions, and `--NTFY_TOPIC` for `ntfy`/`both` actions.

## Heartbeat Monitoring

Optionally alert if the listener hasn't received any syslog messages for a configurable period. This helps detect when the EVL4 goes offline, loses network connectivity, or the syslog client gets misconfigured.

```sh
# Alert if no activity for 24 hours (1440 minutes)
sudo node envisalink-syslog-listener.js --heartbeatMinutes=1440
```

Or set it as an environment variable in the systemd service file:

```ini
Environment=HEARTBEAT_MINUTES=1440
Environment=HEARTBEAT_CHANNEL=ntfy
```

Heartbeat alerts are sent via the configured channel. Use `all` (default) to send via both email and ntfy, or `email`/`ntfy` to use only one. The alert fires once per inactivity period and resets when a new message arrives.

## Push Notifications (ntfy.sh)

[ntfy.sh](https://ntfy.sh) provides free push notifications to your phone with no account required.

### ntfy Setup

1. Install the **ntfy** app on your phone ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))
2. In the app, subscribe to a topic (e.g., `my-envisalink-alerts`)
3. Enable **Instant delivery** in the ntfy app settings
4. Enable **Background App Refresh** for ntfy in your phone's settings
5. Pass the same topic name to the listener:

```sh
sudo node envisalink-syslog-listener.js --NTFY_TOPIC=my-envisalink-alerts
```

Or set it as an environment variable in the systemd service file:

```ini
Environment=NTFY_TOPIC=my-envisalink-alerts
```

> **Tip:** Your topic name is the only thing keeping notifications private. Use something unique and hard to guess.

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

A sample service file is included in the repo. Copy it to create your local version and adjust the paths/environment variables as needed:

```sh
# Create your local service file from the sample
cp envisalink-syslog-listener.service.sample envisalink-syslog-listener.service

# Review/edit the service file -- update paths if your repo is not at /home/pi/envisalink-syslog-listener
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

> **Note:** If you edit the `.service` file after copying, re-run the install script:
>
> ```sh
> ./scripts/install-service.sh
> ```

## Updating

Pull the latest code, install dependencies, and restart the service:

```sh
./scripts/update.sh
```

## Testing

A test script is included to send fake EVL4 syslog messages to the listener without physically triggering a zone:

```sh
# Send a default "Zone Open: 9" to localhost
node send-test-event.js

# Send a custom event
node send-test-event.js "Zone Closed: 4"
node send-test-event.js "Armed Away"
node send-test-event.js "Alarm Activated"

# Send to a remote host (e.g., your Pi)
node send-test-event.js --host 192.168.50.10 "Zone Open: 2"

# Send to a non-default port
node send-test-event.js --port 5514 "Zone Open: 1"
```

This sends a properly formatted syslog packet that the listener processes identically to a real EVL4 message, including logging to file, Google Sheets, and email alerts.

To run the unit tests:

```sh
npm test
```

## How it works

The EnvisaLink 4 has a built-in syslog client that sends zone events over UDP. This is completely separate from the TPI (Third Party Interface) on TCP port 4025. The syslog approach:

- **No TPI conflict** -- won't interfere with Homebridge, Home Assistant, or other TPI clients
- **No connection limit** -- UDP is fire-and-forget; any number of listeners can receive
- **Zero impact on panel** -- the EVL4 sends these passively alongside normal operations

Events captured include:

- **Zone events** -- open, close, alarm, trouble, tamper, restore
- **Arm/disarm** -- via CID (Contact ID) events, including which user and partition
- **Alarm events** -- fire, burglary, panic, medical, and more
- **CID events** -- parsed from Ademco Contact ID protocol codes

### Duplicate alarm notifications

When an alarm is triggered (e.g., keypad panic), the EVL4 typically sends **multiple syslog messages** for a single event:

1. A CID event (e.g., `CID Event: 1123010990` for audible panic)
2. A plain-text message (e.g., `Alarm Zone: 099`)
3. A CID restore when the alarm clears (e.g., `CID Event: 3123010990`)

The CID restore (qualifier 3) is classified as `Alarm Restore` and does **not** trigger alarm notifications. However, messages 1 and 2 both trigger notifications since they are genuinely separate syslog messages from the EVL4. This means you may receive **2 emails and/or 2 ntfy notifications** for a single alarm event. This is by design -- alarms are rare and critical, so it's better to over-notify than risk missing one.

> **Note:** DSC panels use virtual zones for keypad-initiated panic events: zone 095 (fire), 096 (aux/medical), and 099 (police/audible). These are not physical sensor zones.

See [tpi-vs-syslog.md](tpi-vs-syslog.md) for a detailed comparison of syslog vs. TPI capabilities.
