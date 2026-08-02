---
name: memory-recall
description: 在任务开始、失败重试、Agent 交接或指定工具边界召回受权限控制的项目记忆与已审批规则。
---

# Memory Recall

受控工作流必须使用 `workflow_start` 或 `workflow_submit_draft` 返回的上下文；Gateway 会在任务开始和 Agent 交接时强制召回，并固定 `project=hospital-a`、`space_id=hospital-a-copy`。

失败重试必须调用 `workflow_recall(trigger=failure_retry)` 并递增 `attempt`；进入 Policy 声明的外部工具边界前必须调用 `workflow_recall(trigger=tool_boundary, tool_name=...)`。Gateway 会拒绝未分配 Agent、无重试序号和未被已审批 Policy 声明的边界。

只有非受控诊断任务才直接调用 `memory_recall_context`，且必须显式传入 `space_id=hospital-a-copy`、查询和真实触发类型。

只允许以下触发类型：

- `task_start`
- `failure_retry`
- `agent_handoff`
- `tool_boundary`

保留返回内容中的 `memory_ref` 和 `policy_ref`，交付时列出实际引用；不得把其他项目或个人记忆带入任务。
