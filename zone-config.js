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

function watchZonesConfig(zonesPath, { onReload, onError, debounceMs = 100, parseConfig = parseZonesConfig }) {
  const absolutePath = path.resolve(zonesPath);
  const zonesDirectory = path.dirname(absolutePath);
  const zonesFilename = path.basename(absolutePath);
  let debounceTimer = null;
  const watchers = new Map();

  function refreshWatchers() {
    const directories = new Map();
    const addPath = (filePath) => {
      const directory = path.dirname(filePath);
      if (!directories.has(directory)) directories.set(directory, new Set());
      directories.get(directory).add(path.basename(filePath));
    };

    addPath(absolutePath);
    try {
      addPath(fs.realpathSync(absolutePath));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;

      for (const [directory, { filenames }] of watchers) {
        directories.set(directory, new Set(filenames));
      }

      try {
        addPath(path.resolve(zonesDirectory, fs.readlinkSync(absolutePath)));
      } catch (readlinkError) {
        if (readlinkError.code !== 'ENOENT') throw readlinkError;
      }
    }

    for (const [directory, filenames] of directories) {
      const existing = watchers.get(directory);
      if (existing) {
        existing.filenames = filenames;
        continue;
      }

      const watcher = fs.watch(directory, (eventType, filename) => {
        const current = watchers.get(directory);
        if (!current || (filename && !current.filenames.has(filename.toString()))) return;
        scheduleReload();
      });
      watcher.on('error', onError);
      watchers.set(directory, { watcher, filenames });
    }

    for (const [directory, { watcher }] of watchers) {
      if (!directories.has(directory)) {
        watcher.close();
        watchers.delete(directory);
      }
    }
  }

  function scheduleReload() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      let zones;
      try {
        refreshWatchers();
        zones = parseConfig(fs.readFileSync(absolutePath, 'utf8'));
      } catch (err) {
        onError(err);
        return;
      }
      onReload(zones);
    }, debounceMs);
  }

  refreshWatchers();

  return {
    close() {
      clearTimeout(debounceTimer);
      for (const { watcher } of watchers.values()) watcher.close();
      watchers.clear();
    }
  };
}

module.exports = { parseZonesConfig, watchZonesConfig };
