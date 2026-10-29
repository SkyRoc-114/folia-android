import { useEffect } from 'react';
import { useBackgroundLyricHoldStore } from './backgroundLyricHoldStore';
import { useDesktopSettingsStore } from '../../../stores/useDesktopSettingsStore';

// src/components/app/backgroundThrottling/useBackgroundLyricHold.ts
// Holds the lyric animation while 后台节流 is in force and the window is out of sight. The main
// process says both (electron/backgroundThrottling.cjs): whether the switch is in force, and whether
// the window is minimised or hidden to the tray. A page Chromium reports hidden (covered, where it
// can tell) counts too. Losing the focus alone does not: a window still on screen keeps moving.
//
// Android (Capacitor) has no main process. The switch is read from the same persisted desktop
// settings store, and "hidden" comes from the native app lifecycle: the Capacitor bridge fires
// appStateChange when the activity pauses and resumes. The whole branch degrades to no throttling
// when the App plugin is missing from the installed package.

type BackgroundThrottlingState = { active: boolean; hidden: boolean };

const isLyricHeld = (state: BackgroundThrottlingState, visibility: DocumentVisibilityState) => (
    state.active && (state.hidden || visibility === 'hidden')
);

export const useBackgroundLyricHold = () => {
    useEffect(() => {
        const electron = window.electron;
        if (electron?.getBackgroundThrottlingState) {
            let state: BackgroundThrottlingState = { active: false, hidden: false };
            let disposed = false;
            const sync = () => {
                const held = isLyricHeld(state, document.visibilityState);
                if (useBackgroundLyricHoldStore.getState().held !== held) {
                    useBackgroundLyricHoldStore.setState({ held });
                }
            };

            const unsubscribe = electron.onBackgroundThrottlingChanged?.((next) => {
                state = next;
                sync();
            });
            electron.getBackgroundThrottlingState()
                .then((next) => {
                    if (disposed) return;
                    state = next;
                    sync();
                })
                .catch(error => console.warn('[BackgroundThrottling] Reading the switch failed', error));
            document.addEventListener('visibilitychange', sync);

            return () => {
                disposed = true;
                unsubscribe?.();
                document.removeEventListener('visibilitychange', sync);
                useBackgroundLyricHoldStore.setState({ held: false });
            };
        }

        // Android 分支：Capacitor 原生壳。开关与桌面同源（useDesktopSettingsStore.backgroundThrottling，
        // 持久化在 localStorage 的 background_throttling）；hidden 来自 @capacitor/app 的
        // appStateChange。插件缺席（旧安装包未同步原生插件）时降级为不节流。
        const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
        if (!capacitor?.isNativePlatform?.()) {
            return;
        }

        let disposed = false;
        let removeAppListener: (() => void) | null = null;
        let appHidden = false;

        const sync = () => {
            const held = isLyricHeld(
                { active: useDesktopSettingsStore.getState().backgroundThrottling, hidden: appHidden },
                document.visibilityState,
            );
            if (useBackgroundLyricHoldStore.getState().held !== held) {
                useBackgroundLyricHoldStore.setState({ held });
            }
        };

        // 开关变化不重绑原生监听，订阅即可。
        const unsubscribeSettings = useDesktopSettingsStore.subscribe(sync);
        document.addEventListener('visibilitychange', sync);

        void (async () => {
            try {
                const { App } = await import('@capacitor/app');
                if (disposed) return;
                const handle = await App.addListener('appStateChange', (next) => {
                    appHidden = !next.isActive;
                    sync();
                });
                if (disposed) {
                    void handle.remove();
                    return;
                }
                removeAppListener = () => { void handle.remove(); };
                try {
                    const current = await App.getState();
                    if (!disposed) {
                        appHidden = !current.isActive;
                        sync();
                    }
                } catch { /* 初始状态读不到没关系，等下一次 appStateChange */ }
            } catch (error) {
                console.warn('[BackgroundThrottling] Capacitor App plugin unavailable; Android throttling disabled', error);
            }
        })();

        return () => {
            disposed = true;
            unsubscribeSettings();
            removeAppListener?.();
            document.removeEventListener('visibilitychange', sync);
            useBackgroundLyricHoldStore.setState({ held: false });
        };
    }, []);
};
