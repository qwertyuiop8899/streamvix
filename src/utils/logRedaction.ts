const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const UNAVAILABLE = '[Unavailable]';

const SENSITIVE_KEY_PATTERN = String.raw`(?:[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[-_]?key|authorization|cookie)[A-Za-z0-9_.-]*)`;
const QUOTED_VALUE = new RegExp(`((?:["']?)${SENSITIVE_KEY_PATTERN}(?:["']?)\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\2)[^\\\\\\r\\n])*)\\2`, 'gi');
const AUTH_SCHEME_VALUE = /((?:proxy[-_ ]?)?authorization\s*[:=]\s*(?:bearer|basic)\s+)([^\s,;]+)/gi;
const UNQUOTED_VALUE = new RegExp(`((?:["']?)${SENSITIVE_KEY_PATTERN}(?:["']?)\\s*[:=]\\s*)([^\\s"'&,;]+)`, 'gi');
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return /(?:password|passwd|passphrase|secret|token|apikey|authorization|cookie)$/.test(normalized);
}

/** Redact credentials embedded in URLs, assignments, JSON-like text, and error messages. */
export function redactLogText(value: string): string {
    try {
        return value
            .replace(URL_USERINFO, `$1$2:${REDACTED}@`)
            .replace(QUOTED_VALUE, (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`)
            .replace(AUTH_SCHEME_VALUE, `$1${REDACTED}`)
            .replace(UNQUOTED_VALUE, `$1${REDACTED}`);
    } catch {
        return '[Unredactable log text]';
    }
}

/**
 * Produce a console-safe clone without invoking sensitive getters. Cycles are
 * replaced with a marker so later stringification remains non-throwing.
 */
export function redactLogValue(value: unknown): unknown {
    const ancestors = new WeakSet<object>();

    const visit = (current: unknown): unknown => {
        if (typeof current === 'string') return redactLogText(current);
        if (current === null || typeof current !== 'object') return current;

        if (current instanceof Date) {
            return new Date(current.getTime());
        }

        if (ancestors.has(current)) return CIRCULAR;
        ancestors.add(current);

        try {
            if (current instanceof Error) {
                const result: Record<string, unknown> = {
                    name: redactLogText(current.name),
                    message: redactLogText(current.message)
                };
                if (current.stack !== undefined) result.stack = redactLogText(current.stack);
                return result;
            }

            if (Array.isArray(current)) {
                return current.map(item => visit(item));
            }

            const result: Record<string, unknown> = {};
            for (const key of Object.keys(current)) {
                if (isSensitiveKey(key)) {
                    result[key] = REDACTED;
                    continue;
                }
                try {
                    result[key] = visit((current as Record<string, unknown>)[key]);
                } catch {
                    result[key] = UNAVAILABLE;
                }
            }
            return result;
        } catch {
            return UNAVAILABLE;
        } finally {
            ancestors.delete(current);
        }
    };

    try {
        return visit(value);
    } catch {
        return UNAVAILABLE;
    }
}

/** Redact and stringify a value before limiting its log length. */
export function formatLogPreview(value: unknown, maxLength: number): string {
    let rendered: string;
    try {
        const sanitized = redactLogValue(value);
        if (typeof sanitized === 'string') {
            rendered = sanitized;
        } else if (sanitized === undefined) {
            rendered = 'undefined';
        } else {
            const json = JSON.stringify(sanitized, (_key, item) =>
                typeof item === 'bigint' ? `${item.toString()}n` : item
            );
            rendered = json === undefined ? String(sanitized) : json;
        }
    } catch {
        rendered = '[Unserializable log value]';
    }

    const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : rendered.length;
    return rendered.length > limit ? `${rendered.slice(0, limit)}...` : rendered;
}
