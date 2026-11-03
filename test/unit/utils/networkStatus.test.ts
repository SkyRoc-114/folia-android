// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isNetworkOffline, subscribeNetworkStatus } from '@/utils/networkStatus';

describe('networkStatus', () => {
    it('treats the default jsdom navigator as online', () => {
        expect(isNetworkOffline()).toBe(false);
    });

    it('reports offline only when navigator.onLine is explicitly false', () => {
        Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
        expect(isNetworkOffline()).toBe(true);

        Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
        expect(isNetworkOffline()).toBe(false);

        Reflect.deleteProperty(window.navigator, 'onLine');
    });

    it('subscribes to online/offline events and unsubscribes cleanly', () => {
        const seen: boolean[] = [];
        const unsubscribe = subscribeNetworkStatus(offline => seen.push(offline));

        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
        expect(seen).toEqual([true, false]);

        unsubscribe();
        window.dispatchEvent(new Event('offline'));
        expect(seen).toEqual([true, false]);
    });

    it('returns a no-op unsubscribe when window listeners are unavailable', () => {
        const originalAddEventListener = window.addEventListener;
        // @ts-expect-error 模拟无 addEventListener 的环境（非浏览器壳）
        window.addEventListener = undefined;
        try {
            expect(() => subscribeNetworkStatus(() => {})).not.toThrow();
        } finally {
            window.addEventListener = originalAddEventListener;
        }
    });
});
