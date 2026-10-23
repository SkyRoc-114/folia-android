import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { PlayerState } from '../../types';
import { setDuration, setPlayerState } from '../../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { currentTime } from '../../stores/motionSignals';
import { buildNativeDspOptions } from './nativeDsp';
import { nativePlaybackEngine } from './nativePlaybackEngine';
import type { NativeFallbackReason } from './nativeFallback';
import { nativeTransportFade } from './nativeTransportFade';

// src/services/playbackEngine/useNativePlaybackRuntime.ts
//
// 把原生播放器接进现有的播放状态机。这一层只补「`<audio>` 元素原来自己干的那几件事」：
//   · 地址来了 → 装进播放器（原来靠 `src` 属性）
//   · 想自动播 → 调 play（原来在 usePlaybackAudioBridge 里由 shouldAutoPlay 驱动）
//   · 时长出来了 → 写 duration（原来 `onLoadedMetadata`）
//   · 播完了 → 交给队列（原来 `onEnded`）
//   · 播不出来 → 报错（原来 `onError`）
//   · 频谱开关随「原生在播 + 页面可见 + 真的要频谱」变化
//   · 均衡器/音效 → 原生 DSP（只在接管这一首时发；设置一变立即补发）
//
// 剩下的（音量、seek、暂停、进度条时钟）分别在 syncOutputGain / seekMainAudio /
// transport / usePlaybackVisualizerBridge 里各接一次。
//
// ⚠️ 时钟不在这里写：进度条与歌词由 usePlaybackVisualizerBridge 的 rAF 统一从
// `nativePlaybackEngine.getPositionSec()` 读，避免两个写手抢同一个 motion signal。
// 唯一的例外是页面隐藏时：rAF 被 Chromium 停掉，那时只有这里的事件能推进通知栏进度。

type UseNativePlaybackRuntimeOptions = {
    /** 设置开着且插件在（nativeActive）。关掉时这一层完全不参与。 */
    enabled: boolean;
    /** 这一首真的交给原生（nativeActive && 源支持 && 没有 Web Audio 专属功能）。 */
    takes: boolean;
    /** 不接管时的原因，用于日志与诊断。 */
    fallbackReason: NativeFallbackReason | null;
    audioSrc: string | null;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    isLyricsLoading: boolean;
    getTargetPlaybackVolume: () => number;
    /** 网页路径播到哪了：从网页切到原生时从这里续。 */
    getResumePositionSec: () => number;
    /** 单曲循环交给 ExoPlayer 自己重复，Web 侧就收不到 `ended` 了（这正是想要的）。 */
    repeatOne: boolean;
    /** 现在有东西要画频谱（可视化在屏幕上 / 壁纸模式）。 */
    spectrumWanted: boolean;
    onEnded: () => void;
    onError: (message: string) => void;
};

const pageVisible = (): boolean => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
);

