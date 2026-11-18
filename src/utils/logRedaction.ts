const SENSITIVE_NAME = '[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[-_.]?key|authorization|cookie|credential)[A-Za-z0-9_.-]*';
const SENSITIVE_KEY = /password|passwd|pwd|secret|token|api[-_.]?key|authorization|cookie|credential/i;

/** Redact credentials in free-form text before applying preview-length limits. */
export function redactLogText(input: string): string {
    try {
        let text = String(input);

        // URL userinfo is not an assignment, so handle it separately.
        text = text.replace(/\b(https?:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi, '$1[REDACTED]:[REDACTED]@');

        // Preserve quoted delimiters while replacing the complete value, including spaces
        // and escaped instances of the delimiter.
        const quotedAssignment = new RegExp(
            `(^|[?&;,\\s{])((?:["'])?${SENSITIVE_NAME}(?:["'])?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
            'gi'
        );
        text = text.replace(quotedAssignment, (_match, lead, prefix, quotedValue) => {
            const quote = quotedValue.charAt(0);
            return `${lead}${prefix}${quote}[REDACTED]${quote}`;
        });

        const unquotedAssignment = new RegExp(
            `(^|[?&;,\\s{])((?:["'])?${SENSITIVE_NAME}(?:["'])?\\s*[:=]\\s*)([^\\s&,;}"']+)`,
            'gi'
        );
        text = text.replace(unquotedAssignment, '$1$2[REDACTED]');

        // Common header forms may contain spaces without being quoted.
        text = text.replace(
            /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b\s*:\s*)(?!["'])([^\r\n]+)/gi,
            '$1[REDACTED]'
        );
        text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');

        return text;
    } catch {
        return '[Unprintable]';
    }
}

/** Build a logging-safe copy without invoking JSON.stringify. */
export function redactLogValue(value: any, seen: WeakSet<object> = new WeakSet()): any {
    try {
        if (typeof value === 'string') return redactLogText(value);
        if (value === null || value === undefined) return value;
        if (value instanceof Date) {
            const time = value.getTime();
            return Number.isNaN(time) ? '[Invalid Date]' : value.toISOString();
        }
        if (value instanceof Error) {
            return {
                name: redactLogText(value.name || 'Error'),
                message: redactLogText(value.message || ''),
                ...(value.stack ? { stack: redactLogText(value.stack) } : {})
            };
        }
        if (typeof value !== 'object') return value;
        if (seen.has(value)) return '[Circular]';
        seen.add(value);

        if (Array.isArray(value)) {
            return value.map(item => redactLogValue(item, seen));
        }

        const output: Record<string, any> = {};
        for (const key of Reflect.ownKeys(value)) {
            const name = String(key);
            if (SENSITIVE_KEY.test(name)) {
                output[name] = '[REDACTED]';
                continue;
            }
            try {
                output[name] = redactLogValue(value[key], seen);
            } catch {
                output[name] = '[Unprintable]';
            }
        }
        return output;
    } catch {
        return '[Unprintable]';
    }
}

export function redactLogArgs(args: any[]): any[] {
    try {
        return args.map(arg => redactLogValue(arg));
    } catch {
        return ['[Unprintable]'];
    }
}
