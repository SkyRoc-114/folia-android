import React, { useEffect } from 'react';
import { BadgeCheck, CircleHelp, Merge, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HifiSignalPath, HifiSignalStage, HifiSignalStageStatus, HifiSignalVerdict } from '../../types/hifi';
import { useHifiTrackStore } from '../../services/hifi/hifiTrackStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import Sheet from '../shared/Sheet';
import { useHifiPanelStore } from './hifiPanelStore';
import {
    describeConversion,
    describeStage,
    formatStageFormat,
    isConversionLossless,
    stageLabel,
    stageStatusLabel,
    verdictDescription,
    verdictTitle,
} from './hifiSignalText';
import { useHifiSignalPath, useIsHifiRoute } from './useHifiSignalPath';

// src/components/hifi/HifiSignalPathPanel.tsx
// HiFi 信号链路面板：顶上一行大字说结论（原生直通 / 经 DoP 原生输出 DSD / 已转换 / 经过系统混音器 / 尚未确认），
// 下面从源文件到输出设备逐级列出每一级的状态、格式和改动，底部注明 HiFi 绕过了哪些功能。
// 在 AppOverlays 里挂一次，开关由 hifiPanelStore 管；路线离开 HiFi 时自己关上。

const VERDICT_LOOK: Record<HifiSignalVerdict, { icon: LucideIcon; className: string }> = {
    'bit-perfect': { icon: BadgeCheck, className: 'text-[color:var(--st-ok)]' },
    dop: { icon: BadgeCheck, className: 'text-[color:var(--st-ok)]' },
    converted: { icon: TriangleAlert, className: 'text-[color:var(--st-warn)]' },
    'shared-mixer': { icon: Merge, className: 'text-[color:var(--st-warn)]' },
    unknown: { icon: CircleHelp, className: 'text-[color:var(--st-t3)]' },
};

const STATUS_CHIP_CLASS: Record<HifiSignalStageStatus, string> = {
    passthrough: 'bg-[color-mix(in_srgb,var(--st-ok)_14%,transparent)] text-[color:var(--st-ok)]',
    converted: 'bg-[color-mix(in_srgb,var(--st-warn)_14%,transparent)] text-[color:var(--st-warn)]',
    bypassed: 'bg-[var(--st-fill)] text-[color:var(--st-t2)]',
    unknown: 'bg-[var(--st-fill)] text-[color:var(--st-t3)]',
};

const STATUS_DOT_CLASS: Record<HifiSignalStageStatus, string> = {
    passthrough: 'bg-[var(--st-ok)]',
    converted: 'bg-[var(--st-warn)]',
    bypassed: 'bg-[var(--st-t3)]',
    unknown: 'bg-[var(--st-line2)]',
};

type StageRowProps = {
    stage: HifiSignalStage;
    path: HifiSignalPath;
    origin: 'local' | 'navidrome' | null;
    /** 输出级上设置里记着的设备名（比 mpv 的设备 id 好认）。 */
    deviceLabel: string | null;
    isLast: boolean;
};

const StageRow: React.FC<StageRowProps> = ({ stage, path, origin, deviceLabel, isLast }) => {
    const { t, i18n } = useTranslation();
    const format = formatStageFormat(stage, t, i18n.language);
    const description = describeStage(stage, path, origin, t);

    return (
        <li className="flex gap-3">
            {/* 左边一条竖线把五级串起来，点的颜色就是这一级的状态。 */}
            <div aria-hidden className="flex w-2.5 shrink-0 flex-col items-center">
                <span className={`mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[stage.status]}`} />
                {!isLast && <span className="mt-1 w-px flex-1 bg-[var(--st-line)]" />}
            </div>
            <div className={`min-w-0 flex-1${isLast ? '' : ' pb-4'}`}>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium leading-5">{stageLabel(stage.id, t)}</span>
                    <span className={`shrink-0 rounded px-1.5 text-[11px] leading-[18px] ${STATUS_CHIP_CLASS[stage.status]}`}>
                        {stageStatusLabel(stage.status, t)}
                    </span>
                </div>
                {format && <p className="mt-0.5 text-[13px] leading-5 tabular-nums">{format}</p>}
                {description && <p className="text-xs leading-[18px] text-[color:var(--st-t2)]">{description}</p>}
                {stage.id === 'output' && deviceLabel && (
                    <p className="text-xs leading-[18px] text-[color:var(--st-t2)]">{deviceLabel}</p>
                )}
                {stage.detail && (
                    <p className="break-all font-mono text-[11px] leading-4 text-[color:var(--st-t3)]">{stage.detail}</p>
                )}
                {stage.conversions.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5">
                        {stage.conversions.map(conversion => (
                            <li
                                key={conversion}
                                className={`text-xs leading-[18px] ${isConversionLossless(conversion) ? 'text-[color:var(--st-ok)]' : 'text-[color:var(--st-warn)]'}`}
                            >
                                {describeConversion(conversion, path, t, i18n.language)}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </li>
    );
};

const HifiSignalPathPanel: React.FC = () => {
    const { t } = useTranslation();
    const isOpen = useHifiPanelStore(state => state.isSignalPathOpen);
    const close = useHifiPanelStore(state => state.closeSignalPath);
    const isHifiRoute = useIsHifiRoute();
    const path = useHifiSignalPath();
    const songName = useHifiTrackStore(state => state.current?.song.name ?? null);
    const origin = useHifiTrackStore(state => state.current?.origin ?? state.sourceSpec?.origin ?? null);
    const audioDevice = useHifiSettingsStore(state => state.audioDevice);
    const audioDeviceLabel = useHifiSettingsStore(state => state.audioDeviceLabel);

    // 换成 Web 引擎的歌（或停下）之后，这扇窗说的已经不是正在放的东西了。
    useEffect(() => {
        if (isOpen && !isHifiRoute) close();
    }, [isOpen, isHifiRoute, close]);

    const look = path ? VERDICT_LOOK[path.verdict] : null;
    const deviceLabel = path && audioDeviceLabel && path.output.device === audioDevice ? audioDeviceLabel : null;

    // 一直画同一个 Sheet，关上时它还能带着最后的内容退场。
    return (
        <Sheet
            isOpen={isOpen && path !== null}
            onClose={close}
            size="m"
            title={t('hifi.signal.title')}
            subtitle={songName ?? undefined}
            footerNote={t('hifi.signal.bypassedNote')}
        >
            {path && look && (
                <>
                    <section className="flex items-start gap-3 rounded-xl bg-[var(--st-card)] px-4 py-3.5 shadow-[0_0_0_1px_var(--st-line)]">
                        <look.icon size={22} aria-hidden className={`mt-0.5 shrink-0 ${look.className}`} />
                        <div className="min-w-0 flex-1">
                            <p role="status" className="text-lg font-semibold leading-7">{verdictTitle(path.verdict, t)}</p>
                            <p className="mt-0.5 text-[13px] leading-5 text-[color:var(--st-t2)]">{verdictDescription(path.verdict, t)}</p>
                        </div>
                    </section>
                    <ol aria-label={t('hifi.signal.stagesLabel')} className="mt-5 px-1">
                        {path.stages.map((stage, index) => (
                            <StageRow
                                key={stage.id}
                                stage={stage}
                                path={path}
                                origin={origin}
                                deviceLabel={deviceLabel}
                                isLast={index === path.stages.length - 1}
                            />
                        ))}
                    </ol>
                </>
            )}
        </Sheet>
    );
};

export default HifiSignalPathPanel;
