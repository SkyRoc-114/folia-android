'use strict';

const { createHash } = require('crypto');
const path = require('path');
const { createHifiError, toHifiErrorCode } = require('./hifiErrors.cjs');
const {
    compareMpvVersions,
    executablePathFor,
    isExecutableFile,
    listInstalledVersions,
    resolveInstallTarget,
    runtimeRootFor,
} = require('./mpvRuntime.cjs');

// 替用户下载 mpv：边下边算 sha256，核对后解压到 userData/hifi-runtime/mpv/<version>/，只留最新两个版本。

/** 进度最多这么频繁地报一次；70 MB 的 zip 有上千个块。 */
const PROGRESS_INTERVAL_MS = 200;
/** 只管响应头多久内到；传输本身慢不算失败，用户可以取消。 */
const RESPOND_TIMEOUT_MS = 45_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const KEEP_VERSIONS = 2;
const INSTALL_ERROR_CODES = new Set(['INSTALL_FAILED', 'INSTALL_CHECKSUM_MISMATCH', 'INSTALL_CANCELLED']);
const VERSION_DIR_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Windows 构建里两百多 MB 的调试符号，运行用不到。
const SKIPPED_ENTRY_PATTERN = /\.pdb$/i;

/**
 * zip 条目名拆成路径段。'..'、绝对路径、反斜杠和带冒号的段（盘符、NTFS 流）为 undefined，整包拒绝；
 * 目录条目为 null，跳过（目录随文件建出来）。
 */
const safeEntrySegments = name => {
    if (typeof name !== 'string' || name.startsWith('/')) return undefined;
    const segments = name.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.some(segment => segment === '..' || segment.includes('\\') || segment.includes(':'))) return undefined;
    return name.endsWith('/') || segments.length === 0 ? null : segments;
};

const assetNameOf = url => {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const name = decodeURIComponent(last);
    return /^[0-9A-Za-z._-]+$/.test(name) ? name : 'mpv-runtime.zip';
};

