export const ANDROID_PHONE_FIT_STORAGE_KEY = 'folia_android_phone_fit';
export const ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY = 'folia_android_phone_fit_orientation';

export type AndroidPhoneFitOrientation = 'portrait' | 'landscape';

/** 无存储记录时默认开 phone-fit 的最大视口短边：对齐 sheetPresentation 的 SHEET_BOTTOM_MAX_WIDTH（平板/横屏大屏不算手机）。 */
export const ANDROID_PHONE_DEFAULT_MAX_MIN_SIDE = 720;

export const readStoredAndroidPhoneFit = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return localStorage.getItem(ANDROID_PHONE_FIT_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

/**
 * 三态读取：null = 从未动过这个开关（默认值该按平台/几何定），true/false = 用户显式选择（永久尊重）。
 * 与 liteModeEnabled 的 getStoredBoolean(key, platformDefault) 同一规矩：显式关后不再被拉回。
 */
export const readStoredAndroidPhoneFitRaw = (): boolean | null => {
    if (typeof window === 'undefined') return null;
    try {
        const saved = localStorage.getItem(ANDROID_PHONE_FIT_STORAGE_KEY);
        return saved === null ? null : saved === 'true';
    } catch {
        return null;
    }
};

export const writeStoredAndroidPhoneFit = (enabled: boolean): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(ANDROID_PHONE_FIT_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // A storage failure must not make the switch unusable for the current session.
    }
};

export const readStoredAndroidPhoneFitOrientation = (): AndroidPhoneFitOrientation => {
    if (typeof window === 'undefined') return 'portrait';
    try {
        return localStorage.getItem(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY) === 'landscape'
            ? 'landscape'
            : 'portrait';
    } catch {
        return 'portrait';
    }
};

export const writeStoredAndroidPhoneFitOrientation = (orientation: AndroidPhoneFitOrientation): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY, orientation);
    } catch {
        // A storage failure must not make the switch unusable for the current session.
    }
};

/**
 * 触屏手机几何事实：主指针 coarse + 视口短边 < 720（竖屏手机/折叠机内屏；平板与桌面不在此列）。
 * 与 sheetPresentation 的 coarse+portrait+<720 分类对齐——那套管弹窗呈现，这套管紧凑布局默认值，阈值必须一致。
 */
export const shouldDefaultAndroidPhoneFit = ({ coarse, minSide }: { coarse: boolean; minSide: number }): boolean => (
    coarse && minSide < ANDROID_PHONE_DEFAULT_MAX_MIN_SIDE
);

/** 当前视口的几何事实；非浏览器环境返回 null（不默认开）。 */
export const detectPhoneFitFacts = (): { coarse: boolean; minSide: number } | null => {
    if (typeof window === 'undefined') return null;
    try {
        const coarse = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
        const width = Number(window.innerWidth) || 0;
        const height = Number(window.innerHeight) || 0;
        if (width <= 0 || height <= 0) return null;
        return { coarse, minSide: Math.min(width, height) };
    } catch {
        return null;
    }
};

/**
 * phone-fit 最终生效值：存储值永远优先；从未动过开关时，只有「Android 壳 + 触屏手机几何」才默认开。
 * isAndroidShell 由调用侧给（store 已有 IS_ANDROID_WEBVIEW，避免本模块新增导入边）。
 */
export const resolveAndroidPhoneFitEnabled = (
    isAndroidShell: boolean,
    facts: { coarse: boolean; minSide: number } | null,
): boolean => {
    const stored = readStoredAndroidPhoneFitRaw();
    if (stored !== null) return stored;
    return Boolean(isAndroidShell && facts && shouldDefaultAndroidPhoneFit(facts));
};

/** 是否跑在 Android 壳里（Capacitor 平台名）；非浏览器/桌面 WebView 返回 false。 */
const detectAndroidShell = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android';
    } catch {
        return false;
    }
};

/**
 * Applies the Android-only compact layout at the document root.
 *
 * Keeping this as one attribute means every override lives in one stylesheet and upstream
 * components keep their own markup and breakpoints.
 */
export const applyAndroidPhoneFit = (
    enabled: boolean,
    orientation: AndroidPhoneFitOrientation = readStoredAndroidPhoneFitOrientation(),
): void => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-folia-phone-fit', enabled ? 'true' : 'false');
    root.setAttribute('data-folia-phone-orientation', orientation);
};

/**
 * 启动接线：解析最终生效值（存储优先，未动过的触屏手机默认开）→ 挂根属性；
 * 生效时把同一值同步给原生（锁转向/挖孔联动与 web 一致——修掉「web 开了 native 不知道」的存量缺口）。
 * 返回最终生效值，供启动诊断/埋点复用。
 */
export const installAndroidPhoneFitPreference = (): boolean => {
    const enabled = resolveAndroidPhoneFitEnabled(detectAndroidShell(), detectPhoneFitFacts());
    const orientation = readStoredAndroidPhoneFitOrientation();
    applyAndroidPhoneFit(enabled, orientation);
    if (enabled) syncAndroidPhoneFitNative(enabled, orientation);
    return enabled;
};

/**
 * Synchronizes the JS setting with the Android orientation lock. Web and plugin-less runtimes
 * simply keep using the CSS attribute above.
 * 注：syncAndroidPhoneFitNative 的声明在下方（函数提升不可用于 const 箭头函数，install 在其之后使用运行时才调用，无问题）。
 */
export const syncAndroidPhoneFitNative = (
    enabled: boolean,
    orientation: AndroidPhoneFitOrientation,
): void => {
    if (typeof window === 'undefined') return;
    const plugin = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: {
                FoliaNative?: {
                    setPhoneFitLayout?: (options: {
                        enabled: boolean;
                        orientation: AndroidPhoneFitOrientation;
                    }) => Promise<unknown>;
                };
            };
        };
    }).Capacitor?.Plugins?.FoliaNative;
    if (typeof plugin?.setPhoneFitLayout !== 'function') return;
    void plugin.setPhoneFitLayout({ enabled, orientation }).catch(() => undefined);
};
