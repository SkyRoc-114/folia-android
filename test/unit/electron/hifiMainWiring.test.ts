import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 钉住 main.cjs 里 HiFi 跟着窗口走的几处：主页面一去不回（窗口关了、页面进程没了又不重载）时停下 mpv，
// 窗口重建时不停（新页面接手）；启动后清一次下载残留。
//
// main.cjs 不能 require（会把整个应用拉起来）。两个窗口事件的处理函数从源码里原样取出来，把它用到的名字
// 当参数传进去执行，测的是产品代码本身的分支；处理函数新用了一个名字时这里会报 ReferenceError，照样补上。

const rootDir = path.resolve(__dirname, '../../../');
const mainCjs = readFileSync(path.join(rootDir, 'electron/main.cjs'), 'utf8');

type Deps = Record<string, unknown>;

// 把一段处理函数的函数体按给定的名字包成可调用的函数。
const compileHandler = (body: string, names: string[], params: string) => (deps: Deps) => {
    for (const name of names) {
        if (!(name in deps)) throw new Error(`test is missing ${name}`);
    }
    const factory = new Function(...names, `return (${params}) => {\n${body}\n};`);
    return factory(...names.map(name => deps[name])) as (...args: unknown[]) => void;
};

const renderGoneBody = mainCjs.match(/win\.webContents\.on\('render-process-gone', \(_event, details\) => \{\n([\s\S]*?)\n {2}\}\);\n/)?.[1] ?? '';
const closedBody = mainCjs.match(/win\.on\('closed', \(\) => \{\n( {4}if \(mainWindow === win\) \{[\s\S]*?\n {4}\}\n) {2}\}\);/)?.[1] ?? '';

const RENDER_GONE_NAMES = [
    'win',
    'mainWindow',
    'noteWindowNotStuck',
    'modSystem',
    'wallpaperWatchdog',
    'shouldReloadMainRenderer',
    'useWindowsWallpaper',
    'process',
    'isMacWallpaperMode',
    'hifiSession',
];

const CLOSED_NAMES = [
    'win',
    'mainWindow',
    'process',
    'modSystem',
    'isMacWallpaperActive',
    'exitMacWallpaperMode',
    'displaySleepBlocker',
    'hifiSession',
    'mainWindowClickThroughUnlockHover',
    'stopMainWindowClickThroughUnlockHoverMonitor',
    'remoteControlWindow',
    'ytmSandbox',
    'refreshTrayMenu',
];

const createWin = () => ({
    __reopeningWithoutMods: false,
    __rendererCrashReloads: [] as number[],
    isDestroyed: () => false,
    webContents: { reload: vi.fn() },
});

