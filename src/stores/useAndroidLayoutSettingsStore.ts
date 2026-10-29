import { create } from 'zustand';
import { IS_ANDROID_WEBVIEW } from '../utils/platform';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';
import {
    applyAndroidPhoneFit,
    readStoredAndroidPhoneFitOrientation,
    readStoredAndroidPhoneFit,
    syncAndroidPhoneFitNative,
    writeStoredAndroidPhoneFitOrientation,
    writeStoredAndroidPhoneFit,
    type AndroidPhoneFitOrientation,
} from '../services/androidPhoneLayout';
import {
    applyKeepScreenOn,
    readStoredKeepScreenOn,
    writeStoredKeepScreenOn,
} from '../services/androidKeepScreenOn';

type AndroidLayoutSettingsState = {
    phoneFitEnabled: boolean;
    phoneFitOrientation: AndroidPhoneFitOrientation;
    keepScreenOnEnabled: boolean;
    /** #轻量模式：关重特效（tempera 后处理/折射类）省电。Android 默认开，桌面默认关。 */
    liteModeEnabled: boolean;
    setPhoneFitEnabled: (enabled: boolean) => void;
    setPhoneFitOrientation: (orientation: AndroidPhoneFitOrientation) => void;
    setKeepScreenOnEnabled: (enabled: boolean) => void;
    setLiteModeEnabled: (enabled: boolean) => void;
};


const LITE_MODE_STORAGE_KEY = 'android_lite_mode';

export const useAndroidLayoutSettingsStore = create<AndroidLayoutSettingsState>((set, get) => ({
    phoneFitEnabled: readStoredAndroidPhoneFit(),
    phoneFitOrientation: readStoredAndroidPhoneFitOrientation(),
    keepScreenOnEnabled: readStoredKeepScreenOn(),
    // 只有无存储记录时才按平台给默认：用户显式关掉后不再被拉回。
    liteModeEnabled: getStoredBoolean(LITE_MODE_STORAGE_KEY, IS_ANDROID_WEBVIEW),
    setLiteModeEnabled: (enabled) => {
        setStoredBoolean(LITE_MODE_STORAGE_KEY, enabled);
        set({ liteModeEnabled: enabled });
    },
    setPhoneFitEnabled: (enabled) => {
        writeStoredAndroidPhoneFit(enabled);
        applyAndroidPhoneFit(enabled, get().phoneFitOrientation);
        syncAndroidPhoneFitNative(enabled, get().phoneFitOrientation);
        set({ phoneFitEnabled: enabled });
    },
    setPhoneFitOrientation: (orientation) => {
        writeStoredAndroidPhoneFitOrientation(orientation);
        applyAndroidPhoneFit(get().phoneFitEnabled, orientation);
        syncAndroidPhoneFitNative(get().phoneFitEnabled, orientation);
        set({ phoneFitOrientation: orientation });
    },

    setKeepScreenOnEnabled: (enabled) => {
        writeStoredKeepScreenOn(enabled);
        applyKeepScreenOn(enabled);
        set({ keepScreenOnEnabled: enabled });
    },
}));
