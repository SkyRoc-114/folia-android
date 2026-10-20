import { create } from 'zustand';
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
    setPhoneFitEnabled: (enabled: boolean) => void;
    setPhoneFitOrientation: (orientation: AndroidPhoneFitOrientation) => void;
    setKeepScreenOnEnabled: (enabled: boolean) => void;
};


export const useAndroidLayoutSettingsStore = create<AndroidLayoutSettingsState>((set, get) => ({
    phoneFitEnabled: readStoredAndroidPhoneFit(),
    phoneFitOrientation: readStoredAndroidPhoneFitOrientation(),
    keepScreenOnEnabled: readStoredKeepScreenOn(),
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
