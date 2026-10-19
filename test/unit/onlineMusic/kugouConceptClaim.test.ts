import { describe, expect, it } from 'vitest';
import { shouldClaimConceptVipOnFailure } from '../../../src/nativeBridge/api/kugou.js';

// test/unit/onlineMusic/kugouConceptClaim.test.ts
// 取链失败时要不要现场补领概念版每日 VIP：只在「真的被拦、没会员、没凭证、且过了限流间隔」时试。
describe('shouldClaimConceptVipOnFailure', () => {
    const base = { blocked: true, loggedIn: true, hasVipToken: false, isVip: false, now: 10_000_000, lastAttemptAt: 0, intervalMs: 600_000 };

    it('claims once the track is blocked and the account has no VIP at all', () => {
        expect(shouldClaimConceptVipOnFailure(base)).toBe(true);
    });

    it('does not claim when the song was not blocked or the account is not signed in', () => {
        expect(shouldClaimConceptVipOnFailure({ ...base, blocked: false })).toBe(false);
        expect(shouldClaimConceptVipOnFailure({ ...base, loggedIn: false })).toBe(false);
    });

    it('does not claim when a VIP token or a VIP account already exists', () => {
        expect(shouldClaimConceptVipOnFailure({ ...base, hasVipToken: true })).toBe(false);
        expect(shouldClaimConceptVipOnFailure({ ...base, isVip: true })).toBe(false);
    });

    it('waits for the interval between attempts', () => {
        expect(shouldClaimConceptVipOnFailure({ ...base, lastAttemptAt: base.now - 60_000 })).toBe(false);
        expect(shouldClaimConceptVipOnFailure({ ...base, lastAttemptAt: base.now - 600_001 })).toBe(true);
    });

    it('treats a missing input as no claim', () => {
        expect(shouldClaimConceptVipOnFailure(null)).toBe(false);
        expect(shouldClaimConceptVipOnFailure(undefined)).toBe(false);
    });
});
