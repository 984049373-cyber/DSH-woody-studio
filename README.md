# WooDy 剧本工作室

DeepSeek Harness（DSH）桌面版的 AI 剧本创作插件。为短剧编剧提供从作品管理到剧本编辑到 AI 协作改稿的完整工作台。

> 本插件为第三方社区插件，与 DeepSeek 官方无关。

## 功能

### 📚 作品管理
- 侧栏「作品管理」面板：新建/删除/重命名作品
- 每部作品自动生成五目录骨架（大纲/记忆/剧本/细纲/作品资料）+ 系统提示词 AGENTS.md
- 数据存放位置可配置

### 📝 剧本编辑器
- .md 文件点开自动进入编辑模式（所见即所得 Markdown 编辑器）
- 保存 = 落盘 + 自动生成版本快照（保留最近 20 份）
- 草稿自动暂存（不落盘、不占版本）
- 字数统计、定稿对照、大纲导航

### 📌 行号引用（AI 改稿的正确姿势）
- 编辑器左侧显示行号，勾选行号 → 点「引用」→ 填修改要求 → 发送
- AI 收到的是行号+摘要（不贴原文），直接按行号定位改稿，省 token
- 消息流中渲染为彩色引用卡片，点文件名可打开文件

### 🤖 写作方法论 Skill（随插件分发 5 个）
- `screenplay-format-spec` — 剧本格式规范
- `outline-creation-rules` — 大纲创作规则
- `outline-writing-skills` — 细纲创作技巧
- `short-drama-tension-design` — 短剧张力设计
- `de-ai-flavor` — 去 AI 味

插件安装时自动注册到用户级 skill 目录（`~/.dsh/skills/`），所有 DSH 会话可用。防覆盖保护：你修改过的 skill 不会被插件更新冲掉。

## 安装

### 前提
- 已安装 [DeepSeek Harness 桌面版](https://download.deepseek.com)

### 步骤

1. 下载本项目到本地任意目录（如 `D:\woody-dsh-plugin\dsh-woody-studio`）
2. 在项目目录运行安装脚本：
   ```bash
   node 一键安装.mjs
   ```
3. 重启 DSH

### 手动安装（如果脚本不可用）

1. 用 Node 修改 `C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json`（**不要用 PowerShell 写，会植 BOM 导致 DSH 崩溃**）：
   - `dsh.profile.bundles` 数组加 `"dsh-woody-studio"`
   - `dependencies` 对象加 `"dsh-woody-studio": "link:<插件绝对路径>"`
2. 在 `profiles\desktop\node_modules\` 下建 junction 指向插件目录
3. 运行 DSH 自带 pnpm：`node "<DSH安装路径>\resources\runtime\pnpm\bin\pnpm.cjs" install --dir "C:\Users\<你>\.dsh\profiles\desktop"`
4. 重启 DSH

## 使用

### 第一次使用
1. 在 DSH 侧栏点「作品管理」
2. 点「＋ 新建作品」，输入作品名
3. 在作品目录下的大纲/细纲/剧本文件夹中创作 .md 文件

### AI 协作改稿
1. 在编辑器中打开剧本文件
2. 左侧行号栏勾选要修改的行（点击/拖动/Shift 点选）
3. 工具栏点「引用（N 行）」
4. 在下方引用发送框写主消息和修改要求
5. 点「发送」→ AI 收到行号定位 + 修改要求，直接改稿

### 写作方法论 Skill
新作品自动生成 `AGENTS.md` 系统提示词，AI 会按其中的规矩使用 skill。你也可以直接对 AI 说「用剧本格式规范审一下这集」。

## 常见问题

**Q: 编辑模式在其他工作区也出现了？**
A: 插件会检测当前会话是否属于作品工作区，只在作品工作区注册编辑模式。如果还出现，重启 DSH。

**Q: 保存后编辑器跳回第一行？**
A: 已修复（阅读位置保持）。如仍有问题请提 Issue。

**Q: skill 更新后我的修改会被覆盖吗？**
A: 不会。插件有防覆盖保护：你修改过的 skill 文件，插件更新时自动跳过。

**Q: `/api/woody/debug/log` 是什么？**
A: 调试日志端点，只写本地日志文件，无安全风险。用于排查编辑器问题。

## 开发

```bash
npm install
npm run build    # 构建
node selftest.mjs # 自检（约 80 项端到端断言）
```

## 许可

[MIT](LICENSE)

## 致谢

- 编辑器：[Vditor](https://github.com/Vanessa219/vditor)
- 运行环境：[DeepSeek Harness](https://download.deepseek.com)
