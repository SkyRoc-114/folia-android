// src/utils/mediaSessionSync.ts

export type MediaSessionTrackMetadata = {
    title: string;
    artist: string;
    album: string;
    artworkUrl: string;
    /** 歌曲元数据里的时长（秒）：流式音源的 <audio>.duration 是 Infinity，系统媒体控制的进度时间线用它兜底。 */
    durationSeconds?: number;
};

type MediaSessionMetadataFactory = (init: MediaMetadataInit) => MediaMetadata;

const MEDIA_SESSION_ARTWORK_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:']);

const normalizeSourceUrl = (source: string, baseUrl?: string) => {
    try {
        return new URL(source, baseUrl).href;
    } catch {
        return source;
    }
};

export const getSupportedMediaSessionArtworkUrl = (source: string, baseUrl?: string): string => {
    const trimmedSource = source.trim();
    if (!trimmedSource) return '';

    try {
        const url = baseUrl ? new URL(trimmedSource, baseUrl) : new URL(trimmedSource);
        return MEDIA_SESSION_ARTWORK_PROTOCOLS.has(url.protocol)
            ? (baseUrl ? url.href : trimmedSource)
            : '';
    } catch {
        // Relative URLs are valid MediaImage sources; callers can provide baseUrl for strict resolution.
        return baseUrl ? '' : trimmedSource;
    }
};

// Rejects late events from the previous source and sources whose timeline is not usable yet.
// A streaming source's own timeline is never usable (duration stays Infinity); one with a track
// duration beside it still counts as ready - the position is published on that fallback timeline.
export const isMediaSessionSourceReady = (
    audio: Pick<HTMLAudioElement, 'currentSrc' | 'readyState' | 'duration'>,
    expectedSource: string,
    baseUrl?: string,
    fallbackDurationSeconds?: number
) => {
    const timelineReady = (Number.isFinite(audio.duration) && audio.duration > 0)
        || (Number.isFinite(fallbackDurationSeconds) && (fallbackDurationSeconds ?? 0) > 0);
    if (audio.readyState < 1 || !timelineReady) {
        return false;
    }

    if (!audio.currentSrc) {
        return false;
    }

    return normalizeSourceUrl(audio.currentSrc, baseUrl) === normalizeSourceUrl(expectedSource, baseUrl);
};

export const createMediaSessionPositionState = (
    audio: Pick<HTMLAudioElement, 'currentTime' | 'duration' | 'playbackRate'>,
    fallbackDurationSeconds?: number
): MediaPositionState | null => {
    // The element's own timeline wins; a stream (duration Infinity/NaN) falls back to the song's
    // metadata duration, so the platform media session still gets a progress timeline.
    const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : (Number.isFinite(fallbackDurationSeconds) && (fallbackDurationSeconds ?? 0) > 0
            ? fallbackDurationSeconds as number
            : 0);
    if (duration <= 0) {
        return null;
    }

    const position = Number.isFinite(audio.currentTime)
        ? Math.min(Math.max(audio.currentTime, 0), duration)
        : 0;
    const playbackRate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
        ? audio.playbackRate
        : 1;

    return {
        duration,
        playbackRate,
        position,
    };
};

// Position must be valid before metadata is replaced; Chromium otherwise clears the platform session.
export const publishMediaSessionTrack = (
    mediaSession: MediaSession,
    audio: Pick<HTMLAudioElement, 'currentTime' | 'duration' | 'playbackRate'>,
    track: MediaSessionTrackMetadata,
    createMetadata: MediaSessionMetadataFactory = init => new MediaMetadata(init)
) => {
    const positionState = createMediaSessionPositionState(audio, track.durationSeconds);
    if (!positionState) {
        return false;
    }

    mediaSession.setPositionState(positionState);
    const artworkUrl = getSupportedMediaSessionArtworkUrl(track.artworkUrl);
    mediaSession.metadata = createMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: artworkUrl ? [{ src: artworkUrl }] : [],
    });
    return true;
};
