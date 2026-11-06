import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ANDROID_PHONE_FIT_STORAGE_KEY,
    ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY,
    ANDROID_PHONE_DEFAULT_MAX_MIN_SIDE,
    applyAndroidPhoneFit,
    detectPhoneFitFacts,
    installAndroidPhoneFitPreference,
    isAndroidTabletUserAgent,
    readStoredAndroidPhoneFitOrientation,
    readStoredAndroidPhoneFit,
    readStoredAndroidPhoneFitRaw,
    resolveAndroidPhoneFitEnabled,
    shouldDefaultAndroidPhoneFit,
    writeStoredAndroidPhoneFitOrientation,
    writeStoredAndroidPhoneFit,
} from '@/services/androidPhoneLayout';

/** Chrome/WebView 的安卓 UA：手机带 Mobile token，平板不带（设备级事实，与 dpr 无关）。 */
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

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
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 412, tabletUa: false })).toBe(true);
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 719, tabletUa: false })).toBe(true);
        // 边界：最小边到 720 即平板/桌面，不默认开。
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 720, tabletUa: false })).toBe(false);
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 1024, tabletUa: false })).toBe(false);
        // 有鼠标/触控板（桌面浏览器、Electron）不默认开。
        expect(shouldDefaultAndroidPhoneFit({ coarse: false, minSide: 412, tabletUa: false })).toBe(false);
        expect(ANDROID_PHONE_DEFAULT_MAX_MIN_SIDE).toBe(720);
    });

    it('isAndroidTabletUserAgent follows the Android UA Mobile-token convention', () => {
        expect(isAndroidTabletUserAgent(TABLET_UA)).toBe(true);
        // Fire OS 平板同样不带 Mobile。
        expect(isAndroidTabletUserAgent('Mozilla/5.0 (Linux; Android 9; KFMAWI) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36')).toBe(true);
        expect(isAndroidTabletUserAgent(PHONE_UA)).toBe(false);
        expect(isAndroidTabletUserAgent(DESKTOP_UA)).toBe(false);
        expect(isAndroidTabletUserAgent('')).toBe(false);
    });

    it('tablet devices never default phone-fit on even with a sub-720 CSS viewport', () => {
        // 回归防线（.305 实机反馈）：dpr 1.75 的真平板竖屏 CSS 宽只有 ~686，几何阈值会把平板当手机；
        // UA 不带 Mobile token 是设备级事实，平板一律不默认开——否则原生启动锁 SENSOR_PORTRAIT，平板转不了屏。
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 686, tabletUa: true })).toBe(false);
        expect(resolveAndroidPhoneFitEnabled(true, { coarse: true, minSide: 686, tabletUa: true })).toBe(false);
        // 手机 UA + 小视口：默认开照旧。
        expect(shouldDefaultAndroidPhoneFit({ coarse: true, minSide: 686, tabletUa: false })).toBe(true);
    });

    it('resolveAndroidPhoneFitEnabled: stored value always wins, default only for small coarse Android shells', () => {
        stubStorage();
        const phoneFacts = { coarse: true, minSide: 412, tabletUa: false };
        const tabletFacts = { coarse: true, minSide: 800, tabletUa: false };

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

    it('detectPhoneFitFacts reads coarse pointer, the smaller viewport side and the tablet UA flag', () => {
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
            innerWidth: 915,
            innerHeight: 412,
            navigator: { userAgent: PHONE_UA },
        });
        expect(detectPhoneFitFacts()).toEqual({ coarse: true, minSide: 412, tabletUa: false });

        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
            innerWidth: 1280,
            innerHeight: 800,
            navigator: { userAgent: TABLET_UA },
        });
        expect(detectPhoneFitFacts()).toEqual({ coarse: false, minSide: 800, tabletUa: true });

        // 无 navigator（老 stub/异常环境）按非平板处理，不炸。
        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
            innerWidth: 1280,
            innerHeight: 800,
        });
        expect(detectPhoneFitFacts()).toEqual({ coarse: false, minSide: 800, tabletUa: false });
    });

    it('install applies the resolved default and syncs the native side in both directions', () => {
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
            navigator: { userAgent: PHONE_UA },
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

        // 显式关后：属性关、原生也拿到关值——MainActivity 每次启动按原生偏好 apply，
        // 不同步关会把一次误判留下的锁永久残留在原生偏好里（平板竖屏锁死）。
        storage.set(ANDROID_PHONE_FIT_STORAGE_KEY, 'false');
        plugin.setPhoneFitLayout.mockClear();
        expect(installAndroidPhoneFitPreference()).toBe(false);
        expect(plugin.setPhoneFitLayout).toHaveBeenCalledWith({ enabled: false, orientation: 'portrait' });
    });

    it('install heals a stale native lock: tablet UA with sub-720 viewport resolves off and syncs false', () => {
        stubStorage();
        const setAttribute = vi.fn();
        vi.stubGlobal('document', { documentElement: { setAttribute } });
        vi.stubGlobal('window', {
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
            },
            matchMedia: () => ({ matches: true }),
            innerWidth: 686,
            innerHeight: 1256,
            navigator: { userAgent: TABLET_UA },
            Capacitor: {
                getPlatform: () => 'android',
                Plugins: {
                    FoliaNative: {
                        setPhoneFitLayout: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
        });

        // .305 升级路径复现：几何阈值误判（686<720）+ UA 平板事实 → 最终关，
        // 且原生拿到关值（覆盖升级前一次误判同步开的残留偏好）。
        expect(installAndroidPhoneFitPreference()).toBe(false);
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-fit', 'false');
        const plugin = (window as unknown as {
            Capacitor: { Plugins: { FoliaNative: { setPhoneFitLayout: ReturnType<typeof vi.fn> } } };
        }).Capacitor.Plugins.FoliaNative;
        expect(plugin.setPhoneFitLayout).toHaveBeenCalledWith({ enabled: false, orientation: 'portrait' });
        // 默认路径不写存储：保持「从未动过」语义，用户日后仍可享手机默认开。
        expect(storage.has(ANDROID_PHONE_FIT_STORAGE_KEY)).toBe(false);
    });
});
