下面是一版可直接发给工程师的 **精简 PRD**。

---

# PRD：OpenClaw 插件版 AI CLI 异步执行器

## 1. 背景

需要在 **OpenClaw** 内提供一个插件能力，用于在本机指定目录下执行外部 AI CLI（如 `claude`、`codex`、`gemini`），并以**异步任务**方式返回执行状态、日志预览和最终结果。

本项目不再实现独立 MCP Server，也不使用 Go；统一采用 **OpenClaw 插件 + TypeScript** 实现。

---

## 2. 目标

实现一个 OpenClaw 插件，支持：

* 提交 AI CLI 执行任务
* 后台异步运行，不阻塞主调用
* 采集 stdout / stderr
* 日志 ANSI 清洗
* 日志节流聚合
* 查询任务状态
* 获取最终结果
* 取消任务
* 基础安全校验（命令白名单、目录白名单、超时控制）

---

## 3. 非目标

本期不做：

* Docker / bwrap / sandbox 隔离
* MCP progress 通知兼容
* 交互式 CLI 输入
* 历史任务持久化数据库
* 多租户隔离
* Windows 兼容性保证
* 会话内真正的逐 token 流式回传

---

## 4. 总体方案

采用 **OpenClaw 插件**实现，语言为 **TypeScript**。

架构分为两层：

* **Tools 层**：向 OpenClaw 暴露任务提交、状态查询、结果获取、取消任务接口
* **Runtime 层**：负责子进程执行、日志采集、状态管理、超时与取消

执行模型采用 **异步 Job 模型**，而不是单次工具调用内长时间阻塞。

### 流程

1. 调用 `submit` 提交任务
2. 插件立即返回 `job_id`
3. 后台启动 CLI 子进程
4. 持续采集 stdout / stderr，更新任务状态
5. 调用方通过 `status` 查询进度
6. 调用 `result` 获取最终结果
7. 必要时调用 `cancel` 取消任务

---

## 5. 工具定义

### 5.1 `execute_ai_cli_submit`

用途：提交任务

参数：

* `cli_cmd: string` 必填，CLI 命令名
* `args: string[]` 必填，参数数组
* `working_dir: string` 必填，绝对路径
* `timeout_seconds?: number` 可选，默认 900
* `label?: string` 可选，任务标签

返回：

```json
{
  "job_id": "string",
  "status": "accepted",
  "started_at": "ISO datetime",
  "working_dir": "/abs/path"
}
```

---

### 5.2 `execute_ai_cli_status`

用途：查询任务状态

参数：

* `job_id: string` 必填

返回：

```json
{
  "job_id": "string",
  "status": "queued | running | succeeded | failed | timed_out | cancelled",
  "started_at": "ISO datetime | null",
  "finished_at": "ISO datetime | null",
  "exit_code": 0,
  "last_update_at": "ISO datetime | null",
  "stdout_bytes": 123,
  "stderr_bytes": 45,
  "combined_preview": "string",
  "is_truncated": false
}
```

---

### 5.3 `execute_ai_cli_result`

用途：获取最终结果

参数：

* `job_id: string` 必填

返回：

```json
{
  "job_id": "string",
  "status": "succeeded | failed | timed_out | cancelled | running | queued",
  "exit_code": 0,
  "summary": "string",
  "final_log": "string",
  "is_truncated": false,
  "finished_at": "ISO datetime | null"
}
```

---

### 5.4 `execute_ai_cli_cancel`

用途：取消任务

参数：

* `job_id: string` 必填

返回：

```json
{
  "job_id": "string",
  "status": "cancelled | succeeded | failed | timed_out",
  "cancelled_at": "ISO datetime | null"
}
```

---

## 6. 功能要求

## 6.1 子进程执行

必须使用 Node.js `child_process.spawn()`。

要求：

* `cwd = working_dir`
* `shell = false`
* `stdio = ["ignore", "pipe", "pipe"]`
* 不允许使用 `exec()`
* 不处理 stdin 交互
* 默认调用方自行传入非交互参数

---

## 6.2 日志采集

同时监听：

* `child.stdout`
* `child.stderr`

要求：

* 所有输出按 UTF-8 处理
* 清洗 ANSI 控制符后再写入缓冲
* 分别统计 stdout/stderr 字节数
* 维护合并日志视图供预览和最终结果使用

ANSI 清洗正则：

```regex
\x1b\[[0-9;]*m
```

---

## 6.3 节流刷新

内部必须实现日志聚合和节流。

