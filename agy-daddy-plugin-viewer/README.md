# @agy-daddy/plugin-viewer

Agy-Daddy 官方 Layer 2 核心插件：本地 127.0.0.1 HTTP 206 大文件流式检视台与只读 Git 安全行内 Diff 服务。

- **npm 包名**：`@agy-daddy/plugin-viewer`
- **插件 ID**：`agy-daddy.viewer`
- **Layer 层级**：Layer 2（检视与文件呈现增强层）
- **信任等级**：官方 `T0`（声明 `dom:read`、`dom:write`、`rpc:read`、`bridge:route`、`fs:plugin-data`、`fs:user-files`、`net:listen`、`process:spawn` 权限）
- **隔离级别**：`world: "isolated"`（Shadow DOM 挂载无全局样式污染，不注入或侵入宿主原生 `app.asar`）
- **适用场景**：通过 Antigravity 桌面端文件查看器（`fileViewer.header` 锚点）无侵入注入 Omni Viewer 流式检视台与工作区 Git 行内差异视图。解决宿主在处理超大音视频、数万行 CSV/TSV 表格、高精度 SVG 矢量画布与本地字体样张时的卡顿、白屏与内存膨胀瓶颈，同时提供开箱即用、安全严格受控的代码修改行内比对体验。

---

## 核心功能全景

### 1. 本地大文件流式检视台（Omni Viewer）

依托仅监听 `127.0.0.1` 的轻量 HTTP 206 流式网关，按需分块加载本地大文件，支持四大专业检视场景：

- **超大音视频流式检视（Media Inspector）**：
  - **HTTP 206 Range 按需拖动**：遵循 RFC 9110 单 Range 规范，实现数 GB 级音视频的即点即播与任意位置低延迟 Seek，彻底避免整文件全量加载进内存导致的卡顿崩溃；
  - **毫秒级时间码与逐帧步进**：精准展示 `HH:MM:SS.mmm` 时间码，提供以 24 / 25 / 30 / 60 fps 为基准的单帧前进与后退（Step Forward / Backward）精准校对；
  - **双通道波形与内存熔断**：通过 Web Audio API 绘制音频振幅波形包络；超过 `mediaWaveformMaxMB`（默认 100MB）时自动安全熔断全量解码以保护渲染进程内存，音视频流式播放与拖动依然正常运作；
  - **时间轴打点标记（Markers Store）**：支持在时间轴上添加毫秒级 Cue 打点、分类标签（中性、信息、警告、危险）与备注，数据通过安全 Bridge 自动持久化至插件专属目录（`markers.json`），并在文件重命名或下次打开时基于内容指纹无缝恢复。
- **大体积虚拟滚动表格（CSV / TSV Virtual Table）**：
  - **流式稀疏索引引擎（Sparse Checkpoint Index）**：以 256 行为步长动态记录文件字节偏移，兼容标准 RFC 4180 字段引号跨行换行与转义，避免全量文本解析；
  - **分块按需拉取与虚拟滚动**：以 `csvChunkSize`（默认 200 行）向本地网关请求行数据切片，结合视口高度仅渲染可视区域 DOM 行；
  - **表头固定与模式切换**：首行支持一键锁定为冻结表头（Frozen Header），亦可一键切换为纯数据行模式并自动生成 `C1`..`Cn` 虚拟列标识；
  - **全量/单列检索与正则匹配**：支持全局关键词快速过滤、指定列模糊搜索与合法正则表达式检索（内置 ReDoS 防护与语法异常拦截）。
- **无损矢量画布（Lossless SVG Canvas）**：
  - **10%–1600% 无级缩放与平移**：支持鼠标滚轮无损矢量缩放、鼠标抓手拖动画布平移以及「适应视口 / 1:1 实际大小」快速重置；
  - **三态画板背景切换**：内置透明棋盘格（Checkerboard）、亮白画板（Light）与深灰画板（Dark）三种预设背景，便于检视任意配色的矢量线条与轮廓；
  - **严格内容净化（SVG Sanitizer）**：在渲染前自动剔除潜在危险脚本、XML 外部实体与非法内联事件。
