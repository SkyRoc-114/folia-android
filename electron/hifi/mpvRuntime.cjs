'use strict';

const os = require('os');
const path = require('path');

// 找 mpv 并探测版本：手动路径、应用下载的运行时、FOLIA_MPV_PATH、PATH、常见安装位置，结果是 HifiRuntimeStatus。

const PROBE_TIMEOUT_MS = 8000;
const ENV_OVERRIDE_KEY = 'FOLIA_MPV_PATH';
/** 下载的运行时放在 <userData>/hifi-runtime/mpv/<version>/，安装器和检测共用这个布局。 */
const RUNTIME_DIR_SEGMENTS = Object.freeze(['hifi-runtime', 'mpv']);
/** WASAPI 上的 DoP（--audio-spdif=dsd）是 0.41.0 之后才有的。 */
const DOP_AFTER_VERSION = '0.41.0';

// `mpv v0.41.0 Copyright …`、`mpv 0.41.0-123-gabcdef0 Copyright …`、`mpv v0.40.0-dirty`、官方 CI 的 `mpv v0.41.0-dev-g41f6a6450`。
const VERSION_LINE_PATTERN = /^mpv\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+~-]+)?)(?:\s|$)/;
const VERSION_KEY_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/;
const GIT_DESCRIBE_SUFFIX_PATTERN = /^(\d+)-g[0-9a-f]+/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix);

const buildKeyOf = (platform, arch) => `${platform}-${arch}`;

/** `mpv --version` 输出的第一行里的版本号；认不出时为 null。 */
const parseMpvVersion = stdout => {
    if (stdout === null || stdout === undefined) return null;
    const raw = String(stdout).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (!raw) return null;
    const match = VERSION_LINE_PATTERN.exec(raw);
    return match ? { version: match[1], raw } : null;
};

// 比较用的键：x.y.z 加 git describe 的提交数（`-N-g<hash>` 排在 x.y.z 之后）。`-dev-g<hash>` 是 mpv 构建在
// git describe 找不到标签时的写法，0.41.0 正式版和其后的 master CI 构建都印 0.41.0-dev-g…，只能当 x.y.z 本身；
// `-dirty` 不影响顺序。
const versionKey = version => {
    if (typeof version !== 'string') return null;
    const match = VERSION_KEY_PATTERN.exec(version.trim());
    if (!match) return null;
    const commits = GIT_DESCRIBE_SUFFIX_PATTERN.exec(match[4] ?? '');
    return [Number(match[1]), Number(match[2]), Number(match[3]), commits ? Number(commits[1]) : 0];
};

/** 升序比较两个 mpv 版本号，返回 -1 / 0 / 1；认不出的版本排在最前。 */
const compareMpvVersions = (a, b) => {
    const left = versionKey(a);
    const right = versionKey(b);
    if (!left || !right) return left ? 1 : right ? -1 : 0;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
};

/** 这个 mpv 预计能做 DoP：Windows，且版本比 0.41.0 新。 */
const isDopCapable = (platform, version) => platform === 'win32'
    && versionKey(version) !== null
    && compareMpvVersions(version, DOP_AFTER_VERSION) > 0;

