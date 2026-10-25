# dsh-theater

多角色剧场的执行器（Host 半）。**只做三件事**：给角色建独立会话、投一手 cue、绑音色。
打分、裁决、场记、弹窗全部留在导演会话（场景剧情）里——插件里没有剧本逻辑。

## 工具

| 工具 | 用途 |
| --- | --- |
| `theater_open` | 为角色创建独立会话（工作区 + 预设 `theater-actor`），可顺带绑音色 |
| `theater_say` | 投一条 cue，等这一手演完，返回该角色输出原文（台词/行为/内心）；默认后台送达、不切窗，`focus: true` 才把主人窗口切过去 |
| `theater_bind` | 给已存在会话绑 GPT-SoVITS 音色（写 dsh-tts 的 `sessionVoices`） |
| `theater_cast` | 演员表 + 存活状态 |

演员表落盘在 `actors.json`（角色名 → sessionId / 预设 / 音色）。

## 安装

```json
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-theater": "link:<home>/.dsh/plugins/dsh-theater" },
"dsh": { "profile": { "bundles": ["...", "dsh-theater"] } }
```

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-theater" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-theater"
```

预设 `theater-actor` 由 profile 的 `cordis.patch.yml` 注入（只挂 persona + compaction，**不挂任何工具**）。

## 为什么零依赖

本插件以 `link:` 装进 profile，运行时解析不到 `@deepseek-ai/*` 核心包。因此：

- 消息对象按 `dsh-llm` 的 `createUserMessage` 形状手工构造（`{role, content, source, id}`）；
- 工具按 `dsh-tools` 的 `register(definition)` 契约手写（`parameters` 直接给 JSON Schema）。

改这两处之前，先确认插件能不能 import 核心包。

## 投递与切窗

`theater_say` 默认**后台送达**：宿主不推 `now`，主人正在看的窗口不动，对方照常收消息、照常回话。

要看戏时才传 `focus: true`——宿主把 `now` 推到目标会话，客户端轮询到就切过去（等同旧行为）。

```jsonc
{ "sessionId": "session-...", "text": "...", "focus": true }   // 切窗
{ "sessionId": "session-...", "text": "..." }                   // 后台（默认）
```

`focus: false` 时也不会因为「导演回合结束」把视图切回场景：那条切回同样由 `focus: true` 才登记导演会话。

client 半没有改——它只跟随宿主推的 `now`，宿主不推就不切。

**正文一律用代码块包起来**：把 `text` 用三重反引号包住（` ```正文``` `）。语音播报（dsh-tts）会跳过代码块，不把投递内容念出来，不打断主人的语音消息。这条写进了工具 description，每次调用都看得到——别指望会话指令记着，AGENTS 只在会话启动时读一次。

## 并发与唤醒

- 一个会话同时只允许一手 cue；`theater_say` 撞上未完成的手会直接报错。
- 会话未 live 时按演员表里的预设自动 `resume`。
- 回合边界靠 `session/event` 的 `turn/start` → `assistant/message` → `turn/end` 判定，
  只有自己开过的回合才算数，避免被上一手的收尾提前唤醒。

## 日志与排错（0.1.5）

宿主侧的错误和警告一律走 `console.error` / `console.warn`，落在 stdout/stderr，被重启脚本捕获进 `tmp_all\host-out-*.log` 和 `host-err-*.log`。

**不要用 `ctx.logger`。** DSH 的产品 profile 没有给 `ctx.logger` 挂 console exporter（宿主源码 `dsh-llm-deepseek-account/lib/index.js` 里的注释原话是 `product profiles mount no console exporter for ctx.logger`）：cordis 自带的默认 exporter 只把消息推进 1000 条的内存环形缓冲，`dsh-app-boot` 那个 exporter 阈值是 WARN 且只存进内存数组，**整个宿主没有任何 exporter 写 stdout**。

0.1.4 及更早的 `session/event` 异常处理用的是 `ctx.logger?.warn?.(...)`——真出事时那条错误信息一个字也出不来。0.1.5 改成 `console.error("[theater] session/event 处理失败：", error)`，并且带上 `error` 本体而不是只取 `message`，栈才留得住。

**这条没有测试覆盖**：theater 仓库里没有测试脚本，`probe.mjs` 是手动探针。这次改动的验证方式是读源码确认 `ctx.logger` 调用清零（只余注释）加 `node --check` 语法检查，不等于运行时验过；真正的确认要等下一次 `session/event` 抛出异常时看日志里有没有那一行。
