import { create } from 'zustand';
import type { HifiDevice, HifiEngineState, HifiErrorEvent, HifiInstallProgress, HifiRuntimeStatus } from '../../types/hifi';

// src/services/hifi/hifiEngineStore.ts
// 渲染端看到的 HiFi 主进程：支不支持、mpv 运行时、引擎状态、安装进度、设备、最近的错误和熔断。只有 hifiEngine 写它。

export type HifiEngineStoreState = {
    /** preload 暴露了 window.electron.hifi，即桌面版。 */
    supported: boolean;
    /** 最近一次问到的 mpv 检测结果；还没问过时为 null。 */
    runtime: HifiRuntimeStatus | null;
    /** 主进程最新的引擎状态，乱序到达的旧 seq 已丢掉。 */
    engine: HifiEngineState | null;
    installProgress: HifiInstallProgress | null;
    /** 最近一次成功列出的输出设备。 */
    devices: HifiDevice[];
    /** 主进程推来的错误，或起播失败的错误码。 */
    lastError: HifiErrorEvent | null;
    /** mpv 短时间内反复崩溃、主进程熔断后为 true，本次会话不再回到 false：之后的歌都走 Web 引擎。 */
    circuitOpen: boolean;
};

export const createHifiEngineStore = () => create<HifiEngineStoreState>(() => ({
    supported: false,
    runtime: null,
    engine: null,
    installProgress: null,
    devices: [],
    lastError: null,
    circuitOpen: false,
}));

export type HifiEngineStore = ReturnType<typeof createHifiEngineStore>;

export const useHifiEngineStore = createHifiEngineStore();