/** 点分数字版本（系统版本 '14.5.0' 对清单的 '14.0'）是否不低于 minimum；缺一方时不拦。 */
const meetsMinimumVersion = (actual, minimum) => {
    if (typeof minimum !== 'string' || !minimum) return true;
    if (typeof actual !== 'string' || !/^\d+(\.\d+)*$/.test(actual.trim())) return true;
    const have = actual.trim().split('.').map(Number);
    const want = minimum.split('.').map(Number);
    for (let index = 0; index < Math.max(have.length, want.length); index += 1) {
        const left = have[index] ?? 0;
        const right = want[index] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
};

/** 存在、是文件；POSIX 上还要有执行位（Windows 只看存在，ACL 探测不可靠）。 */
const isExecutableFile = (fs, platform, candidate) => {
    try {
        if (!fs.statSync(candidate).isFile()) return false;
        if (platform === 'win32') return true;
        fs.accessSync(candidate, fs.constants?.X_OK ?? 1);
        return true;
    } catch {
        return false;
    }
};

const runtimeRootFor = (userDataPath, pathModule = path) => pathModule.join(userDataPath, ...RUNTIME_DIR_SEGMENTS);

const executablePathFor = (versionDir, build, pathModule = path) => pathModule.join(versionDir, ...build.executable.split('/'));

const isUsableBuild = build => Boolean(build)
    && typeof build.url === 'string' && /^https:\/\//.test(build.url)
    && Number.isSafeInteger(build.bytes) && build.bytes > 0
    && typeof build.sha256 === 'string' && SHA256_PATTERN.test(build.sha256)
    && typeof build.archive === 'string'
    && typeof build.executable === 'string' && build.executable.length > 0;

/** 这台机器能装的那个构建：清单推荐版本里这个平台和架构的构建，且系统版本够；没有时为 null。 */
const resolveInstallTarget = ({ manifest, platform, arch, systemVersion = null }) => {
    const version = manifest?.recommended;
    const entry = (manifest?.versions ?? []).find(item => item?.version === version);
    const build = entry?.builds?.[buildKeyOf(platform, arch)];
    if (!isUsableBuild(build)) return null;
    if (!meetsMinimumVersion(systemVersion, build.minOsVersion)) return null;
    return { version, build };
};

/** userData 里装好、可执行文件也在的版本（只认清单列出的版本），新的在前。 */
const listInstalledVersions = ({ fs, manifest, platform, arch, root, pathModule = path }) => {
    const key = buildKeyOf(platform, arch);
    return (manifest?.versions ?? [])
        .filter(entry => typeof entry?.version === 'string' && typeof entry.builds?.[key]?.executable === 'string')
        .map(entry => ({
            version: entry.version,
            executablePath: executablePathFor(pathModule.join(root, entry.version), entry.builds[key], pathModule),
        }))
        .filter(entry => isExecutableFile(fs, platform, entry.executablePath))
        .sort((a, b) => compareMpvVersions(b.version, a.version));
};

const createMpvRuntime = ({
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    fs = require('fs'),
    execFileFn = require('child_process').execFile,
    getUserDataPath,
    manifest = require('../../shared/mpvRuntimeManifest.json'),
    homedir = os.homedir,
    isInstalling = () => false,
    // macOS 上传 process.getSystemVersion()，清单里的 minOsVersion 才拦得住装不上的构建；缺省时不拦。
    systemVersion = null,
    logInfo = (...args) => console.info(...args),
    logWarn = (...args) => console.warn(...args),
} = {}) => {
    const pathModule = pathFor(platform);
    const binaryName = platform === 'win32' ? 'mpv.exe' : 'mpv';
    let cachedStatus = null;
    let detectSeq = 0;

    // Windows 的环境变量名不分大小写，注入的 env 对象却分。
    const envValue = name => {
        if (!env) return '';
        if (typeof env[name] === 'string') return env[name];
        if (platform !== 'win32') return '';
        const key = Object.keys(env).find(item => item.toUpperCase() === name.toUpperCase());
        return key && typeof env[key] === 'string' ? env[key] : '';
    };

    const resolveHome = () => {
        try {
            const home = typeof homedir === 'function' ? homedir() : homedir;
            return typeof home === 'string' && home ? home : null;
        } catch {
            return null;
        }
    };

    const downloadedRuntimeDir = () => runtimeRootFor(getUserDataPath(), pathModule);

    const listInstalled = () => {
        try {
            return listInstalledVersions({ fs, manifest, platform, arch, root: downloadedRuntimeDir(), pathModule });
        } catch (error) {
            logWarn('[HiFi] runtime: could not list downloaded mpv', error);
            return [];
        }
    };

    const pathCandidates = () => envValue('PATH')
        .split(platform === 'win32' ? ';' : ':')
        .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(entry => entry && pathModule.isAbsolute(entry))
        .map(entry => pathModule.join(entry, binaryName));

    const commonLocations = () => {
        const home = resolveHome();
        if (platform === 'darwin') {
            return [
                '/opt/homebrew/bin/mpv',
                '/usr/local/bin/mpv',
                '/Applications/mpv.app/Contents/MacOS/mpv',
                home && pathModule.join(home, 'Applications', 'mpv.app', 'Contents', 'MacOS', 'mpv'),
            ];
        }
        if (platform === 'win32') {
            const scoop = envValue('SCOOP') || (home && pathModule.join(home, 'scoop'));
            return [
                scoop && pathModule.join(scoop, 'shims', 'mpv.exe'),
                scoop && pathModule.join(scoop, 'apps', 'mpv', 'current', 'mpv.exe'),
                pathModule.join(envValue('ProgramData') || 'C:\\ProgramData', 'chocolatey', 'bin', 'mpv.exe'),
                pathModule.join(envValue('ProgramFiles') || 'C:\\Program Files', 'mpv', 'mpv.exe'),
            ];
        }
        return ['/usr/bin/mpv', '/usr/local/bin/mpv', '/snap/bin/mpv'];
    };

    // 手动路径之后的顺序：下载的运行时（新的在前）→ FOLIA_MPV_PATH → PATH → 常见安装位置。
    const automaticCandidates = installed => {
        const fromEnv = envValue(ENV_OVERRIDE_KEY).trim();
        return [
            ...installed.map(entry => ({ path: entry.executablePath, source: 'downloaded' })),
            ...(fromEnv && pathModule.isAbsolute(fromEnv) ? [{ path: fromEnv, source: 'system' }] : []),
            ...pathCandidates().map(candidate => ({ path: candidate, source: 'system' })),
            ...commonLocations().filter(Boolean).map(candidate => ({ path: candidate, source: 'system' })),
        ];
    };

    const probe = candidate => new Promise((resolve) => {
        try {
            execFileFn(candidate, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
                resolve(error ? null : parseMpvVersion(stdout));
            });
        } catch {
            resolve(null);
        }
    });

    const comparablePath = candidate => {
        const normalized = pathModule.normalize(candidate);
        return platform === 'win32' ? normalized.toLowerCase() : normalized;
    };

    const downloadInfo = installed => {
        const target = resolveInstallTarget({ manifest, platform, arch, systemVersion });
        const installedVersion = installed[0]?.version ?? null;
        let installing = false;
        try {
            installing = Boolean(isInstalling());
        } catch {
            installing = false;
        }
        return {
            supported: target !== null,
            version: target?.version ?? null,
            installedVersion,
            updateAvailable: target !== null && installedVersion !== null
                && compareMpvVersions(target.version, installedVersion) > 0,
            installing,
        };
    };

    /** 按顺序找第一个能跑 `--version` 的 mpv；手动路径不可用时标出来，再接着找别的。 */
    const detect = async ({ manualPath = null } = {}) => {
        const seq = ++detectSeq;
        const installed = listInstalled();
        const manual = typeof manualPath === 'string' ? manualPath.trim() : '';
        const tried = new Set();
        let manualPathRejected = false;
        let found = null;

        if (manual) {
            tried.add(comparablePath(manual));
            const probed = pathModule.isAbsolute(manual) && isExecutableFile(fs, platform, manual)
                ? await probe(manual)
                : null;
            if (probed) {
                found = { path: manual, source: 'manual', version: probed.version };
            } else {
                manualPathRejected = true;
                logWarn('[HiFi] runtime: manual mpv path rejected', manual);
            }
        }

        if (!found) {
            for (const candidate of automaticCandidates(installed)) {
                const key = comparablePath(candidate.path);
                if (tried.has(key)) continue;
                tried.add(key);
                if (!isExecutableFile(fs, platform, candidate.path)) continue;
                const probed = await probe(candidate.path);
                if (probed) {
                    found = { ...candidate, version: probed.version };
                    break;
                }
            }
        }

        const status = {
            available: found !== null,
            path: found?.path ?? null,
            version: found?.version ?? null,
            source: found?.source ?? null,
            errorCode: found && !manualPathRejected ? null : 'MPV_NOT_FOUND',
            manualPathRejected,
            platform,
            arch,
            download: downloadInfo(installed),
            dopCapable: found ? isDopCapable(platform, found.version) : false,
        };
        if (found) {
            logInfo(`[HiFi] runtime: mpv ${found.version} (${found.source}) at ${found.path}`);
        } else {
            logWarn(`[HiFi] runtime: no mpv found on ${platform}-${arch}`);
        }
        // 两次检测交叠时，只让后发起的那次写缓存。
        if (seq === detectSeq) cachedStatus = status;
        return status;
    };

    const getCachedStatus = () => cachedStatus;

    return { detect, getCachedStatus, downloadedRuntimeDir };
};

module.exports = {
    PROBE_TIMEOUT_MS,
    ENV_OVERRIDE_KEY,
    RUNTIME_DIR_SEGMENTS,
    parseMpvVersion,
    compareMpvVersions,
    isDopCapable,
    meetsMinimumVersion,
    isExecutableFile,
    runtimeRootFor,
    executablePathFor,
    resolveInstallTarget,
    listInstalledVersions,
    createMpvRuntime,
};
