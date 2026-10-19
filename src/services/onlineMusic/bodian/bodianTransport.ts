import { OnlineProviderError } from '../../../types/onlineMusic';
import { isFoliaExtensionBridgeConfigured, requestFoliaExtension } from '../../foliaExtensionBridge';
import { IS_ANDROID_WEBVIEW } from '../../../utils/platform';
import type { BodianOperation, BodianParams, BodianResult } from 'bodian-music-api';

// src/services/onlineMusic/bodian/bodianTransport.ts

export type { BodianOperation, BodianParams } from 'bodian-music-api';
export type BodianBridgeResult = BodianResult;

// What a request fails with where this page has no desktop bridge (the web build), and where the bridge
// itself failed (the main process threw). bodianFailure.ts tells both apart by them.
export const BODIAN_NEEDS_DESKTOP = 'Bodian requires the desktop app';
export const BODIAN_BRIDGE_FAILED = 'Bodian desktop request failed';
export const BODIAN_ANDROID_FAILED = 'Bodian Android bridge request failed';

// 桌面走 Electron 主进程桥；安卓没有 Electron，走内置原生桥（nativeBridge/api/bodian.js）。
// 以前这里只认 electron，安卓上波点会被判成「运行时不可用」，整个平台在界面上就消失了。
export const getBodianTransportAvailability = () => (
    typeof window !== 'undefined'
    && (typeof window.electron?.bodianRequest === 'function' || IS_ANDROID_WEBVIEW)
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

export async function requestBodian<T = unknown>(operation: BodianOperation, params: BodianParams = {}): Promise<T> {
    if (!getBodianTransportAvailability().configured) {
        throw new OnlineProviderError('unavailable', BODIAN_NEEDS_DESKTOP, 'bodian');
    }
    // Omni consumers request 150/1000-row batches; Bodian serves at most 100 and returns its own cursor.
    const boundedParams = Number.isSafeInteger(params.limit) && Number(params.limit) > 100
        ? { ...params, limit: 100 } : params;

    let result: BodianBridgeResult;
    if (typeof window.electron?.bodianRequest === 'function') {
        try { result = await window.electron.bodianRequest(operation, boundedParams); }
        catch (error) { throw new OnlineProviderError('network', BODIAN_BRIDGE_FAILED, 'bodian', error); }
    } else {
        // Android：内置原生桥（nativeBridge/api/bodian.js 按同样的协议回答）。
        if (!isFoliaExtensionBridgeConfigured('extension')) {
            throw new OnlineProviderError('unavailable', BODIAN_NEEDS_DESKTOP, 'bodian');
        }
        try {
            result = await requestFoliaExtension<BodianBridgeResult>({
                provider: 'bodian',
                operation,
                params: boundedParams,
            });
        } catch {
            throw new OnlineProviderError('network', BODIAN_ANDROID_FAILED, 'bodian');
        }
    }
    // 包的 code/message 归一成 OmniError：auth-required 原样保留，其余按模板细分。
    // 桥只透出 code/与一句说明：code 与包的 BodianErrorCode 同名，直接当 ProviderErrorCode 用。
    if (!result.ok) throw new OnlineProviderError(result.error.code as OnlineProviderError['code'], result.error.message, 'bodian');
    return result.data as T;
}
