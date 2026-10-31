import { beforeEach, describe, expect, it } from 'vitest';
import { applyHidPayload, useHidDevicesStore } from '../../../src/stores/useHidDevicesStore';
import { selectOnboardingTouchStoryboard } from '../../../src/components/ponder/targets/basics/ponderOnboardingShared';

// 键鼠接入的共享状态（设计 §3.1/§3.2）：
// HID 设备状态从 useHidConnection 的 React state 提升成 zustand store —— 教程分镜选择
// 在非 React 的注册表层也要读得到。applyHidPayload 是唯一的写入口（插件负载/桌面常量都走它）。
// 教程分镜选择器：键鼠接入（任一）→ 桌面分镜；无键鼠且无细指针 → 触屏分镜。

beforeEach(() => {
    useHidDevicesStore.setState({ keyboard: false, mouse: false });
});

describe('useHidDevicesStore', () => {
    it('derives hidConnected from either device', () => {
        applyHidPayload({ keyboard: true, mouse: false });
        expect(useHidDevicesStore.getState().hidConnected).toBe(true);
        applyHidPayload({ keyboard: false, mouse: true });
        expect(useHidDevicesStore.getState().hidConnected).toBe(true);
        applyHidPayload({ keyboard: false, mouse: false });
        expect(useHidDevicesStore.getState().hidConnected).toBe(false);
    });

    it('treats anything but strict true as not connected', () => {
        applyHidPayload({ keyboard: 1, mouse: 'yes' });
        expect(useHidDevicesStore.getState()).toMatchObject({ keyboard: false, mouse: false, hidConnected: false });
    });

    it('treats garbage payloads as everything unplugged', () => {
        applyHidPayload({ keyboard: true });
        expect(useHidDevicesStore.getState().hidConnected).toBe(true);
        applyHidPayload(null);
        expect(useHidDevicesStore.getState()).toMatchObject({ keyboard: false, mouse: false, hidConnected: false });
        applyHidPayload('keyboard');
        expect(useHidDevicesStore.getState()).toMatchObject({ keyboard: false, mouse: false, hidConnected: false });
        applyHidPayload(undefined);
        expect(useHidDevicesStore.getState()).toMatchObject({ keyboard: false, mouse: false, hidConnected: false });
    });
});

describe('selectOnboardingTouchStoryboard', () => {
    it('plays the touch storyboard only with no HID devices and a coarse pointer', () => {
        expect(selectOnboardingTouchStoryboard(true, false)).toBe(true);
    });

    it('a plugged keyboard or mouse switches to the desktop storyboard', () => {
        expect(selectOnboardingTouchStoryboard(true, true)).toBe(false);
    });

    it('a fine pointer (browser mouse) keeps the desktop storyboard even without HID report', () => {
        expect(selectOnboardingTouchStoryboard(false, false)).toBe(false);
    });

    it('desktop stays desktop no matter what', () => {
        expect(selectOnboardingTouchStoryboard(false, true)).toBe(false);
    });
});
