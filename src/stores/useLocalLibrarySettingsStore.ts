import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/useLocalLibrarySettingsStore.ts
// Local-library behaviour settings. Currently one: whether the app watches the imported folders and
// rescans them by itself. The watcher runtime lives in services/localLibraryAutoScan.ts and
// subscribes to this store rather than being driven by the settings UI.

const AUTO_SCAN_STORAGE_KEY = 'local_library_auto_scan';
const AUTO_RESCAN_STARTUP_STORAGE_KEY = 'local_library_auto_rescan_startup';

export type LocalLibrarySettingsState = {
    /** Off by default: observation costs OS handles, and an unattended rescan should be opted into. */
    autoScanEnabled: boolean;
    /** #866：启动时做一次整库重扫（Android=设备音乐库扫描；桌面兼作监听漏项的兑底）。默认关。 */
    autoRescanOnStartup: boolean;
    setAutoScanEnabled: (enabled: boolean) => void;
    setAutoRescanOnStartup: (enabled: boolean) => void;
    toggleAutoScan: () => void;
};

export const useLocalLibrarySettingsStore = create<LocalLibrarySettingsState>((set, get) => ({
    autoScanEnabled: getStoredBoolean(AUTO_SCAN_STORAGE_KEY, false),
    autoRescanOnStartup: getStoredBoolean(AUTO_RESCAN_STARTUP_STORAGE_KEY, false),

    setAutoScanEnabled: (enabled) => {
        setStoredBoolean(AUTO_SCAN_STORAGE_KEY, enabled);
        set({ autoScanEnabled: enabled });
    },

    setAutoRescanOnStartup: (enabled) => {
        setStoredBoolean(AUTO_RESCAN_STARTUP_STORAGE_KEY, enabled);
        set({ autoRescanOnStartup: enabled });
    },

    toggleAutoScan: () => get().setAutoScanEnabled(!get().autoScanEnabled),
}));