- **多字号字体样张检视台（Font Specimen）**：
  - **本地字体安全解析**：支持 `.ttf`、`.otf`、`.woff2`、`.woff` 格式，通过网关安全拉取并通过 `FontFace` API 动态注入沙箱视口；
  - **多字号瀑布流（Waterfall Specimen）**：提供 12px 至 72px 连续字阶的瀑布流样张展示，支持内置中英数符号全要素全字母句（Pangram）或用户自定义测试文案；
  - **全量字形网格（Glyph Grid）**：分块分页展示字体包含的全部字符字形、Unicode 编码与码点信息；
  - **加载上限熔断**：单字体文件超过 `fontMaxSizeMB`（默认 50MB）时拒绝注入并展示保护横幅，防止字体解包爆内存。

### 2. Git 安全行内 Diff（Git Safe Inline Diff）

在 Antigravity 文件查看器与侧边栏中提供严格只读的工作区代码差异对比服务：

- **单文件原位行内 Diff**：直接在文件查看器中切换到行内 Diff 视图，与 Git 最新基准（HEAD / 暂存区 / 工作区未暂存）比对当前文件的修改；
- **全工作区变更抽屉（Changes Drawer）**：侧边栏支持展开 Git 变更清单抽屉，清晰展示 Modified、Added、Deleted、Renamed 与 Untracked 状态徽章与差异统计（`+行 / -行`），点击任意变更项即可瞬时切入 Diff 视图；
- **词级细粒度差异高亮（Intraline Word Highlight）**：基于 Myers 差异与分词算法，在行级增删（Addition / Deletion）基础上，精准计算并高亮连续改动行内部的具体字符与词组差异片段（`wordSpans`）；
- **布局灵活切换与上下文展开**：支持窄侧栏推荐的单栏行内对比（Unified）以及宽屏桌面下的双栏并排对比（Split）；每个差异块（Hunk）默认保留 3 行上下文，并支持点击空白占位条按需向上/向下展开折叠代码；
- **安全熔断机制**：单文件差异体积超过 `diffMaxFileSizeMB`（默认 2MB）或单次渲染行数超过 `diffMaxLines`（默认 5000 行）时，自动安全截断并展示警示横幅，确保大文件对比不阻塞宿主渲染线程。

---

## 「官方优先礼让」机制与触发说明

本插件遵循**官方优先礼让（Official-First Deferral）**核心准则：不破坏、不强占宿主原生的轻量预览体验。

### 1. 自动接管触发矩阵

当配置项 `officialFirstDeferral: true` 时，插件依循以下矩阵裁决是否自动原位接管：

| 文件类型 | 判定规则与自动接管阈值 | 说明 |
|---|---|---|
| **音视频 (`.mp4`, `.webm`, `.mp3`, `.wav` 等)** | 体积 $\ge$ `mediaThresholdMB`（默认 **5 MB**）或宿主容器无可用 `<video>`/`<audio>` 控件时 | 超出阈值的大体积多媒体自动切入 HTTP 206 流式播放与时间轴打点；轻量小体积多媒体继续由宿主原生直接播放。设为 `0` 表示全部接管。 |
| **表格 (`.csv`, `.tsv`)** | 体积 $\ge$ `csvThresholdMB`（默认 **1 MB**）或头部 64KB 估算行数 $\ge$ `csvThresholdLines`（默认 **2000 行**）时 | 超出阈值时自动切入稀疏索引与虚拟滚动表格，防止原生卡死；小文本表格保持宿主文本预览。 |
| **矢量 (`.svg`)** | 依据 `svgTakeoverMode` 设置：<br>• `threshold`：体积 $\ge$ `svgThresholdKB`（默认 **64 KB**）时自动接管<br>• `always`：无论体积，打开即自动接管<br>• `manual`：保持原生代码/预览，仅允许手动切换 | 适应不同用户对 SVG 代码检视 vs 画布平移缩放的操作偏好。 |
| **字体 (`.ttf`, `.otf`, `.woff2`, `.woff`)** | 默认自动接管（`fontAutoTakeover: true`） | 宿主无原生字体样张展示能力，打开字体文件自动呈现字阶瀑布流与字形网格。 |
| **原生截断标记感知** | 容器包含 `truncated`、`too large`、`文件过大`、`已截断` 或 `无法预览` 提示 | 无论属于上述何种文件类型，只要检测到宿主原生渲染截断或告警，Omni Viewer 立即无缝接管呈现。 |

