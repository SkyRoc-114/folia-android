// src/utils/networkStatus.ts
// 网络连通性的粗判定（叶子层）：WebView 按 Android ConnectivityManager 维护 navigator.onLine，
// 桌面浏览器在断网时同样翻 false。onLine === true 不代表端到端可达（网关故障、DNS 劫持仍会让请求
// 失败），但 onLine === false 时请求必然失败——这时与其让 WebView 抛一层含混的 "Failed to fetch"
// 再被笼统显示成"搜索失败"，不如提前拦截并给出明确的离线态。搜索 store、工作区显示层共用这一份。

import { useEffect, useSyncExternalStore } from 'react';

export type NetworkStatusListener = (offline: boolean) => void;

/** 断网判定：只在 onLine 明确为 false 时算离线，其余环境（无 navigator、SSR、旧 WebView）都按在线处理，避免误拦。 */
export const isNetworkOffline = (): boolean => (
    typeof navigator !== 'undefined' && navigator.onLine === false
);

/** 订阅 online/offline 事件；返回退订函数。返回的 listener 带当前离线态参数，useSyncExternalStore 会传无参回调，忽略即可。 */
export const subscribeNetworkStatus = (listener: NetworkStatusListener): (() => void) => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return () => {};
    }
    const handleOnline = () => listener(false);
    const handleOffline = () => listener(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
    };
};

/** React 侧的离线态：事件驱动，online/offline 切换时重渲染（比如断网时打开搜索工作区、回网后文案自动回落）。 */
export const useNetworkOffline = (): boolean => useSyncExternalStore(
    subscribeNetworkStatus,
    isNetworkOffline,
    () => false,
);
