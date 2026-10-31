// src/utils/shortcutHints.ts
// 「快捷键显示」的生效值（docs/plans/2026-10-31-…-design.md §3.1）。
//
// Android 触屏上 kbd 键位徽章是噪音：默认不显示；插上物理键盘或鼠标（任一）才自动开启，
// 全部拔出自动回落。三态由设置页控制：auto（默认，跟随键鼠）/ on（强制显示）/ off（强制隐藏）。
// 桌面（Electron）useHidConnection 恒报接入 → auto 与「一直显示」行为一致，桌面零回归。
// 存储在 useInteractionSettingsStore（shortcut_hints_mode），这里只放纯判定，方便直测。

export const SHORTCUT_HINTS_MODES = ['auto', 'on', 'off'] as const;
export type ShortcutHintsMode = typeof SHORTCUT_HINTS_MODES[number];

/** 三态 → 是否显示键位徽章。hidConnected = 物理键盘或鼠标任一接入。 */
export const resolveShortcutHintsVisible = (mode: ShortcutHintsMode, hidConnected: boolean): boolean => (
    mode === 'on' ? true : mode === 'off' ? false : hidConnected
);

/** 存储值收敛：只认三个模式词，其余（含空）回默认 auto。 */
export const normalizeShortcutHintsMode = (raw: unknown): ShortcutHintsMode => (
    SHORTCUT_HINTS_MODES.includes(raw as ShortcutHintsMode) ? (raw as ShortcutHintsMode) : 'auto'
);