> **提示**：若将 `officialFirstDeferral` 设为 `false`，则支持的上述四大类格式在打开时均会一律直接进入 Omni Viewer 增强检视台。

### 2. 原生回退与防弹跳（Anti-Rebound）

- **标题栏控制胶囊（Header Switch Capsule）**：在文件查看器标题栏（`fileViewer.header` 锚点）常驻注入 `[Omni 检视]` 与 `[行内 Diff]` 快捷控制胶囊。用户可随时一键切回宿主原生预览（Native Preview）；
- **反弹跳覆盖态（Anti-Rebound Manual Override）**：一旦用户主动点击切回原生视图，插件将在当前会话中记录 `manualOverride = "native"`，后续打开同文件或定时重查时**绝对不会再次自动抢占**，杜绝页面闪烁与抢夺焦点的抖动行为；
- **内联文件编辑器友好共存**：当检测到同生态插件 `@agy-daddy/plugin-chat-nav` 的内联文件编辑器面板（`#agy-inline-file-editor-panel`）正在打开编辑时，插件会自动暂停视图接管，确保编辑与只读检视互不干扰。

---

## 本地 HTTP 206 流式网关安全机制

本地网关在 Node 主进程中常驻运行，承载大文件的 HTTP 206 字节流切片与 Git 安全查询，构建了 5 重网络安全门禁与 4 层路径前置拦截体系：

```
[Renderer 渲染层] (fileViewer / Shadow DOM)
       │
       ▼ (RPC 安全签发 5 分钟短效 Token)
[Node 主进程] ──▶ 生成 Capability Ticket
       │
       ▼ (发起本地流式 HTTP 请求)
[本地 127.0.0.1 网关]
  ├─ 门禁 1: Socket 级校验 (remoteAddress === '127.0.0.1')
  ├─ 门禁 2: HTTP 方法白名单 (严格仅限 GET / HEAD / OPTIONS)
  ├─ 门禁 3: Host 标头比对 (严格匹配 127.0.0.1:<port> / localhost:<port>，防御 DNS Rebinding)
  ├─ 门禁 4: Origin 白名单校验 (仅允许 vscode-file:// / vscode-webview:// 等受信任来源)
  ├─ 门禁 5: Referer 校验与短效 Token 定常时间比对 (crypto.timingSafeEqual)
  │
  ▼ 路径安全校验 (Path Guard)
  ├─ 拦截 1: 前置语法与 UNC/网络路径门禁 (拦截 \\server\share, file://remote, \0 截断)
  ├─ 拦截 2: 规范化解析与符号链接解析 (fs.realpath 物理路径定位)
  ├─ 拦截 3: 系统敏感与凭据路径黑名单 (/System, /etc, .ssh, .aws, .git/credentials 等)
  └─ 拦截 4: 授权工作区根目录沙箱校验 (严格限定在当前活跃工作区或 allowedRoots 白名单内)
       │
       ▼ (返回安全切片数据)
[RFC 9110 HTTP 206 Partial Content / 净化后的 SVG / Git Diff]
```

