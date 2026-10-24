import { describe, expect, it } from 'vitest';
import { createHifiClock } from '@/services/hifi/hifiClock';

// test/unit/hifi/hifiClock.test.ts
// The extrapolated HiFi position: it moves on between mpv's ticks while playing, holds while paused,
// and never leaves [0, duration].

describe('createHifiClock', () => {
    it('starts at zero, paused, with no duration', () => {
        const clock = createHifiClock();
        expect(clock.read(1000)).toBe(0);
        expect(clock.state()).toEqual({ baseSec: 0, startedAtMs: null, paused: true, durationSec: null });
    });

    it('extrapolates from the last sync while playing', () => {
        const clock = createHifiClock();
        clock.sync({ positionSec: 10, paused: false, durationSec: 200, nowMs: 1000 });
        expect(clock.read(1000)).toBe(10);
        expect(clock.read(1750)).toBeCloseTo(10.75);
        expect(clock.state()).toEqual({ baseSec: 10, startedAtMs: 1000, paused: false, durationSec: 200 });
    });

    it('holds the position while paused', () => {
        const clock = createHifiClock();
        clock.sync({ positionSec: 42, paused: true, durationSec: 200, nowMs: 1000 });
        expect(clock.read(9000)).toBe(42);
        expect(clock.state().startedAtMs).toBeNull();
    });

    it('clamps to the duration once known, and does not cap an unknown one', () => {
        const clock = createHifiClock();
        clock.sync({ positionSec: 199, paused: false, durationSec: 200, nowMs: 0 });
        expect(clock.read(5000)).toBe(200);
        clock.sync({ positionSec: 199, paused: false, durationSec: null, nowMs: 0 });
        expect(clock.read(5000)).toBe(204);
    });

    it('keeps the previous duration when a sync leaves it out', () => {
        const clock = createHifiClock();
        clock.sync({ positionSec: 0, paused: true, durationSec: 120, nowMs: 0 });
        clock.sync({ positionSec: 300, paused: true, nowMs: 0 });
        expect(clock.state().durationSec).toBe(120);
        expect(clock.read(0)).toBe(120);
    });

    it('never reads below zero or from a non-finite position', () => {
        const clock = createHifiClock();
        clock.sync({ positionSec: -3, paused: true, nowMs: 0 });
        expect(clock.read(0)).toBe(0);
        clock.sync({ positionSec: Number.NaN, paused: false, durationSec: Number.POSITIVE_INFINITY, nowMs: 0 });
        expect(clock.state().durationSec).toBeNull();
        expect(clock.read(500)).toBeCloseTo(0.5);
        // A clock read before the sync time (another frame's timestamp) does not run backwards.
        expect(clock.read(-1000)).toBe(0);
    });

    it('reads performance.now() when no time is given', () => {
        const clock = createHifiClock();
        clock.sync({ positionSec: 5, paused: false, durationSec: 100 });
        const read = clock.read();
        expect(read).toBeGreaterThanOrEqual(5);
        expect(read).toBeLessThan(6);
    });
});
