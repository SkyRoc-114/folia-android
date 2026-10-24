import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import type { HifiRuntimeStatus } from '../../../src/types/hifi';

// 钉住 mpv 版本解析和排序、DoP 判断，以及检测顺序：手动路径 → 下载的运行时 → FOLIA_MPV_PATH → PATH → 常见位置。

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileFn = (file: string, args: string[], options: Record<string, unknown>, callback: ExecFileCallback) => void;

interface FakeFs {
    constants: { X_OK: number };
    statSync: (target: string) => { isFile: () => boolean };
    accessSync: (target: string, mode?: number) => void;
}

interface RuntimeOptions {
    platform: string;
    arch: string;
    env?: Record<string, string>;
    fs: FakeFs;
    execFileFn: ExecFileFn;
    getUserDataPath: () => string;
    manifest?: unknown;
    homedir?: () => string;
    isInstalling?: () => boolean;
    systemVersion?: string | null;
    logInfo?: (...args: unknown[]) => void;
    logWarn?: (...args: unknown[]) => void;
}

interface MpvRuntime {
    detect: (options?: { manualPath?: string | null }) => Promise<HifiRuntimeStatus>;
    getCachedStatus: () => HifiRuntimeStatus | null;
    downloadedRuntimeDir: () => string;
}

const require = createRequire(import.meta.url);
const { parseMpvVersion, compareMpvVersions, isDopCapable, createMpvRuntime } = require('../../../electron/hifi/mpvRuntime.cjs') as {
    parseMpvVersion: (stdout: unknown) => { version: string; raw: string } | null;
    compareMpvVersions: (a: unknown, b: unknown) => number;
    isDopCapable: (platform: string, version: unknown) => boolean;
    createMpvRuntime: (options: RuntimeOptions) => MpvRuntime;
};

const VERSION_OUTPUT = 'mpv v0.41.0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects\n built on Dec 21 2025\n';

type FileSpec = { executable?: boolean; directory?: boolean };

/** 只认 files 里列出的路径；executable 决定 X_OK。 */
const createFakeFs = (files: Record<string, FileSpec>): FakeFs => ({
    constants: { X_OK: 1 },
    statSync: (target) => {
        const spec = files[target];
        if (!spec) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
        return { isFile: () => !spec.directory };
    },
    accessSync: (target) => {
        if (!files[target]?.executable) throw Object.assign(new Error(`EACCES: ${target}`), { code: 'EACCES' });
    },
});

/** outputs 里有的路径照着回 stdout，其余像找不到文件那样报错；calls 记下每次探测。 */
const createFakeExecFile = (outputs: Record<string, string>) => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const execFileFn: ExecFileFn = (file, args, options, callback) => {
        calls.push({ file, args, options });
        if (file in outputs) callback(null, outputs[file], '');
        else callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', '');
    };
    return { execFileFn, calls };
};

const silent = { logInfo: () => { }, logWarn: () => { } };

const twoVersionManifest = {
    schema: 1,
    recommended: '0.41.0',
    versions: ['0.41.0', '0.40.0'].map(version => ({
        version,
        builds: {
            'darwin-arm64': {
                url: `https://example.test/mpv-${version}.zip`,
                bytes: 10,
                sha256: 'a'.repeat(64),
                archive: 'zip+tar.gz',
                tarball: 'mpv.tar.gz',
                executable: 'mpv.app/Contents/MacOS/mpv',
                minOsVersion: '14.0',
            },
            'win32-x64': {
                url: `https://example.test/mpv-${version}-win.zip`,
                bytes: 10,
                sha256: 'b'.repeat(64),
                archive: 'zip',
                executable: 'mpv.exe',
            },
        },
    })),
};

describe('parseMpvVersion', () => {
    it('reads release, git describe, dirty and official CI version lines', () => {
        expect(parseMpvVersion(VERSION_OUTPUT)).toEqual({
            version: '0.41.0',
            raw: 'mpv v0.41.0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects',
        });
        expect(parseMpvVersion('mpv 0.41.0-123-gabcdef0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects')?.version)
            .toBe('0.41.0-123-gabcdef0');
        expect(parseMpvVersion('mpv v0.40.0-dirty')?.version).toBe('0.40.0-dirty');
        // 官方 0.41.0 的 Windows / macOS 构建就是这样印的。
        expect(parseMpvVersion('mpv v0.41.0-dev-g41f6a6450 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects')?.version)
            .toBe('0.41.0-dev-g41f6a6450');
        expect(parseMpvVersion('\r\nmpv v0.39.0 Copyright\r\n')?.version).toBe('0.39.0');
    });

    it('returns null for anything that is not mpv', () => {
        for (const garbage of ['', 'ffmpeg version 8.1', 'mplayer 1.5', 'mpv', 'mpv vNext', 'hello\nmpv v0.41.0', null, undefined]) {
            expect(parseMpvVersion(garbage)).toBeNull();
        }
    });
});

