const DEFAULT_MAX_STRING_LENGTH = 100;
const DEFAULT_MAX_OBJECT_KEYS = 12;
const DEFAULT_MAX_ARRAY_ITEMS = 5;

function truncateString(value: string, maxLength: number = DEFAULT_MAX_STRING_LENGTH): string {
    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...(${value.length} chars)`;
}

function maskSecret(value: string): string {
    if (!value) {
        return value;
    }

    if (value.startsWith('Bearer ')) {
        const token = value.slice('Bearer '.length);
        return `Bearer ${maskSecret(token)}`;
    }

    if (value.length <= 10) {
        return '***';
    }

    return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

export function summarizeHeaders(
    headers: Record<string, unknown> | undefined | null,
    keys: string[] = ['content-type', 'authorization', 'api-key', 'anthropic-version', 'x-api-key']
): Record<string, unknown> {
    if (!headers) {
        return {};
    }

    const normalizedHeaders: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(headers)) {
        normalizedHeaders[key.toLowerCase()] = value;
    }

    const summary: Record<string, unknown> = {};

    for (const key of keys) {
        const value = normalizedHeaders[key];
        if (value === undefined) {
            continue;
        }

        if (typeof value === 'string') {
            summary[key] = key === 'authorization' || key === 'api-key' || key === 'x-api-key'
                ? maskSecret(value)
                : truncateString(value);
        } else if (Array.isArray(value)) {
            summary[key] = value.map(item => typeof item === 'string' ? truncateString(item) : item);
        } else {
            summary[key] = value;
        }
    }

    return summary;
}

export function summarizePayload(value: unknown, depth: number = 0): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        return truncateString(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        const items = value
            .slice(0, DEFAULT_MAX_ARRAY_ITEMS)
            .map(item => summarizePayload(item, depth + 1));

        if (value.length > DEFAULT_MAX_ARRAY_ITEMS) {
            items.push(`...(${value.length - DEFAULT_MAX_ARRAY_ITEMS} more items)`);
        }

        return items;
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    if (depth >= 4) {
        return '[Object]';
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const summary: Record<string, unknown> = {};

    for (const [key, nestedValue] of entries.slice(0, DEFAULT_MAX_OBJECT_KEYS)) {
        summary[key] = summarizePayload(nestedValue, depth + 1);
    }

    if (entries.length > DEFAULT_MAX_OBJECT_KEYS) {
        summary.__truncatedKeys = entries.length - DEFAULT_MAX_OBJECT_KEYS;
    }

    return summary;
}

export function summarizeResponseBody(body: unknown): unknown {
    return summarizePayload(body);
}

export function buildOpenAIAuthHeaders(apiKey: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
}
