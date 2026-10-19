import { describe, expect, it } from 'vitest';
import {
    buildKGTrackerVipTypeCandidates,
    mergeKGVipState,
    resolveKGEffectiveVipToken,
    resolveKGTrackerVipType,
} from '../../../src/nativeBridge/api/kugou.js';

// test/unit/onlineMusic/kugouVipState.test.ts
// 酷狗取链时 tracker 请求要带 vip_type 候选；标准版来自 vip_type/vip_token，概念版可能只剩
// is_vip 一类的状态。这里钉住「两版都能给出可用候选」的纯逻辑。
describe('kugou vip state helpers', () => {
    it('merges the vip state of several sources', () => {
        expect(mergeKGVipState({ vipType: 0, isVip: false }, { vipType: 6, isVip: true }))
            .toEqual({ vipType: 6, isVip: true });
        // 任一来源说 VIP、没有档位时补 6，避免被当免费账号。
        expect(mergeKGVipState({}, { isVip: true })).toEqual({ vipType: 6, isVip: true });
        expect(mergeKGVipState({ vipType: 3 }, { vipType: 33 })).toEqual({ vipType: 33, isVip: true });
        expect(mergeKGVipState(null, null)).toEqual({ vipType: 0, isVip: false });
    });

    it('prefers the cookie vip_token over the cached one', () => {
        expect(resolveKGEffectiveVipToken('vip_token=cookie-token; userid=1', { vipToken: 'cached' })).toBe('cookie-token');
        expect(resolveKGEffectiveVipToken('userid=1', { vipToken: 'cached' })).toBe('cached');
        expect(resolveKGEffectiveVipToken('userid=1', null)).toBe('');
    });

    it('resolves the tracker vip_type from cookie, login or tokens', () => {
        expect(resolveKGTrackerVipType('vip_type=33; userid=1', 0)).toBe('33');
        expect(resolveKGTrackerVipType('userid=1', 6)).toBe('6');
        expect(resolveKGTrackerVipType('vip_token=t; userid=1', 0)).toBe('6');
        expect(resolveKGTrackerVipType('userid=1', 0)).toBe('0');
    });

    it('offers every fallback the tracker accepts', () => {
        const candidates = buildKGTrackerVipTypeCandidates('userid=1', 0);
        expect(candidates).toContain('6');
        expect(candidates).toContain('11');
        expect(candidates).toContain('33');
        expect(candidates).toContain('3');
        // 去重：同一值只出现一次。
        expect(new Set(candidates).size).toBe(candidates.length);
    });
});
