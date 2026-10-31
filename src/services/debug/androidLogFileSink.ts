import {
    addConsoleLogSink,
    getConsoleLogEntries,
    type ConsoleLogEntry,
} from '../../utils/consoleLogBuffer';
import { isAndroidNativeRuntime } from '../../utils/platform';

// src/services/debug/androidLogFileSink.ts
// The phone shell's half of "save logs to a file": the SAF folder the user picked, and the pipe
// that streams console lines into it as they are logged.
//
// The desktop build answers the same need through the debug module's main-process file
// (see services/debug/debugModule.ts). Android has no main process, so the receiving end is a
// FoliaNative plugin method (`appendLogLines`) that writes into a `folia-log-<timestamp>.txt`
// document inside a user-chosen folder - DocumentsProvider, so it works on Android 7 too and
// the file lands wherever the user can reach it (Documents, SD card, ...).
//
// Every interaction with the plugin is optional-chained and every failure degrades to
// "stopped, with a reason" rather than an exception escaping into console - the sink runs
// *inside* console, and a throwing sink would recurse into itself.

type NativeLogPlugin = {
    pickLogFolder: (options?: Record<string, unknown>) => Promise<{
        cancelled?: boolean;
        fileName?: string;
        folderName?: string;
    }>;
    startLogSession: (options?: Record<string, unknown>) => Promise<{
        fileName?: string;
        folderName?: string;
    }>;
    appendLogLines: (options: { text: string }) => Promise<unknown>;
    endLogSession: (options?: Record<string, unknown>) => Promise<unknown>;
    forgetLogFolder: (options?: Record<string, unknown>) => Promise<unknown>;
    getLogSessionStatus: (options?: Record<string, unknown>) => Promise<{
        hasFolder?: boolean;
        active?: boolean;
        fileName?: string;
        folderName?: string;
        permissionLost?: boolean;
    }>;
};

export interface AndroidLogFileSnapshot {
    /** Whether the user wants lines written to a file (persisted in localStorage). */
    enabled: boolean;
    /** Whether the native side currently has an open session file. */
    active: boolean;
    fileName: string;
    folderName: string;
    /** The saved folder lost its persisted grant (system settings cleared it). */
    permissionLost: boolean;
    /** Last failure worth showing under the switch. Cleared on the next successful start. */
    error: string | null;
}

const IDLE: AndroidLogFileSnapshot = {
    enabled: false,
    active: false,
    fileName: '',
    folderName: '',
    permissionLost: false,
    error: null,
};

const ENABLE_KEY = 'console_log_file_enabled';

/**
 * How long a line waits for company before crossing the bridge.
 *
 * One plugin call per console line is a real cost on a subsystem that logs in bursts - a
 * prefetch pass writes forty lines in a few milliseconds - and a session file nobody tails
 * live can pay half a second of latency for batching. But the whole point on a phone is
 * "the last line before the crash survives", so this batches tighter than the desktop's 1s.
 */
const BATCH_MS = 500;
const BATCH_MAX = 60;

const plugin = (): NativeLogPlugin | null => {
    if (typeof window === 'undefined' || !isAndroidNativeRuntime()) return null;
    const capacitor = (window as unknown as {
        Capacitor?: { Plugins?: Record<string, NativeLogPlugin | undefined> };
    }).Capacitor;
    return capacitor?.Plugins?.FoliaNative ?? null;
};

let snapshot: AndroidLogFileSnapshot = IDLE;
const listeners = new Set<() => void>();

const publish = (next: AndroidLogFileSnapshot) => {
    snapshot = next;
    listeners.forEach(listener => listener());
};

const patch = (changes: Partial<AndroidLogFileSnapshot>) => {
    publish({ ...snapshot, ...changes });
};

export const getAndroidLogFileSnapshot = () => snapshot;

export const subscribeToAndroidLogFile = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

// ---- line formatting ---------------------------------------------------------

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Local time, full date: the file outlives the session, so "19:30:45" alone is not enough. */
const formatTimestamp = (at: number) => {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        + `.${pad(date.getMilliseconds(), 3)}`;
};

const formatLine = (entry: ConsoleLogEntry) => `${formatTimestamp(entry.at)} [${entry.level}] ${entry.text}`;

// ---- the pipe ----------------------------------------------------------------

