import type { LoginState } from '../../../types/onlineMusic';
import { kugouCheckFailure } from './kugouLoginFailure';

// src/services/onlineMusic/kugou/kugouLoginState.ts
// 酷狗扫码检查的答复 → 登录窗口的状态。桥回的 status 是酷狗自己的码：
// 0 已过期、1 等扫码、2/3 已扫码待确认、4 登录成功；有的答复不带 status 只带 token。
// 标准版与概念版扫的是同一个二维码，这段映射两版共用，单独放一处并钉住测试。

const nestedData = (response: any): any => (
    (response && (response.data ?? response.body?.data ?? response.body)) || {}
);

const textOf = (raw: any, ...keys: string[]): string => {
    for (const key of keys) {
        const direct = raw && raw[key];
        if (typeof direct === 'string' && direct) return direct;
    }
    return '';
};

export const mapKugouQrLoginState = (response: any): LoginState => {
    const data = nestedData(response);
    const rawStatus = data.status != null ? data.status : response && response.status;
    const status = Number(rawStatus);
    if (Number.isFinite(status)) {
        if (status === 0) return { state: 'expired' };
        if (status === 1) return { state: 'waiting' };
        if (status === 2 || status === 3) return { state: 'scanned' };
        if (status === 4) return { state: 'confirmed' };
    }
    // 没有 status 但已经带回 token：上游换了答复形状，按成功处理。
    if (data && typeof data.token === 'string' && data.token) return { state: 'confirmed' };
    const message = textOf(response, 'message', 'msg', 'error') || textOf(data, 'message', 'msg', 'error');
    return {
        state: 'error',
        ...(message ? { message } : {}),
        failure: kugouCheckFailure(status, message),
    };
};
