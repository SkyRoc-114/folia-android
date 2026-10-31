import { describe, expect, it } from 'vitest';
import { resolveShortcutHintsVisible, SHORTCUT_HINTS_MODES, type ShortcutHintsMode } from '../../../src/utils/shortcutHints';

// 「快捷键显示」生效值（设计 §3.1）：三态 auto/on/off。
// auto 跟随键鼠接入（任一接入即开、全拔即关）；on/off 强制；默认 auto。
// 桌面 hidConnected 恒真 → auto 行为与「一直显示」一致，零回归。

describe('resolveShortcutHintsVisible', () => {
    it('auto follows hidConnected both ways', () => {
        expect(resolveShortcutHintsVisible('auto', true)).toBe(true);
        expect(resolveShortcutHintsVisible('auto', false)).toBe(false);
    });

    it('on forces visible even with nothing connected', () => {
        expect(resolveShortcutHintsVisible('on', false)).toBe(true);
        expect(resolveShortcutHintsVisible('on', true)).toBe(true);
    });

    it('off forces hidden even with devices connected', () => {
        expect(resolveShortcutHintsVisible('off', true)).toBe(false);
        expect(resolveShortcutHintsVisible('off', false)).toBe(false);
    });

    it('exposes exactly the three modes with auto first (the default)', () => {
        expect(SHORTCUT_HINTS_MODES).toEqual(['auto', 'on', 'off']);
    });

    it('narrows the mode type', () => {
        const mode: ShortcutHintsMode = 'auto';
        expect(mode).toBe('auto');
    });
});
