// src/services/nativeAudioServerPort.ts
// 本机音频服务（LocalAudioServer）端口的唯一来源：本地曲库、文件挑选和媒体缓存都从这里取。
//
// 端口每次启动都可能变（见 nativeLocalMusic.ts 顶部），所以谁都不把 URL 存死，只存 ref/key，
// 播放时按当前端口重新拼地址。单独成文件是因为它必须是依赖图的叶子：nativeMediaCache 要被
// db 引用，而 db 又被 nativeLocalMusic 引用，取端口的这段不能顺手把整条链拉进来。

export type FoliaNativeAudioServerPlugin = {
    /** 原生 LocalAudioServer 实际监听的端口；还没起来时返回 0 / 缺失。 */
    localAudioServerPort?: () => Promise<{ port?: number }>;
};

/**
 * Capacitor 在安卓 WebView 里按原生上报的 pluginHeaders 挂出来的插件代理。
 * 拿不到（网页 / Electron / 旧包）就是 null。
 */
export const getFoliaNativePlugin = <T extends object = FoliaNativeAudioServerPlugin>(): T | null => (
    typeof window === 'undefined'
        ? null
        : ((window as unknown as { Capacitor?: { Plugins?: { FoliaNative?: T } } }).Capacitor?.Plugins?.FoliaNative ?? null)
);

let resolvedAudioServerPort = 0;

/** 取（并缓存）本机音频服务的端口。拿不到返回 0，调用方据此判定「原生不可用」。 */
export const resolveNativeAudioServerPort = async (): Promise<number> => {
    if (resolvedAudioServerPort > 0) return resolvedAudioServerPort;
    const plugin = getFoliaNativePlugin<FoliaNativeAudioServerPlugin>();
    if (!plugin?.localAudioServerPort) return 0;
    try {
        const response = await plugin.localAudioServerPort();
        const port = Number(response?.port) || 0;
        if (port > 0) resolvedAudioServerPort = port;
        return port;
    } catch {
        return 0;
    }
};

/** 挑选接口回包里带着端口，顺手记下来，省掉一次往返。 */
export const noteNativeAudioServerPort = (port: unknown): void => {
    const value = Number(port) || 0;
    if (value > 0) resolvedAudioServerPort = value;
};

/**
 * 忘掉缓存的端口：本机服务换了端口（重启、Activity 重建）后，下一次取端口会重新问原生。
 * 只在请求确实连不上时调；HTTP 层的失败（404 / 500）不代表端口变了。
 */
export const resetNativeAudioServerPort = (): void => {
    resolvedAudioServerPort = 0;
};
