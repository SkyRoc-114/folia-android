import { describe, expect, it } from 'vitest';
import { audioMimeTypeFor } from '../../../src/utils/appPlaybackHelpers';

// test/unit/playback/audioMimeType.test.ts
// 经原生桥拉下来的音频 blob：CDN 常回 application/octet-stream 或不声明类型，播放器要正确 MIME 才解码。
describe('audioMimeTypeFor', () => {
    const head = (...bytes: number[]) => new Uint8Array(bytes);

    it('recognises the formats the platforms actually serve', () => {
        expect(audioMimeTypeFor('x', null, head(0x49, 0x44, 0x33, 0x04))).toBe('audio/mpeg');
        expect(audioMimeTypeFor('x', null, head(0xff, 0xfb, 0x90, 0x64))).toBe('audio/mpeg');
        expect(audioMimeTypeFor('x', null, head(0x66, 0x4c, 0x61, 0x43))).toBe('audio/flac');
        expect(audioMimeTypeFor('x', null, head(0x4f, 0x67, 0x67, 0x53))).toBe('audio/ogg');
        expect(audioMimeTypeFor('x', null, head(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBe('audio/wav');
        expect(audioMimeTypeFor('x', null, head(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70))).toBe('audio/mp4');
    });

    it('falls back to a usable declared type before the URL suffix', () => {
        expect(audioMimeTypeFor('https://cdn/x.mp3', 'audio/mpeg; charset=binary')).toBe('audio/mpeg');
        expect(audioMimeTypeFor('https://cdn/x', 'application/octet-stream')).toBeNull();
    });

    it('uses the URL suffix when the CDN declares nothing', () => {
        expect(audioMimeTypeFor('https://cdn/a.flac?sign=1')).toBe('audio/flac');
        expect(audioMimeTypeFor('https://cdn/a.ogg')).toBe('audio/ogg');
        expect(audioMimeTypeFor('https://cdn/a.m4a')).toBe('audio/mp4');
        expect(audioMimeTypeFor('https://cdn/a.mp3')).toBe('audio/mpeg');
        expect(audioMimeTypeFor('https://cdn/a')).toBeNull();
    });
});
