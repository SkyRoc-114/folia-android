import { describe, expect, it } from 'vitest';
import { normalizeQualityPreference, pickKGHashForQuality } from '../../../src/nativeBridge/api/kugou.js';

// test/unit/onlineMusic/kugouQualityFallback.test.ts
// 取链的质量回退顺序：标准版与概念版的差别只在会员身份，回退本身必须一致且单调
// （要不到就降一档，绝不越级）。这里钉住这段纯逻辑。
describe('kugou quality fallback', () => {
    const hashes = {
        sqhash: 'sq-hash',
        '320hash': 'hq-hash',
        '128hash': 'std-hash',
    };

    it('normalises the app preference to a kuGou level', () => {
        expect(normalizeQualityPreference('hires')).toBe('hires');
        expect(normalizeQualityPreference('lossless')).toBe('lossless');
        expect(normalizeQualityPreference('high')).toBe('exhigh');
        expect(normalizeQualityPreference('standard')).toBe('standard');
        expect(normalizeQualityPreference('')).toBe('hires');
    });

    it('picks the requested level when its hash is present', () => {
        expect(pickKGHashForQuality(hashes, 'base', 'lossless')).toMatchObject({ hash: 'sq-hash', level: 'lossless' });
        expect(pickKGHashForQuality(hashes, 'base', 'exhigh')).toMatchObject({ hash: 'hq-hash', level: 'exhigh' });
        expect(pickKGHashForQuality(hashes, 'base', 'standard')).toMatchObject({ hash: 'std-hash', level: 'standard' });
    });

    it('degrades one level at a time and never upgrades', () => {
        expect(pickKGHashForQuality({ '320hash': 'hq-hash', '128hash': 'std-hash' }, 'base', 'lossless'))
            .toMatchObject({ hash: 'hq-hash', level: 'exhigh' });
        expect(pickKGHashForQuality({ '128hash': 'std-hash' }, 'base', 'lossless'))
            .toMatchObject({ hash: 'std-hash', level: 'standard' });
        // 只要求标准时，绝不返回更高档的 hash。
        expect(pickKGHashForQuality(hashes, 'base', 'standard')).toMatchObject({ level: 'standard', hash: 'std-hash' });
    });

    it('falls back to the base hash when nothing is known', () => {
        expect(pickKGHashForQuality({}, 'base-hash', 'lossless')).toMatchObject({ hash: 'base-hash', level: 'standard' });
    });
});
