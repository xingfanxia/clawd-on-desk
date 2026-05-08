# Soul Engine Integration

Clawd 的 AI 大脑是独立的 `clawd-soul` 服务（HTTP :23456），由 Electron 在
`prefs.simpleMode === false`（advanced 模式）时自动启动。**Simple Mode 默认 true**
（fork 全新安装），此时 `main.js` 中的 soul 启动块整体被 gate 掉——chat-window /
speech-bubble / soul-client / soul IPC / onboarding 全部不挂载。从 Settings →
General → AI Features 切换 simpleMode 后重启 Clawd 即可拉起本节描述的所有子系统。

桌宠（body）和灵魂（brain）通过 HTTP 解耦：body 负责渲染、动画、hooks；soul 负责
人格、记忆、视觉、对话。代码在 `soul/` 目录下。

## soul/ 目录文件

| 文件 | 职责 |
|------|------|
| `soul/client.js` | Soul 服务器生命周期管理：发现/启动、屏幕截图、观察循环、聊天转发、心跳轮询 |
| `soul/speech-bubble.js` + `.html` | 对话气泡（透明 BrowserWindow，可点击→打开聊天窗口） |
| `soul/chat-window.js` + `.html` | 微信风格聊天窗口（持久历史、输入框、关闭按钮） |
| `soul/emotion-map.js` | 情绪→动画映射（兴奋→happy、思考→thinking 等） |
| `soul/onboarding.html` | 首次启动引导（名字、语言、性格原型、AI 服务商、API 密钥） |
| `soul/diary-viewer.html` | 日记查看窗口 |
| `soul/pairing.html` | 多设备配对界面（连接 + 共享两个标签） |
| `soul/preload-*.js` | 各窗口的 contextBridge |

## 交互流程

- 单击宠物 → `soul-observe` IPC → `client.js` 截屏 → POST /react → 思考动画 → 气泡回复
- 点击气泡 → `speech-open-chat` IPC → 打开聊天窗口
- 右键菜单 → 聊天 / 你看到了什么 / 查看日记 / 连接远程灵魂
- 每 45s 静默观察（POST /observe，不显示气泡）
- 每 5min 心跳（GET /proactive，宠物自己决定说不说话）

## 数据存储（~/.clawd/）

| 文件 | 内容 | 可导出？ |
|------|------|---------|
| `config.json` | API 密钥、服务商、宠物名 | 否（含密钥） |
| `soul.json` | 性格原型、情绪、信任度、语义记忆、进化特征 | 是 |
| `memory.db` | 情景记忆、日记（SQLite + FTS5 + sqlite-vec） | 是 |
| `chat-history.jsonl` | 持久对话记录 | 是 |
| `chat-summary.json` | 压缩的旧对话摘要 | 是 |
| `soul-runtime.json` | 运行中服务器的端口+PID（临时） | 否 |

## 注意事项

- Soul 服务器用系统 `node` 启动（不是 Electron 的），因为 better-sqlite3 是原生模块
- `findNodeBinary()` 会搜索 asdf/nvm/homebrew 路径
- 截屏分辨率 1920×1080 JPEG q85，vision API 用 `detail: 'auto'`
- 对话在 500k token 时自动压缩（AI 总结旧消息，保留最近 50 条）
- 多设备通过 LAN 模式（0.0.0.0 绑定 + bearer auth），不需要云服务

## Phase 2 Integration Opportunities

灵魂目前以 bolt-on 形式接入，未来可以更深整合 upstream 的新特性：

- **Settings panel**：把 onboarding / 性格选择 / API key / pairing 从独立窗口迁移到 settings 面板的 "Soul" tab
- **Animation overrides**：让 soul 根据当前情绪/原型动态选择 idle 动画（caring→甩尾、snarky→翻白眼）
- **Session HUD**：在 session card 上显示当前情绪 emoji + 信任值 bar
- **Doctor**：添加 "Soul" 诊断面板（:23456 可达？soul.json 有效？API key 配置？）
- **Theme capability**：声明 soul-aware 主题能力，让 Cloudling 成为默认 soul 主题
- **AskUserQuestion bubble**：复用 upstream 的问题气泡 UI 让 soul 主动提问（"你今天吃饭了吗？"）
- **Custom global shortcuts**：暴露 "Talk to Clawd"、"Show Diary" 等可绑定快捷键
- **Foreground app detection**：把 tick.js 里的 osascript/PowerShell 轮询迁移到 focus.js 的常驻 PowerShell + C# FFI（更省 CPU）
