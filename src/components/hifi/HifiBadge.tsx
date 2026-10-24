import React from 'react';
import { useTranslation } from 'react-i18next';
import { openHifiSignalPath } from './hifiPanelStore';
import { formatHifiBadge, verdictTone, type HifiVerdictTone } from './hifiSignalText';
import { useHifiSignalPath } from './useHifiSignalPath';

// src/components/hifi/HifiBadge.tsx
// 播放胶囊进度条旁的 HiFi 小牌子：结论加输出格式，如「HiFi · 原生直通 · 96 kHz / 24 bit」，点一下打开信号链路面板。
// 只在 HiFi 路线上出现。胶囊在面板外面，--st-* 到不了这里，颜色只用根变量。

type HifiBadgeProps = {
    isDaylight?: boolean;
    disabled?: boolean;
};

// 日间胶囊是半透明白底，底色要深一点才看得出。
const TONE_CLASS: Record<HifiVerdictTone, { day: string; night: string }> = {
    accent: {
        day: 'text-[color:var(--text-accent)] bg-[color-mix(in_srgb,var(--text-accent)_18%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-accent)_26%,transparent)]',
        night: 'text-[color:var(--text-accent)] bg-[color-mix(in_srgb,var(--text-accent)_14%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-accent)_22%,transparent)]',
    },
    muted: {
        day: 'text-[color:var(--text-secondary)] bg-[color-mix(in_srgb,var(--text-secondary)_14%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-secondary)_22%,transparent)]',
        night: 'text-[color:var(--text-secondary)] bg-[color-mix(in_srgb,var(--text-secondary)_12%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--text-secondary)_20%,transparent)]',
    },
};

const HifiBadge: React.FC<HifiBadgeProps> = ({ isDaylight = false, disabled = false }) => {
    const { t, i18n } = useTranslation();
    const path = useHifiSignalPath();

    if (!path) {
        return null;
    }

    const { text, shortText } = formatHifiBadge(path, t, i18n.language);
    const tone = TONE_CLASS[verdictTone(path.verdict)][isDaylight ? 'day' : 'night'];

    return (
        <button
            type="button"
            aria-haspopup="dialog"
            aria-label={t('hifi.player.badgeAria', { badge: text })}
            disabled={disabled}
            onClick={(event) => {
                // 胶囊本身点一下会去播放页。
                event.stopPropagation();
                openHifiSignalPath();
            }}
            className={`shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-4 tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${tone}`}
        >
            {/* 窄屏上进度条已经很短，只写结论。 */}
            <span className="sm:hidden">{shortText}</span>
            <span className="max-sm:hidden">{text}</span>
        </button>
    );
};

export default HifiBadge;
