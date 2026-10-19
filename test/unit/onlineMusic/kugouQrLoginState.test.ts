import { describe, expect, it } from 'vitest';
import { mapKugouQrLoginState } from '../../../src/services/onlineMusic/kugou/kugouLoginState';

// test/unit/onlineMusic/kugouQrLoginState.test.ts
// 酷狗扫码检查答复 → 登录窗口状态。标准版与概念版扫同一个二维码，映射共用，状态码是酷狗自己的：
// 0 过期、1 等扫、2/3 已扫待确认、4 成功；有的答复不带 status 只带 token。
describe('mapKugouQrLoginState', () => {
    it('maps the kuGou status codes', () => {
        expect(mapKugouQrLoginState({ status: 0 })).toEqual({ state: 'expired' });
        expect(mapKugouQrLoginState({ status: 1 })).toEqual({ state: 'waiting' });
        expect(mapKugouQrLoginState({ status: 2 })).toEqual({ state: 'scanned' });
        expect(mapKugouQrLoginState({ status: 3 })).toEqual({ state: 'scanned' });
        expect(mapKugouQrLoginState({ status: 4 })).toEqual({ state: 'confirmed' });
    });

    it('reads the status from a nested body', () => {
        expect(mapKugouQrLoginState({ data: { status: 1 } })).toEqual({ state: 'waiting' });
        expect(mapKugouQrLoginState({ body: { data: { status: 4 } } })).toEqual({ state: 'confirmed' });
    });

    it('accepts a token-only answer as signed in', () => {
        expect(mapKugouQrLoginState({ data: { token: 'tok' } })).toEqual({ state: 'confirmed' });
    });

    it('answers an error with the platform words for anything else', () => {
        expect(mapKugouQrLoginState({ status: 9, message: '风控' })).toMatchObject({
            state: 'error',
            message: '风控',
        });
        expect(mapKugouQrLoginState({})).toMatchObject({ state: 'error' });
    });
});
