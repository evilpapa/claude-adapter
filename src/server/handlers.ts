// Proxy server request handlers
import { FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { AnthropicMessageRequest } from '../types/anthropic';
import { AdapterConfig } from '../types/config';
import { convertRequestToOpenAI } from '../converters/request';
import { convertResponseToAnthropic, createErrorResponse } from '../converters/response';
import { streamOpenAIToAnthropic } from '../converters/streaming';
import { streamXmlOpenAIToAnthropic } from '../converters/xmlStreaming';
import { validateAnthropicRequest, formatValidationErrors } from '../utils/validation';
import { logger, RequestLogger } from '../utils/logger';
import { recordUsage } from '../utils/tokenUsage';
import { recordError } from '../utils/errorLog';
import { createAzureChatCompletion, createAzureChatCompletionStream } from '../utils/azureOpenAI';
import { isAzureOpenAIV1BaseUrl } from '../utils/provider';
import {
    buildOpenAIAuthHeaders,
    summarizeHeaders,
    summarizePayload,
    summarizeResponseBody
} from '../utils/debugFormat';

// Request ID counter for unique identification
let requestIdCounter = 0;

function generateRequestId(): string {
    requestIdCounter++;
    const timestamp = Date.now().toString(36);
    const counter = requestIdCounter.toString(36).padStart(4, '0');
    return `req_${timestamp}_${counter} `;
}

/**
 * Handle POST /v1/messages requests
 */
export function createMessagesHandler(config: AdapterConfig) {
    const isAzureOpenAIV1 = isAzureOpenAIV1BaseUrl(config.baseUrl);
    const openai = isAzureOpenAIV1 ? null : new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
    });

    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const requestId = generateRequestId();
        const log = logger.withRequestId(requestId);

        // Add request ID to response headers for client tracing
        reply.header('X-Request-Id', requestId);

        try {
            // Validate request before processing
            const validation = validateAnthropicRequest(request.body);
            if (!validation.valid) {
                const errorMessage = formatValidationErrors(validation.errors);
                log.warn('Invalid request', { errors: validation.errors });
                const errorResponse = createErrorResponse(new Error(errorMessage), 400);
                reply.code(400).send({ error: errorResponse.error });
                return;
            }

            const anthropicRequest = request.body as AnthropicMessageRequest;
            const targetModel = anthropicRequest.model;
            const isStreaming = anthropicRequest.stream ?? false;

            log.info(`→ ${targetModel} [sent]`);
            log.debug('Incoming Anthropic request', {
                method: request.method,
                url: request.url,
                headers: summarizeHeaders(request.headers as Record<string, unknown>),
                body: summarizePayload(anthropicRequest)
            });

            // Determine tool calling style from config
            const toolStyle = config.toolFormat || 'native';

            // Convert request to OpenAI format
            const openaiRequest = convertRequestToOpenAI(anthropicRequest, targetModel, toolStyle);

            // Log tool calling mode when tools are present
            if (toolStyle === 'xml' && anthropicRequest.tools?.length) {
                log.info(`Using XML tool calling mode (${anthropicRequest.tools.length} tools)`);
            }

            if (isStreaming) {
                if (toolStyle === 'xml') {
                    await handleXmlStreamingRequest(openai, openaiRequest, reply, anthropicRequest.model, config, log);
                } else {
                    await handleStreamingRequest(openai, openaiRequest, reply, anthropicRequest.model, config, log);
                }
            } else {
                await handleNonStreamingRequest(openai, openaiRequest, reply, anthropicRequest.model, config, log);
            }

            log.info(`← ${targetModel} [received]`);
        } catch (error) {
            const body = request.body as any;
            handleError(error as Error, reply, log, {
                requestId,
                provider: config.baseUrl,
                modelName: body?.model ?? 'unknown',
                streaming: body?.stream ?? false
            });
        }
    };
}

/**
 * Handle non-streaming API request
 */
