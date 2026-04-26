import { OpenAIChatRequest } from '../types/openai';

export type TokenLimitField = 'max_tokens' | 'max_completion_tokens';

/**
 * Detect Azure OpenAI v1 endpoints.
 * Supports the official Azure host shape:
 * https://{resource}.openai.azure.com/openai/v1/
 */
export function isAzureOpenAIV1BaseUrl(baseUrl: string): boolean {
    try {
        const url = new URL(baseUrl);
        const normalizedPath = url.pathname.replace(/\/+$/, '');
        return (url.hostname.endsWith('.openai.azure.com') || url.hostname.endsWith('services.ai.azure.com')) && normalizedPath === '/openai/v1';
    } catch {
        return false;
    }
}

/**
 * Normalize the token limit field to match provider/model expectations.
 */
export function applyTokenLimitField(
    request: OpenAIChatRequest,
    field: TokenLimitField
): OpenAIChatRequest {
    const {
        max_tokens,
        max_completion_tokens,
        ...rest
    } = request;

    const tokenLimit = max_completion_tokens ?? max_tokens;

    if (tokenLimit === undefined) {
        return rest;
    }

    if (field === 'max_completion_tokens') {
        return {
            ...rest,
            max_completion_tokens: tokenLimit,
        };
    }

    return {
        ...rest,
        max_tokens: tokenLimit,
    };
}

/**
 * Some Azure OpenAI models reject max_tokens and require max_completion_tokens,
 * while older ones do the inverse. Detect those provider hints and swap fields
 * on a single retry.
 */
export function resolveTokenLimitFieldRetry(
    statusCode: number,
    errorMessage: string
): TokenLimitField | null {
    if (statusCode !== 400) {
        return null;
    }

    if (/unsupported parameter:\s*'max_tokens'.*use 'max_completion_tokens' instead/i.test(errorMessage)) {
        return 'max_completion_tokens';
    }

    if (/unsupported parameter:\s*'max_completion_tokens'.*use 'max_tokens' instead/i.test(errorMessage)) {
        return 'max_tokens';
    }

    return null;
}