### 1. 严格回环绑定与端口策略
- 网关强制仅绑定 `127.0.0.1`，内部具备断言保护，任何非 `127.0.0.1` 的监听尝试均会直接抛出致命错误，彻底隔离外部网络与局域网；
- 默认采用 `gatewayPortMode: "auto"`（动态空闲端口）；若配置为 `fixed`（默认端口 `18770`），在检测到端口被占用时会自动安全降级至随机空闲端口并触发告警，避开宿主其他已知服务端口（如 18765–18767）。

### 2. 动态短效能力票据（Capability Ticket）
- 主进程通过内部 RPC 为合法文件访问请求动态颁发 Token，默认有效时长为 5 分钟（`TICKET_TTL_MS = 300,000ms`）；
- 票据最大活跃数量硬上限为 64 个，超量或超期自动淘汰清理；
- 校验 Token 时使用 `crypto.timingSafeEqual` 进行恒定时间比对，杜绝时序攻击；
- 日志输出时自动对 URL 中携带的 Ticket 进行脱敏替换（`?t=[REDACTED]`），防止调试日志泄露临时鉴权凭证。

### 3. 5 重网络安全门禁（Network Gates）
1. **Socket 回环连接**：物理层校验底层连接必须来自 `127.0.0.1`，非回环连接立即终止；
2. **HTTP 只读方法**：仅允许 `GET`、`HEAD` 与预检 `OPTIONS` 请求，杜绝写操作；
3. **Host 标头比对**：必须严格等于当前网关绑定的 `127.0.0.1:<port>` 或 `localhost:<port>`，防止外部恶意网页通过 DNS 重绑定绕过浏览器同源策略；
4. **Origin 来源校验**：严格审查请求来源 Origin，阻断任何非受信任外部网站发起的 Ajax / Fetch 跨站请求及跨站 `no-cors` 探测；
5. **Referer 一致性验证**：要求 Referer 来源协议与 Origin 保持完全一致。

### 4. 4 层路径前置拦截安全沙箱（Path Guard）
在执行任何底层文件系统系统调用前，所有路径均须连续通过 4 层防御：
1. **前置词法门禁（Pre-Syscall Lexical Gate）**：
   - 路径长度必须在 4096 字符以内；
   - 彻底拦截空字节注入（`\0` 及 `%00`）；
   - 彻底拦截 Windows UNC 路径（`\\server\share` 或 `//server/share`）与远端主机 `file://hostname/path`，杜绝内网 NTLM 凭据中继与网络超时挂起；
2. **规范化与真实路径解析（Decode & Resolve）**：
   - 安全解码 URI 组件，展开 `~` 用户主目录；
   - 调用系统原生 `fs.realpath`（`fs.realpathSync.native`）获取底层真实物理绝对路径，穿透所有别名与中间级软链接；
3. **敏感系统路径与凭据黑名单**：
   - **系统核心目录**：`/System`, `/etc`, `/private/etc`, `/usr`, `/bin`, `/sbin`, `/var/root`, `/proc`, `/sys`, `/dev`, `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)` 等；
   - **高危凭据文件**：`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.npmrc`, `.netrc`, `.git/credentials`, `1Password` 等敏感目录/文件，全面实施绝对禁止访问；
4. **授权工作区根目录沙箱（Allowed Roots Sandbox）**：
   - 文件的最终真实物理路径，必须严格位于当前活跃工作区根目录或配置中显式声明的 `allowedRoots` 列表中；
   - 任何指向工作区外部目录的符号链接（Symlink Escape）或 `../` 目录穿越行为均会被精确识别并拒绝访问。

### 5. 纵深防御与 SVG 内容净化（SVG Sanitizer）
- 响应头强制附带最高级别隔离标头：
  - `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Cross-Origin-Resource-Policy: cross-origin`
  - `Cache-Control: no-store`