export const useNativePlaybackRuntime = ({
    enabled,
    takes,
    fallbackReason,
    audioSrc,
    shouldAutoPlayRef,
    isLyricsLoading,
    getTargetPlaybackVolume,
    getResumePositionSec,
    repeatOne,
    spectrumWanted,
    onEnded,
    onError,
}: UseNativePlaybackRuntimeOptions): void => {
    // 回调每次渲染都换身份，进 effect 依赖会把订阅反复重建。
    const callbacksRef = useRef({ onEnded, onError, getTargetPlaybackVolume, getResumePositionSec });
    callbacksRef.current = { onEnded, onError, getTargetPlaybackVolume, getResumePositionSec };
    const takesRef = useRef(takes);
    takesRef.current = takes;
    const wantedRef = useRef(spectrumWanted);
    wantedRef.current = spectrumWanted;
    const decisionKeyRef = useRef('');

    /*
     * 均衡器与音效：读听众自己的设置、mod 曲线和挂起状态，算出实际听到的那一组。
     *
     * 只在原生真的接管这一首时交给引擎；回落网页时一个字节也不发 —— 网页路径的 Web Audio
     * 图自己会处理（usePlaybackAudioBridge）。enabled=false 也照发：Java 收下参数并旁路，
     * 这样开关均衡器不需要重新 prepare 这一首。
     */
    const audioEqualizerSettings = useAudioSettingsStore(state => state.audioEqualizerSettings);
    const audioEqualizerModCurve = useAudioSettingsStore(state => state.audioEqualizerModCurve);
    const audioEqualizerModCurveSuspended = useAudioSettingsStore(state => state.audioEqualizerModCurveSuspended);
    const dspOptions = useMemo(
        () => buildNativeDspOptions(audioEqualizerSettings, audioEqualizerModCurve, audioEqualizerModCurveSuspended),
        [audioEqualizerSettings, audioEqualizerModCurve, audioEqualizerModCurveSuspended],
    );
    /** 上一次发出去的是哪一首、哪一组设置：同一首歌同一组设置不重发。 */
    const dspSentRef = useRef<{ source: string | null; signature: string }>({ source: null, signature: '' });

    // 本首是接管还是回落：日志一条、诊断计数一次（同一首同一原因不重复记）。
    useEffect(() => {
        const key = `${audioSrc ?? ''}|${takes}|${fallbackReason ?? ''}`;
        if (key === decisionKeyRef.current) return;
        decisionKeyRef.current = key;
        if (!audioSrc) {
            nativePlaybackEngine.noteDecision(false, fallbackReason, null);
            return;
        }
        if (takes) {
            nativePlaybackEngine.noteTakeover(audioSrc);
        } else {
            nativePlaybackEngine.noteFallback(fallbackReason ?? 'unknown', audioSrc);
        }
    }, [audioSrc, fallbackReason, takes]);

    // 频谱开关的唯一判定：原生在播 + 页面可见 + 有东西要看。
    const syncSpectrum = useCallback(() => {
        const shouldEnable = enabled
            && takesRef.current
            && wantedRef.current
            && pageVisible()
            && nativePlaybackEngine.isPlaying();
        nativePlaybackEngine.setSpectrumEnabled(shouldEnable);
    }, [enabled]);

    // 地址 → 播放器。blob 地址（媒体缓存副本 / 本地歌）原生吃不下，那种歌整首回落到 <audio>。
    useEffect(() => {
        if (!enabled) return;
        nativeTransportFade.cancel();
        if (takes && audioSrc) {
            // 先记下循环模式：切歌那一刻才用得上；已经在播的这一首由 App 的 onEnded 兜底重播。
            nativePlaybackEngine.setRepeatMode(repeatOne ? 1 : 0);
            if (nativePlaybackEngine.activeUrl() === audioSrc) return;
            const startPositionMs = Math.max(0, Math.round(callbacksRef.current.getResumePositionSec() * 1000));
            void nativePlaybackEngine.setSource(audioSrc, { startPositionMs }).catch(error => {
                console.error('[NativePlayer] prepare failed', error);
                callbacksRef.current.onError(String(error));
            });
            return;
        }
        if (nativePlaybackEngine.ownsPlayback()) {
            // 保留位置：回落网页路径时从原生停下的地方续。
            void nativePlaybackEngine.stop().catch(() => undefined);
        }
    }, [audioSrc, enabled, repeatOne, takes]);

    /*
     * 均衡器 + 音效 → 原生 DSP。放在装地址之后：这一首已经进播放器（currentUrl 已设），参数不会跑到
     * prepare 前面太远。三种时机各发一次：
     *   1. 开始接管这一首（换歌 / 从网页切回原生）—— 原生重新 prepare 过，参数再落一次；
     *   2. 接管过程中设置变化（拖均衡器、开音效、mod 曲线生效/挂起）—— 立即补发，不等切歌；
     *   3. 重新接管同一首（回落过又回来）—— 上面清过记号，按 1 处理。
     * 回落网页时清掉记号且不发送：网页路径有自己的 Web Audio 图。
     */
    useEffect(() => {
        if (!takes || !audioSrc) {
            dspSentRef.current = { source: null, signature: '' };
            return;
        }
        const signature = JSON.stringify(dspOptions);
        const freshTakeover = dspSentRef.current.source !== audioSrc;
        if (!freshTakeover && signature === dspSentRef.current.signature) return;
        dspSentRef.current = { source: audioSrc, signature };
        // freshTakeover 时强制重发：引擎按 payload 去重，换歌后的同一组设置本来会被它挡掉。
        nativePlaybackEngine.setDsp(dspOptions, { force: freshTakeover });
    }, [audioSrc, dspOptions, takes]);

    // 设置关掉、或插件消失 → 收掉播放器，别让上一首在后台继续响。
    useEffect(() => {
        if (enabled) return;
        nativeTransportFade.cancel();
        if (nativePlaybackEngine.ownsPlayback()) {
            void nativePlaybackEngine.stop().catch(() => undefined);
        }
    }, [enabled]);

    // 自动播放。`shouldAutoPlayRef` 由 playSong 置位，Web 那条路（元素 src 对不上）会自然跳过。
    useEffect(() => {
        if (!takes || !audioSrc || isLyricsLoading) return;
        if (!shouldAutoPlayRef.current) return;
        shouldAutoPlayRef.current = false;
        nativePlaybackEngine.setVolume(callbacksRef.current.getTargetPlaybackVolume(), { immediate: true });
        void nativePlaybackEngine.play().catch(error => {
            console.error('[NativePlayer] play failed', error);
            callbacksRef.current.onError(String(error));
        });
    }, [audioSrc, isLyricsLoading, shouldAutoPlayRef, takes]);

    // 播放器事件 → 现有状态机 + 频谱开关的随动。
    useEffect(() => {
        if (!enabled) {
            nativePlaybackEngine.setSpectrumEnabled(false);
            return undefined;
        }
        const unsubscribe = nativePlaybackEngine.subscribe(event => {
            /*
             * 位置也在这里落一次 —— 只在页面不可见时。
             *
             * 前台时 rAF 每帧都在写（插值过的、更平滑），这里再写一次只是把 500ms 前的采样值
             * 覆盖回去：每秒两次、每次往回退最多半秒，歌词就会看得见的抖。切到后台以后 rAF
             * 直接被 Chromium 停掉，那时候只剩这一条 —— 通知栏那条进度条才走得动。
             */
            const hidden = !pageVisible();
            if (hidden && 'positionMs' in event && typeof event.positionMs === 'number' && event.type !== 'ready') {
                currentTime.set(nativePlaybackEngine.getPositionSec());
            }
            switch (event.type) {
                case 'ready':
                    if (typeof event.durationMs === 'number' && event.durationMs > 0) {
                        setDuration(event.durationMs / 1000);
                    }
                    break;
                /*
                 * 播放状态也由原生事件回来。没有这一档，自动播放（以及 Java 自己接的耳机键 / 系统
                 * 控件）开始或停下时，transport 会一直停在 IDLE —— 界面显示暂停，声音却在放。
                 * 暂停仍在淡出的那 150ms 里，元素侧的同一条规则同样适用：这时收到 playing
                 * 不该把界面翻回播放。
                 */
                case 'playing':
                    if (!nativeTransportFade.isFadingOut()) {
                        setPlayerState(PlayerState.PLAYING);
                    }
                    break;
                case 'paused':
                    setPlayerState(PlayerState.PAUSED);
                    break;
                case 'ended':
                    callbacksRef.current.onEnded();
                    break;
                case 'error':
                    callbacksRef.current.onError(('message' in event && event.message) || 'unknown');
                    break;
                default:
                    break;
            }
            syncSpectrum();
        });
        const onVisibilityChange = () => syncSpectrum();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibilityChange);
        }
        syncSpectrum();
        return () => {
            unsubscribe();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibilityChange);
            }
            nativePlaybackEngine.setSpectrumEnabled(false);
        };
    }, [enabled, syncSpectrum]);

    // 暂停/停止/回到前台都会走事件；这里补「页面可见性/可视化挂载」变化时的一次同步。
    useEffect(() => {
        syncSpectrum();
    }, [syncSpectrum, takes, spectrumWanted]);
};
