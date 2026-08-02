# MemoryVault 医院 A 演示脚本

## 演示目标

证明同事 Agent 可以在负责人缺席时，安全继承医院 A 的规则和偏好，并完成“召回、执行、审核、人工批准、经验写回”的可审计闭环。

## 1. 确定性工程验证

```bash
pnpm install
pnpm build
pnpm test
MEMORY_DB_PATH=/tmp/memory-vault-hospital-a.db node build/hospital-demo.js
```

重点展示输出字段：

- `status=completed`
- `memory_refs` 与 `policy_refs`
- `artifact_revision=1`
- `agent_events=12`
- `outbox.completed=12`
- `tool_boundary_policy_refs` 与 `policy_refs` 一致
- `e2ee.plaintext_found_in_database=false`

## 2. Dashboard 审计

```bash
MEMORY_DB_PATH=/tmp/memory-vault-hospital-a.db DASHBOARD_PORT=3080 memory-vault-dashboard
```

打开 `http://localhost:3080`：

1. Timeline 展示医院 A 偏好和新沉淀经验。
2. Operations 展示 Agent Trace、Outbox、Policy 数量和人工审批状态。
3. Trace 中按 `trace_id` 过滤，确认 Manager、Writer、Reviewer 和 Human 事件顺序。

## 3. 人工回滚分支

在 AgentTeams 真实演示中，让 Writer 生成“保证治愈”等绝对化表述。Reviewer 必须引用医疗宣传 `policy_ref` 并返回 rejected；工作流状态变为 `rejected`，记录 `rollback_to_revision=0`，不能再由人工发布。

## 4. AgentTeams 真实演示

```bash
bash examples/agentteams-hospital-a/package-worker.sh
python3 -m http.server 8099 --bind 0.0.0.0 --directory examples/agentteams-hospital-a
```

在 AgentTeams 仓库应用：

```bash
bash install/agentteams-apply.sh -f /absolute/path/to/Memory-Vault/examples/agentteams-hospital-a/agentteams.yaml
```

Worker Ready 后映射独立 consumer key，再启动鉴权 MCP：

```bash
MEMORYVAULT_HTTP_PRINCIPALS_FILE="$HOME/.memoryvault/agentteams-hospital-a-principals.json" \
bash examples/agentteams-hospital-a/configure-principals.sh

MEMORYVAULT_HTTP_HOST=0.0.0.0 \
MEMORYVAULT_HTTP_PORT=3090 \
MEMORYVAULT_HTTP_PRINCIPALS_FILE="$HOME/.memoryvault/agentteams-hospital-a-principals.json" \
memory-vault-http

MEMORY_DB_PATH="$HOME/.memoryvault/memory.db" memory-vault-worker
```

向 Manager 发送：

```text
医院 A 原文案负责人今天缺席。请让 hospital-a-team 接手“世界心脏日义诊活动”公众号文案，使用历史客户偏好和已审批医疗宣传规则，完成文案、独立审核、人工确认和经验回写，并给出 memory_ref、policy_ref、task_id、trace_id 与执行证据。
```

## 5. 故障与安全证据

- 重复提交相同 task、Draft、Review 或 Human Decision，不会重复工件和经验。
- Worker 失败会指数重试，耗尽进入 dead_letter。
- Reader Token 写入返回 403；撤销 Token 后访问返回 401。
- 成员撤销立即轮换空间密钥；旧成员不能解密新版本数据。
- Secret、Token、Authorization 在不可变事件落盘前被脱敏。
- Lead、Writer、Reviewer 只能看到各自允许的工作流工具，跨租户、项目、空间或冒充身份均被服务端拒绝。
