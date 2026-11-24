# @agy-daddy/plugin-chat-nav

Agy-Daddy 官方 Layer 2 对话栏增强插件：右侧悬浮导航栏、思考块锁定、产物内联编辑、全文检索与多格式导出（MD/HTML/PDF）。

- **npm 包名**：`@agy-daddy/plugin-chat-nav`
- **Layer 层级**：Layer 2（对话交互与导出层）
- **信任等级**：官方 `T0`（声明 `dom:read`、`dom:write`、`fs:read`、`fs:write` 权限）
- **适用场景**：长会话快速顶底定位、思考块批量展开、代码产物内联直改、对话全文检索及归档导出。

---

## 核心功能与安全默认值

- **右侧悬浮导航栏**：动态贴合对话区右侧边缘，提供一键直达顶部、直达底部、展开思考块、全文检索及复制会话 ID 按钮。
- **产物文件头内联编辑**：在对话生成的代码块头部提供直接编辑并保存回工作区文件的能力。
- **全文检索与高亮定位**：支持普通关键字与正则表达式模式，在多轮对话中精准跳转。
- **多格式本地导出**：纯函数本地渲染 Markdown、HTML 与 PDF，零网络外传。
- **安全默认值**：
  - `keepThinkingExpanded: false`：默认折叠思考块保持视窗清爽；
  - `exportSaveBehavior: "dialog"`：导出时默认弹窗确认保存路径，防止静默写入覆盖本地文件。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-chat-nav
```

### 3. 宿主设置中心与交互
安装后自动激活（`onStartup`）。在对话区右侧自动呈现浮动导航栏，并在对话操作栏扩展按钮。用户可在设置中心「对话栏增强」中配置导出格式偏好与快捷行为。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `showFloatDock` | `boolean` | `true` | 右侧悬浮导航条：在对话区右下侧显示浮动操作栏（直达顶部/底部、思考块开关与全文搜索） |
| `keepThinkingExpanded` | `boolean` | `false` | 锁定思考块保持展开：开启后新进入会话或加载新轮次时，思考内容默认自动展开 |
| `enableInlineFileEditor` | `boolean` | `true` | 产物文件头内联编辑：在产物卡片与代码块头部提供直接查看与保存原文件的内联编辑器 |
| `enableCmdClickLinks` | `boolean` | `true` | Cmd/Ctrl+点击安全打开外链：按住 Cmd/Ctrl 键点击对话中的 http/https 链接直接调用外部浏览器打开 |
| `searchRegexMode` | `boolean` | `false` | 全文检索默认启用正则：会话内快速检索时默认启用正则表达式匹配 |
| `searchCaseSensitive` | `boolean` | `false` | 全文检索区分大小写：检索消息内容时是否严格匹配大小写 |
| `exportSaveBehavior` | `enum` | `"dialog"` | 默认保存行为：`dialog`（每次弹出系统保存文件对话框）或 `auto`（静默自动保存至下方默认文件夹） |
| `exportSaveDir` | `string` | `""` | 默认保存路径：自动保存时的目录路径；可手动输入或点击「选择」 |
| `exportFormats` | `list` | `["md"]` | 允许导出文件格式：批量导出时支持的格式列表（可选 md, html, pdf） |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Services (provides)**：
  - `chat-nav`（版本 `1.0.0`，realm: `page-isolated`）
  - `chat-nav-node`（版本 `1.0.0`，realm: `node`）
- **Surfaces (provides)**：
  - `chat.navButtons`：对话区导航按钮扩展插槽
- **Events (provides)**：
  - `chat:thinking-expanded@1`：思考块展开事件广播
- **States (provides)**：
  - `state:chat-nav.search@1`：全文检索过滤状态
- **Commands (contributes)**：
  - `chat-nav.scroll-top`：滚动到对话顶部
  - `chat-nav.scroll-bottom`：滚动到对话底部
  - `chat-nav.expand-thinking`：展开全部思考块
  - `chat-nav.search`：执行对话全文检索
  - `chat-nav.copy-id`：复制当前会话 ID
  - `chat-nav.export-md`：导出当前对话为 Markdown
  - `chat-nav.export`：导出当前对话 (MD/HTML/PDF)
  - `chat-nav.export-all`：批量导出当前对话为全部所选格式
  - `chat-nav.browseExportDir`：选择默认导出保存文件夹

---

## 使用示例与本地测试

### 使用示例
在动辄数十轮的长对话中，点击悬浮导航条的搜索图标，输入检索关键字，页面平滑滚动并高亮命中消息；点击导出按钮，即可秒级生成美观规范的 Markdown 或 PDF 归档文件。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