describe('main.cjs: mpv stops when the page driving it is gone for good', () => {
    it('finds both handlers in main.cjs', () => {
        expect(renderGoneBody, 'render-process-gone handler').toContain('shouldReloadMainRenderer(win, details)');
        expect(closedBody, 'closed handler of the main window').toContain('mainWindow = null;');
    });

    const renderGone = (overrides: Deps = {}) => {
        const win = createWin();
        const hifiSession = { stop: vi.fn(async () => {}) };
        const deps: Deps = {
            win,
            mainWindow: win,
            noteWindowNotStuck: () => {},
            modSystem: null,
            wallpaperWatchdog: { handleRendererGone: () => false },
            shouldReloadMainRenderer: () => false,
            useWindowsWallpaper: false,
            process: { platform: 'linux' },
            isMacWallpaperMode: () => false,
            hifiSession,
            ...overrides,
        };
        const handler = compileHandler(renderGoneBody, RENDER_GONE_NAMES, '_event, details');
        return { run: (details: Deps) => handler(deps)(null, details), win: deps.win as ReturnType<typeof createWin>, hifiSession };
    };

    it('render-process-gone: stops mpv when the main page is not loaded again (killed, oom, crashed past the reload limit)', () => {
        for (const reason of ['killed', 'oom', 'crashed', 'launch-failed']) {
            const { run, hifiSession, win } = renderGone();
            run({ reason });
            expect(hifiSession.stop, reason).toHaveBeenCalledTimes(1);
            expect(win.webContents.reload, reason).not.toHaveBeenCalled();
        }
    });

    it('render-process-gone: leaves mpv alone when the page is reloaded (the new page adopts it) or is not the main one', () => {
        const reloaded = renderGone({ shouldReloadMainRenderer: () => true });
        reloaded.run({ reason: 'crashed' });
        expect(reloaded.win.webContents.reload).toHaveBeenCalledTimes(1);
        expect(reloaded.hifiSession.stop).not.toHaveBeenCalled();

        const windowsWallpaper = renderGone({ useWindowsWallpaper: true });
        windowsWallpaper.run({ reason: 'crashed' });
        expect(windowsWallpaper.win.webContents.reload).toHaveBeenCalledTimes(1);
        expect(windowsWallpaper.hifiSession.stop).not.toHaveBeenCalled();

        const reopening = renderGone();
        reopening.win.__reopeningWithoutMods = true;
        reopening.run({ reason: 'killed' });
        expect(reopening.hifiSession.stop).not.toHaveBeenCalled();

        const otherWindow = renderGone({ mainWindow: createWin() });
        otherWindow.run({ reason: 'killed' });
        expect(otherWindow.hifiSession.stop).not.toHaveBeenCalled();
    });

    const closed = (overrides: Deps = {}) => {
        const win = createWin();
        const hifiSession = { stop: vi.fn(async () => {}) };
        const deps: Deps = {
            win,
            mainWindow: win,
            process: { platform: 'darwin' },
            modSystem: null,
            isMacWallpaperActive: false,
            exitMacWallpaperMode: () => {},
            displaySleepBlocker: { stop: () => {} },
            hifiSession,
            mainWindowClickThroughUnlockHover: false,
            stopMainWindowClickThroughUnlockHoverMonitor: () => {},
            remoteControlWindow: null,
            ytmSandbox: { destroy: () => {} },
            refreshTrayMenu: () => {},
            ...overrides,
        };
        const handler = compileHandler(closedBody, CLOSED_NAMES, '');
        return { run: () => handler(deps)(), hifiSession };
    };

    it('closed: the main window closing for good stops mpv (macOS keeps the app running)', () => {
        const { run, hifiSession } = closed();
        run();
        expect(hifiSession.stop).toHaveBeenCalledTimes(1);
    });

    it('closed: the old window of a rebuild does not stop mpv, since mainWindow already points at the new one', () => {
        const { run, hifiSession } = closed({ mainWindow: createWin() });
        run();
        expect(hifiSession.stop).not.toHaveBeenCalled();

        // That holds because every rebuild replaces mainWindow before the old window is destroyed.
        const rebuild = mainCjs.match(/function recreateMainWindowWithTransparencyMode\([\s\S]*?\n\}\n/)?.[0] ?? '';
        expect(rebuild).not.toBe('');
        const cleared = rebuild.indexOf('mainWindow = null;');
        const destroys = [...rebuild.matchAll(/previousWindow\.destroy\(\)/g)].map(match => match.index ?? -1);
        expect(cleared).toBeGreaterThan(-1);
        expect(destroys.length).toBeGreaterThan(0);
        for (const at of destroys) expect(at).toBeGreaterThan(cleared);
    });
});

describe('main.cjs: leftover mpv downloads', () => {
    it('sweeps them once after app ready, and logs a failure instead of throwing', () => {
        const site = mainCjs.match(/app\.whenReady\(\)\n\s*\.then\(\(\) => hifiInstaller\.pruneLeftovers\(\)\)\n\s*\.catch\(error => console\.warn\('\[HiFi\] [^']*', error\)\);/);
        expect(site, 'no startup sweep of leftover mpv downloads').not.toBeNull();
    });
});
