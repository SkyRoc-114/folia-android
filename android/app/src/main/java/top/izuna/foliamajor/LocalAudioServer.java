package top.izuna.foliamajor;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 本地音频流服务器。
 *
 * 来源：
 *   /audio/<MediaStore id>          系统媒体库里的文件
 *   /audio/imported-<file name>     通过系统文件管理器挑选后复制进 App 私有目录的文件
 *   /remote-audio/<token>           代转发的远端音频（白名单主机）
 *   /media-cache/<id>               媒体缓存副本（App 私有目录，可写可读可删）
 *   /media-cache-stats              媒体缓存的 {count, bytes}
 *
 * WebView 的 <audio> 播不了 content:// 这种 URI，也不认 App 私有目录里的路径，
 * 所以原生起一个只监听 127.0.0.1 的小服务，把音频以 http 的形式喂回去。
 * 必须支持 Range：<audio> 拖进度、以及某些格式要先读文件尾部的元数据，都靠它。
 *
 * <p>线程：{@code cachedThreadPool} 一个连接一个线程，请求体（PUT）就在自己那条连接
 * 线程上流式读，不会占住别人的 GET / HEAD —— 并发上传和边传边播都不用另外排队。
 * 池子不设上限是故意的：这个服务只监听回环，连接数由本应用自己控制。
 */
final class LocalAudioServer {
    private static final String TAG = "LocalAudioServer";
    private static final String AUDIO_PATH_PREFIX = "/audio/";
    private static final String REMOTE_AUDIO_PATH_PREFIX = "/remote-audio/";
    /** 媒体缓存副本：GET/HEAD/PUT/DELETE 都走这个前缀。 */
    private static final String MEDIA_CACHE_PATH_PREFIX = "/media-cache/";
    /** 不带尾斜杠的目录本身：只接 DELETE（清空整个缓存）。 */
    private static final String MEDIA_CACHE_DIRECTORY_PATH = "/media-cache";
    /** 缓存占用统计：{count, bytes}。 */
    private static final String MEDIA_CACHE_STATS_PATH = "/media-cache-stats";
    /** 缓存 id 只允许 base64url（Web 侧 id = base64url(cacheKey)）；点号留给 sidecar。 */
    private static final Pattern MEDIA_CACHE_ID_PATTERN = Pattern.compile("[A-Za-z0-9_-]{1,120}");
    /** sidecar 后缀：<id>.mime 里存 PUT 时的 Content-Type。 */
    private static final String MEDIA_CACHE_MIME_SUFFIX = ".mime";
    /** 没有 sidecar / sidecar 坏了时的兜底类型。 */
    private static final String DEFAULT_MEDIA_CACHE_MIME = "audio/mpeg";
    private static final String CORS_ALLOW_METHODS = "GET, HEAD, PUT, DELETE, OPTIONS";
    private static final String CORS_ALLOW_HEADERS = "range, content-range, content-length, content-type";
    private static final String CORS_EXPOSE_HEADERS = "range, content-range, content-length, accept-ranges";
    private static final String IMPORTED_PREFIX = "imported-";
    /** 直接按绝对路径流原文件的 ref 前缀（文件系统兜底扫描出来的歌，不复制进私有目录）。 */
    private static final String FILE_PREFIX = "file-";
    /*
     * 汽水音乐（抖音/字节）播放地址所在的 CDN 后缀。
     *
     * 播放地址来自 douyinvod / bytefcdn / zjcdn 这类字节域，qishui.com、douyin.com
     * 自己也会直发流。单列一份是因为 Referer 要按这一族单独判（见 refererForHost），
     * 下面那份白名单只是把它并进去。不要在这里写 com / cn 这种过宽的后缀：
     * 这个数组决定本机能代谁去取流，宽一格就多一片可被滥用的目标。
     */
    private static final String[] BYTEDANCE_AUDIO_HOST_SUFFIXES = {
        "douyinvod.com",
        "bytefcdn.com",
        "bytecdn.cn",
        "byteicdn.com",
        "ibytedtos.com",
        "pstatp.com",
        "bytedance.com",
        "bytetos.com",
        "volcvideo.com",
        "volccdn.com",
        "volces.com",
        "volcengineapi.com",
        "douyin.com",
        "qishui.com",
        "zijieapi.com",
        "zjcdn.com",
        "snssdk.com"
    };
    /*
     * 只能代哪些主机的远端音频。
     *
     * 这个服务监听在 127.0.0.1 上，设备上任何应用都能连上来 —— 放行任意 URL 就等于
     * 开了一个「任读全网」的口子，所以按主机白名单收口。目前只有 Kuwo（波点）/ 网易 /
     * 酷狗，以及汽水音乐（抖音/字节）需要它：它们的 CDN 不下发 CORS 头，而
     * <audio> 带 crossOrigin="anonymous"，于是播放被同源策略挡掉
     * （表现是 MEDIA_ELEMENT_ERROR: Format error）。
     */
    private static final String[] REMOTE_AUDIO_HOST_SUFFIXES = withSuffixes(
        new String[] { "kuwo.cn", "music.126.net", "kugou.com" },
        BYTEDANCE_AUDIO_HOST_SUFFIXES
    );
    private static final String REMOTE_AUDIO_USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";
    private static final String REMOTE_AUDIO_REFERER = "https://www.kuwo.cn/";
    private static final String NETEASE_REMOTE_AUDIO_REFERER = "https://music.163.com/";
    /** 汽水（抖音）的 CDN 只认自家站点来的请求，桌面站点的 Referer 会被拒或被回错误页。 */
    private static final String BYTEDANCE_REMOTE_AUDIO_REFERER = "https://music.douyin.com/";
    private final Context context;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final OkHttpClient remoteAudioClient = new OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .build();
    private final Map<String, String> remoteAudioUrls = new LinkedHashMap<>();
    /** 转发时要额外带上的请求头（按 token 存）；没有时为 null，见 {@link #registerRemoteAudio}。 */
    private final Map<String, Map<String, String>> remoteAudioHeaders = new LinkedHashMap<>();
    private ServerSocket serverSocket;
    private int port;