- 针对 SVG 矢量文件实施强力内容净化：
  - 彻底剥离 `<script>`, `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<meta>`, `<link>`, `<base>` 标签及其所有子节点；
  - 剔除 XML 外部实体声明（`<!DOCTYPE>` / `<!ENTITY>`）与样式表处理指令（`<?xml-stylesheet?>`），根除 XXE 攻击面；
  - 剥离所有元素上的内联 `on*` 事件监听器（如 `onload`, `onclick`, `onerror` 等）；
  - 净化 `href`, `xlink:href`, `src` 属性，仅允许合法的文档内部锚点（`#id`）或 Base64 Data URI 图片；
  - 净化内联样式及 `<style>` 标签，剔除 `@import`、IE `expression()` 以及异常外部网络 `url(...)` 引用。

### 6. 只读 Git 服务安全隔离
- **子命令严格白名单**：底层只允许调用 `rev-parse`, `symbolic-ref`, `status`, `diff`, `show` 5 项只读查询子命令；
- **防止参数注入**：拦截任何以 `-` 开头的异常文件名参数，并强制使用 `--` 分隔符传递路径；
- **环境变量全面脱敏**：彻底移除 `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_SSH_COMMAND`, `GIT_CONFIG*` 等敏感环境变量，并强制注入 `GIT_TERMINAL_PROMPT=0` 与 `protocol.file.allow=never`。

---

## 配置项参考表

对照 `settings.schema.json`（全部 30 项完整字段）：

