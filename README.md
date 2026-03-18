# OpenClaw AI CLI Runner

一个给 OpenClaw 用的本地插件，用来把白名单内的 AI CLI 命令作为异步后台任务执行。

当前重点能力是：

- 提供 `/cc` 命令，把任务提交给本地 `claude` CLI
- 返回“任务已提交”的回执
- 后台异步执行
- 任务完成后自动把结果通知回原会话
- 同时暴露一组工具接口，供 OpenClaw 内部或其他流程调用

这个插件现在采用的是“OpenClaw 插件命令 + 本地进程执行 + 任务队列”的实现，不是 ACP thread / ACP spawn 模式。

## 功能概览

- `/cc <任务描述> @/绝对路径`
  - 把任务提交给本地 Claude Code
  - 立即返回任务回执
  - 后台继续跑
  - 完成后推送结果
- 工具接口
  - `execute_ai_cli_submit`
  - `execute_ai_cli_status`
  - `execute_ai_cli_result`
  - `execute_ai_cli_cancel`

## 工作原理

整体流程如下：

1. 用户在 OpenClaw 聊天中发送 `/cc ...`
2. OpenClaw 命中这个插件注册的 `cc` 命令
3. 插件解析任务描述和工作目录
4. 插件调用本地 `claude` CLI，作为异步任务加入队列
5. 插件立即返回“已派发 Claude Code + 任务ID”
6. 任务在后台执行
7. 完成后，插件把结果追加到会话并发送到原频道

这套方案的重点是：

- `/cc` 命中后直接由插件命令处理，不再进入主 agent
- 因此不会再产生那种多余的“第二条解释性回复”
- 结果通知依然会正常回来

## 前置条件

使用前请确认：

- 已安装 OpenClaw
- 已安装 Node.js 24 或更高版本
- 当前机器上可以直接执行 `claude`
- `claude` 已完成登录或必要认证
- 你计划操作的目录已经存在，并且会加入 `allowedWorkingDirs`

如果 `claude` 不在 `PATH` 里，或者 OpenClaw 运行时环境找不到它，任务会提交失败。

## 安装流程

### 1. 安装插件

在本机执行：

```bash
openclaw plugins install -l /home/pc/claw-link-cli
```

如果你已经安装过，也可以用以下命令检查：

```bash
openclaw plugins list
```

### 2. 配置 OpenClaw

编辑 `~/.openclaw/openclaw.json`，在 `plugins.entries.openclaw-ai-cli-runner` 下添加或更新配置：

```json5
{
  plugins: {
    entries: {
      "openclaw-ai-cli-runner": {
        enabled: true,
        config: {
          allowedCommands: ["claude", "codex", "gemini"],
          allowedWorkingDirs: ["/workspace", "/home/pc/.openclaw/workspace/cc-jobs"],
          defaultWorkingDir: "/home/pc/.openclaw/workspace/cc-jobs",
          commandPrefix: "/cc",
          defaultTimeoutSeconds: 900,
          maxLogChars: 4000,
          previewFlushBytes: 1024,
          previewFlushIntervalMs: 500,
          maxConcurrentJobs: 4,
          deliverToChannelOnCompletion: true
        }
      }
    }
  }
}
```

### 3. 重启或重新加载 OpenClaw

如果你的 OpenClaw 运行在网关或守护进程模式下，修改配置后需要让它重新加载插件与配置。

### 4. 验证

在聊天里发送：

```text
/cc 你是什么模型
```

正常情况下你会先收到一条提交回执，然后稍后收到完成通知。

## 配置项说明

### `allowedCommands`

允许执行的 CLI 命令白名单。

虽然插件当前的 `/cc` 默认固定调用 `claude`，但工具接口仍然支持其他白名单命令，例如 `codex`、`gemini`。

示例：

```json
["claude", "codex", "gemini"]
```

### `allowedWorkingDirs`

允许执行任务的工作目录白名单。

插件会校验目标目录是否在这些目录之内。目录必须真实存在，否则会报错。

示例：

```json
["/home/pc/.openclaw/workspace/cc-jobs", "/workspace"]
```

### `defaultWorkingDir`

当用户没有在 `/cc` 命令里显式写 `@/绝对路径` 时，使用这个默认目录。

### `commandPrefix`

命令前缀，默认是：

```text
/cc
```

如果你改了它，例如改成 `/claudecode`，那么用法也要跟着改。

