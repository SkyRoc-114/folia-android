package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.annotation.Nullable;

import java.io.InputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

import org.json.JSONObject;

import top.izuna.foliamajor.coloros.ColorOsLyricBridge;
import top.izuna.foliamajor.player.FoliaNativePlayerPlugin;

public class FoliaPlaybackService extends Service {
    private static final String CHANNEL_ID = "folia_playback";
    private static final int NOTIFICATION_ID = 31009;
    public static final String ACTION_REFRESH_METADATA = "top.izuna.foliamajor.action.REFRESH_METADATA";
    private MediaSession mediaSession;
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    private final OkHttpClient artworkClient = new OkHttpClient();
    private final Map<String, Bitmap> artworkCache = new ConcurrentHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile String currentArtworkUrl = "";
    private volatile String appliedArtworkUrl = "";
    private volatile Bitmap appliedArtworkBitmap = null;
    private volatile String lastRequestedCoverUrl = "";
    private volatile String cachedTitle = "";
    private volatile String cachedArtist = "";
    private volatile String cachedAlbum = "";
    private volatile String cachedCoverUrl = "";
    private volatile String cachedSongKey = "";
    private volatile long cachedDurationMs = 0L;
    private volatile long cachedPositionMs = 0L;
    private volatile boolean cachedPlaying = false;
    private static volatile boolean running = false;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private static volatile String powerDiagnostic = "inactive";
    private static final long SERVICE_HEARTBEAT_INTERVAL_MS = 10_000L;
    /**
     * 原生播放时刷新系统 PlaybackState 的周期。
     *
     * 后台的 WebView 会被节流，Web 那一秒一次的状态推送可能几十秒才来；而 ExoPlayer 还在正常
     * 出声。锁屏/通知栏的进度条读的是这里写进去的 PlaybackState，不自己刷新就会停在原地。
     * 只在原生手上确实有歌时才动，没歌时这一步什么也不做。
     */
    private static final long NATIVE_PROGRESS_INTERVAL_MS = 1_000L;
    /**
     * `service-start` 的重复记录间隔。前台服务每次收到播放状态推送都会走一遍 `onStartCommand`，
     * 崩溃历史只留 20 条，不节流的话这些重复记录会把真正的退出原因挤掉。
     */
    private static final long SERVICE_START_RECORD_INTERVAL_MS = 5_000L;
    private volatile boolean lastPlaying = false;
    private volatile long lastServiceStartRecordAt = 0L;
    private volatile boolean lastServiceStartPlaying = false;
    private volatile String lastServiceStartSongKey = "";
    private final Runnable serviceHeartbeatRunnable = new Runnable() {
        @Override
        public void run() {
            recordServiceHeartbeat();
            mainHandler.postDelayed(this, SERVICE_HEARTBEAT_INTERVAL_MS);
        }
    };
    private final Runnable nativeProgressRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                if (FoliaNativePlayerPlugin.hasActiveMedia() && mediaSession != null) {
                    mediaSession.setPlaybackState(buildPlaybackState(
                        FoliaNativePlayerPlugin.isNativePlaying(),
                        Math.max(0L, FoliaNativePlayerPlugin.currentPositionMs()),
                        cachedSongKey
                    ));
                }
            } catch (Throwable ignored) {
                // 原生播放这一层不在时保持原样；下一次 tick 会再试。
            }
            if (running) {
                mainHandler.postDelayed(this, NATIVE_PROGRESS_INTERVAL_MS);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        createNotificationChannel();
        mediaSession = new MediaSession(this, "FoliaPlayback");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() {
                // 原生播放这一路直接动手：后台挂久了 WebView 的 JS 会被节流甚至挂起，
                // 只靠「广播 → 插件 → JS」会出现「通知中心点了播放一点反应都没有」。
                // 发命令给 Web 的原有行为保持不变，两边各管一半（原生出声，Web 管界面与歌词）。
                try {
                    FoliaNativePlayerPlugin.resumeFromSystem();
                } catch (Throwable ignored) {
                    // 原生播放器不在（没开原生播放 / 插件没加载）：交给 Web 那条路照旧。
                }
                emit("play");
            }
            @Override public void onPause() {
                // 同上，方向相反：先让原生停下，再照旧把命令发给 Web。
                try {
                    FoliaNativePlayerPlugin.pauseFromSystem();
                } catch (Throwable ignored) {
                    // 同上。
                }
                emit("pause");
            }
            @Override public void onSkipToNext() { emit("next"); }
            @Override public void onSkipToPrevious() { emit("previous"); }
            @Override public void onStop() { emit("stop"); }
        });
        mediaSession.setActive(true);
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Folia:Playback");
            wakeLock.setReferenceCounted(false);
        }
        WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifiManager != null) {
            int lockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifiManager.createWifiLock(lockMode, "Folia:Playback");
            wifiLock.setReferenceCounted(false);
        }
        recordServiceLifecycle("service-create", "Foreground playback service created");
        mainHandler.post(serviceHeartbeatRunnable);
        mainHandler.post(nativeProgressRunnable);
    }

    /** ColorOS lyric bridge uses this to decide whether a metadata refresh intent is worth sending. */
    public static boolean isRunning() {
        return running;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || "clear".equals(intent.getAction())) {
            recordServiceLifecycle("service-stop-command", "Stop command received");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_REFRESH_METADATA.equals(intent.getAction())) {
            applyCachedMetadata();
            return START_STICKY;
        }

        cachedTitle = intent.getStringExtra("title");
        cachedArtist = intent.getStringExtra("artist");
        cachedAlbum = intent.getStringExtra("album");
        cachedCoverUrl = intent.getStringExtra("coverUrl");
        cachedSongKey = intent.getStringExtra("songKey");
        cachedPlaying = intent.getBooleanExtra("playing", false);
        cachedPositionMs = intent.getLongExtra("position", 0);
        cachedDurationMs = intent.getLongExtra("duration", 0);
        if (cachedTitle == null) cachedTitle = "";
        if (cachedArtist == null) cachedArtist = "";
        if (cachedAlbum == null) cachedAlbum = "";
        if (cachedCoverUrl == null) cachedCoverUrl = "";
        if (cachedSongKey == null) cachedSongKey = "";
        lastPlaying = cachedPlaying;
        recordServiceStartIfNoteworthy();
        currentArtworkUrl = cachedCoverUrl.trim();
        Bitmap retainedArtwork = appliedArtworkBitmap;
        if (currentArtworkUrl.isEmpty()) {
            appliedArtworkUrl = "";
            appliedArtworkBitmap = null;
            retainedArtwork = null;
        }
        if (!currentArtworkUrl.equals(lastRequestedCoverUrl)) {
            lastRequestedCoverUrl = currentArtworkUrl;
            FoliaNativePlugin.notePlaybackArtwork(
                currentArtworkUrl,
                currentArtworkUrl.isEmpty() ? "none" : "queued",
                ""
            );
        }

        // The notification goes on right below via startForeground; building it twice here was
        // one of the two writes per start command (the other is the lifecycle record).
        applyCachedMetadata(false);
        FoliaNativePlugin.notePlaybackArtworkApplied(retainedArtwork != null);

        Notification notification = buildNotification(cachedTitle, cachedArtist, cachedPlaying, retainedArtwork);
        startForeground(NOTIFICATION_ID, notification);
        updatePlaybackLocks(cachedPlaying);
        String requestedCover = currentArtworkUrl;
        loadArtwork(requestedCover, bitmap -> {
            if (!requestedCover.equals(currentArtworkUrl)) return;
            mediaSession.setMetadata(buildMetadata(cachedTitle, cachedArtist, cachedAlbum, cachedDurationMs, bitmap, cachedCoverUrl, cachedSongKey));
            FoliaNativePlugin.notePlaybackArtworkApplied(bitmap != null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, buildNotification(cachedTitle, cachedArtist, cachedPlaying, bitmap));
            }
        });
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        CrashDiagnostics.recordText(
            getApplicationContext(),
            "activity-lifecycle",
            "service",
            "task-removed",
            "Task removed from recents",
            "FoliaPlaybackService.onTaskRemoved"
        );
        super.onTaskRemoved(rootIntent);
    }

    private MediaMetadata buildMetadata(
        String title,
        String artist,
        String album,
        long duration,
        Bitmap artwork,
        String coverUrl,
        String songKey
    ) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title == null ? "Folia" : title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist == null ? "" : artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album == null ? "" : album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
        if (artwork == null && coverUrl != null && !coverUrl.isEmpty()) {
            metadata.putString(MediaMetadata.METADATA_KEY_ART_URI, coverUrl);
            metadata.putString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI, coverUrl);
        }
        if (artwork != null) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ART, artwork);
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        }
        ColorOsLyricBridge.attach(metadata, songKey);
        return metadata.build();
    }

    private void applyCachedMetadata() {
        applyCachedMetadata(true);
    }

    /** `notify=false`：紧接着就要 `startForeground` 的路径，不再重复构建一次通知。 */
    private void applyCachedMetadata(boolean notify) {
        if (mediaSession == null) return;
        Bitmap retained = appliedArtworkBitmap;
        mediaSession.setMetadata(buildMetadata(
            cachedTitle,
            cachedArtist,
            cachedAlbum,
            cachedDurationMs,
            retained,
            cachedCoverUrl,
            cachedSongKey
        ));
        mediaSession.setPlaybackState(buildPlaybackState(cachedPlaying, resolvePlaybackPositionMs(), cachedSongKey));
        if (notify) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && running) {
                manager.notify(NOTIFICATION_ID, buildNotification(cachedTitle, cachedArtist, cachedPlaying, retained));
            }
        }
    }

    /**
     * 通知栏 / 锁屏那条进度条该显示的位置。
     *
     * 原生在放的时候直接问播放器：它的位置就是真值。Web 报上来的那一份要过 Chromium 的
     * 定时器节流 —— 挂着不动久了，那一推可能几十秒才来一次，通知栏就停着、或者一直是 00。
     * 其余情况照旧用 Web 报的位置：`<audio>` 播到哪只有它知道。
     */
    private long resolvePlaybackPositionMs() {
        try {
            if (FoliaNativePlayerPlugin.hasActiveMedia()) {
                long nativePosition = FoliaNativePlayerPlugin.currentPositionMs();
                if (nativePosition >= 0L) {
                    return nativePosition;
                }
            }
        } catch (Throwable ignored) {
            // 原生播放这一层不可用（插件没加载）：回退到 Web 上报的缓存值。
        }
        return cachedPositionMs;
    }

    private PlaybackState buildPlaybackState(boolean playing, long position, String songKey) {
        PlaybackState.Builder builder = new PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY
                    | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO
            )
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, position, playing ? 1f : 0f);
        if (ColorOsLyricBridge.hasTranslationFor(songKey)) {
            builder.addCustomAction(new PlaybackState.CustomAction.Builder(
                ColorOsLyricBridge.ACTION_TOGGLE_TRANSLATION,
                "翻译",
                translationActionIcon()
            ).build());
        }
        return builder.build();
    }

    private int translationActionIcon() {
        int icon = getApplicationInfo().icon;
        return icon != 0 ? icon : android.R.drawable.ic_menu_info_details;
    }

    private Notification buildNotification(
        String title,
        String artist,
        boolean playing,
        Bitmap artwork
    ) {
        Intent activityIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            activityIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        int playPauseIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        PendingIntent playPauseIntent = PendingIntent.getBroadcast(
            this,
            1,
            new Intent(this, PlaybackActionReceiver.class).setAction(playing ? "pause" : "play"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent previousIntent = PendingIntent.getBroadcast(
            this,
            2,
            new Intent(this, PlaybackActionReceiver.class).setAction("previous"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent nextIntent = PendingIntent.getBroadcast(
            this,
            3,
            new Intent(this, PlaybackActionReceiver.class).setAction("next"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title == null ? "Folia" : title)
            .setContentText(artist == null ? "" : artist)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Previous", previousIntent)
            .addAction(playPauseIcon, playing ? "Pause" : "Play", playPauseIntent)
            .addAction(android.R.drawable.ic_media_next, "Next", nextIntent)
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        if (artwork != null) builder.setLargeIcon(artwork);
        return builder.build();
    }

    private void loadArtwork(String value, ArtworkCallback callback) {
        if (value == null || value.isEmpty()) return;
        if (value.equals(appliedArtworkUrl)) return;
        Bitmap cached = artworkCache.get(value);
        if (cached != null) {
            mainHandler.post(() -> {
                if (value.equals(currentArtworkUrl)) {
                    appliedArtworkUrl = value;
                    appliedArtworkBitmap = cached;
                    FoliaNativePlugin.notePlaybackArtwork(
                        value,
                        "loaded",
                        "cached " + cached.getWidth() + "x" + cached.getHeight()
                    );
                }
                callback.onLoaded(cached);
            });
            return;
        }
        if (!(value.startsWith("http://") || value.startsWith("https://"))) {
            FoliaNativePlugin.notePlaybackArtwork(value, "error", "unsupported-cover-url");
            return;
        }
        artworkExecutor.execute(() -> {
            Bitmap bitmap = null;
            String failure = "";
            try (Response response = artworkClient.newCall(new Request.Builder()
                .url(value)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile)")
                .build()).execute()) {
                ResponseBody body = response.body();
                if (response.isSuccessful() && body != null) {
                    try (InputStream input = body.byteStream()) {
                        bitmap = BitmapFactory.decodeStream(input);
                    }
                    if (bitmap == null) failure = "decode-failed";
                } else {
                    failure = "http-" + response.code();
                }
            } catch (Exception error) {
                failure = error.getClass().getSimpleName();
            }
            if (bitmap != null) artworkCache.put(value, bitmap);
            Bitmap resolved = bitmap;
            if (resolved != null) {
                mainHandler.post(() -> {
                    if (value.equals(currentArtworkUrl)) {
                        appliedArtworkUrl = value;
                        appliedArtworkBitmap = resolved;
                        FoliaNativePlugin.notePlaybackArtwork(
                            value,
                            "loaded",
                            resolved.getWidth() + "x" + resolved.getHeight()
                        );
                    }
                    callback.onLoaded(resolved);
                });
            } else {
                FoliaNativePlugin.notePlaybackArtwork(value, "error", failure.isEmpty() ? "unknown" : failure);
            }
        });
    }

    private interface ArtworkCallback {
        void onLoaded(Bitmap bitmap);
    }

    /**
     * Keeps the remote-audio proxy alive in the background.
     *
     * A foreground service keeps the process visible, but it does not stop Doze from throttling
     * the CPU or the Wi-Fi radio. Playback pulls the stream through LocalAudioServer, so losing
     * either one shows up as intermittent audio while the screen is off.
     */
    private void updatePlaybackLocks(boolean playing) {
        try {
            if (playing) {
                if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
                if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
            } else {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            }
            powerDiagnostic = "wake=" + (wakeLock != null && wakeLock.isHeld() ? "held" : "released")
                + " wifi=" + (wifiLock != null && wifiLock.isHeld() ? "held" : "released")
                + " error=none";
        } catch (Exception error) {
            powerDiagnostic = "wake=" + (wakeLock != null && wakeLock.isHeld() ? "held" : "released")
                + " wifi=" + (wifiLock != null && wifiLock.isHeld() ? "held" : "released")
                + " error=" + error.getClass().getSimpleName();
        }
    }

    static String getPowerDiagnostic() {
        return powerDiagnostic;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Folia playback",
                NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void emit(String action) {
        FoliaNativePlugin.emitMediaAction(action);
    }

    private void recordServiceLifecycle(String type, String message) {
        CrashDiagnostics.recordText(
            getApplicationContext(),
            "service-lifecycle",
            "service",
            type,
            message,
            "FoliaPlaybackService"
        );
    }

    /**
     * 只在播放状态或曲目真的变了、或距上次记录已满 {@link #SERVICE_START_RECORD_INTERVAL_MS}
     * 时记一条 `service-start`。推送本身仍然每次都处理，只是不再每次都写诊断。
     */
    private void recordServiceStartIfNoteworthy() {
        long now = SystemClock.elapsedRealtime();
        boolean stateChanged = cachedPlaying != lastServiceStartPlaying
            || !cachedSongKey.equals(lastServiceStartSongKey);
        if (!stateChanged && now - lastServiceStartRecordAt < SERVICE_START_RECORD_INTERVAL_MS) {
            return;
        }
        lastServiceStartRecordAt = now;
        lastServiceStartPlaying = cachedPlaying;
        lastServiceStartSongKey = cachedSongKey;
        recordServiceLifecycle("service-start", "playing=" + cachedPlaying);
    }

    private void recordServiceHeartbeat() {
        try {
            JSONObject payload = new JSONObject();
            payload.put("at", System.currentTimeMillis());
            payload.put("playing", lastPlaying);
            payload.put("wakeLock", wakeLock != null && wakeLock.isHeld() ? "held" : "released");
            payload.put("wifiLock", wifiLock != null && wifiLock.isHeld() ? "held" : "released");
            payload.put("foreground", true);
            CrashDiagnostics.recordServiceHeartbeat(getApplicationContext(), payload.toString());
        } catch (Exception ignored) {
            // A missed heartbeat is harmless; the next one is 10 seconds away.
        }
    }

    @Override
    public void onDestroy() {
        recordServiceLifecycle("service-destroy", "Foreground playback service destroyed");
        running = false;
        mainHandler.removeCallbacks(serviceHeartbeatRunnable);
        mainHandler.removeCallbacks(nativeProgressRunnable);
        updatePlaybackLocks(false);
        artworkExecutor.shutdownNow();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