describe('compareMpvVersions', () => {
    it('orders numerically and puts a git describe suffix after its base', () => {
        expect(compareMpvVersions('0.41.0', '0.40.0')).toBe(1);
        expect(compareMpvVersions('0.10.0', '0.9.9')).toBe(1);
        expect(compareMpvVersions('0.41.0-123-gabcdef0', '0.41.0')).toBe(1);
        expect(compareMpvVersions('0.41.0-123-gabcdef0', '0.41.0-124-g1234567')).toBe(-1);
        expect(compareMpvVersions('0.42.0', '0.41.0-500-gabcdef0')).toBe(1);
        expect(compareMpvVersions('v0.41.0', '0.41.0')).toBe(0);
    });

    it('treats -dev-g<hash> and -dirty as the base version', () => {
        // 官方 CI 构建 git describe 找不到标签时印 x.y.z-dev-g<hash>，说明不了比 x.y.z 新。
        expect(compareMpvVersions('0.41.0-dev-g41f6a6450', '0.41.0')).toBe(0);
        expect(compareMpvVersions('0.40.0-dirty', '0.40.0')).toBe(0);
    });

    it('sorts unreadable versions first', () => {
        expect(['0.41.0', 'garbage', '0.40.0-3-gabc1234', '0.40.0'].sort(compareMpvVersions))
            .toEqual(['garbage', '0.40.0', '0.40.0-3-gabc1234', '0.41.0']);
    });
});

describe('isDopCapable', () => {
    it('needs Windows and a build newer than 0.41.0', () => {
        expect(isDopCapable('win32', '0.41.0')).toBe(false);
        expect(isDopCapable('win32', '0.41.0-dev-g41f6a6450')).toBe(false);
        expect(isDopCapable('win32', '0.41.0-12-gabcdef0')).toBe(true);
        expect(isDopCapable('win32', '0.42.0')).toBe(true);
        expect(isDopCapable('darwin', '0.42.0')).toBe(false);
        expect(isDopCapable('linux', '0.42.0')).toBe(false);
        expect(isDopCapable('win32', 'garbage')).toBe(false);
    });
});

