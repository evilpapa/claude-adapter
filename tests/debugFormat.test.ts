import {
    buildOpenAIAuthHeaders,
    summarizeHeaders,
    summarizePayload,
    summarizeResponseBody
} from '../src/utils/debugFormat';

describe('Debug Format Utilities', () => {
    describe('summarizeHeaders', () => {
        it('should mask sensitive headers', () => {
            const summary = summarizeHeaders({
                Authorization: 'Bearer super-secret-token',
                'api-key': 'very-secret-key',
                'content-type': 'application/json'
            });

            expect(summary.authorization).toContain('Bearer ');
            expect(summary.authorization).not.toContain('super-secret-token');
            expect(summary['api-key']).not.toBe('very-secret-key');
            expect(summary['content-type']).toBe('application/json');
        });
    });

    describe('summarizePayload', () => {
        it('should truncate long strings to 100 chars', () => {
            const longText = 'a'.repeat(140);
            const summary = summarizePayload({ text: longText }) as Record<string, unknown>;

            expect(summary.text).toBe(`${'a'.repeat(100)}...(140 chars)`);
        });

        it('should limit array item count in summaries', () => {
            const summary = summarizePayload({
                items: [1, 2, 3, 4, 5, 6, 7]
            }) as Record<string, unknown>;

            expect(summary.items).toEqual([1, 2, 3, 4, 5, '...(2 more items)']);
        });
    });

    describe('summarizeResponseBody', () => {
        it('should summarize nested response objects', () => {
            const summary = summarizeResponseBody({
                id: 'chatcmpl-123',
                choices: [
                    {
                        message: {
                            content: 'hello world'
                        }
                    }
                ]
            }) as Record<string, unknown>;

            expect(summary.id).toBe('chatcmpl-123');
            expect(summary.choices).toBeDefined();
        });
    });

    describe('buildOpenAIAuthHeaders', () => {
        it('should build standard OpenAI auth headers', () => {
            expect(buildOpenAIAuthHeaders('test-key')).toEqual({
                'Content-Type': 'application/json',
                Authorization: 'Bearer test-key'
            });
        });
    });
});
