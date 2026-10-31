import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestThemeJsonWithTruncationRetry, type ThemeRawReply } from '@/services/aiText';

// AI 主题生成的截断重试（main 线 cff50711 语义移植）：
// finish=length 意味着 JSON 一定不完整，报告里的「Invalid AI theme JSON format」就是这种形态。
// 截断取决于这一次推理的预算，是偶发的——再要一次通常就是完整的。只在截断时多发一次请求；
// 第二次更短（同为截断）时保留第一次，避免用更差的响应替换；重试本身失败沿用第一次。

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const reply = (text: string, finishReason: ThemeRawReply['finishReason']): ThemeRawReply => ({
    text,
    finishReason,
    textLength: text.length,
});

describe('requestThemeJsonWithTruncationRetry', () => {
    it('does not retry when the first answer is complete (finish=stop)', async () => {
        const request = vi.fn(async () => reply('{"complete":true}', 'stop'));
        const result = await requestThemeJsonWithTruncationRetry(request);
        expect(result.text).toBe('{"complete":true}');
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('retries exactly once when truncated, keeping the longer second answer', async () => {
        const request = vi.fn()
            .mockImplementationOnce(async () => reply('{"trunca', 'length'))
            .mockImplementationOnce(async () => reply('{"complete":true}', 'stop'));
        const result = await requestThemeJsonWithTruncationRetry(request);
        expect(result.text).toBe('{"complete":true}');
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('keeps the first answer when the retry is truncated even shorter', async () => {
        const request = vi.fn()
            .mockImplementationOnce(async () => reply('{"trunc', 'length'))
            .mockImplementationOnce(async () => reply('{"tru', 'length'));
        const result = await requestThemeJsonWithTruncationRetry(request);
        expect(result.text).toBe('{"trunc');
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('keeps the first answer when the retry request itself fails', async () => {
        const request = vi.fn()
            .mockImplementationOnce(async () => reply('{"trunc', 'length'))
            .mockImplementationOnce(async () => { throw new Error('network down'); });
        const result = await requestThemeJsonWithTruncationRetry(request);
        expect(result.text).toBe('{"trunc');
    });
});
