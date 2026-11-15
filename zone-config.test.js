const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseZonesConfig, watchZonesConfig } = require('./zone-config');

describe('parseZonesConfig', () => {
  test('parses valid zone mappings', () => {
    expect(parseZonesConfig('{"2":"Back Door"}')).toEqual({ '2': 'Back Door' });
  });

  test.each([
    ['[]', /JSON object/],
    ['null', /JSON object/],
    ['{"door":"Back Door"}', /invalid zone mapping/],
    ['{"2":""}', /invalid zone mapping/],
    ['{"2":null}', /invalid zone mapping/]
  ])('rejects invalid zone configuration %s', (raw, error) => {
    expect(() => parseZonesConfig(raw)).toThrow(error);
  });
});

describe('watchZonesConfig', () => {
  let directory;
  let zonesPath;
  let watcher;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-config-'));
    zonesPath = path.join(directory, 'zones.json');
    fs.writeFileSync(zonesPath, '{"2":"Back Door"}');
  });

  afterEach(() => {
    if (watcher) watcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('reloads atomic replacements, retains invalid content, and recovers on a later save', async () => {
    const onReload = jest.fn();
    const onError = jest.fn();
    watcher = watchZonesConfig(zonesPath, { onReload, onError, debounceMs: 20 });

    const replaceZones = (content) => {
      const temporaryPath = path.join(directory, 'zones.tmp');
      fs.writeFileSync(temporaryPath, content);
      fs.renameSync(temporaryPath, zonesPath);
    };

    replaceZones('{"2":"Intermediate Name"}');
    replaceZones('{"2":"Kitchen Back Door"}');
    await waitFor(() => onReload.mock.calls.length === 1);
    expect(onReload).toHaveBeenLastCalledWith({ '2': 'Kitchen Back Door' });

    replaceZones('{"2":');
    await waitFor(() => onError.mock.calls.length === 1);
    expect(onReload).toHaveBeenCalledTimes(1);

    fs.unlinkSync(zonesPath);
    await waitFor(() => onError.mock.calls.length === 2);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'ENOENT' }));
    expect(onReload).toHaveBeenCalledTimes(1);

    replaceZones('{"2":"Back Door Updated"}');
    await waitFor(() => onReload.mock.calls.length === 2);
    expect(onReload).toHaveBeenLastCalledWith({ '2': 'Back Door Updated' });
  });

  test('watches symlink targets and refreshes the target watch when the link changes', async () => {
    const targetDirectory = path.join(directory, 'targets');
    fs.mkdirSync(targetDirectory);
    const firstTarget = path.join(targetDirectory, 'first.json');
    const secondTarget = path.join(targetDirectory, 'second.json');
    fs.writeFileSync(firstTarget, '{"2":"First Target"}');
    fs.writeFileSync(secondTarget, '{"2":"Second Target"}');
    fs.unlinkSync(zonesPath);
    fs.symlinkSync(firstTarget, zonesPath);

    const onReload = jest.fn();
    const onError = jest.fn();
    watcher = watchZonesConfig(zonesPath, { onReload, onError, debounceMs: 20 });

    const replaceTarget = (targetPath, content) => {
      const temporaryPath = `${targetPath}.tmp`;
      fs.writeFileSync(temporaryPath, content);
      fs.renameSync(temporaryPath, targetPath);
    };

    replaceTarget(firstTarget, '{"2":"First Target Updated"}');
    await waitFor(() => onReload.mock.calls.length === 1);
    expect(onReload).toHaveBeenLastCalledWith({ '2': 'First Target Updated' });

    const temporaryLink = `${zonesPath}.tmp`;
    fs.symlinkSync(secondTarget, temporaryLink);
    fs.renameSync(temporaryLink, zonesPath);
    await waitFor(() => onReload.mock.calls.length === 2);
    expect(onReload).toHaveBeenLastCalledWith({ '2': 'Second Target' });

    replaceTarget(firstTarget, '{"2":"Stale Target"}');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(onReload).toHaveBeenCalledTimes(2);

    replaceTarget(secondTarget, '{"2":"Second Target Updated"}');
    await waitFor(() => onReload.mock.calls.length === 3);
    expect(onReload).toHaveBeenLastCalledWith({ '2': 'Second Target Updated' });
    expect(onError).not.toHaveBeenCalled();
  });

  test('recovers when a symlink target is deleted and recreated', async () => {
    const targetDirectory = path.join(directory, 'targets');
    fs.mkdirSync(targetDirectory);
    const targetPath = path.join(targetDirectory, 'zones.json');
    fs.writeFileSync(targetPath, '{"2":"Original Target"}');
    fs.unlinkSync(zonesPath);
    fs.symlinkSync(targetPath, zonesPath);

    const onReload = jest.fn();
    const onError = jest.fn();
    watcher = watchZonesConfig(zonesPath, { onReload, onError, debounceMs: 20 });

    fs.unlinkSync(targetPath);
    await waitFor(() => onError.mock.calls.length === 1);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'ENOENT' }));

    const temporaryPath = `${targetPath}.tmp`;
    fs.writeFileSync(temporaryPath, '{"2":"Recreated Target"}');
    fs.renameSync(temporaryPath, targetPath);
    await waitFor(() => onReload.mock.calls.length === 1);
    expect(onReload).toHaveBeenLastCalledWith({ '2': 'Recreated Target' });
  });

  test('reports watcher creation errors without throwing from the reload timer', async () => {
    const initialTargetDirectory = path.join(directory, 'initial-target');
    const targetDirectory = path.join(directory, 'new-target');
    fs.mkdirSync(initialTargetDirectory);
    fs.mkdirSync(targetDirectory);
    const initialTargetPath = path.join(initialTargetDirectory, 'zones.json');
    const targetPath = path.join(targetDirectory, 'zones.json');
    fs.writeFileSync(initialTargetPath, '{"2":"Target"}');
    fs.writeFileSync(targetPath, '{"2":"Updated Target"}');
    fs.unlinkSync(zonesPath);
    fs.symlinkSync(initialTargetPath, zonesPath);

    const onReload = jest.fn();
    const onError = jest.fn();
    watcher = watchZonesConfig(zonesPath, { onReload, onError, debounceMs: 20 });

    const nativeWatch = fs.watch;
    const watch = jest.spyOn(fs, 'watch');
    const resolvedTargetDirectory = fs.realpathSync(targetDirectory);
    const watchError = Object.assign(new Error('watch limit reached'), { code: 'ENOSPC' });
    watch.mockImplementation((directoryPath, ...args) => {
      if (directoryPath === resolvedTargetDirectory) throw watchError;
      return nativeWatch(directoryPath, ...args);
    });

    try {
      const temporaryLink = `${zonesPath}.tmp`;
      fs.symlinkSync(targetPath, temporaryLink);
      fs.renameSync(temporaryLink, zonesPath);
      await waitFor(() => watch.mock.calls.some(([directoryPath]) => directoryPath === resolvedTargetDirectory));
      expect(onError).toHaveBeenCalledWith(watchError);
      expect(onReload).not.toHaveBeenCalled();
    } finally {
      watch.mockRestore();
    }
  });
});

async function waitFor(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for zone configuration watcher');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
