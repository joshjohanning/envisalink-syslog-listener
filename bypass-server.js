// Bypass Server - HTTP API for temporarily suppressing zone alerts
//
// Endpoints:
//   GET    /bypasses            - List all active bypasses
//   POST   /bypass/:zone        - Activate bypass (optional ?minutes=N for auto-expiry)
//   DELETE /bypass/:zone        - Cancel bypass
//   GET    /bypass/:zone/status - Check if zone is bypassed (Homebridge stateful switch)
//   POST   /bypass/:zone/toggle - Toggle bypass on/off (Homebridge-friendly)

const http = require('http');
const fs = require('fs');
const path = require('path');

class BypassServer {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.bypassPath = options.bypassPath || path.join(__dirname, 'bypasses.json');
    this.debug = options.debug || false;
    this.logFn = options.logFn || console.log;
    this.zones = options.zones || {};
    this.bypasses = {}; // zone -> { activatedAt, expiresAt (null = indefinite) }
    this.server = null;

    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.bypassPath)) {
        const raw = fs.readFileSync(this.bypassPath, 'utf8');
        const data = JSON.parse(raw);
        const now = Date.now();

        // Restore active bypasses, prune expired ones
        for (const [zone, entry] of Object.entries(data)) {
          if (entry.expiresAt && entry.expiresAt <= now) {
            continue; // expired
          }
          this.bypasses[zone] = entry;
        }

        this._save();
        if (this.debug) {
          this.logFn(`Bypass: loaded ${Object.keys(this.bypasses).length} active bypass(es) from ${this.bypassPath}`);
        }
      }
    } catch (err) {
      this.logFn(`Bypass: could not load ${this.bypassPath}: ${err.message}`);
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.bypassPath, JSON.stringify(this.bypasses, null, 2), 'utf8');
    } catch (err) {
      this.logFn(`Bypass: could not save ${this.bypassPath}: ${err.message}`);
    }
  }

  isBypassed(zone) {
    const key = String(zone);
    const entry = this.bypasses[key];
    if (!entry) return false;

    // Check expiry
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      delete this.bypasses[key];
      this._save();
      return false;
    }
    return true;
  }

  activate(zone, minutes) {
    const key = String(zone);
    const now = Date.now();
    this.bypasses[key] = {
      activatedAt: now,
      expiresAt: minutes ? now + minutes * 60 * 1000 : null
    };
    this._save();
    this.logFn(`Bypass: activated for zone ${key}${minutes ? ` (expires in ${minutes} min)` : ' (indefinite)'}`);
    return this.bypasses[key];
  }

  deactivate(zone) {
    const key = String(zone);
    const existed = !!this.bypasses[key];
    delete this.bypasses[key];
    this._save();
    if (existed) {
      this.logFn(`Bypass: deactivated for zone ${key}`);
    }
    return existed;
  }

  toggle(zone, minutes) {
    if (this.isBypassed(zone)) {
      this.deactivate(zone);
      return false;
    } else {
      this.activate(zone, minutes);
      return true;
    }
  }

  listActive() {
    const now = Date.now();
    const result = {};
    for (const [zone, entry] of Object.entries(this.bypasses)) {
      if (entry.expiresAt && entry.expiresAt <= now) continue;
      result[zone] = {
        ...entry,
        zoneName: this.zones[zone] || `Zone ${zone}`,
        remainingMinutes: entry.expiresAt ? Math.round((entry.expiresAt - now) / 60000) : null
      };
    }
    return result;
  }

  start() {
    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res);
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      this.logFn(`Bypass API server listening on 127.0.0.1:${this.port}`);
    });

    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const pathParts = url.pathname.split('/').filter(Boolean);

    res.setHeader('Content-Type', 'application/json');

    // GET /bypasses
    if (req.method === 'GET' && url.pathname === '/bypasses') {
      const active = this.listActive();
      res.writeHead(200);
      res.end(JSON.stringify(active));
      return;
    }

    // Routes: /bypass/:zone and /bypass/:zone/status and /bypass/:zone/toggle
    if (pathParts[0] === 'bypass' && pathParts.length >= 2) {
      const zone = decodeURIComponent(pathParts[1]);
      const subPath = pathParts[2] || null;

      // GET /bypass/:zone/status
      if (req.method === 'GET' && subPath === 'status') {
        const bypassed = this.isBypassed(zone);
        res.writeHead(200);
        res.end(JSON.stringify({ zone, bypassed, zoneName: this.zones[zone] || `Zone ${zone}` }));
        return;
      }

      // POST /bypass/:zone/toggle
      if (req.method === 'POST' && subPath === 'toggle') {
        const minutes = url.searchParams.get('minutes') ? parseInt(url.searchParams.get('minutes'), 10) : null;
        const nowActive = this.toggle(zone, minutes);
        res.writeHead(200);
        res.end(JSON.stringify({ zone, bypassed: nowActive, zoneName: this.zones[zone] || `Zone ${zone}` }));
        return;
      }

      // POST /bypass/:zone - activate
      if (req.method === 'POST' && !subPath) {
        const minutes = url.searchParams.get('minutes') ? parseInt(url.searchParams.get('minutes'), 10) : null;
        const entry = this.activate(zone, minutes);
        res.writeHead(200);
        res.end(JSON.stringify({ zone, bypassed: true, ...entry, zoneName: this.zones[zone] || `Zone ${zone}` }));
        return;
      }

      // DELETE /bypass/:zone - deactivate
      if (req.method === 'DELETE' && !subPath) {
        const existed = this.deactivate(zone);
        res.writeHead(200);
        res.end(JSON.stringify({ zone, bypassed: false, existed, zoneName: this.zones[zone] || `Zone ${zone}` }));
        return;
      }
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

module.exports = BypassServer;
