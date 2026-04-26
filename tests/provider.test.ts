import {
    applyTokenLimitField,
    isAzureOpenAIV1BaseUrl,
    resolveTokenLimitFieldRetry
} from '../src/utils/provider';

describe('Provider Utilities', () => {
    describe('isAzureOpenAIV1BaseUrl', () => {
        it('should detect official Azure OpenAI v1 endpoints', () => {
            expect(isAzureOpenAIV1BaseUrl('https://example.openai.azure.com/openai/v1/')).toBe(true);
            expect(isAzureOpenAIV1BaseUrl('https://example.openai.azure.com/openai/v1')).toBe(true);
        });

        it('should reject non-v1 Azure paths', () => {
            expect(isAzureOpenAIV1BaseUrl('https://example.openai.azure.com/openai/deployments/foo/chat/completions?api-version=2024-10-21')).toBe(false);
        });

        it('should reject non-Azure endpoints', () => {
            expect(isAzureOpenAIV1BaseUrl('https://api.openai.com/v1')).toBe(false);
        });
    });

    describe('applyTokenLimitField', () => {
        const baseRequest = {
            model: 'test-model',
            messages: [{ role: 'user' as const, content: 'hello' }],
            max_tokens: 128,
            stream: false
        };

        it('should preserve max_tokens when requested', () => {
            const result = applyTokenLimitField(baseRequest, 'max_tokens');
            expect(result.max_tokens).toBe(128);
            expect(result.max_completion_tokens).toBeUndefined();
        });

        it('should swap max_tokens to max_completion_tokens when requested', () => {
            const result = applyTokenLimitField(baseRequest, 'max_completion_tokens');
            expect(result.max_tokens).toBeUndefined();
            expect(result.max_completion_tokens).toBe(128);
        });
    });

    describe('resolveTokenLimitFieldRetry', () => {
        it('should retry with max_completion_tokens when Azure asks for it', () => {
            const result = resolveTokenLimitFieldRetry(
                400,
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
            );

            expect(result).toBe('max_completion_tokens');
        });

        it('should retry with max_tokens when provider asks for it', () => {
            const result = resolveTokenLimitFieldRetry(
                400,
                "Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead."
            );

            expect(result).toBe('max_tokens');
        });

        it('should not retry on unrelated errors', () => {
            expect(resolveTokenLimitFieldRetry(500, 'Internal server error')).toBeNull();
        });
    });
});
