import assert from 'assert';
import { formatLogPreview, redactLogText, redactLogValue } from '../src/utils/logRedaction';

const phraseSecret = 'correct horse battery staple';
const nested = {
    service: 'media',
    endpoint: 'https://proxy.example/media/manifest.m3u8',
    credentials: {
        mediaFlowProxyPassword: phraseSecret,
        apiKey: 'synthetic-api-key'
    }
};
const nestedOutput = JSON.stringify(redactLogValue(nested));
assert(!nestedOutput.includes(phraseSecret));
assert(!nestedOutput.includes('synthetic-api-key'));
assert(nestedOutput.includes('proxy.example/media/manifest.m3u8'));
assert(nestedOutput.includes('[REDACTED]'));

const url = 'https://proxy.example/proxy/mpd/manifest.m3u8?api_password=alpha%20beta&token=second%20phrase&quality=hd#watch';
const urlOutput = formatLogPreview(url, 500);
assert(!urlOutput.includes('alpha%20beta'));
assert(!urlOutput.includes('second%20phrase'));
assert(urlOutput.includes('proxy.example/proxy/mpd/manifest.m3u8'));
assert(urlOutput.includes('quality=hd'));

const quotedMessage = `request failed: password="${phraseSecret}"; token='second secret phrase'; status=401`;
const messageOutput = redactLogText(quotedMessage);
assert(!messageOutput.includes(phraseSecret));
assert(!messageOutput.includes('second secret phrase'));
assert(messageOutput.includes('status=401'));

const mixedQuoteSecret = `correct horse's battery staple`;
const mixedQuoteOutput = redactLogText(`password="${mixedQuoteSecret}"; status=403`);
assert(!mixedQuoteOutput.includes(mixedQuoteSecret));
assert(mixedQuoteOutput.includes('status=403'));

const escapedQuoteSecret = `alpha phrase \\"inner delimiter\\" omega phrase`;
const escapedQuoteOutput = redactLogText(`password="${escapedQuoteSecret}"; status=429`);
assert(!escapedQuoteOutput.includes('inner delimiter'));
assert(!escapedQuoteOutput.includes('omega phrase'));
assert(escapedQuoteOutput.includes('password="[REDACTED]"'));
assert(escapedQuoteOutput.includes('status=429'));

const errorOutput = JSON.stringify(redactLogValue(new Error(quotedMessage)));
assert(!errorOutput.includes(phraseSecret));
assert(!errorOutput.includes('second secret phrase'));
assert(errorOutput.includes('request failed'));

const circular: any = { name: 'retained', password: phraseSecret };
circular.self = circular;
let circularOutput = '';
assert.doesNotThrow(() => {
    circularOutput = JSON.stringify(redactLogValue(circular));
});
assert(circularOutput.includes('[Circular]'));
assert(circularOutput.includes('retained'));
assert(!circularOutput.includes(phraseSecret));

assert.strictEqual(redactLogValue(undefined), undefined);
assert.doesNotThrow(() => formatLogPreview(undefined, 20));
assert.doesNotThrow(() => formatLogPreview(new Date('invalid'), 20));

const throwingGetter: Record<string, unknown> = {};
Object.defineProperty(throwingGetter, 'detail', {
    enumerable: true,
    get() {
        throw new Error('getter failed');
    }
});
assert.doesNotThrow(() => formatLogPreview(throwingGetter, 100));
assert(formatLogPreview(throwingGetter, 100).includes('[Unavailable]'));

const basicAuth = redactLogText('https://viewer:synthetic-password@proxy.example/live');
assert(!basicAuth.includes('synthetic-password'));
assert(basicAuth.includes('viewer:[REDACTED]@proxy.example/live'));

console.log('log redaction tests passed');
