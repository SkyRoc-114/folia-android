# 酷狗：标准版与概念版的支持方案

这份文档记录「酷狗音乐」与「酷狗概念版」两个客户端在 Folia 安卓版里的支持方式、关键代码位置、
诊断标记和验证办法。两个版本**不需要用户选择**：扫码登录走同一条链路，会员身份与取链由下面几层
各自兜底。

## 登录：同一个二维码，两个 App 都能扫

- 扫码流程在原生桥 `src/nativeBridge/api/kugou.js`（`handleKGLoginQrKey` / `handleKGLoginQrCreate` /
  `handleKGLoginQrCheck`），登录窗口文案已写明「酷狗音乐 / 酷狗概念版」。
- 状态映射抽在 `src/services/onlineMusic/kugou/kugouLoginState.ts`：酷狗状态码
  0 过期、1 等扫码、2/3 已扫码待确认、4 成功；兼容嵌套 `body.data`、只有 token 的答复。
  单测：`test/unit/onlineMusic/kugouQrLoginState.test.ts`。

## 会员识别：四条路径覆盖两个版本

| 路径 | 位置 | 覆盖 |
| --- | --- | --- |
| `login_by_token` 刷新 | `src/nativeBridge/api/kugou.js` `refreshKGLoginByToken` | 标准版 `vip_token` / `vip_type` |
| 概念版 union 探测 | 同上，`getKGYouthUnionVip` + `kgConceptVipTypeOf` | 概念版畅听 VIP 的 `is_vip` / `busi_vip` / `vip_type` |
| `/user/vip/detail` 合并探测 | 同上，`getKGUserVipDetail`（取链前，5 分钟限流） | 两版 + 移动端会员信息合并 |
| 账号界面档位解析 | `src/services/onlineMusic/kugou/kugouProvider.ts` `normalizeKugouVipType` | 两版字段 + 到期时间兜底 |

每日领取（概念版 VIP 只有一天）：

- 登录状态读取时补领（`ensureKugouYouthVip`）
- `kugouProvider.watch` 每 6 小时确认/补领
- 取链失败时现场补领（限流 10 分钟，决策函数 `shouldClaimConceptVipOnFailure`）

单测：`test/unit/onlineMusic/kugouConceptVip.test.ts`、
`kugouConceptClaim.test.ts`、`kugouVipState.test.ts`。

## 取链与质量回退

- 取链入口：`src/nativeBridge/api/kugou.js` `handleKGSongUrl`。
- 强制刷新后**重读登录态**再重试（`url:retry-vip-state` 记录前后 `vipType`/`isVip`）。
- 质量回退：`pickKGHashForQuality` 逐档下降、绝不越级；单测 `kugouQualityFallback.test.ts`。
- tracker 的 `vip_type` 候选：`buildKGTrackerVipTypeCandidates`（含 6/11/33/3 兜底）；
  单测 `kugouVipState.test.ts`。

## 播放：原生流式代理（Range + CORS）

音频元素带 `crossOrigin="anonymous"` 且接 WebAudio 分析，CDN 不回 CORS 头就会「取到链但无声」。
所以：

- `src/services/onlineMusic/omni.ts` 把播放地址挂到原生本地流服务
  （`LocalAudioServer` 的 `/remote-audio/<token>`，带 `Range` 与 `ACAO:*`）。
- 白名单在 `android/app/src/main/java/top/izuna/foliamajor/LocalAudioServer.java`
  （`REMOTE_AUDIO_HOST_SUFFIXES` 含 `kugou.com`，酷狗 CDN 转发带官网 Referer）。
- 未白名单的地址回退到 `src/services/onlinePlayback.ts` 的同源 blob 拉流：
  25 秒上限、一次重试、<4KB 视为占位符、按文件头补 MIME（`audioMimeTypeFor`）。
- 播放失败会记录媒体错误码与地址种类（`media-error-*`、`proxy-source`、`native-stream:`）。

## 诊断标记（设置 → 帮助 → 复制诊断数据）

| 标记 | 含义 |
| --- | --- |
| `youth:union:done` | 概念版 union VIP 探测结果（含字段名） |
| `auth:refresh:ok` | token 刷新结果：`hasVipToken` / `vipType` / `vipFlag` / `conceptVipType` |
| `auth:refresh:concept-vip:miss` | 刷新后仍没有会员线索 |
| `auth:user-vip:probe` | 取链前 `/user/vip/detail` 探测结果 |
| `url:retry-vip-state` | 强制刷新前后会员状态 |
| `vip:claim-on-fail:*` | 取链失败现场补领的尝试/结果 |
| `proxy-source` / `native-stream:` / `media-error-*` | 播放走的路线与失败原因 |

## 验证

```bash
npm run typecheck                 # tsc --noEmit
npx vitest run -c vitest.config.ts # 全量单测（当前 9999 通过）
npm run verify:android            # dist 与 cap sync 后的 assets 是否含本轮关键标记
```

## 已知限制

- 概念版会员没有 `vip_token` 时，部分 VIP 歌曲可能只能拿到较低档位的地址；此时以「能播放」优先。
- 最终的播放与会员识别效果需要真机（标准版 + 概念版各一次）确认；诊断报告按上表核对。
