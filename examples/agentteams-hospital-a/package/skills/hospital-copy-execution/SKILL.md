---
name: hospital-copy-execution
description: 根据医院 A 的已审批规则、客户偏好和历史反馈撰写可审核的办公文案。
---

# Hospital Copy Execution

1. 读取 `workflow_start` 返回的 `writer_context`，确认强制规则和客户偏好。
2. 文案中不得使用召回内容未支持的医疗事实、疗效数字或绝对化结论。
3. 输出标题三个版本、正文、事实待确认项、`memory_ref` 和 `policy_ref`。
4. 调用 `workflow_submit_draft`，传入原 `task_id`、`actor_id=hospital-a-writer`、`reviewer_id=hospital-a-reviewer` 和完整草稿。
5. Gateway 自动记录工件版本、交接事件并为 reviewer 强制召回；不得自行批准或绕过该工具。
