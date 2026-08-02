# AgentTeams 医院 A 真实运行证据

验证时间：2026-08-02

## 环境

- AgentTeams v1.2.0 Embedded
- CoPaw Runtime
- DeepSeek `deepseek-v4-flash`
- MemoryVault Streamable HTTP MCP、Ollama `nomic-embed-text`、常驻 `memory-vault-worker`
- `hospital-a-lead`、`hospital-a-writer`、`hospital-a-reviewer` 均为 Running
- `hospital-a-team` 为 Active，Worker `2/2 Ready`

## 真实任务

- task_id：`agentteams-hospital-a-20260802173847`
- trace_id：`adac4fb8-9f31-4eb3-9c25-3bdc1dba2bcc`
- 场景：医院 A 原文案负责人缺席，由 Agent Team 接手世界心脏日义诊活动公众号文案
- 最终状态：`completed`
- AgentTeams Manager 状态：`active_tasks=[]`

## 强制链路

1. Lead 调用 `workflow_start`，召回 3 条版本化上下文并交接 Writer。
2. Writer 调用 `workflow_recall` 和 `workflow_submit_draft`，提交带 `memory_ref`、`policy_ref` 的草稿。
3. Reviewer 独立调用 `workflow_recall` 和 `workflow_submit_review`，结论为 `approved`。
4. 独立 Human Principal 调用 `workflow_human_decide`，工作流进入 `completed`。
5. Lead 再调用 `workflow_get` 核验，Manager 拉取交付物并关闭 AgentTeams 任务。

角色工具隔离验证：

- Lead：`workflow_start`、`workflow_get`
- Writer：`workflow_recall`、`workflow_submit_draft`、`workflow_get`
- Reviewer：`workflow_recall`、`workflow_submit_review`、`workflow_get`
- Human：`workflow_human_decide`、`workflow_get`

## 审计与安全

- 10 条任务审计事件全部由常驻 Outbox Worker 消费为 `completed`
- `failed=0`，`dead_letter=0`
- 2 条医院 A 团队记忆均为 Space E2EE，`key_version=1`
- 数据库中的团队记忆明文行数为 0
- 8 个测试容器均为 Running，未发生 OOM

## 上游限制

AgentTeams v1.2.0 Embedded 将 Team 交付物保存到 Team MinIO 命名空间，而 Manager 从 Global MinIO 命名空间核验父任务。本次由 Controller 运维层完成一次命名空间桥接后收尾；MemoryVault MCP 鉴权、召回、审核、审批和审计链路不受影响。
