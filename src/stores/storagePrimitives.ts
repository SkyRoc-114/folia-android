// src/stores/storagePrimitives.ts
// The localStorage read/write primitives every settings store shares.
//
// Moved out of useSettingsUiStore so the domain stores split out of it do not have to import
// from each other just to read a boolean. Behaviour is unchanged, including the SSR guard.

export const getStoredBoolean = (key: string, fallback: boolean) => {
    if (typeof window === 'undefined') {
        return fallback;
    }

    const saved = localStorage.getItem(key);
    return saved !== null ? saved === 'true' : fallback;
};

export const setStoredBoolean = (key: string, value: boolean) => {
    if (typeof window !== 'undefined') {
        localStorage.setItem(key, String(value));
    }
};

export const getStoredString = (key: string, fallback: string) => {
    if (typeof window === 'undefined') {
        return fallback;
    }

    return localStorage.getItem(key) || fallback;
};
export const getStoredJson = <T>(key: string, fallback: T): T => {
    if (typeof window === 'undefined') {
        return fallback;
    }

    const saved = localStorage.getItem(key);
    if (saved === null) {
        return fallback;
    }

    try {
        return JSON.parse(saved) as T;
    } catch {
        return fallback;
    }
};

export const setStoredJson = (key: string, value: unknown) => {
    if (typeof window !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(value));
    }
};