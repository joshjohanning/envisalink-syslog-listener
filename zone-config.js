const fs = require('fs');
const path = require('path');

function parseZonesConfig(raw) {
  const zones = JSON.parse(raw);
  if (!zones || typeof zones !== 'object' || Array.isArray(zones)) {
    throw new Error('zone configuration must be a JSON object');
  }

  for (const [zone, name] of Object.entries(zones)) {
    if (!/^\d+$/.test(zone) || typeof name !== 'string' || name.trim() === '') {
      throw new Error(`invalid zone mapping for "${zone}"`);
    }
  }

  return zones;
}

function watchZonesConfig(zonesPath, { onReload, onError, debounceMs = 100 }) {
  const absolutePath = path.resolve(zonesPath);
  const zonesDirectory = path.dirname(absolutePath);
  const zonesFilename = path.basename(absolutePath);
  let debounceTimer = null;

  const watcher = fs.watch(zonesDirectory, (eventType, filename) => {
    if (filename && filename.toString() !== zonesFilename) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      let zones;
      try {
        zones = parseZonesConfig(fs.readFileSync(absolutePath, 'utf8'));
      } catch (err) {
        onError(err);
        return;
      }
      onReload(zones);
    }, debounceMs);
  });

  watcher.on('error', onError);

  return {
    close() {
      clearTimeout(debounceTimer);
      watcher.close();
    }
  };
}

module.exports = { parseZonesConfig, watchZonesConfig };
