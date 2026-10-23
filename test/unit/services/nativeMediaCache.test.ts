import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/nativeMediaCache.test.ts
// 安卓媒体缓存的原生一侧：id 是 cacheKey 的 base64url、地址是回环 http、非安卓整条路径禁用，
// 本地服务不在时每个调用都静默失败（播放不能因为缓存等它）。

type StubOptions = {
    native?: boolean;
    platform?: string;
    port?: number | (() => Promise<unknown>);
    withPlugin?: boolean;
};

const fakeResponse = (fields: { ok?: boolean; status?: number; blob?: Blob; json?: unknown }): Response => ({
    ok: fields.ok ?? true,
    status: fields.status ?? 200,
    blob: async () => fields.blob ?? new Blob(['x']),
    json: async () => fields.json,
} as unknown as Response);

const stubWindow = (options: StubOptions = {}) => {
    const port = options.port ?? 41234;
    const plugin = options.withPlugin === false ? {} : {
        localAudioServerPort: vi.fn(async () => (typeof port === 'function' ? await port() : { port })),
    };
    const capacitor = {
        isNativePlatform: () => options.native === true,
        getPlatform: () => options.platform ?? (options.native ? 'android' : 'web'),
        Plugins: { FoliaNative: plugin },
    };
    vi.stubGlobal('window', { Capacitor: capacitor });
    return plugin;
};

const load = async () => {
    vi.resetModules();
    return import('@/services/nativeMediaCache');
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('native media cache ids and urls', () => {
    it('encodes the cache key as base64url of its UTF-8 bytes', async () => {
        const { nativeMediaCacheId } = await load();

        expect(nativeMediaCacheId('a')).toBe('YQ');
        const key = 'audio_online:\u7f51\u6613\u4e91:42';
        const id = nativeMediaCacheId(key);
        expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(Buffer.from(id, 'base64url').toString('utf8')).toBe(key);
    });

    it('builds the loopback URL from the port the plugin reports', async () => {
        stubWindow({ native: true, port: 43210 });
        const { nativeMediaCache, nativeMediaCacheId } = await load();

        await expect(nativeMediaCache.urlFor('audio_x')).resolves.toBe(
            'http://127.0.0.1:43210/media-cache/' + nativeMediaCacheId('audio_x'),
        );
    });

    it('refuses a key whose id would be longer than the server accepts', async () => {
        stubWindow({ native: true });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.urlFor('audio_' + 'x'.repeat(200))).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('outside the Android shell', () => {
    it.each([
        ['a browser', { native: false }],
        ['a native iOS shell', { native: true, platform: 'ios' }],
        ['an android shell without the plugin', { native: true, withPlugin: false }],
    ] as const)('stays out of the way on %s', async (_label, options) => {
        stubWindow(options);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.has('audio_x')).resolves.toBe(false);
        await expect(nativeMediaCache.readBlob('audio_x')).resolves.toBeNull();
        await expect(nativeMediaCache.save('audio_x', new Blob(['abc']))).resolves.toBe(false);
        await expect(nativeMediaCache.remove('audio_x', 3)).resolves.toBe(false);
        await expect(nativeMediaCache.clear()).resolves.toBe(false);
        await expect(nativeMediaCache.stats()).resolves.toBeNull();
        await expect(nativeMediaCache.urlFor('audio_x')).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is disabled when the plugin has no port to give', async () => {
        stubWindow({ native: true, port: 0 });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.has('audio_x')).resolves.toBe(false);
        await expect(nativeMediaCache.save('audio_x', new Blob(['abc']))).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('requests', () => {
    it('asks HEAD for existence and treats a non-2xx as absent', async () => {
        stubWindow({ native: true });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }))
            .mockResolvedValueOnce(fakeResponse({ ok: false, status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.has('audio_x')).resolves.toBe(true);
        await expect(nativeMediaCache.has('audio_x')).resolves.toBe(false);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
    });

    it('writes with PUT, the blob as the body and its mime type in the header', async () => {
        stubWindow({ native: true });
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse({ ok: true, status: 201 }));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'log').mockImplementation(() => { });
        const { nativeMediaCache } = await load();
        const blob = new Blob(['abc'], { type: 'audio/flac' });

        await expect(nativeMediaCache.save('audio_x', blob, 'audio/flac')).resolves.toBe(true);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/media-cache/');
        expect(init).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'audio/flac' } });
        expect(init?.body).toBe(blob);
    });

    it('answers false for a write the server refuses', async () => {
        stubWindow({ native: true });
        vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ ok: false, status: 500 })));
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.save('audio_x', new Blob(['abc']))).resolves.toBe(false);
    });

    it('reads the bytes over GET and hands back the blob', async () => {
        stubWindow({ native: true });
        const body = new Blob(['audio-bytes'], { type: 'audio/mpeg' });
        vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ ok: true, status: 200, blob: body })));
        const { nativeMediaCache } = await load();

        const blob = await nativeMediaCache.readBlob('audio_x');

        expect(blob).toBe(body);
    });

    it('deletes with the size it was read at, and clears the whole cache', async () => {
        stubWindow({ native: true });
        const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse({ ok: true, status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.remove('audio_x', 5)).resolves.toBe(true);
        expect(fetchMock.mock.calls[0][0]).toMatch(/\/media-cache\/[A-Za-z0-9_-]+\?size=5$/);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });

        await expect(nativeMediaCache.clear()).resolves.toBe(true);
        expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:41234/media-cache');
    });

    it('reads count and bytes from the stats route', async () => {
        stubWindow({ native: true });
        const fetchMock = vi.fn(async (_url: string) => fakeResponse({ ok: true, status: 200, json: { count: 3, bytes: 2048 } }));
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.stats()).resolves.toEqual({ count: 3, bytes: 2048 });
        expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:41234/media-cache-stats');
    });
});

describe('when the local service is not there', () => {
    it('swallows every failure instead of failing the caller', async () => {
        stubWindow({ native: true });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.has('audio_x')).resolves.toBe(false);
        await expect(nativeMediaCache.readBlob('audio_x')).resolves.toBeNull();
        await expect(nativeMediaCache.save('audio_x', new Blob(['abc']))).resolves.toBe(false);
        await expect(nativeMediaCache.remove('audio_x', 3)).resolves.toBe(false);
        await expect(nativeMediaCache.clear()).resolves.toBe(false);
        await expect(nativeMediaCache.stats()).resolves.toBeNull();
    });

    it('is a miss, not a crash, when the bridge itself fails', async () => {
        stubWindow({ native: true, port: async () => { throw new Error('bridge is gone'); } });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { nativeMediaCache } = await load();

        await expect(nativeMediaCache.urlFor('audio_x')).resolves.toBeNull();
        await expect(nativeMediaCache.has('audio_x')).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