推荐触发条件：

* 缓冲累计达到 `1024` 字节，或
* 距上次刷新超过 `500ms`

每次刷新时：

* 更新 `combined_preview`
* 更新 `last_update_at`
* 更新已统计字节数
* 不强制主动推消息，由调用方通过查询工具读取

---

## 6.4 日志截断

任务结束后对最终日志执行截断保护。

规则：

* 总字符数 `<= 4000`：直接返回完整日志
* 总字符数 `> 4000`：

  * 取前 `1000` 字符
  * 取后 `2000` 字符
  * 中间拼接：

```text
\n... [省略中间日志] ...\n
```

并设置：

* `is_truncated = true`

---

## 6.5 状态机

任务状态流转：

```text
queued -> running -> succeeded | failed | timed_out | cancelled
```

定义：

* `queued`：任务已创建，尚未启动
* `running`：子进程已启动
* `succeeded`：退出码为 0
* `failed`：退出码非 0 或执行异常
* `timed_out`：超时被终止
* `cancelled`：被主动取消

完成条件：

* 子进程退出
* stdout 流结束
* stderr 流结束

以上全部满足，任务才进入最终态

---

## 6.6 超时控制

默认超时：

* `900 秒`

支持通过 `timeout_seconds` 覆盖。

超时后：

* 杀死子进程
* 状态标记为 `timed_out`
* 保存已收集日志
* 记录 `finished_at`

---

## 6.7 取消控制

调用取消时：

* 若任务处于 `queued` / `running`，尝试终止进程
* 状态设为 `cancelled`
* 若任务已结束，直接返回当前状态

---

## 7. 安全要求

### 7.1 `working_dir` 校验

必须满足：

* 绝对路径
* 路径存在
* 为目录
* 位于允许目录白名单内（配置项控制）

### 7.2 `cli_cmd` 校验

必须命中命令白名单。

例如允许：

* `claude`
* `codex`
* `gemini`

默认不允许任意命令执行。

### 7.3 `args` 校验

要求：

* 必须为字符串数组
* 不拼接 shell 命令
* 必须直接传给 `spawn(cli_cmd, args, ...)`

---

## 8. 配置项

插件至少支持以下配置：

```json
{
  "allowedCommands": ["claude", "codex", "gemini"],
  "allowedWorkingDirs": ["/workspace", "/Users/foo/projects"],
  "defaultTimeoutSeconds": 900,
  "maxLogChars": 4000,
  "previewFlushBytes": 1024,
  "previewFlushIntervalMs": 500,
  "maxConcurrentJobs": 4
}
```

---

## 9. 数据结构建议

```ts
type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

interface JobRecord {
  jobId: string;
  label?: string;
  cliCmd: string;
  args: string[];
  workingDir: string;

  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastUpdateAt: string | null;

  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;

  combinedPreview: string;
  finalLog: string | null;
  isTruncated: boolean;

  childPid?: number;
}
```

---

## 10. 目录建议

```text
openclaw-ai-cli-runner/
├── openclaw.plugin.json
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── tools/
    │   ├── submit.ts
    │   ├── status.ts
    │   ├── result.ts
    │   └── cancel.ts
    ├── runtime/
    │   ├── job-manager.ts
    │   ├── process-runner.ts
    │   ├── log-buffer.ts
    │   └── store.ts
    └── utils/
        ├── ansi.ts
        ├── truncate.ts
        ├── validate.ts
        └── id.ts
```

---

## 11. 验收标准

满足以下条件即视为本期完成：

1. 插件可在 OpenClaw 中安装并加载
2. 可成功调用 `execute_ai_cli_submit`
3. 任务提交后立即返回 `job_id`
4. 后台可正常执行外部 CLI
5. stdout / stderr 能被正确采集
6. ANSI 控制符被清洗
7. `status` 可查看任务实时状态和日志预览
8. `result` 可获取最终日志与结果
9. 超时任务会被正确终止
10. `cancel` 可取消运行中的任务
11. 白名单与目录校验生效
12. 单个任务异常不会导致插件整体崩溃

---

## 12. 风险与注意事项

* 插件与 OpenClaw Gateway 同进程运行，必须视为受信代码
* 长日志任务不能无限制保留完整字符串，建议使用 head/tail 缓冲
* 子进程退出与流结束需要统一收口，避免状态过早结束
* Windows 平台的 kill 行为先不保证一致性
* 本期先做查询式异步模型，不承诺会话内原生持续推流体验

---


