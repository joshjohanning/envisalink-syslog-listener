// Smoke tests — verify that all runtime dependencies can be loaded.
// These catch breaking changes like ESM-only upgrades (e.g., yargs 18)
// that unit tests on parser.js alone would miss.

describe('dependency smoke tests', () => {
  test('yargs can be required', () => {
    const yargs = require('yargs/yargs');
    const { hideBin } = require('yargs/helpers');
    expect(typeof yargs).toBe('function');
    expect(typeof hideBin).toBe('function');
  });

  test('yargs parses options correctly', () => {
    const yargs = require('yargs/yargs');
    const argv = yargs(['--port', '5514', '--debug', '--dryRun'])
      .option('port', { type: 'number', default: 514 })
      .option('debug', { type: 'boolean', default: false })
      .option('dryRun', { type: 'boolean', default: false })
      .argv;
    expect(argv.port).toBe(5514);
    expect(argv.debug).toBe(true);
    expect(argv.dryRun).toBe(true);
  });

  test('mailgun.js can be required and initialized', () => {
    const Mailgun = require('mailgun.js');
    const formData = require('form-data');
    const mailgun = new Mailgun(formData);
    expect(typeof mailgun.client).toBe('function');
    const mg = mailgun.client({ username: 'api', key: 'test-key' });
    expect(mg).toBeDefined();
    expect(typeof mg.messages.create).toBe('function');
  });

  test('form-data can be required', () => {
    const FormData = require('form-data');
    expect(typeof FormData).toBe('function');
  });
});
