import { create } from 'zustand';

// src/stores/useHidDevicesStore.ts
// 物理键盘 / 鼠标的接入状态（docs/plans/2026-10-31-…-design.md §3.1）。
//
// 唯一的写入口是 applyHidPayload：useHidConnection 在安卓壳里把插件的查询与
// onHidDevicesChanged 事件灌进来，桌面端在启动时写入「两件都在」。
// 之所以独立成 store 而不是留在 hook 的 useState：教程分镜选择
// （ponderOnboardingShared）在注册表/非 React 层也要读到同一份事实。
//
// 不落存储（ephemeral，每次启动由原生重新上报），所以没有 XXX_KEY，不进 storeContract 快照。

export type HidDevicesState = {
    keyboard: boolean;
    mouse: boolean;
    /** 任一接入即 true。 */
    hidConnected: boolean;
};

const derive = (keyboard: boolean, mouse: boolean): HidDevicesState => ({
    keyboard,
    mouse,
    hidConnected: keyboard || mouse,
});

export const useHidDevicesStore = create<HidDevicesState>(() => derive(false, false));

/** 插件负载 / 桌面常量统一从这里进 store：只认真布尔，垃圾负载当全部拔出。 */
export const applyHidPayload = (payload: unknown): void => {
    const source = (payload && typeof payload === 'object' ? payload : {}) as { keyboard?: unknown; mouse?: unknown };
    useHidDevicesStore.setState(derive(source.keyboard === true, source.mouse === true));
};
