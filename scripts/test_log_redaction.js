'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('src/utils/logRedaction.ts', 'utf8');
const runnable = source
    .replace(/\bexport\s+/g, '')
    .replace(/:\s*WeakSet<object>/g, '')
    .replace(/:\s*Record<string, any>/g, '')
    .replace(/:\s*any\[\]/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*any/g, '')
    + '\n;globalThis.__logRedaction = { redactLogText, redactLogValue, redactLogArgs };';

const sandbox = { Error, Date, WeakSet, Reflect, Number };
vm.createContext(sandbox);
vm.runInContext(runnable, sandbox);
const { redactLogText, redactLogValue } = sandbox.__logRedaction;

const synthetic = 'synthetic value with spaces';
const nested = redactLogValue({
    service: 'video',
    password: synthetic,
    nested: {
        accessToken: 'nested-token',
        api_key: 'nested-key',
        useful: 'kept'
    }
});
assert.strictEqual(nested.password, '[REDACTED]');
assert.strictEqual(nested.nested.accessToken, '[REDACTED]');
assert.strictEqual(nested.nested.api_key, '[REDACTED]');
assert.strictEqual(nested.nested.useful, 'kept');
assert.ok(!JSON.stringify(nested).includes(synthetic));

const quoted = redactLogText('password="alpha beta" secret=\'gamma delta\' token="one \\"two\\" three"');
for (const leaked of ['alpha', 'beta', 'gamma', 'delta', 'one', 'two', 'three']) {
    assert.ok(!quoted.includes(leaked), `quoted value leaked: ${leaked}`);
}
assert.strictEqual((quoted.match(/\[REDACTED\]/g) || []).length, 3);

const url = redactLogText('fetch https://alice:open-sesame@example.test/path?api_password=space%20secret&mode=fast');
assert.ok(url.includes('example.test/path'));
assert.ok(url.includes('mode=fast'));
for (const leaked of ['alice', 'open-sesame', 'space%20secret']) assert.ok(!url.includes(leaked));

const error = redactLogValue(new Error('request failed: authorization="Bearer synthetic credential"'));
assert.ok(error.message.includes('[REDACTED]'));
assert.ok(!error.message.includes('synthetic credential'));

const circular = { name: 'root' };
circular.self = circular;
assert.strictEqual(redactLogValue(circular).self, '[Circular]');
assert.strictEqual(redactLogValue(undefined), undefined);
assert.strictEqual(redactLogValue(new Date('invalid')), '[Invalid Date]');
const throwing = {};
Object.defineProperty(throwing, 'value', { enumerable: true, get() { throw new Error('password=getter-secret'); } });
assert.doesNotThrow(() => redactLogValue(throwing));
assert.strictEqual(redactLogValue(throwing).value, '[Unprintable]');

const addon = fs.readFileSync('src/addon.ts', 'utf8');
assert.ok(addon.includes("import { redactLogArgs, redactLogText, redactLogValue } from './utils/logRedaction';"));
assert.ok(addon.includes("console.log('[DEBUG]', ...redactLogArgs(args))"));
assert.ok(addon.includes("console.log('[VAVOO-DEBUG]', ...redactLogArgs(args))"));
assert.ok(!addon.includes('Configuration string: ${args.substring(0, 50)}'));
assert.ok(!addon.includes('Base64 decoded result: ${decoded.substring(0, 50)}'));
assert.ok(addon.includes('redactLogText(decodedUrl).substring(0, 100)'));
assert.ok(addon.includes('redactLogText(finalUrl).substring(0, 100)'));

const thisnot = fs.readFileSync('src/utils/thisnotChannels.ts', 'utf8');
assert.ok(thisnot.includes("import { redactLogText, redactLogValue } from './logRedaction';"));
assert.ok(thisnot.includes('redactLogText(playerUrl)'));
assert.ok(thisnot.includes('redactLogValue(error)'));

console.log('log redaction assertions passed');