const createMpvRuntimeInstaller = ({
    manifest = require('../../shared/mpvRuntimeManifest.json'),
    platform = process.platform,
    arch = process.arch,
    getUserDataPath,
    fetchFn = (...args) => fetch(...args),
    fsp = require('fs/promises'),
    fs = require('fs'),
    unzipSync = require('fflate').unzipSync,
    execFileFn = require('child_process').execFile,
    onProgress,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    // 和 mpvRuntime 一样：macOS 上传 process.getSystemVersion()，系统版本不够的构建当作不支持。
    systemVersion = null,
    logInfo = (...args) => console.info(...args),
    logWarn = (...args) => console.warn(...args),
} = {}) => {
    /** 进行中的那一次：{ controller, promise }。 */
    let current = null;

    const runtimeRoot = () => runtimeRootFor(getUserDataPath(), path);

    const report = progress => {
        try {
            onProgress?.(progress);
        } catch {
            // 窗口已关，不影响安装。
        }
    };

    const removeQuietly = async target => {
        try {
            await fsp.rm(target, { recursive: true, force: true });
        } catch (error) {
            logWarn('[HiFi] install: could not remove', target, error);
        }
    };

    const throwIfCancelled = signal => {
        if (signal.aborted) throw createHifiError('INSTALL_CANCELLED');
    };

    const run = (command, args, signal) => new Promise((resolve, reject) => {
        execFileFn(command, args, { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, signal }, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });

    /**
     * 把 zip 流进 `.part`，边写边算 sha256；字节数超过清单就立刻停。取消时连读带写一起停：
     * 不指望 fetch 的实现会让正在读的流报错，直接取消 reader。
     */
    const downloadTo = async (build, partPath, signal, onBytes) => {
        const host = new URL(build.url).host;
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let deadline = setTimeoutFn(() => controller.abort(new Error('no response')), RESPOND_TIMEOUT_MS);
        let handle = null;
        let reader = null;
        const cancelReader = () => {
            reader?.cancel().catch(() => { });
        };
        try {
            const response = await fetchFn(build.url, { redirect: 'follow', signal: controller.signal });
            clearTimeoutFn(deadline);
            deadline = null;
            if (!response.ok || !response.body) {
                response.body?.cancel().catch(() => { });
                throw createHifiError('INSTALL_FAILED', `${host}: HTTP ${response.status}`);
            }

            const hash = createHash('sha256');
            handle = await fsp.open(partPath, 'w');
            reader = response.body.getReader();
            controller.signal.addEventListener('abort', cancelReader, { once: true });
            let received = 0;
            for (;;) {
                if (controller.signal.aborted) break;
                const { done, value } = await reader.read();
                if (done || controller.signal.aborted) break;
                received += value.byteLength;
                if (received > build.bytes) {
                    throw createHifiError('INSTALL_CHECKSUM_MISMATCH', `${host}: more than ${build.bytes} bytes`);
                }
                hash.update(value);
                await handle.write(value);
                onBytes(received);
            }
            throwIfCancelled(controller.signal);
            return { received, digest: hash.digest('hex') };
        } finally {
            if (deadline) clearTimeoutFn(deadline);
            signal.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', cancelReader);
            // 提前停下（字节超了、写盘失败）时别让连接挂着；读完的流取消也无妨。
            cancelReader();
            await handle?.close().catch(() => { });
        }
    };

    /** Windows：fflate 在内存里解，逐个写出；条目名先过一遍，路径不安全就整包拒绝。 */
    const unzipInto = async (zipPath, tmpDir) => {
        const bytes = await fsp.readFile(zipPath);
        let unsafeName = null;
        const entries = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
            filter: (file) => {
                const segments = safeEntrySegments(file.name);
                if (segments === undefined) {
                    unsafeName ??= file.name;
                    return false;
                }
                return segments !== null && !SKIPPED_ENTRY_PATTERN.test(file.name);
            },
        });
        if (unsafeName !== null) throw createHifiError('INSTALL_FAILED', `unsafe zip entry ${unsafeName}`);
        const root = path.resolve(tmpDir);
        for (const [name, data] of Object.entries(entries)) {
            const destination = path.resolve(root, ...safeEntrySegments(name));
            if (!destination.startsWith(root + path.sep)) throw createHifiError('INSTALL_FAILED', `unsafe zip entry ${name}`);
            await fsp.mkdir(path.dirname(destination), { recursive: true });
            await fsp.writeFile(destination, data);
        }
    };

    // macOS 用系统的 ditto 解 zip；官方构建的 zip 里只有一个 mpv.tar.gz，再用系统 tar（bsdtar 默认拒绝 '..' 和绝对路径）解开。
    const extract = async (build, zipPath, tmpDir, signal) => {
        await fsp.mkdir(tmpDir, { recursive: true });
        if (platform === 'darwin' && (build.archive === 'zip' || build.archive === 'zip+tar.gz')) {
            await run('ditto', ['-x', '-k', zipPath, tmpDir], signal);
            if (build.archive === 'zip+tar.gz') {
                if (typeof build.tarball !== 'string' || !/^[0-9A-Za-z._-]+$/.test(build.tarball)) {
                    throw createHifiError('INSTALL_FAILED', 'manifest has no usable tarball name');
                }
                const tarball = path.join(tmpDir, build.tarball);
                await run('tar', ['-xzf', tarball, '-C', tmpDir], signal);
                await fsp.rm(tarball, { force: true });
            }
            return;
        }
        if (platform === 'win32' && build.archive === 'zip') {
            await unzipInto(zipPath, tmpDir);
            return;
        }
        throw createHifiError('INSTALL_FAILED', `cannot extract ${build.archive} on ${platform}`);
    };

    /** 只留最新两个版本目录；刚装的那个无论新旧都留着。删不掉（Windows 上正在跑）只记一笔。 */
    const prune = async (root, installedVersion) => {
        const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
        const versions = entries
            .filter(entry => entry.isDirectory() && VERSION_DIR_PATTERN.test(entry.name) && !entry.name.endsWith('.tmp'))
            .map(entry => entry.name)
            .sort((a, b) => compareMpvVersions(b, a));
        const keep = new Set([installedVersion]);
        for (const version of versions) {
            if (keep.size >= KEEP_VERSIONS) break;
            keep.add(version);
        }
        for (const version of versions) {
            if (keep.has(version)) continue;
            try {
                await fsp.rm(path.join(root, version), { recursive: true, force: true });
                logInfo(`[HiFi] install: removed old mpv ${version}`);
            } catch (error) {
                logWarn(`[HiFi] install: could not remove old mpv ${version}`, error);
            }
        }
    };

    /** 一次完整安装：下载 → 校验 → 解压到 <version>.tmp → 核对可执行文件 → 改名到位 → 清旧版本。 */
    const runInstall = async ({ version, build }, signal) => {
        const root = runtimeRoot();
        const zipPath = path.join(root, assetNameOf(build.url));
        const partPath = `${zipPath}.part`;
        const tmpDir = path.join(root, `${version}.tmp`);
        const finalDir = path.join(root, version);
        const executablePath = executablePathFor(finalDir, build, path);
        let received = 0;
        let announced = 0;
        const emit = (phase, errorCode = null) => report({
            phase,
            version,
            receivedBytes: received,
            totalBytes: build.bytes,
            errorCode,
        });

        try {
            if (isExecutableFile(fs, platform, executablePath)) {
                received = build.bytes;
                emit('done');
                return { ok: true, errorCode: null, version, executablePath };
            }
            await fsp.mkdir(root, { recursive: true });
            await removeQuietly(partPath);
            await removeQuietly(zipPath);
            await removeQuietly(tmpDir);

            logInfo(`[HiFi] install: downloading mpv ${version} from ${new URL(build.url).host}`);
            announced = now();
            emit('downloading');
            const downloaded = await downloadTo(build, partPath, signal, (bytes) => {
                received = bytes;
                const at = now();
                if (at - announced >= PROGRESS_INTERVAL_MS) {
                    announced = at;
                    emit('downloading');
                }
            });
            emit('downloading');

            emit('verifying');
            if (downloaded.received !== build.bytes || downloaded.digest !== build.sha256) {
                throw createHifiError(
                    'INSTALL_CHECKSUM_MISMATCH',
                    `${downloaded.received} bytes, sha256 ${downloaded.digest.slice(0, 12)}`
                    + ` (wanted ${build.bytes}, ${build.sha256.slice(0, 12)})`,
                );
            }
            await fsp.rename(partPath, zipPath);
            throwIfCancelled(signal);

            emit('extracting');
            await extract(build, zipPath, tmpDir, signal);
            throwIfCancelled(signal);
            const stagedExecutable = executablePathFor(tmpDir, build, path);
            const stat = await fsp.stat(stagedExecutable).catch(() => null);
            if (!stat?.isFile()) throw createHifiError('INSTALL_FAILED', `archive has no ${build.executable}`);
            if (platform !== 'win32') await fsp.chmod(stagedExecutable, 0o755);

            await fsp.rm(finalDir, { recursive: true, force: true });
            await fsp.rename(tmpDir, finalDir);
            await removeQuietly(zipPath);
            await prune(root, version);

            emit('done');
            logInfo(`[HiFi] install: mpv ${version} installed at ${finalDir}`);
            return { ok: true, errorCode: null, version, executablePath };
        } catch (error) {
            const code = signal.aborted ? 'INSTALL_CANCELLED' : toHifiErrorCode(error, 'INSTALL_FAILED');
            const errorCode = INSTALL_ERROR_CODES.has(code) ? code : 'INSTALL_FAILED';
            await removeQuietly(partPath);
            await removeQuietly(zipPath);
            await removeQuietly(tmpDir);
            if (errorCode === 'INSTALL_CANCELLED') {
                logInfo(`[HiFi] install: mpv ${version} cancelled`);
                emit('cancelled', errorCode);
            } else {
                logWarn(`[HiFi] install: mpv ${version} failed (${errorCode})`, error);
                emit('error', errorCode);
            }
            return { ok: false, errorCode, version, executablePath: null };
        }
    };

    /** 装清单推荐的版本；已在装时返回同一次的结果。Linux 和清单里没有的平台不碰网络，直接 UNSUPPORTED_PLATFORM。 */
    const install = () => {
        if (current) return current.promise;
        const target = resolveInstallTarget({ manifest, platform, arch, systemVersion });
        if (!target) {
            logInfo(`[HiFi] install: no mpv build for ${platform}-${arch}`);
            return Promise.resolve({ ok: false, errorCode: 'UNSUPPORTED_PLATFORM', version: null, executablePath: null });
        }
        const controller = new AbortController();
        const promise = runInstall(target, controller.signal).finally(() => {
            if (current?.controller === controller) current = null;
        });
        current = { controller, promise };
        return promise;
    };

    const cancel = () => {
        current?.controller.abort(new Error('cancelled'));
    };

    const isInstalling = () => current !== null;

    const listInstalled = () => {
        try {
            return listInstalledVersions({ fs, manifest, platform, arch, root: runtimeRoot(), pathModule: path })
                .map(entry => entry.version);
        } catch (error) {
            logWarn('[HiFi] install: could not list installed mpv', error);
            return [];
        }
    };

    return { install, cancel, isInstalling, listInstalled };
};

module.exports = {
    PROGRESS_INTERVAL_MS,
    KEEP_VERSIONS,
    safeEntrySegments,
    createMpvRuntimeInstaller,
};