    LocalAudioServer(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized int start() throws IOException {
        if (serverSocket != null && !serverSocket.isClosed()) return port;
        // 端口交给系统分配（0）：写死一个的话，被别的进程占了就起不来，
        // 而每次启动拿到的端口都可能不同，所以 URL 不能持久化，播放前要重新拼（见插件的 localAudioServerPort）。
        serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        port = serverSocket.getLocalPort();
        executor.execute(() -> {
            while (!serverSocket.isClosed()) {
                try {
                    Socket socket = serverSocket.accept();
                    executor.execute(() -> handle(socket));
                } catch (IOException ignored) {
                    Log.i(TAG, "server socket closed, stopping accept loop");
                    break;
                }
            }
        });
        return port;
    }

    int getPort() {
        return port;
    }

    /**
     * 把一个远端音频地址挂到本地服务上，返回 `http://127.0.0.1:<port>/remote-audio/<token>`。
     *
     * 为什么要绕这一圈：<audio> 带 crossOrigin="anonymous"，而 Kuwo（波点）的 CDN
     * 根本不下发 Access-Control-Allow-Origin —— 请求连字节都拿不到，报出来却是
     * 一句毫无特征的 "MEDIA_ELEMENT_ERROR: Format error" / "The element has no supported sources"。
     * 本地服务回包带 ACAO: *，同源检查就过了；Range 也照样转发，拖进度条不受影响。
     */
    synchronized String registerRemoteAudio(String value) throws IOException {
        return registerRemoteAudio(value, null, false);
    }

    /**
     * 同 {@link #registerRemoteAudio(String)}，但多两个开关：转发时要附带的请求头，以及"允许任意主机"。
     *
     * 为什么要它们：飞牛（FNOS）这类自建服务的音频流只认 `Cookie: music-token=...`，
     * 而 <audio> 加不了任何请求头；它的地址又是用户在登录时自己填的局域网地址，
     * 不可能出现在 {@link #REMOTE_AUDIO_HOST_SUFFIXES} 那份白名单里。
     * 两个开关都由调用方显式打开，白名单那一路（Kuwo / 网易）行为不变。
     */
    synchronized String registerRemoteAudio(String value, Map<String, String> headers, boolean allowAnyHost) throws IOException {
        URL url = new URL(value);
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        if (!("http".equals(url.getProtocol()) || "https".equals(url.getProtocol()))
            || !(allowAnyHost || isRemoteAudioHostAllowed(host))) {
            throw new IOException("Unsupported remote audio host");
        }
        int localPort = start();
        String token = android.util.Base64.encodeToString(
            value.getBytes(StandardCharsets.UTF_8),
            android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP
        );
        synchronized (remoteAudioUrls) {
            remoteAudioUrls.remove(token);
            remoteAudioUrls.put(token, value);
            remoteAudioHeaders.remove(token);
            if (headers != null && !headers.isEmpty()) remoteAudioHeaders.put(token, new HashMap<>(headers));
            while (remoteAudioUrls.size() > 128) {
                String oldest = remoteAudioUrls.keySet().iterator().next();
                remoteAudioUrls.remove(oldest);
                remoteAudioHeaders.remove(oldest);
            }
        }
        return "http://127.0.0.1:" + localPort + REMOTE_AUDIO_PATH_PREFIX + token;
    }

    /** 有些 CDN 看 Referer 决定给不给资源：不带时回的是一段 HTML 而不是音频。 */
    private static String remoteAudioReferer(String value) {
        String host;
        try {
            host = new URL(value).getHost();
        } catch (Exception ignored) {
            return REMOTE_AUDIO_REFERER;
        }
        return refererForHost(host);
    }

    /**
     * 按主机挑 Referer。
     *
     * 汽水（抖音）的 CDN 只认自家站点来的请求：带 www.kuwo.cn 那种无关的 Referer
     * 会被回成一段 HTML 或 403，喂进 <audio> 就是 "Format error"。所以这一族主机
     * 统一发 music.douyin.com；UA 仍然是上面那条移动 Chrome，不发 LunaOpenSDK 的
     * 客户端 UA —— 那套 UA 是桌面端登录链路的，拿它取流反而容易被判成异常客户端。
     */
    static String refererForHost(String host) {
        String normalized = host == null ? "" : host.toLowerCase(Locale.ROOT);
        if (matchesHost(normalized, "music.126.net")) return NETEASE_REMOTE_AUDIO_REFERER;
        // 酷狗 CDN 对没有 Referer 的请求有时回错误页；带上官网 Referer 与普通移动 UA 即可。
        if (matchesHost(normalized, "kugou.com")) return "https://www.kugou.com/";
        if (isByteDanceHost(normalized)) return BYTEDANCE_REMOTE_AUDIO_REFERER;
        return REMOTE_AUDIO_REFERER;
    }

    /** 汽水/抖音那批 CDN 主机（含 qishui.com、douyin.com 自身）。 */
    private static boolean isByteDanceHost(String host) {
        if (host.isEmpty()) return false;
        for (String suffix : BYTEDANCE_AUDIO_HOST_SUFFIXES) {
            if (matchesHost(host, suffix)) return true;
        }
        return false;
    }

    /** 主机正好是后缀本身，或者是它的子域。 */
    private static boolean matchesHost(String host, String suffix) {
        return host.equals(suffix) || host.endsWith("." + suffix);
    }

    private static boolean isRemoteAudioHostAllowed(String host) {
        if (host.isEmpty()) return false;
        for (String suffix : REMOTE_AUDIO_HOST_SUFFIXES) {
            if (matchesHost(host, suffix)) return true;
        }
        return false;
    }

    /** 把几组主机后缀并成一份白名单；域名只在各自的数组里写一次。 */
    private static String[] withSuffixes(String[]... groups) {
        int total = 0;
        for (String[] group : groups) total += group.length;
        String[] merged = new String[total];
        int offset = 0;
        for (String[] group : groups) {
            System.arraycopy(group, 0, merged, offset, group.length);
            offset += group.length;
        }
        return merged;
    }

    /** 调用方带来的头里有没有这一条（HTTP 头名不分大小写，Map 的键却是大小写敏感的）。 */
    private static boolean hasHeader(Map<String, String> headers, String name) {
        if (headers == null) return false;
        for (String key : headers.keySet()) {
            if (name.equalsIgnoreCase(key)) return true;
        }
        return false;
    }

    /** 复制进私有目录的音频存放位置。 */
    File importedAudioDirectory() {
        File dir = new File(context.getFilesDir(), "imported-audio");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /**
     * 媒体缓存副本存放位置：<filesDir>/media-cache/。
     *
     * 在线歌播过一次之后，字节从 WebView 的 IndexedDB 搬到 App 私有目录，播放器拿
     * http://127.0.0.1:<port>/media-cache/<id> 直接播。blob: 对 ExoPlayer 来说是个
     * 它不认识的 scheme，只能回落 <audio>；换成回环 HTTP 之后两条播放路径都能吃。
     */
    File mediaCacheDirectory() {
        File dir = new File(context.getFilesDir(), "media-cache");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** 缓存 id 白名单：base64url 字符集、1..120 字符，拒绝路径穿越与隐藏文件。 */
    private static boolean isMediaCacheIdValid(String id) {
        return id != null && MEDIA_CACHE_ID_PATTERN.matcher(id).matches();
    }

    /**
     * 媒体缓存的 {count, bytes}。
     *
     * sidecar（.mime）与写一半的 .part 不算，否则「缓存占用」会随每首歌多出几十字节，
     * 统计也跟实际能播的份数对不上。
     */
    private long[] mediaCacheStats() {
        File[] files = mediaCacheDirectory().listFiles();
        long count = 0;
        long bytes = 0;
        if (files != null) {
            for (File file : files) {
                if (!file.isFile()) continue;
                String name = file.getName();
                if (name.endsWith(MEDIA_CACHE_MIME_SUFFIX) || name.endsWith(".part")) continue;
                count += 1;
                bytes += file.length();
            }
        }
        return new long[] { count, bytes };
    }

    /** 清空整个媒体缓存目录（含 sidecar / 残骸）。 */
    private int clearMediaCache() {
        File[] files = mediaCacheDirectory().listFiles();
        if (files == null) return 0;
        int removed = 0;
        for (File file : files) {
            if (file.isFile() && file.delete()) removed += 1;
        }
        return removed;
    }

    /** sidecar 里存的 Content-Type；没有、读不动、内容不像话时回 audio/mpeg。 */
    private String readMediaCacheMime(File directory, String id) {
        File sidecar = new File(directory, id + MEDIA_CACHE_MIME_SUFFIX);
        if (!sidecar.isFile() || sidecar.length() <= 0 || sidecar.length() > 256) {
            return DEFAULT_MEDIA_CACHE_MIME;
        }
        byte[] buffer = new byte[(int) sidecar.length()];
        try (InputStream input = new FileInputStream(sidecar)) {
            int read = 0;
            while (read < buffer.length) {
                int current = input.read(buffer, read, buffer.length - read);
                if (current == -1) break;
                read += current;
            }
            String value = new String(buffer, 0, read, StandardCharsets.UTF_8);
            return normalizeMediaCacheMime(value);
        } catch (IOException error) {
            Log.w(TAG, "media cache mime unreadable: " + id, error);
            return DEFAULT_MEDIA_CACHE_MIME;
        }
    }

    /** 把调用方给的 Content-Type 收成一行安全值（header 里不能带 CR/LF）。 */
    private static String normalizeMediaCacheMime(String raw) {
        if (raw == null) return DEFAULT_MEDIA_CACHE_MIME;
        String value = raw.trim();
        if (value.isEmpty() || value.length() > 120) return DEFAULT_MEDIA_CACHE_MIME;
        for (int index = 0; index < value.length(); index += 1) {
            char current = value.charAt(index);
            if (current < 0x20 || current == 0x7f) return DEFAULT_MEDIA_CACHE_MIME;
        }
        return value;
    }

    /** 写 sidecar；失败只记日志，不影响副本本身（读的时候会回 audio/mpeg）。 */
    private void writeMediaCacheMime(File directory, String id, String mime) {
        File sidecar = new File(directory, id + MEDIA_CACHE_MIME_SUFFIX);
        try (OutputStream output = new FileOutputStream(sidecar)) {
            output.write(normalizeMediaCacheMime(mime).getBytes(StandardCharsets.UTF_8));
        } catch (IOException error) {
            Log.w(TAG, "media cache mime write failed: " + id, error);
        }
    }

    private void handle(Socket socket) {
        try (Socket client = socket;
             BufferedInputStream input = new BufferedInputStream(client.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(client.getOutputStream())) {
            String requestLine = readLine(input);
            if (requestLine == null) return;
            String[] requestParts = requestLine.split(" ");
            if (requestParts.length < 2) return;

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                int separator = line.indexOf(':');
                if (separator > 0) {
                    headers.put(
                        line.substring(0, separator).trim().toLowerCase(),
                        line.substring(separator + 1).trim()
                    );
                }
            }

            String rawPath = requestParts[1];
            int queryAt = rawPath.indexOf('?');
            String queryString = queryAt >= 0 ? rawPath.substring(queryAt + 1) : "";
            String path = queryAt >= 0 ? rawPath.substring(0, queryAt) : rawPath;
            String method = requestParts[0];
            /*
             * 预检（OPTIONS）必须自己答。
             *
             * 跨源请求只要带了 Range 之外的头、或者某些 WebView 版本对 Range 也走预检，
             * 浏览器就会先发一个 OPTIONS —— 服务不答就是 CORS 失败，
             * 而失败的表现和「文件不存在」一模一样（mediaErrorCode=4）。
             * 媒体缓存的 PUT/DELETE 还会带 Content-Type，所以这里的方法与头都要放行；
             * 答一个 204 之后，探测、播放、上传三条路都才走得通。
             */
            if ("OPTIONS".equals(method)) {
                String response = "HTTP/1.1 204 No Content\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Methods: " + CORS_ALLOW_METHODS + "\r\n"
                    + "Access-Control-Allow-Headers: " + CORS_ALLOW_HEADERS + "\r\n"
                    + "Access-Control-Expose-Headers: " + CORS_EXPOSE_HEADERS + "\r\n"
                    + "Access-Control-Max-Age: 86400\r\n"
                    + "Content-Length: 0\r\nConnection: close\r\n\r\n";
                output.write(response.getBytes(StandardCharsets.US_ASCII));
                output.flush();
                return;
            }
            if (MEDIA_CACHE_STATS_PATH.equals(path)) {
                if ("GET".equals(method) || "HEAD".equals(method)) {
                    writeMediaCacheStats(output, "HEAD".equals(method));
                } else {
                    writeStatus(output, 405, "Method Not Allowed");
                }
                return;
            }
            /*
             * 媒体缓存目录本身：DELETE 清空整个目录。
             *
             * /media-cache 与 /media-cache/ 两种写法都收：Web 侧把 base 拼出来时尾斜杠
             * 很容易多一个，为这个回 404 没有意义。
             */
            if (MEDIA_CACHE_DIRECTORY_PATH.equals(path) || (MEDIA_CACHE_DIRECTORY_PATH + "/").equals(path)) {
                if ("DELETE".equals(method)) {
                    int removed = clearMediaCache();
                    Log.i(TAG, "media cache cleared (" + removed + " files)");
                    writeNoContent(output);
                } else {
                    writeStatus(output, 405, "Method Not Allowed");
                }
                return;
            }
            if (path.startsWith(MEDIA_CACHE_PATH_PREFIX)) {
                String id = decodePathSegment(path.substring(MEDIA_CACHE_PATH_PREFIX.length()));
                if (id == null) {
                    writeStatus(output, 400, "Bad Request");
                    return;
                }
                if (!isMediaCacheIdValid(id)) {
                    // 路径穿越 / 点号 / 超长一律挡在拼路径之前。
                    Log.w(TAG, "media cache id refused: " + id);
                    writeStatus(output, 400, "Bad Request");
                    return;
                }
                if ("PUT".equals(method)) {
                    writeMediaCacheFile(input, output, headers, id);
                } else if ("DELETE".equals(method)) {
                    deleteMediaCacheFile(output, id, queryString);
                } else if ("GET".equals(method) || "HEAD".equals(method)) {
                    streamMediaCacheFile(output, requestParts, headers, id);
                } else {
                    writeStatus(output, 405, "Method Not Allowed");
                }
                return;
            }
            if (path.startsWith(REMOTE_AUDIO_PATH_PREFIX)) {
                streamRemoteAudio(output, requestParts, headers, path.substring(REMOTE_AUDIO_PATH_PREFIX.length()));
                return;
            }
            if (!path.startsWith(AUDIO_PATH_PREFIX)) {
                writeStatus(output, 404, "Not Found");
                return;
            }

            String token = URLDecoder.decode(path.substring(AUDIO_PATH_PREFIX.length()), "UTF-8");
            if (token.startsWith(IMPORTED_PREFIX)) {
                /*
                 * 传**完整的** token，别先剥掉 imported- 再拼路径。
                 *
                 * 磁盘上的副本名本身就是 "imported-<稳定名>"（导入那边 safeName 就是这么起的，
                 * 删副本的 resolveImportedFile 也是按完整 ref 拼的），而这里剥掉前缀之后
                 * 拼出来的是 "imported-audio/<稳定名>" —— 少了一段，永远 isFile() == false，
                 * 于是每一首手动导入的歌都回 404：<audio> 报 Format error、
                 * 导入时抓封面和内嵌歌词的那次 fetch 也一起失败（封面/歌词全空）。
                 * 表现正是「扫描导入能播，手动导入一律播不了」。
                 */
                streamImportedFile(output, requestParts, headers, token);
                return;
            }
            if (token.startsWith(FILE_PREFIX)) {
                streamExternalFile(output, requestParts, headers, token.substring(FILE_PREFIX.length()));
                return;
            }
            streamMediaStoreFile(output, requestParts, headers, token);
        } catch (Exception error) {
            // 之前这里连日志都没有：流写到一半断掉，WebView 那边只会报一句
            // Format error，原生侧连发生了什么都不知道。
            Log.w(TAG, "audio request failed", error);
            // 顺带进崩溃诊断：诊断报告里能直接读到 local-audio-server 这条，
            // 不用再让用户去捞 logcat。
            CrashDiagnostics.record(context, "local-audio-server", "server", error);
        }
    }

    private void streamMediaStoreFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String mediaId
    ) throws IOException {
        Uri uri = Uri.withAppendedPath(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId);
        ContentResolver resolver = context.getContentResolver();
        long size = -1;
        String mime = "audio/*";
        try (Cursor cursor = resolver.query(uri, new String[]{
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE
        }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                size = cursor.getLong(0);
                String queriedMime = cursor.getString(1);
                if (queriedMime != null && !queriedMime.isEmpty()) mime = queriedMime;
            }
        }
        writeResponse(output, requestParts, headers, size, mime, () -> resolver.openInputStream(uri));
    }

    private void streamImportedFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String fileName
    ) throws IOException {
        // 现在传进来的是完整文件名（含 imported- 前缀）。这个服务监听在 127.0.0.1 上，
        // 设备上任何应用都能连，名字来自 URL，必须挡掉路径穿越。
        if (fileName.contains("/") || fileName.contains("\\") || fileName.contains("..")) {
            Log.w(TAG, "imported audio refused: " + fileName);
            writeStatus(output, 404, "Not Found");
            return;
        }
        File target = new File(importedAudioDirectory(), fileName);
        if (!target.isFile()) {
            Log.w(TAG, "imported audio missing: " + fileName);
            writeStatus(output, 404, "Not Found");
            return;
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(fileName),
            () -> new FileInputStream(target)
        );
    }

    /**
     * 按绝对路径流用户自己的音频（文件系统兜底扫描的歌）。
     *
     * 只放行外存根目录下的音频文件，别的一律 404 —— 这个服务监听在 127.0.0.1 上，
     * 设备上任何应用都能连上来，不能让它变成一个任读全盘的口子。
     * 走这条路的歌要求已授予「所有文件访问」，没授权时读流会自己失败。
     */
    private void streamExternalFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String encodedPath
    ) throws IOException {
        String filePath = URLDecoder.decode(encodedPath, "UTF-8");
        File target = new File(filePath);
        File root = Environment.getExternalStorageDirectory();
        boolean insideRoot = root != null && filePath.startsWith(root.getPath() + File.separator);
        if (!insideRoot || !target.isFile() || !isAudioFileName(filePath)) {
            Log.w(TAG, "external audio refused: " + filePath);
            writeStatus(output, 404, "Not Found");
            return;
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(filePath),
            () -> new FileInputStream(target)
        );
    }

