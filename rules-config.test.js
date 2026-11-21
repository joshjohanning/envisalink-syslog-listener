const { parseRulesConfig } = require('./rules-config');

const rule = { zone: '2', condition: 'open_duration', minutes: 0.01, action: 'ntfy' };

test('accepts optional fields, disabled rules, fractional timing, and an empty rules file', () => {
  const rules = [rule, { ...rule, zone: 3, enabled: false, repeatInterval: 0, maxRepeats: 0 }];
  expect(parseRulesConfig(JSON.stringify(rules))).toEqual(rules);
  expect(parseRulesConfig('[]')).toEqual([]);
});

test.each([
  null, {}, [null], [{ ...rule, zone: {} }], [{ ...rule, zone: 'door' }],
  [{ ...rule, condition: 'unknown' }], [{ ...rule, action: 'unknown' }],
  [{ ...rule, enabled: 'false' }], [{ ...rule, description: 42 }],
  ...['minutes', 'repeatInterval', 'maxRepeats'].flatMap(field =>
    [-1, '2', null].map(value => [{ ...rule, [field]: value }])),
  [{ ...rule, minutes: 0 }], [{ ...rule, minutes: 40000 }],
  [{ ...rule, repeatInterval: 40000 }], [{ ...rule, maxRepeats: 1.5 }],
  [{ ...rule, enabled: false, action: 'invalid' }]
])('rejects invalid configuration: %j', config => {
  expect(() => parseRulesConfig(JSON.stringify(config))).toThrow();
});

test('rejects malformed JSON and non-finite timing', () => {
  expect(() => parseRulesConfig('[')).toThrow();
  expect(() => parseRulesConfig('[{"zone":"2","condition":"open_duration","action":"ntfy","minutes":1e999}]')).toThrow();
});
