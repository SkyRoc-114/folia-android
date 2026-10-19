package top.izuna.foliamajor;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import okhttp3.FormBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Spotify 的安卓登录：OAuth 授权码 + PKCE，回环地址接回调，令牌存在应用私有目录。
 *
 * <p>与桌面版（electron/spotify/signIn.cjs）用同一个 client id 和同一个回环重定向
 * （127.0.0.1:5588/login），所以安卓上也必须监听这个固定端口；端口占不到就明确失败，
 * 不换端口——换了 Spotify 不认这个重定向。
 *
 * <p>浏览器一打开就离开应用：Activity 可能在登录期间被回收，因此令牌由登录线程直接落盘，
 * 界面上重新问 {@link #status()} 就能拿到。
 */
final class SpotifyAuth {

    static final String CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
    static final int PORT = 5588;
    static final String REDIRECT_URI = "http://127.0.0.1:" + PORT + "/login";

    private static final String PREFS = "folia_spotify_auth";
    private static final String KEY_REFRESH = "refresh_token";
    private static final String KEY_ACCESS = "access_token";
    private static final String KEY_EXPIRES = "expires_at";
    private static final String KEY_USER = "user_json";

    private static final String SCOPES = "app-remote-control playlist-modify playlist-modify-private playlist-modify-public "
            + "playlist-read playlist-read-collaborative playlist-read-private streaming ugc-image-upload user-follow-modify "
            + "user-follow-read user-library-modify user-library-read user-modify user-modify-playback-state user-modify-private "
            + "user-personalized user-read-birthdate user-read-currently-playing user-read-email user-read-play-history "
            + "user-read-playback-position user-read-playback-state user-read-private user-read-recently-played user-top-read";

    private static final long ATTEMPT_MS = 3 * 60 * 1000L;
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build();

    private static volatile ServerSocket server;
    private static volatile CountDownLatch pending;
    private static volatile String lastError;
    /** 失败的真实原因（HTTP 码 / Spotify 的 error 字段 / 回调里缺什么），给诊断报告用。 */
    private static volatile String lastDetail;

    private SpotifyAuth() { }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 有 refresh token 就是已登录（资料页拿不到不影响登录态）。 */
    static boolean hasSession(Context context) {
        String refresh = prefs(context).getString(KEY_REFRESH, null);
        return refresh != null && !refresh.isEmpty();
    }

    /** 已登录时返回账号 id（资料页还没拉到时给一个占位 id），没有令牌时 null。 */
    static String signedInId(Context context) {
        if (!hasSession(context)) return null;
        try {
            String id = new JSONObject(prefs(context).getString(KEY_USER, "{}")).optString("id", "");
            return id.isEmpty() ? "spotify" : id;
        } catch (JSONException error) {
            return "spotify";
        }
    }

    /** 当前可用令牌（过期前 60 秒刷新）。没有登录时返回 null。 */
    static String accessToken(Context context) throws IOException {
        SharedPreferences store = prefs(context);
        String access = store.getString(KEY_ACCESS, null);
        long expiresAt = store.getLong(KEY_EXPIRES, 0L);
        if (access != null && !access.isEmpty() && System.currentTimeMillis() < expiresAt - 60_000L) return access;
        String refresh = store.getString(KEY_REFRESH, null);
        if (refresh == null || refresh.isEmpty()) return null;
        JSONObject tokens = tokenRequest(new FormBody.Builder()
                .add("grant_type", "refresh_token")
                .add("refresh_token", refresh)
                .add("client_id", CLIENT_ID)
                .build());
        if (tokens == null) {
            signOut(context);
            return null;
        }
        saveTokens(context, tokens);
        return tokens.optString("access_token", null);
    }

    /**
     * 完整登录：起回环监听 → 打开系统浏览器 → 等回调 → 换令牌。阻塞调用（调用方放在后台线程）。
     * 成功返回账号 id，取消/失败返回 null，失败原因在 {@link #lastError()}。
     */
    static String signIn(Context context) throws IOException {
        if (signedInId(context) == null) {
            // 清掉旧令牌，避免浏览器里还留着别的账号的授权会话时直接静默通过。
            signOut(context);
        }
        lastError = null;
        lastDetail = null;
        String verifier = randomBase64Url(64);
        String challenge = base64Url(sha256(verifier));
        CountDownLatch latch = new CountDownLatch(1);
        pending = latch;
        try {
            startListener(context, verifier, latch);
            String url = "https://accounts.spotify.com/authorize?response_type=code"
                    + "&client_id=" + Uri.encode(CLIENT_ID)
                    + "&redirect_uri=" + Uri.encode(REDIRECT_URI)
                    + "&scope=" + Uri.encode(SCOPES)
                    + "&code_challenge_method=S256&code_challenge=" + Uri.encode(challenge)
                    + "&state=" + Uri.encode(verifier.substring(0, 16));
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            if (!latch.await(ATTEMPT_MS, TimeUnit.MILLISECONDS)) {
                lastError = "browser-unfinished";
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            lastError = "browser-unfinished";
        } finally {
            stopListener();
            pending = null;
        }
        if (lastError != null) return null;
        // 令牌存下来就算登录成功：资料页（/v1/me）只是展示信息，Spotify 的公共 Web API 会对
        // 这个 client 直接回 429，拿不到也不该把登录判死；资料由渲染层用 pathfinder 再拉。
        return signedInId(context);
    }

    /** 用户从登录窗口取消：关掉回环监听，登录线程会尽快结束。 */
    static void cancel() {
        CountDownLatch latch = pending;
        if (latch != null) latch.countDown();
        stopListener();
    }

    static void signOut(Context context) {
        prefs(context).edit().clear().apply();
    }

    static String lastError() {
        return lastError;
    }

    static String lastDetail() {
        return lastDetail;
    }

    // ── 回环监听 ────────────────────────────────────────────────────────────

    private static void startListener(Context context, String verifier, CountDownLatch latch) throws IOException {
        ServerSocket socket = new ServerSocket(PORT, 4, InetAddress.getByName("127.0.0.1"));
        server = socket;
        Thread thread = new Thread(() -> {
            try (Socket client = socket.accept()) {
                String requestLine = readRequestLine(client.getInputStream());
                Uri uri = requestLine == null ? null : Uri.parse("http://127.0.0.1" + requestLine.split(" ")[1]);
                String code = uri == null ? null : uri.getQueryParameter("code");
                String error = uri == null ? null : uri.getQueryParameter("error");
                String state = uri == null ? null : uri.getQueryParameter("state");
                boolean refused = "access_denied".equals(error);
                if (code == null) {
                    lastError = refused ? "not-authorized" : "failed";
                    lastDetail = "callback without code: " + (requestLine == null ? "(no request line)" : requestLine);
                    writePage(client.getOutputStream(), refused ? "未授权。请回到 Folia 重试。" : "登录未完成。请回到 Folia 重试。");
                } else {
                    try {
                        JSONObject tokens = tokenRequest(new FormBody.Builder()
                                .add("grant_type", "authorization_code")
                                .add("code", code)
                                .add("redirect_uri", REDIRECT_URI)
                                .add("client_id", CLIENT_ID)
                                .add("code_verifier", verifier)
                                .build());
                        if (tokens == null) {
                            lastError = "failed";
                            lastDetail = "token exchange failed: " + tokenDetail;
                            writePage(client.getOutputStream(), "登录未完成。请回到 Folia 重试。");
                        } else {
                            saveTokens(context, tokens);
                            try {
                                fetchProfile(context);
                            } catch (IOException profileError) {
                                // 资料页失败不影响登录态：令牌已经存下，下次登录状态会重新拉资料。
                                lastDetail = "profile fetch failed: " + profileError.getMessage();
                            }
                            writePage(client.getOutputStream(), "已登录 Spotify，可以回到 Folia 了。");
                        }
                    } catch (IOException failed) {
                        lastError = "failed";
                        lastDetail = "callback exchange error: " + failed.getMessage();
                        writePage(client.getOutputStream(), "登录未完成。请回到 Folia 重试。");
                    }
                }
            } catch (IOException ignored) {
                // 监听被取消（窗口关闭）时这里会 IOException，属正常结束。
            } finally {
                latch.countDown();
            }
        }, "folia-spotify-oauth");
        thread.setDaemon(true);
        thread.start();
    }

    private static void stopListener() {
        ServerSocket socket = server;
        server = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // 已关。
            }
        }
    }

    private static String readRequestLine(InputStream input) {
        try {
            StringBuilder line = new StringBuilder();
            int read;
            while ((read = input.read()) != -1) {
                char c = (char) read;
                if (c == '\n') break;
                if (c != '\r') line.append(c);
                if (line.length() > 4096) break;
            }
            return line.length() == 0 ? null : line.toString();
        } catch (IOException error) {
            return null;
        }
    }

    private static void writePage(OutputStream output, String text) {
        String html = "<!doctype html><meta charset=\"utf-8\"><title>Folia</title><body style=\"margin:0;display:grid;"
                + "place-items:center;height:100vh;background:#121212;color:#fff;font:16px system-ui,sans-serif\">"
                + text + "</body>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        try {
            output.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    + "Cache-Control: no-store\r\nConnection: close\r\nContent-Length: " + body.length + "\r\n\r\n")
                    .getBytes(StandardCharsets.UTF_8));
            output.write(body);
            output.flush();
        } catch (IOException ignored) {
            // 浏览器提前断开也无所谓。
        }
    }

    // ── 令牌与资料 ──────────────────────────────────────────────────────────

    /** 上一次 token 请求的失败细节（HTTP 状态与响应体），随 lastDetail 带进诊断。 */
    private static volatile String tokenDetail;

    private static JSONObject tokenRequest(RequestBody form) throws IOException {
        tokenDetail = null;
        Request request = new Request.Builder()
                .url("https://accounts.spotify.com/api/token")
                .post(form)
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            String body = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                tokenDetail = "HTTP " + response.code() + " " + body.trim();
                return null;
            }
            try {
                JSONObject json = new JSONObject(body);
                if (json.optString("access_token", "").isEmpty()) {
                    tokenDetail = "no access_token in " + body.trim();
                    return null;
                }
                return json;
            } catch (JSONException error) {
                tokenDetail = "unreadable token body: " + body.trim();
                return null;
            }
        } catch (IOException error) {
            tokenDetail = "token request error: " + error.getMessage();
            throw error;
        }
    }

    private static void saveTokens(Context context, JSONObject tokens) throws IOException {
        JSONObject json = tokens;
        int expiresIn = json.optInt("expires_in", 3600);
        long expiresAt = System.currentTimeMillis() + Math.max(60, expiresIn) * 1000L;
        SharedPreferences.Editor editor = prefs(context).edit()
                .putString(KEY_ACCESS, json.optString("access_token", ""))
                .putLong(KEY_EXPIRES, expiresAt);
        String refresh = json.optString("refresh_token", "");
        if (!refresh.isEmpty()) editor.putString(KEY_REFRESH, refresh);
        editor.apply();
    }

    /** 资料页只是展示信息：拿不到就留空，下次登录状态再拉（公共 Web API 可能回 429）。 */
    private static void fetchProfile(Context context) throws IOException {
        String access = accessToken(context);
        if (access == null) return;
        Request request = new Request.Builder()
                .url("https://api.spotify.com/v1/me")
                .header("Authorization", "Bearer " + access)
                .build();
        try (Response response = HTTP.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) return;
            String body = response.body().string();
            try {
                JSONObject profile = new JSONObject(body);
                prefs(context).edit().putString(KEY_USER, profile.toString()).apply();
            } catch (JSONException ignored) {
                // 资料拿不到不影响登录态。
            }
        }
    }

    static JSONObject profile(Context context) {
        try {
            return new JSONObject(prefs(context).getString(KEY_USER, "{}"));
        } catch (JSONException error) {
            return new JSONObject();
        }
    }

    // ── PKCE 工具 ───────────────────────────────────────────────────────────

    private static String randomBase64Url(int bytes) {
        byte[] buffer = new byte[bytes];
        new SecureRandom().nextBytes(buffer);
        return base64Url(buffer);
    }

    private static byte[] sha256(String text) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static String base64Url(byte[] bytes) {
        return android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE
                        | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
    }
}
