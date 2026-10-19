import { describe, expect, it } from 'vitest';
import { kgConceptVipTypeOf } from '../../../src/nativeBridge/api/kugou.js';

// test/unit/onlineMusic/kugouConceptVip.test.ts
// 概念版（畅听 VIP）在 /v1/get_union_vip 的答复里可能只给 is_vip、busi_vip 或到期时间，
// 标准版则给 vip_type。这里钉住「两种版本都能认出会员」的解析规则。
describe('kgConceptVipTypeOf', () => {
    it('reads an explicit vip_type and maps it like the user centre does', () => {
        expect(kgConceptVipTypeOf({ data: { vip_type: 4 } })).toBe(33);
        expect(kgConceptVipTypeOf({ data: { vip_type: 7 } })).toBe(3);
        expect(kgConceptVipTypeOf({ data: { vip_type: 2 } })).toBe(6);
        expect(kgConceptVipTypeOf({ data: { vipType: 6 } })).toBe(6);
    });

    it('recognises a concept-edition flag without a type', () => {
        expect(kgConceptVipTypeOf({ data: { is_vip: true } })).toBe(6);
        expect(kgConceptVipTypeOf({ data: { is_vip: 1 } })).toBe(6);
        expect(kgConceptVipTypeOf({ body: { data: { is_vip: '1' } } })).toBe(0);
    });

    it('recognises an active business VIP entry', () => {
        expect(kgConceptVipTypeOf({ data: { busi_vip: [{ is_vip: 1 }] } })).toBe(6);
        expect(kgConceptVipTypeOf({ data: { busi_vip: [{ is_vip: 0 }, { is_vip: 0 }] } })).toBe(0);
        expect(kgConceptVipTypeOf({ data: {} })).toBe(0);
        expect(kgConceptVipTypeOf(null)).toBe(0);
    });
});
