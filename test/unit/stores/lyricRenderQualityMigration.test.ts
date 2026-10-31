import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stores read localStorage at import time; the store layer maps it through storagePrimitives, and
// persistence helpers touch window.localStorage directly. Stub it before the imports run.
vi.hoisted(() => {
    const items = new Map<string, string>();
    // storagePrimitives 有 typeof window === 'undefined' 的 SSR guard：node 环境里把 window 指回 globalThis。
    (globalThis as { window?: unknown }).window = globalThis;
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: (key: string, value: string) => { items.set(key, String(value)); },
            removeItem: (key: string) => { items.delete(key); },
            clear: () => items.clear(),
            key: (index: number) => Array.from(items.keys())[index] ?? null,
            get length() { return items.size; },
        },
    });
});

import { readStoredLyricRenderQuality } from '../../../src/stores/visualizerSettingsPersistence';
import { LYRIC_RENDER_QUALITY_STORAGE_KEY } from '../../../src/utils/lyricRenderQuality';

// 旧 #929 实现（d9796d6a）的 lyrics_antialias 布尔，迁到 Folium 1.8 的 lyric_render_quality 挡位：
// true → {scale:1, antialias:'on'}（旧用户明确要 MSAA，尊重）；false/未设 → 默认（auto）。
// 迁移是一次性的：搬完写新键、删旧键；新键已存在时旧键视为陈旧残留，直接清。

const LEGACY_KEY = 'lyrics_antialias';

describe('lyrics_antialias legacy migration (Folium 1.8)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('migrates lyrics_antialias=true to {scale:1, antialias:on} and removes the legacy key', () => {
        localStorage.setItem(LEGACY_KEY, 'true');
        expect(readStoredLyricRenderQuality()).toEqual({ scale: 1, antialias: 'on' });
        expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
        expect(JSON.parse(localStorage.getItem(LYRIC_RENDER_QUALITY_STORAGE_KEY)!)).toEqual({ scale: 1, antialias: 'on' });
    });

    it('migrates lyrics_antialias=false to the default and removes the legacy key', () => {
        localStorage.setItem(LEGACY_KEY, 'false');
        expect(readStoredLyricRenderQuality()).toEqual({ scale: 1, antialias: 'auto' });
        expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
        expect(JSON.parse(localStorage.getItem(LYRIC_RENDER_QUALITY_STORAGE_KEY)!)).toEqual({ scale: 1, antialias: 'auto' });
    });

    it('keeps an existing lyric_render_quality value and cleans the stale legacy key', () => {
        localStorage.setItem(LYRIC_RENDER_QUALITY_STORAGE_KEY, JSON.stringify({ scale: 0.5, antialias: 'off' }));
        localStorage.setItem(LEGACY_KEY, 'true');
        expect(readStoredLyricRenderQuality()).toEqual({ scale: 0.5, antialias: 'off' });
        expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it('defaults with neither key set', () => {
        expect(readStoredLyricRenderQuality()).toEqual({ scale: 1, antialias: 'auto' });
        expect(localStorage.getItem(LYRIC_RENDER_QUALITY_STORAGE_KEY)).toBeNull();
    });
});
