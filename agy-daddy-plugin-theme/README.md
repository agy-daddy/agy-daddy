# @agy-daddy/plugin-theme

Agy-Daddy 官方独立视觉主题与光学定制插件（T0 官方插件）。

核心原则：**默认零变动**。安装后默认保持 Antigravity 宿主 100% 原生视觉外观，不强制注入任何主题样式；允许用户按需启用光学配色预设、逐组件自由定制视觉细节，以及按需开启阻尼动效与语义余晖（支持一键静默省电模式）。

---

## 核心特性

1. **默认零变动**：`enabled` 默认 `false`、`preset` 默认 `native`，未启用或全默认配置下不向文档注入任何 `<style>` 节点。
2. **非侵入式光学体系**：严格运行于 Chrome `isolated` 隔离世界，通过托管 `ctx.styles.inject` 按需增量更新 CSS 自定义属性与精细选择器，`< 10ms` 实时热生效，关闭时 100% 干净卸载并回退至原生外观。
3. **4 套原创深浅光学预设**：
   - `obsidian-void`（深空黑曜 · 深色）
   - `warm-basalt`（暖炭玄岩 · 深色）
   - `cool-crystal`（冷晶白 · 浅色）
   - `warm-album`（暖白画册 · 浅色）
4. **组件级细粒度自定义**：
   - **用户气泡**：背景色、边框高光、圆角（`0–28px`）
   - **助手气泡**：背景色、边框高光、圆角（`0–28px`）
   - **代码块**：独立代码高亮主题（`native` / `obsidian-night` / `warm-amber` / `crystal-light` / `paper-ink`）、背景色、边框、圆角
   - **终端凹槽**：背景色、边框、凹陷质感（`native` / `recessed` / `subtle` / `flat`）
   - **Artifact 卡片**：圆角半径、边框高光
   - **顶栏、底栏与按钮**：顶栏背景、底部输入框容器背景与圆角、主按钮强调色与圆角
5. **动效、余晖与静默省电开关**：
   - `dampedSpringMotion`：二阶阻尼弹簧过渡动效
   - `microAnimatedIcons`：交互图标微尺度反馈
   - `semanticAfterglow`：输入框与交互卡片边缘语义余晖
   - `powerSaveMode`：一键切换为静默省电模式，立即抑制所有过渡动效、模糊滤镜与边缘光晕
6. **净室原创 MIT 合规**：全套样式代码与预设均从零独立实现，遵守 MIT 协议与紫调门禁规范。

---

## 声明式命令与服务

- **Commands**：
  - `theme.toggle-enabled`：启用 / 关闭视觉主题增强
  - `theme.set-preset`：切换光学配色预设
  - `theme.toggle-power-save`：切换静默省电模式
  - `theme.reset-native`：一键恢复宿主原生外观
- **Service (`realm: "node"`)**：`theme` (`getConfig`, `getPresets`, `updateConfig`, `setPreset`, `toggleEnabled`, `togglePowerSave`, `resetToNative`)
- **State**：`state:theme.config@1`

---

## 本地测试

```sh
npm test
```