let queue: string[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
/** Set while reporting a failure, so the warning cannot recurse back into this sink. */
let reportingFailure = false;

const reportFailure = (message: string) => {
    patch({ active: false, error: message });
    // Guarded: push() calls this sink again, and the sink must not chase its own tail.
    reportingFailure = true;
    try {
        console.warn('[AndroidLogFile] Stopped writing:', message);
    } finally {
        reportingFailure = false;
    }
};

const flush = async () => {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (!queue.length) return;
    const native = plugin();
    if (!native) { queue = []; return; }
    const text = queue.join('\n');
    queue = [];
    try {
        await native.appendLogLines({ text });
    } catch (error) {
        reportFailure(error instanceof Error ? error.message : String(error));
    }
};

const enqueue = (entry: ConsoleLogEntry) => {
    if (reportingFailure) return;
    if (!snapshot.enabled || !snapshot.active) return;
    queue.push(formatLine(entry));
    if (queue.length >= BATCH_MAX) { void flush(); return; }
    if (batchTimer) return;
    batchTimer = setTimeout(() => void flush(), BATCH_MS);
};

// ---- session control ---------------------------------------------------------

const readEnabledPreference = (): boolean => {
    try {
        return localStorage.getItem(ENABLE_KEY) === 'on';
    } catch {
        return false;
    }
};

const writeEnabledPreference = (enabled: boolean) => {
    try {
        localStorage.setItem(ENABLE_KEY, enabled ? 'on' : 'off');
    } catch {
        // Blocked storage: the choice still applies to this session, it just does not last.
    }
};

/**
 * One-time text for a fresh file: when it opened, and everything the buffer already held.
 *
 * Without the replay, enabling the log after the problem happened shows an empty file, and
 * the pre-enable lines are exactly the ones a reader asks for first.
 */
const writeSessionHeader = async (native: NativeLogPlugin, resumedFromSettings: boolean) => {
    const backlog = getConsoleLogEntries();
    const header = [
        `=== Folia log session started at ${formatTimestamp(Date.now())}`
            + `${resumedFromSettings ? ' (resumed from saved folder)' : ''} ===`,
    ];
    if (backlog.length > 0) {
        header.push(`=== Replay of ${backlog.length} line(s) logged before this session opened ===`);
        backlog.forEach(entry => header.push(formatLine(entry)));
    }
    try {
        await native.appendLogLines({ text: header.join('\n') });
    } catch (error) {
        reportFailure(error instanceof Error ? error.message : String(error));
    }
};

/** Starts writing into the saved folder (native creates a new per-session file). */
const activate = async (resumedFromSettings: boolean): Promise<boolean> => {
    const native = plugin();
    if (!native) return false;
    try {
        const result = await native.startLogSession();
        patch({
            active: true,
            error: null,
            fileName: result?.fileName || '',
            folderName: result?.folderName || snapshot.folderName,
        });
        await writeSessionHeader(native, resumedFromSettings);
        return snapshot.active;
    } catch (error) {
        patch({ active: false, error: error instanceof Error ? error.message : String(error) });
        return false;
    }
};

const deactivate = async () => {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    queue = [];
    const native = plugin();
    if (!native) { patch({ active: false }); return; }
    try {
        await native.endLogSession();
    } catch {
        // The native side closes its writer on failure anyway; stop claiming an active session.
    }
    patch({ active: false });
};

/**
 * Toggles the switch in settings.
 *
 * Enabling without a folder goes straight to the picker: on a phone, "write to file" without
 * "where" is not a state a user can act on, and a second tap would be the same question.
 */
export const toggleAndroidLogFile = async () => {
    if (snapshot.enabled) {
        writeEnabledPreference(false);
        patch({ enabled: false, error: null });
        await deactivate();
        return;
    }
    if (!snapshot.folderName) {
        await pickAndroidLogFolder();
        return;
    }
    if (await activate(false)) {
        writeEnabledPreference(true);
        patch({ enabled: true });
    }
};

/**
 * Opens the SAF picker; on success the native side has already closed any old session, opened a
 * fresh file and is writing, so the switch lands on and the header (with the buffer replay) is
 * written here once for the new file.
 */
export const pickAndroidLogFolder = async () => {
    const native = plugin();
    if (!native) return;
    try {
        const result = await native.pickLogFolder();
        if (result?.cancelled) return;
        patch({
            enabled: true,
            folderName: result?.folderName || snapshot.folderName,
            fileName: result?.fileName || '',
            error: null,
            permissionLost: false,
        });
        writeEnabledPreference(true);
        await writeSessionHeader(native, false);
    } catch (error) {
        patch({ error: error instanceof Error ? error.message : String(error) });
    }
};

/** Stops writing and forgets the folder (native releases the persisted grant). */
export const forgetAndroidLogFolder = async () => {
    writeEnabledPreference(false);
    const native = plugin();
    try {
        await native?.forgetLogFolder();
    } catch {
        // Nothing to remember is the state we wanted anyway.
    }
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    queue = [];
    publish({ ...IDLE });
};

// ---- install -----------------------------------------------------------------

let installed = false;

/**
 * Starts the module on the Android shell. Idempotent; a no-op everywhere else.
 *
 * Called from bootstrap right after the desktop debug module: the desktop pipe takes the
 * `setConsoleLogSink` seat, this one registers itself beside it via `addConsoleLogSink`, so a
 * build running in either shell (or both) keeps every destination it has.
 */
export const installAndroidLogFileSink = () => {
    if (installed || typeof window === 'undefined') return;
    if (!isAndroidNativeRuntime() || !plugin()) return;
    installed = true;

    addConsoleLogSink(enqueue);
    // The session file is flushed per batch by the native side; a clean page teardown should
    // not leave up to BATCH_MS of lines unsent. A process kill cannot be caught, which is
    // exactly why the native writer flushes after every append.
    window.addEventListener('pagehide', () => { void flush(); });

    const enabled = readEnabledPreference();
    patch({ enabled });

    // Always read the saved folder first, so "选择保存位置" can tell whether one exists even when
    // the switch was off. A lost grant is a visible state ("choose it again"), not a silent
    // switch back to off.
    void (async () => {
        const native = plugin();
        if (!native) return;
        try {
            const status = await native.getLogSessionStatus();
            patch({
                folderName: status?.folderName || '',
                permissionLost: Boolean(status?.permissionLost),
            });
            if (!enabled || status?.permissionLost) return;
            await activate(true);
        } catch {
            // Fall through to the inactive state; the switch stays as saved so the reason shows.
        }
    })();
};
