import { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from '../types/openai';
import { applyTokenLimitField, resolveTokenLimitFieldRetry, TokenLimitField } from './provider';
import { RequestLogger } from './logger';
import { summarizeHeaders, summarizePayload, summarizeResponseBody } from './debugFormat';

interface AzureErrorShape {
    error?: {
        message?: string;
        code?: string;
        type?: string;
    };
    message?: string;
}

export class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}

function buildAzureHeaders(apiKey: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'api-key': apiKey,
    };
}

function buildChatCompletionsUrl(baseUrl: string): string {
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    return `${normalizedBase}/chat/completions`;
}

function extractErrorMessage(payload: AzureErrorShape | null, status: number, fallback: string): string {
    return payload?.error?.message || payload?.message || fallback || `HTTP ${status}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
    return await response.json() as T;
}

async function createAzureRequest(
    baseUrl: string,
    apiKey: string,
    request: OpenAIChatRequest,
    log?: RequestLogger,
    attempt: number = 1
): Promise<Response> {
    const url = buildChatCompletionsUrl(baseUrl);
    const headers = buildAzureHeaders(apiKey);

    log?.debug('Upstream request', {
        provider: 'azure-openai-v1',
        url,
        attempt,
        headers: summarizeHeaders(headers),
        params: summarizePayload(request)
    });

    return await fetch(buildChatCompletionsUrl(baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
    });
}

async function requestWithTokenFallback(
    baseUrl: string,
    apiKey: string,
    request: OpenAIChatRequest,
    initialField: TokenLimitField = 'max_tokens',
    log?: RequestLogger
): Promise<Response> {
    let normalizedRequest = applyTokenLimitField(request, initialField);
    let response = await createAzureRequest(baseUrl, apiKey, normalizedRequest, log, 1);

    if (response.ok) {
        return response;
    }

    const errorPayload = await parseJsonResponse<AzureErrorShape | null>(response).catch(() => null);
    const errorMessage = extractErrorMessage(errorPayload, response.status, response.statusText);
    log?.debug('Upstream response', {
        provider: 'azure-openai-v1',
        url: buildChatCompletionsUrl(baseUrl),
        attempt: 1,
        statusCode: response.status,
        body: summarizeResponseBody(errorPayload ?? { message: errorMessage })
    });
    const retryField = resolveTokenLimitFieldRetry(response.status, errorMessage);

    if (!retryField || retryField === initialField) {
        throw new HttpError(response.status, errorMessage);
    }

    log?.debug('Retrying Azure request with alternate token field', {
        from: initialField,
        to: retryField
    });

    normalizedRequest = applyTokenLimitField(request, retryField);
    response = await createAzureRequest(baseUrl, apiKey, normalizedRequest, log, 2);

    if (!response.ok) {
        const retryPayload = await parseJsonResponse<AzureErrorShape | null>(response).catch(() => null);
        log?.debug('Upstream response', {
            provider: 'azure-openai-v1',
            url: buildChatCompletionsUrl(baseUrl),
            attempt: 2,
            statusCode: response.status,
            body: summarizeResponseBody(retryPayload ?? { message: response.statusText })
        });
        throw new HttpError(
            response.status,
            extractErrorMessage(retryPayload, response.status, response.statusText)
        );
    }

    return response;
}

export async function createAzureChatCompletion(
    baseUrl: string,
    apiKey: string,
    request: OpenAIChatRequest,
    log?: RequestLogger
): Promise<OpenAIChatResponse> {
    const response = await requestWithTokenFallback(baseUrl, apiKey, request, 'max_tokens', log);
    const payload = await parseJsonResponse<OpenAIChatResponse>(response);
    log?.debug('Upstream response', {
        provider: 'azure-openai-v1',
        url: buildChatCompletionsUrl(baseUrl),
        statusCode: response.status,
        body: summarizeResponseBody(payload)
    });
    return payload;
}

export async function createAzureChatCompletionStream(
    baseUrl: string,
    apiKey: string,
    request: OpenAIChatRequest,
    log?: RequestLogger
): Promise<AsyncIterable<OpenAIStreamChunk>> {
    const response = await requestWithTokenFallback(baseUrl, apiKey, request, 'max_tokens', log);

    if (!response.body) {
        throw new HttpError(response.status, 'Azure OpenAI returned an empty response body');
    }

    log?.debug('Upstream response', {
        provider: 'azure-openai-v1',
        url: buildChatCompletionsUrl(baseUrl),
        statusCode: response.status,
        body: '[stream]'
    });

    return streamSseJson<OpenAIStreamChunk>(response.body);
}

async function* streamSseJson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        let boundaryIndex = buffer.indexOf('\n\n');
        while (boundaryIndex !== -1) {
            const eventBlock = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);

            const parsed = parseSseEvent<T>(eventBlock);
            if (parsed !== undefined) {
                yield parsed;
            }

            boundaryIndex = buffer.indexOf('\n\n');
        }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
        const parsed = parseSseEvent<T>(buffer);
        if (parsed !== undefined) {
            yield parsed;
        }
    }
}

function parseSseEvent<T>(eventBlock: string): T | undefined {
    const dataLines = eventBlock
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());

    if (dataLines.length === 0) {
        return undefined;
    }

    const data = dataLines.join('\n');
    if (data === '[DONE]') {
        return undefined;
    }

    return JSON.parse(data) as T;
}
