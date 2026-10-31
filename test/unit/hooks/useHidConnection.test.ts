import { afterEach, describe, expect, it, vi } from 'vitest';
import { fallbackMouseConnected, hidPluginOf } from '@/hooks/useHidConnection';

// 键鼠接入判定的纯件（设计 §3.1）：安卓壳里插件查询+事件；桌面恒接入；无插件环境 matchMedia 兜底。
// React 接线很薄，node 环境下测纯件。插件负载的解析（applyHidPayload）随重构搬进了
// useHidDevicesStore —— 那边的测试文件管它。

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('hidPluginOf', () => {
    it('returns null without a Capacitor plugin (node / browser)', () => {
        expect(hidPluginOf()).toBeNull();
    });

    it('finds FoliaNative under Capacitor.Plugins', () => {
        const plugin = { getConnectedHidDevices: async () => ({ keyboard: true, mouse: true }) };
        vi.stubGlobal('window', { Capacitor: { Plugins: { FoliaNative: plugin } } });
        expect(hidPluginOf()).toBe(plugin);
    });

    it('returns null when Capacitor exists but FoliaNative does not', () => {
        vi.stubGlobal('window', { Capacitor: { Plugins: {} } });
        expect(hidPluginOf()).toBeNull();
    });
});

describe('fallbackMouseConnected', () => {
    it('is false without a window (node)', () => {
        expect(fallbackMouseConnected()).toBe(false);
    });

    it('reads the fine-pointer media query when a window exists', () => {
        const matchMedia = vi.fn().mockReturnValue({ matches: true });
        vi.stubGlobal('window', { matchMedia });
        expect(fallbackMouseConnected()).toBe(true);
        expect(matchMedia).toHaveBeenCalledWith('(hover: hover) and (pointer: fine)');
    });
});