| Key | 类型 | 默认值 | 分组 | 字段说明与行为 |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | 通用 | 插件总开关；关闭后停止本地流式网关并完全恢复宿主原生侧边栏与文件查看器行为 |
| `officialFirstDeferral` | `boolean` | `true` | 通用 | 官方优先礼让策略：宿主原生可轻量预览的文件优先保持原生处理，仅在超出阈值或无原生预览时自动原位接管 |
| `showHeaderSwitchButton` | `boolean` | `true` | 通用 | 在文件查看器标题栏注入 `[Omni 检视]` 与 `[行内 Diff]` 快捷控制胶囊 |
| `allowedRoots` | `list` | `[]` | 通用 | 允许只读流式网关与 Git Diff 访问的本地根目录白名单；留空时默认仅允许宿主当前活跃工作区（最多 32 项） |
| `enableMediaViewer` | `boolean` | `true` | 音视频检视 | 启用超大音视频流式检视台：支持 HTTP 206 按需拖动、毫秒时间码、逐帧步进与波形打点 |
| `mediaThresholdMB` | `number` | `5` | 音视频检视 | 音视频自动接管体积阈值 (MB)；达到该值（或宿主无播放器控件）时自动接管，设为 `0` 全部自动接管（范围 0–2048） |
| `mediaDefaultFps` | `enum` | `"30"` | 音视频检视 | 逐帧步进默认帧率基准；可选 `24`（电影）、`25`（PAL）、`30`（标准，默认）、`60`（高帧率） |
| `mediaWaveformMaxMB` | `number` | `100` | 音视频检视 | 波形渲染体积上限 (MB)；超过此体积自动熔断全量波形解码以保护内存，流式播放仍正常可用（范围 10–500） |
| `enableCsvViewer` | `boolean` | `true` | 表格检视 | 启用大体积 CSV / TSV 流式检视台：支持流式分块稀疏索引、虚拟滚动、冻结表头与检索筛选 |
| `csvThresholdMB` | `number` | `1` | 表格检视 | CSV / TSV 自动接管体积阈值 (MB)；文件体积达到或超过该值时自动切入流式表格（范围 0–500） |
| `csvThresholdLines` | `number` | `2000` | 表格检视 | CSV 自动接管行数阈值；基于文件头部 64KB 样本估算总行数达到该值时自动接管（范围 100–1000000） |
| `csvChunkSize` | `number` | `200` | 表格检视 | 每次流式向本地网关请求的数据行分块大小（范围 50–2000） |
| `csvFirstRowHeader` | `boolean` | `true` | 表格检视 | 默认将首行作为冻结表头；关闭后将首行作为普通数据行并自动生成 `C1`..`Cn` 虚拟列标识 |
| `enableSvgViewer` | `boolean` | `true` | 矢量与字体 | 启用 SVG 矢量画布检视台：支持安全脚本剥离、10%–1600% 无损矢量缩放平移与三态画板背景切换 |
| `svgTakeoverMode` | `enum` | `"threshold"` | 矢量与字体 | SVG 接管模式；可选 `threshold`（超体积阈值自动接管）、`always`（始终自动接管）、`manual`（仅手动切换） |
| `svgThresholdKB` | `number` | `64` | 矢量与字体 | SVG 自动接管体积阈值 (KB)；仅在接管模式为 `threshold` 时生效（范围 1–10240） |
| `svgDefaultBackground` | `enum` | `"checkerboard"` | 矢量与字体 | SVG 画布默认背景；可选 `checkerboard`（透明棋盘格，默认）、`light`（亮白画板）、`dark`（深灰画板） |
| `enableFontViewer` | `boolean` | `true` | 矢量与字体 | 启用字体样张检视台：支持 `.ttf` / `.otf` / `.woff2` / `.woff` 多字号瀑布流样张与全量字形网格预览 |
| `fontAutoTakeover` | `boolean` | `true` | 矢量与字体 | 打开字体文件时自动进入样张检视台（宿主无原生字体预览能力） |
| `fontMaxSizeMB` | `number` | `50` | 矢量与字体 | 字体加载安全上限 (MB)；超过此体积拒绝自动注入内存并显示安全熔断横幅（范围 1–200） |
| `fontSampleText` | `string` | `""` | 矢量与字体 | 自定义默认样张文案；留空则使用内置中英数符号全要素全字母句样张 |
| `enableGitDiff` | `boolean` | `true` | Git 行内 Diff | 启用 Git 安全行内 Diff：在文件查看器及变更抽屉中提供严格只读的工作区代码差异对比 |
| `diffDefaultScope` | `enum` | `"head"` | Git 行内 Diff | 默认 Git 比对范围；可选 `head`（全部未提交 vs HEAD）、`unstaged`（仅未暂存 Working）、`staged`（仅已暂存 Staged） |
| `diffDefaultLayout` | `enum` | `"unified"` | Git 行内 Diff | 默认对比布局；可选 `unified`（单栏行内，窄侧边栏推荐）、`split`（双栏并排） |
| `diffShowWordHighlight` | `boolean` | `true` | Git 行内 Diff | 高亮行内词级差异：对连续增删行计算并精准高亮字符/词组改动片段 |
| `diffContextLines` | `number` | `3` | Git 行内 Diff | 每个变更块（Hunk）上下默认保留的未修改上下文代码行数（范围 0–20） |
| `diffMaxFileSizeMB` | `number` | `2` | Git 行内 Diff | 单文件 Diff 体积熔断上限 (MB)；超出时截断输出并提示熔断保护横幅（范围 1–20） |
| `diffMaxLines` | `number` | `5000` | Git 行内 Diff | 单文件 Diff 最大行数熔断；超出上限时安全截断（范围 500–50000） |
| `gatewayPortMode` | `enum` | `"auto"` | 本地网关 | 本地网关端口策略；可选 `auto`（动态随机端口，推荐）、`fixed`（固定回环端口） |
| `gatewayPort` | `number` | `18770` | 本地网关 | 固定监听端口 (127.0.0.1)；避开 18765–18767 端口段，被占用时自动回退随机空闲端口（范围 1024–65535） |

---

## 声明的服务 / 事件 / 命令 / 扩展点

严格依据 `agy-plugin.json` 声明：

