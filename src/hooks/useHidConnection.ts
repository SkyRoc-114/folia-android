// src/hooks/useHidConnection.ts
// 键鼠接入判定（docs/plans/2026-10-31-…-design.md §3.1）。
//
// 三个环境的优先级：
// 1. 桌面（Electron / 非安卓壳）：恒接入 —— 桌面必有键鼠，「快捷键显示」的 auto 档在那里
//    行为与「一直显示」一致，零回归。
// 2. 安卓壳（Capacitor）：FoliaNative 插件查询 getConnectedHidDevices() 再订
//    onHidDevicesChanged 事件（InputDeviceListener 在原生层，接入/拔出即时回调）。先查后订，
//    防丢订阅前的那次接入。
// 3. 兜底（安卓壳里插件缺失，如老包升级期）：matchMedia 细指针当鼠标信号；纯键盘接入在
//    Web 层没有媒体查询可感知，接受「按一下才识别」之外的空档（用户拍板：原生监听为主）。
//
// 纯件（hidDevicesFromPayload / hidPluginOf / fallbackMouseConnected）node 直测；React 接线很薄。

import { useEffect, useMemo, useState } from 'react';
import { IS_ANDROID_WEBVIEW } from '../utils/platform';
import { FINE_POINTER_QUERY } from './useSupportsFinePointer';

export type HidDevices = { keyboard: boolean; mouse: boolean };
export type HidConnectionState = HidDevices & { hidConnected: boolean };

/** 桌面恒接入（键盘+鼠标都算在）。 */
const DESKTOP_CONNECTED: HidDevices = { keyboard: true, mouse: true };

type HidPlugin = {
    getConnectedHidDevices?: () => Promise<unknown>;
    addListener?: (
        eventName: string,
        listener: (payload: unknown) => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
};

/** FoliaNative 插件（有 Capacitor 才有）；拿不到就 null，调用方走兜底。 */
export const hidPluginOf = (): HidPlugin | null => (
    typeof window === 'undefined'
        ? null
        : ((window as unknown as { Capacitor?: { Plugins?: { FoliaNative?: HidPlugin } } })
            ?.Capacitor?.Plugins?.FoliaNative ?? null)
);

/** 插件负载 → 设备布尔：只认真布尔，垃圾负载安全落空。 */
export const hidDevicesFromPayload = (payload: unknown): HidDevices => {
    const source = (payload && typeof payload === 'object' ? payload : {}) as { keyboard?: unknown; mouse?: unknown };
    return { keyboard: source.keyboard === true, mouse: source.mouse === true };
};

/** 无插件环境的兜底：细指针 ≈ 鼠标接入；键盘信号拿不到。 */
export const fallbackMouseConnected = (): boolean => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(FINE_POINTER_QUERY).matches
        : false
);

export const useHidConnection = (): HidConnectionState => {
    const [devices, setDevices] = useState<HidDevices>(() => (
        IS_ANDROID_WEBVIEW ? { keyboard: false, mouse: fallbackMouseConnected() } : DESKTOP_CONNECTED
    ));

    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        const plugin = hidPluginOf();
        let disposed = false;
        let removeListener: (() => void) | null = null;
        const sync = (payload: unknown) => {
            if (!disposed) setDevices(hidDevicesFromPayload(payload));
        };
        void (async () => {
            // 先查后订：订阅之前发生过的接入不能丢。
            if (plugin?.getConnectedHidDevices) {
                try {
                    sync(await plugin.getConnectedHidDevices());
                } catch {
                    // 查询失败留给事件/兜底。
                }
            }
            if (plugin?.addListener) {
                try {
                    const handle = await plugin.addListener('onHidDevicesChanged', sync);
                    removeListener = () => {
                        void Promise.resolve(handle.remove()).catch(() => undefined);
                    };
                } catch {
                    // 挂不上事件就靠初始查询，拔出感知不到（可接受：老插件）。
                }
            }
        })();
        return () => {
            disposed = true;
            removeListener?.();
        };
    }, []);

    return useMemo(
        () => ({ ...devices, hidConnected: devices.keyboard || devices.mouse }),
        [devices],
    );
};
