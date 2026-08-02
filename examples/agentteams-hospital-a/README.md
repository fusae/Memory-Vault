# Hospital A AgentTeams Demo

这个示例使用 AgentTeams 的 Manager、Team Leader、文案 Worker 和审核 Worker，演示原负责人缺席后由同事 Agent 接手医院 A 文案任务。

## 1. 构建 Worker Package

```bash
bash examples/agentteams-hospital-a/package-worker.sh
python3 -m http.server 8099 --bind 0.0.0.0 --directory examples/agentteams-hospital-a
```

Worker 容器通过 `host.docker.internal:8099` 下载自定义 Skill package；应用 YAML 期间保持该命令运行。

## 2. 应用 AgentTeams 资源

在 AgentTeams 仓库中执行：

```bash
bash install/agentteams-apply.sh -f /absolute/path/to/memory-vault/examples/agentteams-hospital-a/agentteams.yaml
```

YAML 按官方要求先声明 Manager 和 Worker，再声明引用这些 Worker 的 Team。顶层 Manager 只负责委派，不直接连接 MemoryVault；Lead、Writer、Reviewer 各自使用 AgentTeams 注入的独立 consumer key。

## 3. 建立 Agent Principal 映射

等待三个 Worker Ready 后，在 MemoryVault 主机执行：

```bash
MEMORYVAULT_HTTP_PRINCIPALS_FILE="$HOME/.memoryvault/agentteams-hospital-a-principals.json" \
bash examples/agentteams-hospital-a/configure-principals.sh
```

脚本自动支持两种 AgentTeams 部署：Kubernetes 模式从 `agentteams-system` 命名空间的 `agentteams-creds-*` Secret 读取，Embedded Docker 模式从 Controller 的 `/data/worker-creds/*.env` 读取。脚本仅把 SHA-256 写入权限为 `0600` 的 Principal 文件，Token 不会输出或落盘。可用 `AGENTTEAMS_CREDENTIAL_BACKEND=kubernetes|embedded` 强制指定模式；自定义命名空间使用 `AGENTTEAMS_NAMESPACE`。

## 4. 启动 MemoryVault HTTP MCP

```bash
MEMORYVAULT_HTTP_HOST=0.0.0.0 \
MEMORYVAULT_HTTP_PORT=3090 \
MEMORYVAULT_HTTP_PRINCIPALS_FILE="$HOME/.memoryvault/agentteams-hospital-a-principals.json" \
memory-vault-http
```

另启常驻 Outbox Worker，确保审计事件持续消费而不是停留在 `pending`：

```bash
MEMORY_DB_PATH="$HOME/.memoryvault/memory.db" memory-vault-worker
```

MemoryVault 根据 bearer token 强制绑定 `hospital-a-lead=manager`、`hospital-a-writer=writer`、`hospital-a-reviewer=reviewer`，并限制 `tenant=agency`、`project=hospital-a`、`space_id=hospital-a-copy`。不要使用共享 `MEMORYVAULT_HTTP_TOKEN`；非回环地址在无认证时会拒绝启动。

## 5. 演示任务

在 Element 中向 Manager 发送：

```text
医院 A 原文案负责人今天缺席。请让 hospital-a-team 接手一篇“世界心脏日义诊活动”公众号文案，必须使用历史客户偏好和已审批医疗宣传规则，完成文案、独立审核、人工确认和经验回写，并给出 memory_ref、policy_ref、task_id、trace_id 与执行证据。
```

预期闭环：Manager 委派给 Team Leader，Leader 调用 `workflow_start`，Gateway 强制召回并分配 writer；writer 通过 `workflow_submit_draft` 交接 reviewer，reviewer 用 `workflow_submit_review` 证明已核对当前 Policy。最后在 Dashboard 的 Operations 页面执行 Publish 或 Rollback；批准时可填写经验，由 Outbox 与 Memory Worker 写入团队记忆。

## AgentTeams v1.2.0 Embedded 已知限制

该版本会把 Team 产物写入 Team MinIO 命名空间，但 Manager 从 Global MinIO 命名空间核验父任务交付物。若 Manager 报告 `result.md` 不存在，需要由 Controller 运维层把 Team 产物桥接到对应的 Global `shared/tasks/...` 路径；这是 AgentTeams 的跨命名空间交付限制，不是 MemoryVault 鉴权或工作流失败。
