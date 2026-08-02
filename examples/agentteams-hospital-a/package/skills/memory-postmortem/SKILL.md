---
name: memory-postmortem
description: 在任务完成或明确纠错后，将可跨任务复用的经验可靠写入 MemoryVault。
---

# Memory Postmortem

只提炼客户偏好、项目决策、稳定流程和可复用问题解决经验，不保存一次性指令。

受控工作流在 Dashboard 人工批准时填写可复用经验，由 `workflow_human_decide` 自动生成幂等 `memory_candidate` 并经 Outbox、Memory Worker 写入团队空间。失败任务不得沉淀为已验证经验。

发现错误记忆时使用 `memory_correct`，必须传入原上下文中的完整 `memory_ref`。