    /**
     * 代转发一个远端音频（只有白名单主机能用，见 {@link #registerRemoteAudio}）。
     *
     * Range 原样往上带：拖进度条时 <audio> 会发 `bytes=xxx-`，上游回 206，
     * 我们也要回 206 并把它的 Content-Range 转给 WebView，否则播放器会认为
     * 服务端不支持拖动，重新整首下载一次。
     */
    private void streamRemoteAudio(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String token
    ) throws IOException {
        String target;
        synchronized (remoteAudioUrls) {
            target = remoteAudioUrls.get(token);
        }
        if (target == null) {
            Log.w(TAG, "remote audio token unknown: " + token);
            writeStatus(output, 404, "Not Found");
            return;
        }

        Map<String, String> extraHeaders;
        synchronized (remoteAudioUrls) {
            extraHeaders = remoteAudioHeaders.get(token);
        }
        Request.Builder request = new Request.Builder().url(target);
        // 有些 CDN 看 UA / Referer 决定给不给资源，不带的话会回一段 HTML 而不是音频
        // —— 那种回包喂进 <audio> 正是「Format error」的经典来源。
        //
        // 默认值只补空缺：调用方显式给了 UA / Referer（汽水的 CDN 有时要带自己的）时，
        // 不再写默认值，同名的头以调用方为准。HTTP 头不分大小写，所以这里按忽略大小写判。
        if (!hasHeader(extraHeaders, "user-agent")) {
            request.header("User-Agent", REMOTE_AUDIO_USER_AGENT);
        }
        if (!hasHeader(extraHeaders, "referer")) {
            request.header("Referer", remoteAudioReferer(target));
        }
        // 调用方带来的头（汽水的 Referer/UA、飞牛的 music-token）最后写：同名的以它为准。
        if (extraHeaders != null) {
            for (Map.Entry<String, String> entry : extraHeaders.entrySet()) {
                request.header(entry.getKey(), entry.getValue());
            }
        }
        String range = headers.get("range");
        if (range != null && range.startsWith("bytes=")) request.header("Range", range);

        Response upstream = remoteAudioClient.newCall(request.build()).execute();
        try {
            ResponseBody body = upstream.body();
            if (!upstream.isSuccessful() || body == null) {
                Log.w(TAG, "remote audio upstream " + upstream.code() + " for " + target);
                writeStatus(output, 502, "Upstream Error");
                return;
            }
            String contentType = body.contentType() != null ? body.contentType().toString() : "audio/mpeg";
            String contentRange = upstream.header("Content-Range");
            long size = body.contentLength();
            // 上游不给长度（chunked）时用 Content-Range 兜底，但要分清是哪一段：
            // 206 的 Content-Length 必须是「这一段」的字节数，拿 Content-Range 里的 total
            // 顶上去，发出去的字节比头部声明少，播放器就会一直等剩下的数据（拖进度条后卡住）；
            // 200 的 Content-Length 才是整首长度。
            if (size < 0 && contentRange != null) {
                size = upstream.code() == 206
                    ? contentRangeWidth(contentRange)
                    : contentRangeTotal(contentRange);
            }
            boolean partial = upstream.code() == 206 || contentRange != null;

            Log.i(TAG, "remote " + target + " -> " + upstream.code()
                + " type=" + contentType + " size=" + size + " range=" + (contentRange == null ? "-" : contentRange));

            StringBuilder response = new StringBuilder();
            response.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            response.append("Content-Type: ").append(contentType).append("\r\n");
            response.append("Accept-Ranges: bytes\r\n");
            // 这一整条链路存在的唯一理由就是同源：没有这两行，<audio crossOrigin="anonymous">
            // 依然会被 CORS 挡在门外，和直连 CDN 没区别。
            response.append("Access-Control-Allow-Origin: *\r\n");
            response.append("Access-Control-Allow-Headers: range, content-range, content-length\r\n");
            response.append("Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n");
            response.append("Connection: close\r\n");
            if (size >= 0) {
                response.append("Content-Length: ").append(size).append("\r\n");
                if (contentRange != null) {
                    response.append("Content-Range: ").append(contentRange).append("\r\n");
                }
            }
            response.append("\r\n");
            output.write(response.toString().getBytes(StandardCharsets.US_ASCII));

            if ("GET".equals(requestParts[0])) {
                try (InputStream audio = body.byteStream()) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = audio.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                    }
                }
            }
            output.flush();
        } finally {
            upstream.close();
        }
    }

    /**
     * 读一份媒体缓存副本（GET / HEAD /media-cache/<id>）。
     *
     * 直接复用 writeResponse：Range / 206 / Content-Range / CORS 只写一遍。ExoPlayer
     * 拖进度和 <audio> 探元数据都靠 Range，少了它播放器会整首重下。
     */
    private void streamMediaCacheFile(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        String id
    ) throws IOException {
        File directory = mediaCacheDirectory();
        File target = new File(directory, id);
        if (!target.isFile()) {
            Log.w(TAG, "media cache copy missing: " + id);
            writeStatus(output, 404, "Not Found");
            return;
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            readMediaCacheMime(directory, id),
            () -> new FileInputStream(target)
        );
    }

    /**
     * 存一份媒体缓存副本（PUT /media-cache/<id>）。
     *
     * 字节走 HTTP 请求体，不走 Capacitor 桥：桥只有一条，几 MB 的 base64 压上去，
     * 位置事件和别的调用全在排队。
     *
     * <p>先写临时 .part 再 rename：写一半被杀不会把一份坏字节留成「这首歌」，而坏副本
     * 正是下一次播放会读到的那份（症状是「播到一半断了，之后永远播不了」）。临时名带
     * 纳秒：同一个 id 并发 PUT 时各自写各自的 .part，不会互相踩。
     *
     * <p>请求体支持 Content-Length 和 Transfer-Encoding: chunked 两种；后者是 Web 侧
     * 用 ReadableStream 做 body 时浏览器会选的编码，不能只会读定长。
     */
    private void writeMediaCacheFile(
        BufferedInputStream input,
        BufferedOutputStream output,
        Map<String, String> headers,
        String id
    ) throws IOException {
        String mime = normalizeMediaCacheMime(headers.get("content-type"));
        long declared = parseLongOr(headers.get("content-length"), -1);
        String transferEncoding = headers.get("transfer-encoding");
        boolean chunked = transferEncoding != null
            && transferEncoding.toLowerCase(Locale.ROOT).contains("chunked");
        if (declared <= 0 && !chunked) {
            // 没有长度就没法判断「写完了没有」：宁可 411，也不留半份副本。
            writeStatus(output, 411, "Length Required");
            return;
        }
        File directory = mediaCacheDirectory();
        File target = new File(directory, id);
        File temp = new File(directory, id + "-" + System.nanoTime() + ".part");
        long written = 0;
        try (OutputStream fileOutput = new BufferedOutputStream(new FileOutputStream(temp))) {
            if (chunked) {
                written = copyChunkedBody(input, fileOutput);
            } else {
                byte[] buffer = new byte[64 * 1024];
                while (written < declared) {
                    int read = input.read(buffer, 0, (int) Math.min(buffer.length, declared - written));
                    if (read == -1) break;
                    fileOutput.write(buffer, 0, read);
                    written += read;
                }
            }
        }
        // chunked 时 Content-Length 按 RFC 应被忽略（有些客户端会同时发一个旧的），
        // 完整性只看 chunked 自己的结束块。
        if (written <= 0 || (!chunked && declared > 0 && written != declared)) {
            temp.delete();
            Log.w(TAG, "media cache write short: " + written + "/" + declared + " id=" + id);
            writeStatus(output, 400, "Incomplete Body");
            return;
        }
        if (!temp.renameTo(target)) {
            // 目标已存在时个别实现会拒绝 rename：清掉再试一次（同一 id 是覆盖写）。
            target.delete();
            if (!temp.renameTo(target)) {
                temp.delete();
                Log.w(TAG, "media cache rename failed: " + id);
                writeStatus(output, 500, "Store Failed");
                return;
            }
        }
        // sidecar 在 rename 之后写：副本已经完整，Content-Type 差一点也只是回兜底类型。
        writeMediaCacheMime(directory, id, mime);
        Log.i(TAG, "media cache stored " + id + " (" + written + " bytes, " + mime + ")");
        writeStatus(output, 201, "Created");
    }

    /**
     * 删一份媒体缓存副本（DELETE /media-cache/<id>?size=NN）。
     *
     * 带 size 时只在长度对得上时才删：调用方要删的是它读到的那一份，期间被写进来的
     * 新副本不是（例如重新缓存后大小变了）。不匹配回 409，让调用方自己决定要不要重试。
     * 不存在的 id 按幂等处理：清掉可能残留的 sidecar，回 204。
     */
    private void deleteMediaCacheFile(
        BufferedOutputStream output,
        String id,
        String queryString
    ) throws IOException {
        File directory = mediaCacheDirectory();
        File target = new File(directory, id);
        File sidecar = new File(directory, id + MEDIA_CACHE_MIME_SUFFIX);
        if (!target.isFile()) {
            sidecar.delete();
            writeNoContent(output);
            return;
        }
        long expectedSize = queryParam(queryString, "size", -1);
        if (expectedSize >= 0 && target.length() != expectedSize) {
            Log.i(TAG, "media cache delete skipped, size mismatch: " + id
                + " local=" + target.length() + " expected=" + expectedSize);
            writeStatus(output, 409, "Conflict");
            return;
        }
        boolean removed = target.delete();
        // sidecar 跟着副本走：留着它会让统计和目录看起来多一份。
        sidecar.delete();
        if (!removed) {
            Log.w(TAG, "media cache delete failed: " + id);
            writeStatus(output, 500, "Delete Failed");
            return;
        }
        writeNoContent(output);
    }

    /** GET /media-cache-stats → {count,bytes}。HEAD 只回头。 */
    private void writeMediaCacheStats(OutputStream output, boolean headOnly) throws IOException {
        long[] stats = mediaCacheStats();
        String body = "{\"count\":" + stats[0] + ",\"bytes\":" + stats[1] + "}";
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        String response = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Cache-Control: no-store\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Methods: " + CORS_ALLOW_METHODS + "\r\n"
            + "Access-Control-Allow-Headers: " + CORS_ALLOW_HEADERS + "\r\n"
            + "Access-Control-Expose-Headers: " + CORS_EXPOSE_HEADERS + "\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(response.getBytes(StandardCharsets.US_ASCII));
        if (!headOnly) output.write(payload);
        output.flush();
    }

    /**
     * 读 chunked 请求体。
     *
     * 格式是「十六进制长度行 + 数据 + CRLF」，最后一块长度 0，后面可能跟 trailer。
     * 写文件的循环在调用方，这里只负责把每一块数据搬到 fileOutput。
     */
    private static long copyChunkedBody(InputStream input, OutputStream fileOutput) throws IOException {
        long written = 0;
        byte[] buffer = new byte[64 * 1024];
        while (true) {
            String sizeLine = readLine(input);
            if (sizeLine == null) throw new IOException("chunked body ended before last chunk");
            int extension = sizeLine.indexOf(';');
            String hex = (extension >= 0 ? sizeLine.substring(0, extension) : sizeLine).trim();
            long chunkSize;
            try {
                chunkSize = Long.parseLong(hex, 16);
            } catch (NumberFormatException error) {
                throw new IOException("invalid chunk size: " + hex);
            }
            if (chunkSize < 0) throw new IOException("negative chunk size: " + chunkSize);
            if (chunkSize == 0) {
                // 吃掉 trailer，直到空行；不解析，只要把连接读到响应的位置。
                String trailer;
                while ((trailer = readLine(input)) != null && !trailer.isEmpty()) {
                    // ignore trailers
                }
                return written;
            }
            long remaining = chunkSize;
            while (remaining > 0) {
                int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                if (read == -1) throw new IOException("chunked body truncated");
                fileOutput.write(buffer, 0, read);
                written += read;
                remaining -= read;
            }
            // 每块数据后面的 CRLF：readLine 读到空行即返回。
            readLine(input);
        }
    }

    /** URL 解码一个路径片段；编码坏掉时回 null，不把异常甩给整条请求。 */
    private static String decodePathSegment(String raw) {
        try {
            return URLDecoder.decode(raw, "UTF-8");
        } catch (Exception error) {
            return null;
        }
    }

    private static long parseLongOr(String raw, long fallback) {
        if (raw == null) return fallback;
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    /** 从 a=1&b=2 里取一个数；没有或不是数就给 fallback。 */
    private static long queryParam(String queryString, String key, long fallback) {
        if (queryString == null || queryString.isEmpty()) return fallback;
        for (String pair : queryString.split("&")) {
            int at = pair.indexOf('=');
            if (at <= 0 || !key.equals(pair.substring(0, at))) continue;
            return parseLongOr(pair.substring(at + 1), fallback);
        }
        return fallback;
    }

    /**
     * 204 响应（DELETE 成功）。
     *
     * 204 按规范不带消息体，也不该带 Content-Length；CORS 头照样要给，否则 fetch 侧
     * 读到的是一次「网络错误」而不是「删掉了」。
     */
    private static void writeNoContent(OutputStream output) throws IOException {
        String response = "HTTP/1.1 204 No Content\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Methods: " + CORS_ALLOW_METHODS + "\r\n"
            + "Access-Control-Allow-Headers: " + CORS_ALLOW_HEADERS + "\r\n"
            + "Access-Control-Expose-Headers: " + CORS_EXPOSE_HEADERS + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(response.getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }

    private interface StreamSupplier {
        InputStream open() throws IOException;
    }

    /** "bytes 100-199/1000" → 100（这一段有多少字节）；解析不出来回 -1。 */
    private static long contentRangeWidth(String contentRange) {
        int space = contentRange.indexOf(' ');
        int dash = space < 0 ? -1 : contentRange.indexOf('-', space + 1);
        int slash = dash < 0 ? -1 : contentRange.indexOf('/', dash + 1);
        if (dash < 0 || slash < 0) return -1;
        try {
            long start = Long.parseLong(contentRange.substring(space + 1, dash).trim());
            long end = Long.parseLong(contentRange.substring(dash + 1, slash).trim());
            return end - start + 1;
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    /** "bytes 100-199/1000" → 1000（整首有多大）；解析不出来回 -1。 */
    private static long contentRangeTotal(String contentRange) {
        int slash = contentRange.indexOf('/');
        if (slash < 0 || slash + 1 >= contentRange.length()) return -1;
        try {
            return Long.parseLong(contentRange.substring(slash + 1).trim());
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    private void writeResponse(
        BufferedOutputStream output,
        String[] requestParts,
        Map<String, String> headers,
        long size,
        String mime,
        StreamSupplier supplier
    ) throws IOException {
        // 空文件喂给 <audio> 只会换来一句莫名的 MEDIA_ELEMENT_ERROR: Format error；
        // 这里直接 404 并把原因写进日志，下次一眼就能看出是"文件是空的"。
        if (size <= 0) {
            Log.w(TAG, "audio source is empty or unreadable (size=" + size + "): " + requestParts[1]);
            writeStatus(output, 404, "Empty Audio");
            return;
        }
        long start = 0;
        long end = size > 0 ? size - 1 : -1;
        String range = headers.get("range");
        boolean partial = false;
        if (range != null && range.startsWith("bytes=")) {
            String[] parts = range.substring(6).split("-", -1);
            try {
                if (!parts[0].isEmpty()) start = Long.parseLong(parts[0]);
                if (parts.length > 1 && !parts[1].isEmpty()) end = Long.parseLong(parts[1]);
                if (size > 0) end = Math.min(end, size - 1);
                partial = true;
            } catch (NumberFormatException ignored) {
                start = 0;
                end = size > 0 ? size - 1 : -1;
                partial = false;
            }
        }

        long contentLength = end >= start ? end - start + 1 : -1;
        Log.i(TAG, requestParts[0] + " " + requestParts[1]
            + " range=" + (range == null ? "-" : range)
            + " size=" + size + " partial=" + partial
            + (partial ? " bytes=" + start + "-" + end : ""));
        StringBuilder response = new StringBuilder();
        response.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        response.append("Content-Type: ").append(mime).append("\r\n");
        response.append("Accept-Ranges: bytes\r\n");
        response.append("Access-Control-Allow-Origin: *\r\n");
        // crossOrigin="anonymous" 的 <audio> 会带 CORS 语义，把 Range 相关头暴露出来，
        // 拖进度条（发 Range、读 Content-Range）才不会在 CORS 检查上被拦。
        response.append("Access-Control-Allow-Headers: ").append(CORS_ALLOW_HEADERS).append("\r\n");
        response.append("Access-Control-Expose-Headers: ").append(CORS_EXPOSE_HEADERS).append("\r\n");
        response.append("Connection: close\r\n");
        if (size > 0) {
            response.append("Content-Length: ").append(contentLength).append("\r\n");
            if (partial) {
                response.append("Content-Range: bytes ")
                    .append(start).append('-').append(end).append('/').append(size).append("\r\n");
            }
        }
        response.append("\r\n");
        output.write(response.toString().getBytes(StandardCharsets.US_ASCII));

        // HEAD 只回头部：<audio> 在真正下载前会先探一次，那时不能把整首歌读一遍。
        if ("GET".equals(requestParts[0])) {
            try (InputStream audio = supplier.open()) {
                if (audio != null) {
                    skipFully(audio, start);
                    byte[] buffer = new byte[64 * 1024];
                    long remaining = contentLength;
                    int read;
                    while ((read = audio.read(buffer)) != -1 && (remaining < 0 || remaining > 0)) {
                        int writeLength = remaining < 0 ? read : (int) Math.min(read, remaining);
                        output.write(buffer, 0, writeLength);
                        if (remaining > 0) remaining -= writeLength;
                    }
                }
            }
        }
        output.flush();
    }

    /**
     * InputStream.skip 不保证一次跳够（它爱跳多少跳多少），文件流上偶尔也会短跳。
     * 之前直接一个 skip 了事，短跳时从错误的位置开始发 —— 解码器读到的就是一段
     * 被错位的数据，表现正是「MEDIA_ELEMENT_ERROR: Format error」这类莫名失败。
     */
    private static void skipFully(InputStream audio, long bytes) throws IOException {
        long remaining = bytes;
        while (remaining > 0) {
            long skipped = audio.skip(remaining);
            if (skipped <= 0) {
                // skip 返回 0 只能靠读来推进（可能已经到头）。
                if (audio.read() == -1) return;
                skipped = 1;
            }
            remaining -= skipped;
        }
    }

    /** 路径是不是设备上常见的音频扩展名（文件系统兜底扫描与 file- 路由共用）。 */
    static boolean isAudioFileName(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        return lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav")
            || lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".ogg")
            || lower.endsWith(".opus") || lower.endsWith(".ape") || lower.endsWith(".wma");
    }

    static String guessMimeType(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
        if (lower.endsWith(".opus")) return "audio/opus";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".ape")) return "audio/ape";
        if (lower.endsWith(".wma")) return "audio/x-ms-wma";
        return "audio/mpeg";
    }

    private static String readLine(InputStream input) throws IOException {
        StringBuilder line = new StringBuilder();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') line.append((char) value);
        }
        return value == -1 && line.length() == 0 ? null : line.toString();
    }

    /**
     * 错误响应也一定要带 CORS 头。
     *
     * <audio> 带 crossOrigin="anonymous"，响应缺 Access-Control-Allow-Origin 时，
     * 浏览器把「CORS 被拒」和「文件不存在 / 空文件」报成一模一样的东西：
     * networkState=3、mediaErrorCode=4（MEDIA_ERR_SRC_NOT_SUPPORTED）——
     * 也就是那句毫无特征的 MEDIA_ELEMENT_ERROR: Format error。
     * 带上 ACAO 之后，上层用 fetch 探一次就能读到真实的 404/502，不用再猜。
     */
    private static void writeStatus(OutputStream output, int status, String message) throws IOException {
        String response = "HTTP/1.1 " + status + " " + message + "\r\n"
            + "Content-Type: text/plain\r\n"
            + "Content-Length: 0\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Headers: " + CORS_ALLOW_HEADERS + "\r\n"
            + "Access-Control-Expose-Headers: " + CORS_EXPOSE_HEADERS + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(response.getBytes(StandardCharsets.US_ASCII));
        output.flush();
    }
}