describe('createMpvRuntime detect', () => {
    const userData = '/Users/lia/Library/Application Support/Folia';
    const downloaded = `${userData}/hifi-runtime/mpv/0.41.0/mpv.app/Contents/MacOS/mpv`;
    const sources = {
        manual: '/opt/manual/mpv',
        downloaded,
        env: '/env/bin/mpv',
        path: '/path/bin/mpv',
        common: '/opt/homebrew/bin/mpv',
    };

    const darwinRuntime = (present: Array<keyof typeof sources>, extra: Partial<RuntimeOptions> = {}) => {
        const files: Record<string, FileSpec> = {};
        const outputs: Record<string, string> = {};
        for (const key of present) {
            files[sources[key]] = { executable: true };
            outputs[sources[key]] = VERSION_OUTPUT;
        }
        const exec = createFakeExecFile(outputs);
        const runtime = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: { FOLIA_MPV_PATH: sources.env, PATH: '/path/bin:/usr/bin' },
            fs: createFakeFs(files),
            execFileFn: exec.execFileFn,
            getUserDataPath: () => userData,
            homedir: () => '/Users/lia',
            ...silent,
            ...extra,
        });
        return { runtime, calls: exec.calls };
    };

    it('takes manual over downloaded over env over PATH over common locations', async () => {
        const order: Array<[keyof typeof sources, string]> = [
            ['manual', 'manual'],
            ['downloaded', 'downloaded'],
            ['env', 'system'],
            ['path', 'system'],
            ['common', 'system'],
        ];
        for (let index = 0; index < order.length; index += 1) {
            const present = order.slice(index).map(([key]) => key);
            const { runtime } = darwinRuntime(present);
            const status = await runtime.detect({ manualPath: sources.manual });
            expect(status.path).toBe(sources[order[index][0]]);
            expect(status.source).toBe(order[index][1]);
            expect(status.available).toBe(true);
            expect(status.version).toBe('0.41.0');
        }
    });

    it('probes with --version, an 8 s timeout and a hidden window', async () => {
        const { runtime, calls } = darwinRuntime(['common']);
        await runtime.detect();
        expect(calls.at(-1)).toEqual({
            file: sources.common,
            args: ['--version'],
            options: { timeout: 8000, windowsHide: true },
        });
    });

    it('rejects an unusable manual path and keeps detecting', async () => {
        const { runtime: garbageRuntime } = darwinRuntime(['downloaded'], {});
        const cases = [
            'mpv', // 不是绝对路径
            '/missing/mpv', // 不存在
        ];
        for (const manualPath of cases) {
            const status = await garbageRuntime.detect({ manualPath });
            expect(status).toMatchObject({
                available: true,
                source: 'downloaded',
                path: sources.downloaded,
                manualPathRejected: true,
                errorCode: 'MPV_NOT_FOUND',
            });
        }

        // 存在、可执行，但 --version 印的不是 mpv。
        const exec = createFakeExecFile({ '/opt/not-mpv': 'ffmpeg version 8.1', [sources.downloaded]: VERSION_OUTPUT });
        const runtime = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs({ '/opt/not-mpv': { executable: true }, [sources.downloaded]: { executable: true } }),
            execFileFn: exec.execFileFn,
            getUserDataPath: () => userData,
            ...silent,
        });
        const status = await runtime.detect({ manualPath: '/opt/not-mpv' });
        expect(status.manualPathRejected).toBe(true);
        expect(status.source).toBe('downloaded');

        // 一个目录也不行。
        const directoryRuntime = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs({ '/Applications/mpv.app': { directory: true } }),
            execFileFn: createFakeExecFile({}).execFileFn,
            getUserDataPath: () => userData,
            ...silent,
        });
        const directoryStatus = await directoryRuntime.detect({ manualPath: '/Applications/mpv.app' });
        expect(directoryStatus.manualPathRejected).toBe(true);
        expect(directoryStatus.available).toBe(false);
    });

    it('accepts a good manual path without a rejection code', async () => {
        const { runtime } = darwinRuntime(['manual']);
        const status = await runtime.detect({ manualPath: `  ${sources.manual}  ` });
        expect(status).toMatchObject({ source: 'manual', manualPathRejected: false, errorCode: null });
    });

    it('skips a file without the execute bit on POSIX', async () => {
        const exec = createFakeExecFile({ [sources.common]: VERSION_OUTPUT });
        const runtime = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs({ [sources.common]: { executable: false } }),
            execFileFn: exec.execFileFn,
            getUserDataPath: () => userData,
            ...silent,
        });
        expect((await runtime.detect()).available).toBe(false);
        expect(exec.calls).toHaveLength(0);
    });

    it('reports MPV_NOT_FOUND when nothing is there and caches the status', async () => {
        const { runtime } = darwinRuntime([]);
        expect(runtime.getCachedStatus()).toBeNull();
        const status = await runtime.detect();
        expect(status).toEqual({
            available: false,
            path: null,
            version: null,
            source: null,
            errorCode: 'MPV_NOT_FOUND',
            manualPathRejected: false,
            platform: 'darwin',
            arch: 'arm64',
            download: {
                supported: true,
                version: '0.41.0',
                installedVersion: null,
                updateAvailable: false,
                installing: false,
            },
            dopCapable: false,
        });
        expect(runtime.getCachedStatus()).toBe(status);
        expect(runtime.downloadedRuntimeDir()).toBe(`${userData}/hifi-runtime/mpv`);
    });

    it('fills download info from the manifest, installed versions and the installer', async () => {
        const older = `${userData}/hifi-runtime/mpv/0.40.0/mpv.app/Contents/MacOS/mpv`;
        const exec = createFakeExecFile({ [older]: 'mpv v0.40.0 Copyright' });
        const runtime = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs({ [older]: { executable: true } }),
            execFileFn: exec.execFileFn,
            getUserDataPath: () => userData,
            manifest: twoVersionManifest,
            isInstalling: () => true,
            ...silent,
        });
        const status = await runtime.detect();
        expect(status.source).toBe('downloaded');
        expect(status.version).toBe('0.40.0');
        expect(status.download).toEqual({
            supported: true,
            version: '0.41.0',
            installedVersion: '0.40.0',
            updateAvailable: true,
            installing: true,
        });
    });

    it('prefers the newest installed runtime and falls back when it does not run', async () => {
        const newer = `${userData}/hifi-runtime/mpv/0.41.0/mpv.app/Contents/MacOS/mpv`;
        const older = `${userData}/hifi-runtime/mpv/0.40.0/mpv.app/Contents/MacOS/mpv`;
        const files = { [newer]: { executable: true }, [older]: { executable: true } };
        const both = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs(files),
            execFileFn: createFakeExecFile({ [newer]: VERSION_OUTPUT, [older]: 'mpv v0.40.0' }).execFileFn,
            getUserDataPath: () => userData,
            manifest: twoVersionManifest,
            ...silent,
        });
        expect((await both.detect()).path).toBe(newer);

        const brokenNewest = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs(files),
            execFileFn: createFakeExecFile({ [older]: 'mpv v0.40.0' }).execFileFn,
            getUserDataPath: () => userData,
            manifest: twoVersionManifest,
            ...silent,
        });
        const status = await brokenNewest.detect();
        expect(status.path).toBe(older);
        expect(status.download.installedVersion).toBe('0.41.0');
        expect(status.download.updateAvailable).toBe(false);
    });

    it('says Linux has no download and an old macOS cannot take the build', async () => {
        const linux = createMpvRuntime({
            platform: 'linux',
            arch: 'x64',
            env: { PATH: '/usr/bin' },
            fs: createFakeFs({ '/usr/bin/mpv': { executable: true } }),
            execFileFn: createFakeExecFile({ '/usr/bin/mpv': VERSION_OUTPUT }).execFileFn,
            getUserDataPath: () => '/home/lia/.config/Folia',
            ...silent,
        });
        const linuxStatus = await linux.detect();
        expect(linuxStatus).toMatchObject({ available: true, path: '/usr/bin/mpv', source: 'system', dopCapable: false });
        expect(linuxStatus.download).toMatchObject({ supported: false, version: null, updateAvailable: false });

        const oldIntel = createMpvRuntime({
            platform: 'darwin',
            arch: 'x64',
            env: {},
            fs: createFakeFs({}),
            execFileFn: createFakeExecFile({}).execFileFn,
            getUserDataPath: () => userData,
            systemVersion: '13.6.1',
            ...silent,
        });
        expect((await oldIntel.detect()).download.supported).toBe(false);
    });

    it('scans Path case-insensitively on Windows and knows scoop and the DoP threshold', async () => {
        const shim = 'C:\\Users\\lia\\scoop\\shims\\mpv.exe';
        const fromPath = 'D:\\tools\\mpv\\mpv.exe';
        const exec = createFakeExecFile({ [fromPath]: 'mpv v0.41.0-58-g1a2b3c4d5 Copyright', [shim]: VERSION_OUTPUT });
        const runtime = createMpvRuntime({
            platform: 'win32',
            arch: 'x64',
            env: { Path: 'C:\\Windows\\System32;"D:\\tools\\mpv"' },
            fs: createFakeFs({ [fromPath]: {}, [shim]: {} }),
            execFileFn: exec.execFileFn,
            getUserDataPath: () => 'C:\\Users\\lia\\AppData\\Roaming\\Folia',
            homedir: () => 'C:\\Users\\lia',
            ...silent,
        });
        const status = await runtime.detect();
        expect(status).toMatchObject({ path: fromPath, version: '0.41.0-58-g1a2b3c4d5', dopCapable: true });

        const shimOnly = createMpvRuntime({
            platform: 'win32',
            arch: 'x64',
            env: {},
            fs: createFakeFs({ [shim]: {} }),
            execFileFn: exec.execFileFn,
            getUserDataPath: () => 'C:\\Users\\lia\\AppData\\Roaming\\Folia',
            homedir: () => 'C:\\Users\\lia',
            ...silent,
        });
        const shimStatus = await shimOnly.detect({ manualPath: 'C:\\missing\\mpv.exe' });
        expect(shimStatus).toMatchObject({ path: shim, dopCapable: false, manualPathRejected: true });
        expect(shimStatus.download).toMatchObject({ supported: true, version: '0.41.0' });
    });

    it('keeps the status of the detect that started last', async () => {
        const pending: Array<() => void> = [];
        const execFileFn: ExecFileFn = (_file, _args, _options, callback) => {
            pending.push(() => callback(null, VERSION_OUTPUT, ''));
        };
        const runtime = createMpvRuntime({
            platform: 'darwin',
            arch: 'arm64',
            env: {},
            fs: createFakeFs({ '/first/mpv': { executable: true }, '/second/mpv': { executable: true } }),
            execFileFn,
            getUserDataPath: () => userData,
            ...silent,
        });
        const first = runtime.detect({ manualPath: '/first/mpv' });
        const second = runtime.detect({ manualPath: '/second/mpv' });
        await Promise.resolve();
        pending[1]();
        await second;
        pending[0]();
        await first;
        expect(runtime.getCachedStatus()?.path).toBe('/second/mpv');
    });
});
