# 数字人智能体工作台 (Digital Human Agent Workbench)

根据飞书文档《PART 13: 数字人智能体开发+工作台搭建》完整构建的本地化全流程工作台，覆盖 6 大核心模块：

1. **模块 1 · 提取文案**：接入中转平台（`https://ai.hzagent.cn/`），粘贴短视频分享文案自动提取链接并获取原文案。
2. **模块 2 · 改写文案**：接入 DeepSeek API（默认 `deepseek-v4-flash`），按风格、字数和补充需求一键二创口播文案。
3. **模块 3 · 声音克隆与合成**：接入 MiniMax 声音复刻（上传音频 → 生成专属 `voice_id`）与语音合成（`/v1/t2a_v2`），支持一键导入模块 2 文案并默认使用您的克隆音色。
4. **模块 4 · 数字人生成**：接入 `avatar-lipsync` 对口型模型，支持设置默认人物底板视频、一键导入模块 3 配音、单次提交（不自动循环重试）与手动查询任务状态。
5. **模块 5 · 视频剪辑（开拍 AI 一键剪辑）**：集成 `meitu-kaipai-cli`，支持动态字幕（`kaipai subtitle`）、智能成片包装（`kaipai smartedit`）及对话式剪辑（`kaipai chat`）。
6. **模块 6 · 成片预览**：内置播放器实时预览成片、支持下载与复制视频链接，并提供接口调试日志面板。

## 启动方式

```bash
cd /Users/penggenhui/GitHub项目/digital-human-workbench
npm install
npm start
```

启动后访问：**http://127.0.0.1:3456**

## 开拍 CLI 登录（首次使用）

本机已全局安装 `meitu-kaipai-cli`。首次使用模块 5 前，请在终端运行：

```bash
/Users/penggenhui/.hermes/node/bin/kaipai auth login
```

或在工作台右上角「⚙️ API 密钥与设置」中填写 `KAIPAI_ACCESS_KEY`。
