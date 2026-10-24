import { useMemo } from 'react';
import type { HifiSignalPath } from '../../types/hifi';
import { useHifiEngineStore } from '../../services/hifi/hifiEngineStore';
import { useHifiTrackStore } from '../../services/hifi/hifiTrackStore';
import { buildSignalPath } from '../../services/hifi/signalPath';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';

// src/components/hifi/useHifiSignalPath.ts
// 播放界面读 HiFi 信号链路的两个 hook：现在是不是 HiFi 路线，以及当前曲目从源文件到声卡的每一级。

/** 当前这首歌由 mpv 发声。 */
export const useIsHifiRoute = () => usePlaybackStore(state => state.playbackRoute === 'hifi');

/**
 * 当前曲目的信号链路：源格式 + 主进程的引擎状态 + HiFi 设置。不在 HiFi 路线上时为 null。
 * 引擎状态还是上一首的（新曲目在载入）时不拿它比，结论先是 unknown，免得把上一首的输出格式安到这一首上。
 */
export const useHifiSignalPath = (): HifiSignalPath | null => {
    const isHifiRoute = useIsHifiRoute();
    const trackKey = useHifiTrackStore(state => state.current?.trackKey ?? null);
    const sourceSpec = useHifiTrackStore(state => state.sourceSpec);
    const engine = useHifiEngineStore(state => state.engine);
    const exclusive = useHifiSettingsStore(state => state.exclusive);
    const dsdMode = useHifiSettingsStore(state => state.dsdMode);
    const softwareVolume = useHifiSettingsStore(state => state.softwareVolume);
    // 和下发给主进程的一样：0–100 的整数，静音为 0。
    const volume = useAudioSettingsStore(state => (state.isMuted ? 0 : Math.round(state.volume * 100)));

    return useMemo(() => {
        if (!isHifiRoute) return null;
        const engineForTrack = engine && trackKey !== null && engine.trackKey === trackKey ? engine : null;
        return buildSignalPath(sourceSpec, engineForTrack, { exclusive, dsdMode, softwareVolume, volume });
    }, [isHifiRoute, trackKey, sourceSpec, engine, exclusive, dsdMode, softwareVolume, volume]);
};