### `defaultTimeoutSeconds`

后台任务默认超时时间，单位秒。

### `maxLogChars`

最终日志最多保留多少字符，用于结果和通知摘要。

### `previewFlushBytes`

预览日志累计到多少字节后刷新一次内部缓冲。

### `previewFlushIntervalMs`

预览日志刷新时间间隔，单位毫秒。

### `maxConcurrentJobs`

最大并发后台任务数。超过后新任务会被拒绝。

### `deliverToChannelOnCompletion`

任务完成后是否把结果直接发送回原聊天频道。

- `true`：发送
- `false`：只保留在内部结果与会话里

## `/cc` 使用说明

### 基本语法

```text
/cc <任务描述> @/绝对路径
```

其中：

- `<任务描述>`：要让 Claude Code 完成的任务
- `@/绝对路径`：可选，任务运行目录，必须是绝对路径

### 示例

在默认目录执行：

```text
/cc 修复当前项目的构建错误
```

指定目录执行：

```text
/cc 给这个项目补一份中文 README @/home/pc/.openclaw/workspace/cc-jobs/demo
```

让 Claude Code 解释模型信息：

```text
/cc 你是什么模型
```

### 返回内容

提交成功时，第一条消息类似：

```text
已派发 Claude Code
任务:你是什么模型
目录:/home/pc/.openclaw/workspace/cc-jobs
任务ID:xxxx
完成后会自动通知到你。
```

任务完成后，第三条消息类似：

```text
Claude Code任务完成
任务:你是什么模型
路径:/home/pc/.openclaw/workspace/cc-jobs
任务ID:xxxx
摘要:...
```

### 输入校验

以下情况会直接返回错误：

- 没写任务描述
- 路径不是绝对路径
- 目标目录不在白名单里
- 并发任务数超限
- `claude` 不在允许命令列表内

## 工具接口说明

除了 `/cc` 命令，插件还注册了 4 个工具：

### `execute_ai_cli_submit`

提交一个异步 AI CLI 任务。

主要参数：

- `cli_cmd`
- `args`
- `working_dir`
- `timeout_seconds`
- `label`
- `notify_on_completion`

### `execute_ai_cli_status`

查询任务状态。

### `execute_ai_cli_result`

读取任务最终结果与日志摘要。

### `execute_ai_cli_cancel`

取消一个仍在运行中的任务。

## 开发与测试

安装依赖后，可直接运行测试：

```bash
npm test
```

当前测试覆盖了：

- `/cc` 命令解析
- 插件命令注册
- 任务提交流程
- 完成通知格式
- 任务管理器行为

## 常见问题

### 1. 为什么不是 ACP 方案？

因为这个插件当前定位是“提交本地后台任务”，不是“建立一个持续交互的 ACP 会话”。

这套实现的优点是：

- 简单
- 稳定
- 不依赖 ACP thread 绑定能力
- 更适合 Telegram 这类线程语义不一致的渠道

### 2. 为什么会有任务ID？

因为任务由插件内部的 Job Manager 管理，每个后台任务都会分配唯一 `job_id`，用于回执、结果查询和完成通知关联。

### 3. 任务完成后为什么有时只显示摘要？

完成通知会优先从输出里提取“项目文件”列表；如果提取不到，就退化成一条摘要。

### 4. 为什么任务提交成功但执行失败？

常见原因：

- `claude` 可执行文件不存在
- `claude` 未登录
- 目录不允许访问
- 任务超时
- 运行环境缺少依赖

## 排障建议

如果你发现 `/cc` 不能正常工作，建议按顺序检查：

1. `claude` 是否能在同一台机器的命令行直接执行
2. `allowedWorkingDirs` 是否包含目标目录
3. `defaultWorkingDir` 是否真实存在
4. OpenClaw 是否已经加载到最新版插件配置
5. 并发任务数是否达到上限

## 适用场景

这个插件特别适合下面这些需求：

- 在聊天里快速把任务甩给本地 Claude Code
- 需要后台执行，不阻塞当前对话
- 希望执行完成后自动回传结果
- 不想引入 ACP 会话编排复杂度

如果你的目标是“持续多轮、强会话语义、深度 agent 协作”，那应该另外考虑 ACP 风格的方案；如果你的目标是“稳定提交一个本地后台任务”，这个插件就是更贴切的实现。
