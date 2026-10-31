// src/hooks/useShortcutHintsVisible.ts
// 「快捷键显示」的生效值hook（docs/plans/2026-10-31-…-design.md §3.2）：
// 三态 store（auto/on/off）× 键鼠接入 → 该不该画 kbd 键位徽章。
// 消费方：WallToolsRows（工具岛菜单）、LatticeFocusButton（帮助列表）、BravaisStageChrome（快动作格）。
// 教程 keycap 走 ponderOnboardingShared 的运行时分镜选择（同一生效值的另一面）；HelpPage 不受控。

import { useInteractionSettingsStore } from '../stores/useInteractionSettingsStore';
import { resolveShortcutHintsVisible } from '../utils/shortcutHints';
import { useHidConnection } from './useHidConnection';

export const useShortcutHintsVisible = (): boolean => {
    const mode = useInteractionSettingsStore(state => state.shortcutHintsMode);
    const { hidConnected } = useHidConnection();
    return resolveShortcutHintsVisible(mode, hidConnected);
};
