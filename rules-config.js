function parseRulesConfig(raw) {
  const rules = JSON.parse(raw);
  if (!Array.isArray(rules)) throw new Error('rules configuration must be a JSON array');

  for (const [index, rule] of rules.entries()) {
    if (rule && typeof rule === 'object' && !Array.isArray(rule) && rule.enabled === false) continue;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
        || !['string', 'number'].includes(typeof rule.zone) || !/^\d+$/.test(String(rule.zone))
        || rule.condition !== 'open_duration'
        || !['email', 'ntfy', 'both'].includes(rule.action)
        || (rule.enabled !== undefined && typeof rule.enabled !== 'boolean')
        || (rule.description !== undefined && typeof rule.description !== 'string')) {
      throw new Error(`invalid alert rule at index ${index}`);
    }
    for (const field of ['minutes', 'repeatInterval', 'maxRepeats']) {
      const value = rule[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)
          || value < 0 || (field === 'minutes' && value === 0)
          || (field === 'maxRepeats' && !Number.isInteger(value))
          || (field !== 'maxRepeats' && value * 60000 > 2147483647))) {
        throw new Error(`invalid ${field} in alert rule at index ${index}`);
      }
    }
  }
  return rules;
}

module.exports = { parseRulesConfig };
