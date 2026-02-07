# TPI vs. Syslog Comparison for EnvisaLink 4

Comparing the two methods of receiving events from an EnvisaLink 4 module.

## Connection Model

| | TPI (TCP port 4025) | Syslog (UDP port 514) |
|---|---|---|
| **Protocol** | TCP (persistent connection) | UDP (fire-and-forget) |
| **Direction** | You connect to the EVL4 | EVL4 pushes to you |
| **Connection limit** | 1 client only | Unlimited listeners |
| **Conflict with Homebridge** | Yes, shares the single TPI slot | None |
| **Conflict with Home Assistant** | Yes, shares the single TPI slot | None |
| **Can send commands** | Yes (arm, disarm, bypass, etc.) | No (receive only) |

## Event Comparison

| Capability | TPI | Syslog |
|---|---|---|
| Door/window opened or closed | Yes (zone bitfield + keypad + CID) | Yes (`Zone Open: 003` / `Zone Close: 003`) |
| Which zone, by number | Yes | Yes |
| Arm / disarm | Yes (partition state + CID) | Yes (CID events, e.g., `CID Event: 3441010020`) |
| Which **user** armed/disarmed | Yes (CID includes user number) | Yes (CID includes user number) |
| Alarm triggered | Yes | Yes |
| Fire / smoke / CO / medical | Yes (specific CID codes 100-118) | Yes (CID codes sent via syslog) |
| Low battery on a sensor | Yes (keypad text "LOBAT" + CID 384) | Possibly (if CID is sent) |
| AC power loss / restore | Yes (icon bitfield + CID 301/302) | Yes (CID codes sent via syslog) |
| Zone bypass status | Yes (keypad + CID 570) | No |
| RF supervision loss | Yes (CID 381) | Possibly (if CID is sent) |
| Bell/siren trouble | Yes (CID 321) | Possibly (if CID is sent) |
| Tamper events | Yes (CID 341, 383) | Possibly (if CID is sent) |
| Keypad LCD text (real-time) | Yes (32 chars, updated live) | No |
| Zone timer history | Yes (seconds since each zone last closed) | No |

## TPI Event Streams (Detail)

The TPI provides several distinct event types:

| Command Code | Event Type | Data | Detail Level |
|---|---|---|---|
| `00` | Virtual Keypad Update | Partition, 16-bit icon bitfield, zone/user number, beep code, 32-char keypad LCD text | Very high. You see exactly what the physical keypad displays. |
| `01` | Zone Status Change | 8-byte hex bitfield. Every zone represented as a single bit (1=active, 0=inactive). | Raw bitfield. Requires decoding. |
| `02` | Partition State Change | 8-byte hex partition mode data | Armed/disarmed/ready/not-ready state |
| `03` | Realtime CID Event | Qualifier (event/restore) + 3-digit ContactID code + partition + zone/user | Rich. Uses the full ContactID code table (400+ event types). |
| `FF` | Zone Timer Dump | 256-char hex string. 64 zone timers showing seconds since last close. | Historical. Shows how long ago every zone was last opened, even across restarts. |

## When to Use Which

**Use Syslog if you:**
- Want a log of door opens/closes, arm/disarm, alarms, and CID events
- Already have a TPI client connected (Homebridge, Home Assistant, etc.)
- Want zero risk to your existing setup
- Don't need to send commands to the panel
- Want to know which user armed/disarmed (via CID events)

**Use TPI if you need to:**
- Send commands (arm, disarm, bypass zones)
- See real-time keypad display text
- Get zone timer history dumps
- Guaranteed access to all CID codes (syslog sends most, but some may vary by firmware)

**You can use both simultaneously.** Syslog operates on a completely independent channel and won't affect TPI connections.