async function handleNonStreamingRequest(
    openai: OpenAI | null,
    openaiRequest: any,
    reply: FastifyReply,
    originalModel: string,
    config: AdapterConfig,
    log: RequestLogger
): Promise<void> {
    log.debug('Making non-streaming request');
    const isAzureRequest = isAzureOpenAIV1BaseUrl(config.baseUrl);

    if (!isAzureRequest) {
        log.debug('Upstream request', {
            provider: 'openai-compatible',
            url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            headers: summarizeHeaders(buildOpenAIAuthHeaders(config.apiKey)),
            params: summarizePayload({
                ...openaiRequest,
                stream: false,
            })
        });
    }

    const response = isAzureRequest
        ? await createAzureChatCompletion(config.baseUrl, config.apiKey, {
            ...openaiRequest,
            stream: false,
        }, log)
        : await openai!.chat.completions.create({
            ...openaiRequest,
            stream: false,
        });

    log.debug('Response received', {
        finishReason: response.choices[0]?.finish_reason,
        usage: response.usage,
        body: summarizeResponseBody(response)
    });

    // Record token usage
    if (response.usage) {
        recordUsage({
            provider: config.baseUrl,
            modelName: originalModel,
            model: response.model,
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
            streaming: false
        });
    }

    const anthropicResponse = convertResponseToAnthropic(response as any, originalModel);
    reply.send(anthropicResponse);
}

/**
 * Handle streaming API request
 */
async function handleStreamingRequest(
    openai: OpenAI | null,
    openaiRequest: any,
    reply: FastifyReply,
    originalModel: string,
    config: AdapterConfig,
    log: RequestLogger
): Promise<void> {
    log.debug('Making streaming request');
    const isAzureRequest = isAzureOpenAIV1BaseUrl(config.baseUrl);

    if (!isAzureRequest) {
        log.debug('Upstream request', {
            provider: 'openai-compatible',
            url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            headers: summarizeHeaders(buildOpenAIAuthHeaders(config.apiKey)),
            params: summarizePayload({
                ...openaiRequest,
                stream: true,
            })
        });
    }

    const stream = isAzureRequest
        ? await createAzureChatCompletionStream(config.baseUrl, config.apiKey, {
            ...openaiRequest,
            stream: true,
        }, log)
        : await openai!.chat.completions.create({
            ...openaiRequest,
            stream: true,
        } as OpenAI.ChatCompletionCreateParamsStreaming);

    await streamOpenAIToAnthropic(stream as any, reply, originalModel, config.baseUrl, log);
    log.debug('Streaming completed');
}

/**
 * Handle XML streaming API request (for models without native tool calling)
 */
async function handleXmlStreamingRequest(
    openai: OpenAI | null,
    openaiRequest: any,
    reply: FastifyReply,
    originalModel: string,
    config: AdapterConfig,
    log: RequestLogger
): Promise<void> {
    log.debug('Making XML streaming request (experimental)');
    const isAzureRequest = isAzureOpenAIV1BaseUrl(config.baseUrl);

    if (!isAzureRequest) {
        log.debug('Upstream request', {
            provider: 'openai-compatible',
            url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            headers: summarizeHeaders(buildOpenAIAuthHeaders(config.apiKey)),
            params: summarizePayload({
                ...openaiRequest,
                stream: true,
            })
        });
    }

    const stream = isAzureRequest
        ? await createAzureChatCompletionStream(config.baseUrl, config.apiKey, {
            ...openaiRequest,
            stream: true,
        }, log)
        : await openai!.chat.completions.create({
            ...openaiRequest,
            stream: true,
        } as OpenAI.ChatCompletionCreateParamsStreaming);

    await streamXmlOpenAIToAnthropic(stream as any, reply, originalModel, config.baseUrl, log);
    log.debug('XML streaming completed');
}

/**
 * Handle errors and send appropriate response
 */
function handleError(
    error: Error,
    reply: FastifyReply,
    log: RequestLogger,
    context?: { requestId: string; provider: string; modelName: string; streaming: boolean }
): void {
    let statusCode = 500;

    // Try to extract status code from OpenAI error
    if ('status' in error) {
        statusCode = (error as any).status;
    }

    log.error('Request failed', error, { statusCode });

    // Record error to file if context is available
    if (context) {
        recordError(error, context);
    }

    const errorResponse = createErrorResponse(error, statusCode);
    reply.code(errorResponse.status).send({ error: errorResponse.error });
}


