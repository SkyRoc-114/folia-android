import { useEffect } from 'react';
import { resyncAllFolders } from '../services/localMusicService';
import { useLocalLibrarySettingsStore } from '../stores/useLocalLibrarySettingsStore';

// src/hooks/useLocalLibraryStartupRescan.ts
// #866：开关开启时，启动后做一次整库重扫。Android 上 resyncAllFolders 就是设备音乐库
// （MediaStore）重扫 —— 那边没有可持久化的目录句柄，FileSystemObserver 监听不可用；
// 桌面上监听（localLibraryAutoScan）是实时的，这一扫兼作漏项兑底。默认关：启动即扫
// 会跟首帧渲染抢 IO，用户得自己选。

/** 等库界面挂稳、首帧走完再扫。 */
const STARTUP_RESCAN_DELAY_MS = 4000;

/** Call once, from the app root. */
export const useLocalLibraryStartupRescan = (): void => {
    useEffect(() => {
        if (!useLocalLibrarySettingsStore.getState().autoRescanOnStartup) return;
        const timer = setTimeout(() => {
            void resyncAllFolders().catch(error => {
                console.warn('[LocalLibrary] Startup rescan failed:', error);
            });
        }, STARTUP_RESCAN_DELAY_MS);
        return () => clearTimeout(timer);
    }, []);
};