- **权限声明（Permissions）**：
  - `dom:read`、`dom:write`：在文件查看器标题栏（`fileViewer.header`）安全挂载控制胶囊与检视视口；
  - `rpc:read`：与宿主主进程及工作区服务安全通信；
  - `bridge:route`：注册本地内部 RPC 路由（检视元数据探测、打点存取、Git 只读差异查询）；
  - `fs:plugin-data`：读写插件专属打点持久化数据（`markers.json`）；
  - `fs:user-files`：流式读取工作区授权文件内容；
  - `net:listen`：在 `127.0.0.1` 本地回环端口启动 HTTP 206 流式网关；
  - `process:spawn`：以严格参数白名单安全执行 `git` 只读差异比对子进程。
- **提供的服务（Services - provides）**：
  - `viewer-node`（版本 `1.0.0`，realm: `node`）：Node 端流式网关与安全 Git 差异服务；
  - `viewer`（版本 `1.0.0`，realm: `page-isolated`）：Renderer 隔离世界接管控制与 Omni Viewer 渲染器。
- **发布的事件（Events）**：
  - `viewer:viewer-mode-changed@1`：检视模式切换事件（`native` ⇄ `omni`）；
  - `viewer:diff-opened@1`：行内 Diff 视图打开事件。
- **发布的状态（States）**：
  - `state:viewer.gateway@1`：本地 HTTP 206 流式网关运行状态（监听地址、端口、已分配票据统计）。
- **注册的命令（Commands - contributes）**：
  - `viewer.toggleOmniViewer`：切换当前文件的 Omni 流式检视 / 原生预览模式；
  - `viewer.openGitDiff`：打开当前工作区的 Git 安全行内 Diff 视图；
  - `viewer.gatewayStatus`：检查并弹出本地流式网关健康与安全状态；
  - `viewer.browseAllowedRoot`：浏览并添加授权工作区根目录白名单。
- **挂载锚点（Requires Anchors）**：
  - `fileViewer.header`：无侵入注入顶部控制胶囊（`agy-viewer-header-host`）与检视舞台。

---

## 常见问题排查（Troubleshooting）

### 1. 提示「出于本地安全隔离策略，已拦截...」
- **排查路径**：
  - 访问路径位于 Windows UNC 共享或网络驱动器（如 `\\192.168.1.100\share`）：出于防凭据泄露策略，插件强制阻断 UNC 路径；请将文件拷贝至本地磁盘后访问；
  - 访问的文件通过符号链接指向了当前工作区外部：插件具备符号链接逃逸保护；若需授权访问该外部目录，请在设置中心「通用」->「授权工作区根目录白名单 (`allowedRoots`)」中点击「浏览添加」加入该外部物理路径；
  - 目标路径包含 `.ssh`, `.aws`, `.env`, `.git/credentials` 等高危凭据目录：插件实施绝对安全隔离，不可覆盖。

### 2. 本地网关端口提示冲突或无法访问
- 网关底层强制绑定 `127.0.0.1`；
- 若设置了固定端口 `18770` 且该端口被系统其他程序占用，网关会自动退避并选用动态随机空闲端口（Ephemeral Port），同时在宿主日志输出警告，业务检视功能不受影响；
- 建议将 `gatewayPortMode` 保持为默认的 `auto` 模式。

### 3. 在普通网页浏览器中直接访问流式 URL 返回 403 Forbidden
- 本地流式网关具备严格的 Host、Origin 与短效 Ticket 门禁，仅受信任的 Antigravity 宿主视口能够访问；
- 外部浏览器直接打开时因缺少合法 Token 或携带外部 Origin 会被直接拦截，此为预期安全防御行为。

### 4. Git Diff 提示「差异行数超出上限，已截断展示」
- 为防止数十万行的巨型变更文件卡死 UI 渲染线程，插件默认配置了 `diffMaxFileSizeMB: 2` 与 `diffMaxLines: 5000` 熔断阈值；
- 用户可在插件设置中心中按需调大该上限，或选择切换到命令行进行超大变更审查。

---

## 安装与测试方式

### 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 单独安装本插件
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-viewer
```

### 本地测试与验证
进入插件目录执行全量自动化测试套件：
```sh
cd agy-daddy-plugin-viewer
npm test
```
