import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ANDROID_PHONE_FIT_STORAGE_KEY,
    ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY,
    ANDROID_PHONE_DEFAULT_MAX_MIN_SIDE,
    applyAndroidPhoneFit,
    detectPhoneFitFacts,
    installAndroidPhoneFitPreference,
    readStoredAndroidPhoneFitOrientation,
    readStoredAndroidPhoneFit,
    readStoredAndroidPhoneFitRaw,
    resolveAndroidPhoneFitEnabled,
    shouldDefaultAndroidPhoneFit,
    writeStoredAndroidPhoneFitOrientation,
    writeStoredAndroidPhoneFit,
} from '@/services/androidPhoneLayout';

const storage = new Map<string, string>();

afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
});

describe('android phone layout preference', () => {
    it('persists the switch using the dedicated key', () => {
        const localStorageStub = {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        };
        vi.stubGlobal('window', { localStorage: localStorageStub });
        vi.stubGlobal('localStorage', localStorageStub);

        writeStoredAndroidPhoneFit(true);
        expect(storage.get(ANDROID_PHONE_FIT_STORAGE_KEY)).toBe('true');
        expect(readStoredAndroidPhoneFit()).toBe(true);

        writeStoredAndroidPhoneFit(false);
        expect(readStoredAndroidPhoneFit()).toBe(false);

        writeStoredAndroidPhoneFitOrientation('landscape');
        expect(storage.get(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY)).toBe('landscape');
        expect(readStoredAndroidPhoneFitOrientation()).toBe('landscape');
    });

    it('gates CSS through the document root attribute', () => {
        const setAttribute = vi.fn();
        vi.stubGlobal('document', { documentElement: { setAttribute } });

        applyAndroidPhoneFit(true, 'landscape');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-fit', 'true');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-orientation', 'landscape');

        applyAndroidPhoneFit(false, 'portrait');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-fit', 'false');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-orientation', 'portrait');
    });
});

describe('phone-fit default for untouched installs (P1)', () => {
    const stubStorage = () => {
        const localStorageStub = {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        };
        vi.stubGlobal('window', { localStorage: localStorageStub });
        vi.stubGlobal('localStorage', localStorageStub);
    };

    it('readStoredAndroidPhoneFitRaw distinguishes "no record" from "explicit off"', () => {
        stubStorage();
        expect(readStoredAndroidPhoneFitRaw()).toBeNull();
        // 旧读取器语义保持：无记录按关处理。
        expect(readStoredAndroidPhoneFit()).toBe(false);
        writeStoredAndroidPhoneFit(false);
        expect(readStoredAndroidPhoneFitRaw()).toBe(false);
        expect(readStoredAndroidPhoneFit()).toBe(false);
        writeStoredAndroidPhoneFit(true);
        expect(readStoredAndroidPhoneFitRaw()).toBe(true);
        expect(readStoredAndroidPhoneFit()).toBe(true);
    });

    it('shouldDefaultAndroidPhoneFit matches the sheet presentation thresholds', () => {
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 412 })).toBe(true);
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 719 })).toBe(true);
        // 边界：最小边到 720 即平板/桌面，不默认开。
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 720 })).toBe(false);
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 1024 })).toBe(false);
        // 有鼠标/触控板（桌面浏览器、Electron）不默认开。
        expect(shouldDefaultAndroidPhoneFit({ coarse: false, minSide: 412 })).toBe(false);
        expect(ANDROID_PHONE_DEFAULT_MAX_MIN_SIDE).toBe(720);
    });

    it('resolveAndroidPhoneFitEnabled: stored value always wins, default only for small coarse Android shells', () => {
        stubStorage();
        const phoneFacts = { coarse: true, minSide: 412 };
        const tabletFacts = { coarse: true, minSide: 800 };

        // 无记录：Android 手机默认开。
        expect(resolveAndroidPhoneFitEnabled(true, phoneFacts)).toBe(true);
        // 显式关：不再拉回（与 liteModeEnabled 同规矩）。
        writeStoredAndroidPhoneFit(false);
        expect(resolveAndroidPhoneFitEnabled(true, phoneFacts)).toBe(false);
        // 显式开：任何几何都开。
        writeStoredAndroidPhoneFit(true);
        expect(resolveAndroidPhoneFitEnabled(true, tabletFacts)).toBe(true);
        // 平板（最小边 ≥720）与桌面壳不默认开。
        storage.delete(ANDROID_PHONE_FIT_STORAGE_KEY);
        expect(resolveAndroidPhoneFitEnabled(true, tabletFacts)).toBe(false);
        expect(resolveAndroidPhoneFitEnabled(false, phoneFacts)).toBe(false);
        // 几何探测失败（node/异常环境）时不默认开。
        expect(resolveAndroidPhoneFitEnabled(true, null)).toBe(false);
    });

    it('detectPhoneFitFacts reads coarse pointer and the smaller viewport side', () => {
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
            innerWidth: 915,
            innerHeight: 412,
        });
        expect(detectPhoneFitFacts()).toEqual({ coarse: true, minSide: 412 });

        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
            innerWidth: 1280,
            innerHeight: 800,
        });
        expect(detectPhoneFitFacts()).toEqual({ coarse: false, minSide: 800 });
    });

    it('install applies the resolved default and syncs the native side only when enabled', () => {
        stubStorage();
        vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn() } });
        vi.stubGlobal('window', {
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
            },
            matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
            innerWidth: 412,
            innerHeight: 915,
            Capacitor: {
                getPlatform: () => 'android',
                Plugins: {
                    FoliaNative: {
                        setPhoneFitLayout: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
        });

        // 无记录 + Android 手机几何 → 默认开，且原生侧拿到同值（修「web 开了 native 不知道」）。
        expect(installAndroidPhoneFitPreference()).toBe(true);
        expect(storage.has(ANDROID_PHONE_FIT_STORAGE_KEY)).toBe(false);
        const plugin = (window as unknown as {
            Capacitor: { Plugins: { FoliaNative: { setPhoneFitLayout: ReturnType<typeof vi.fn> } } };
        }).Capacitor.Plugins.FoliaNative;
        expect(plugin.setPhoneFitLayout).toHaveBeenCalledWith({ enabled: true, orientation: 'portrait' });

        // 显式关后：属性关、原生同步不触发。
        storage.set(ANDROID_PHONE_FIT_STORAGE_KEY, 'false');
        plugin.setPhoneFitLayout.mockClear();
        expect(installAndroidPhoneFitPreference()).toBe(false);
        expect(plugin.setPhoneFitLayout).not.toHaveBeenCalled();
    });
});
