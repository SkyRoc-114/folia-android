// src/utils/openAIEndpoint.ts
// Renderer copy of openAIEndpointOf in electron/aiCredentialStore.cjs. The main process binds the
// saved OpenAI-compatible key to this endpoint and enforces it; the settings form only uses it to
// warn before a URL change leaves the saved key unusable.

const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com';

/** Scheme and host an OPENAI_API_URL value sends requests to (the trimmed value if it is not a URL). */
export const openAIEndpointOf = (rawUrl: unknown): string => {
    const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!trimmed) {
        return DEFAULT_OPENAI_ENDPOINT;
    }
    try {
        const { protocol, host } = new URL(trimmed);
        return `${protocol}//${host}`;
    } catch {
        return trimmed.replace(/\/+$/, '');
    }
};
/** OpenAI 兼容接口的默认地址：安卓壳直连时与 Electron 主进程用同一个。 */
export const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

/** Gemini 的 generateContent 地址；密钥走请求头，不放在 query 里。 */
export const geminiGenerateContentUrl = (model: string): string => (
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
);