import { setPlaybackRoute, usePlaybackStore } from '../../stores/usePlaybackStore';
import { hifiEngine } from './hifiEngine';
import { clearHifiTrack, nextHifiAttempt, useHifiTrackStore } from './hifiTrackStore';

// src/services/hifi/hifiRouteGuard.ts
// 离开 HiFi 路线的唯一出口：Web 引擎接手（audioSrc 有值）、Stage 接管、或别处把路线改回 web 时，当场停掉 mpv、放开独占的设备。

export const isHifiRoute = () => usePlaybackStore.getState().playbackRoute === 'hifi';

// beginHifiTrack 自己写 audioSrc / playbackRoute 的那几下，以及 leaveHifiRoute 自己切路线的那一下，守卫不管。
let ownWriteDepth = 0;

export const withoutRouteGuard = (write: () => void) => {
    ownWriteDepth += 1;
    try {
        write();
    } finally {
        ownWriteDepth -= 1;
    }
};

/** 作废进行中的起播，清掉当前曲目、shim 和登记的文件，停掉 mpv。 */
const releaseHifi = (reason: string) => {
    nextHifiAttempt();
    const trackKey = useHifiTrackStore.getState().current?.trackKey ?? null;
    clearHifiTrack();
    hifiEngine.responder.clear();
    void hifiEngine.stop();
    console.info('[HiFi] left the HiFi route', { reason, trackKey });
};

/**
 * 离开 HiFi 路线，给那些停播却不设 Web 源的路径用（如切换资料库平台）。不在 HiFi 路线上、也没有当前曲目时什么都不做。
 * 先停 mpv、清曲目、重置 shim，再把路线切回 web，全在这一次调用里同步发出：对路线变化同步做出反应的订阅者看到的 mpv 已经停了。
 */
export const leaveHifiRoute = (reason = 'explicit') => {
    if (!isHifiRoute() && !useHifiTrackStore.getState().current) return false;
    releaseHifi(reason);
    withoutRouteGuard(() => setPlaybackRoute('web'));
    return true;
};

/**
 * zustand 的订阅在 setState 里同步执行，早于 React 渲染、也早于 <audio> 换源：Web 引擎接手的那一下 mpv 已经停了，
 * 独占的设备先放开。返回退订函数。
 */
export const installHifiRouteGuard = () => usePlaybackStore.subscribe((state, previous) => {
    if (ownWriteDepth > 0) return;
    if (state.playbackRoute === 'hifi') {
        if (state.audioSrc !== null) leaveHifiRoute('web source');
        else if (state.activePlaybackContext === 'stage') leaveHifiRoute('stage');
        return;
    }
    // 别处直接把路线改回了 web：曲目、shim 和 mpv 跟着收拾。
    if (previous.playbackRoute === 'hifi') releaseHifi('route set to web');
});
