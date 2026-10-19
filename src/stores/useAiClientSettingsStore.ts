import { create } from 'zustand';
import { canUseDirectAiText } from '../utils/platform';
import { getStoredJson, setStoredJson } from './storagePrimitives';

// src/stores/useAiClientSettingsStore.ts
// 安卓壳的 AI 主题设置：密钥与接口参数留在本机（localStorage）。桌面端仍由 Electron 主进程
// 保存密钥，不经这里；浏览器版用部署的服务端密钥，也不经这里。
// 设置页「界面外观 → AI主题设置」读写它，src/services/aiText.ts 直连服务商时读它。

export type AiClientProvider = 'gemini' | 'openai';

export type AiClientSettings = {
    provider: AiClientProvider;
    geminiApiKey: string;
    openaiApiKey: string;
    openaiApiUrl: string;
    openaiApiModel: string;
    openaiTemperature: string;
    openaiStream: boolean;
};

export const DEFAULT_AI_CLIENT_MODEL = 'gpt-4.1-mini';
export const DEFAULT_AI_CLIENT_TEMPERATURE = '0.7';
/** 桌面端默认的 Gemini 模型名（electron/aiTextClient.cjs 的 GEMINI_ENDPOINT）。 */
export const AI_CLIENT_GEMINI_MODEL = 'gemini-2.5-flash';
const AI_CLIENT_SETTINGS_KEY = 'folia.aiClientSettings.v1';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const defaultAiClientSettings = (): AiClientSettings => ({
    provider: 'gemini',
    geminiApiKey: '',
    openaiApiKey: '',
    openaiApiUrl: '',
    openaiApiModel: DEFAULT_AI_CLIENT_MODEL,
    openaiTemperature: DEFAULT_AI_CLIENT_TEMPERATURE,
    openaiStream: false,
});

const sanitize = (raw: unknown): AiClientSettings => {
    const fallback = defaultAiClientSettings();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
    const source = raw as Record<string, unknown>;
    return {
        provider: source.provider === 'openai' ? 'openai' : 'gemini',
        geminiApiKey: text(source.geminiApiKey),
        openaiApiKey: text(source.openaiApiKey),
        openaiApiUrl: text(source.openaiApiUrl),
        openaiApiModel: text(source.openaiApiModel) || fallback.openaiApiModel,
        openaiTemperature: text(source.openaiTemperature) || fallback.openaiTemperature,
        openaiStream: source.openaiStream === true,
    };
};

const loadAiClientSettings = (): AiClientSettings => sanitize(getStoredJson<unknown>(AI_CLIENT_SETTINGS_KEY, null));

const persist = (settings: AiClientSettings): void => setStoredJson(AI_CLIENT_SETTINGS_KEY, settings);

type AiClientSettingsState = {
    settings: AiClientSettings;
    update: (patch: Partial<AiClientSettings>) => AiClientSettings;
    clearApiKey: (provider: AiClientProvider) => AiClientSettings;
};

export const useAiClientSettingsStore = create<AiClientSettingsState>((set, get) => ({
    settings: loadAiClientSettings(),
    update: (patch) => {
        const next = sanitize({ ...get().settings, ...patch });
        persist(next);
        set({ settings: next });
        return next;
    },
    clearApiKey: (provider) => {
        const next = sanitize({ ...get().settings, [provider === 'openai' ? 'openaiApiKey' : 'geminiApiKey']: '' });
        persist(next);
        set({ settings: next });
        return next;
    },
}));

/** 直连服务商只在安卓壳里启用（浏览器版走部署的 /api 路由）。 */
export const isDirectAiTextRuntime = (): boolean => canUseDirectAiText();

/** 当前配置的服务商是否有密钥；设置页用它决定「AI 推断」能不能选。 */
export const aiClientApiKeyStatus = (settings: AiClientSettings = useAiClientSettingsStore.getState().settings): 'configured' | 'missing' => {
    const key = settings.provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey;
    return key.trim() ? 'configured' : 'missing';
};

export const aiClientApiKeyOf = (settings: AiClientSettings, provider: AiClientProvider = settings.provider): string => (
    provider === 'openai' ? settings.openaiApiKey : settings.geminiApiKey
);

export const AI_CLIENT_SETTINGS_STORAGE_KEY = AI_CLIENT_SETTINGS_KEY;
