---
name: hospital-policy-validation
description: 使用已审批 Policy 对医院 A 文案进行医疗合规、品牌规则和交付完整性验证。
---

# Hospital Policy Validation

1. 使用 `workflow_submit_draft` 返回的 `reviewer_context` 和 `required_policy_refs`。
2. 逐条检查命名、绝对化宣传、事实依据和审批流程。
3. 通过时调用 `workflow_submit_review`，提交 `decision=approved`、全部 `required_policy_refs` 和发现项。
4. 失败时调用同一工具提交 `decision=rejected`、命中的 `policy_ref`、问题位置和修改建议。
5. Writer 不得自审；Gateway 校验 reviewer 身份和 Policy 当前版本，最终仍需 Dashboard 人工批准。
