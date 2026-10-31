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
// 设备状态落在 useHidDevicesStore（zustand）而不是本 hook 的 state：教程分镜选择
// （ponderOnboardingShared）在非 React 层也要读到同一份事实。本 hook 只是 store 的
// 订阅面 + 采集器。纯件（hidPluginOf / fallbackMouseConnected）node 直测。

import { useEffect } from 'react';
import { IS_ANDROID_WEBVIEW } from '../utils/platform';
import { applyHidPayload, useHidDevicesStore } from '../stores/useHidDevicesStore';
import { FINE_POINTER_QUERY } from './useSupportsFinePointer';

export type { HidDevicesState } from '../stores/useHidDevicesStore';

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

/** 无插件环境的兜底：细指针 ≈ 鼠标接入；键盘信号拿不到。 */
export const fallbackMouseConnected = (): boolean => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(FINE_POINTER_QUERY).matches
        : false
);

// 桌面在模块求值时就写「两件都在」：store 默认是全拔出，等 effect 再写会让桌面首帧
// 键位徽章闪一次「隐藏→出现」。安卓壳的采集仍留给 hook（matchMedia/插件在挂载后跑）。
if (!IS_ANDROID_WEBVIEW) {
    applyHidPayload({ keyboard: true, mouse: true });
}

export const useHidConnection = () => {
    const devices = useHidDevicesStore();

    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        // 触屏起步：先按兜底摆鼠标信号，插件查询/事件来了再覆盖。
        applyHidPayload({ keyboard: false, mouse: fallbackMouseConnected() });
        const plugin = hidPluginOf();
        let disposed = false;
        let removeListener: (() => void) | null = null;
        const sync = (payload: unknown) => {
            if (!disposed) applyHidPayload(payload);
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

    return devices;
};
