# MemoryVault 赛事项目介绍

适用赛道：[GOAI Agent Infra 新智基座](https://www.goaihz.com/tracks?track=infra)

## 500 字作品简介

MemoryVault 是面向企业多 Agent 协作的开源 Agent MemoryOps 基础设施，解决客户规则、偏好、反馈与执行经验被锁在个人会话、换人后无法稳定接手的问题。项目以“医院 A 文案负责人缺席，同事 Agent 接手”为示范：AgentTeams Manager 拆解任务，Writer 使用授权记忆执行，Reviewer 按已审批 Policy 验证，客户负责人最终发布或回滚。Workflow Gateway 在服务端强制召回、交接、审核和审批顺序；事件先进入 SQLite Outbox，再由 Memory Worker 幂等沉淀，每条上下文携带版本化 memory_ref 或 policy_ref。Agent Principal 强制角色与租户、项目、空间、actor 边界，团队数据支持空间 E2EE、撤销和密钥轮换。项目保持 local-first 和 MCP 兼容，已提供 AgentTeams 包、4 个 Skills、Dashboard、故障恢复测试、医院 A 端到端 Demo 与 MIT 开源仓库，可迁移至客服、法务、营销和研发交接。

## Agent Identity 清单

| Agent | 身份与边界 | 输入 | 输出 | 禁止事项 |
|---|---|---|---|---|
| Manager / Team Lead | 接收任务、拆解、启动受控工作流 | 企业任务、project、space | task_id、trace_id、Writer 上下文 | 不直接产出或批准最终文案 |
| Hospital A Writer | 使用授权记忆和 Policy 执行文案 | request、writer_context | 版本化 Draft | 不自审、不越权读取其他空间 |
| Compliance Reviewer | 独立核对全部 required_policy_refs | Draft、reviewer_context、Policy | approved/rejected、findings | 不使用 Draft Policy、不替代人工发布 |
| Human Owner | 业务责任人 | Draft、Review、证据 | Publish 或 Rollback | 决策后不能修改幂等载荷 |

## 端到端闭环

1. 任务输入：医院 A 原负责人缺席，收到世界心脏日义诊文案任务。
2. 任务拆解：Team Lead 调用 `workflow_start`，指定 Writer 和团队空间。
3. 上下文传递：Gateway 在任务开始和交接时强制召回，返回 memory_ref、policy_ref、来源和版本。
4. 工具调用：Writer 调用 `workflow_submit_draft`，Gateway 保存不可变工件版本。
5. 结果验证：Reviewer 调用 `workflow_submit_review`，必须证明核对全部当前 Policy。
6. 审批与回滚：Dashboard 只允许人工 Publish 或 Rollback；未批准不能进入 completed。
7. 执行证据：task_id、trace_id、事件、Outbox、工件、审核和人工决策均可查询。
8. 经验沉淀：批准后的经验成为 memory_candidate，经 Outbox、Memory Worker、治理和去重后写回团队空间。

## 核心 Skills

| Skill | 输入 / 输出 | 调用条件 | 依赖工具 | 失败与安全边界 | 协同关系 | 复用价值 |
|---|---|---|---|---|---|---|
| memory-recall | project、space、trigger -> Governed Context | 开始、重试、交接、Policy 工具边界 | `workflow_start`、`workflow_recall`、sqlite-vec、PolicyStore | 精确空间隔离；非法触发拒绝 | Lead 启动，Gateway 向 Writer/Reviewer 传递上下文 | 所有企业任务可复用 |
| hospital-copy-execution | request、writer_context -> Draft | Writer 已被 Gateway 分配 | `workflow_submit_draft` | 不生成无来源医疗事实，不自审 | Writer 产出版本化工件并交接 Reviewer | 可替换成任意客户执行 Skill |
| hospital-policy-validation | Draft、Policy refs -> Review | 独立 Reviewer 接手 | `workflow_submit_review`、PolicyStore | 只接受当前 approved Policy | Reviewer 独立验收并决定继续或回滚 | 可复用于合规、法务、品牌审核 |
| memory-postmortem | 人工结论、经验 -> memory_candidate | 人工批准后 | `workflow_human_decide`、Outbox、Memory Worker | 敏感项进审核；失败重试或死信 | Human 结论触发可靠经验写回 | 可复用于客服、研发、运维复盘 |

## Skill 发布与质量

- 版本与发布：四个 Skill 随 Worker Package `version=1.0` 形成不可变 ZIP 发布单元，AgentTeams 通过 `spec.package` 分发。
- 回滚：保留上一版 ZIP 并重新应用 Worker CR；Policy、Memory 和工件本身均带版本引用，可回滚且不覆盖历史证据。
- 质量门禁：自动校验 Skill 名称、工具契约、Agent 身份、CR 结构和 Principal 映射；全量测试覆盖正常闭环、拒绝分支、重试、死信、崩溃重放和 E2EE。
- 兼容范围：AgentTeams `agentteams.io/v1beta1`、MCP Streamable HTTP/stdio、Node.js 18+；Higress、RocketMQ、PolarDB 均通过现有接口契约替换。

## 官方评分映射

| 评分维度 | 项目证据 |
|---|---|
| 场景价值与行业可复制性 25% | 医院 A 办公交接；同一模型可替换为客服、法务、营销、研发和运维空间 |
| 多 Agent 协同与闭环 25% | AgentTeams 4 个角色；Gateway 强制状态机；异常、审核、人工审批和回滚 |
| Skill 工程与复用 25% | 4 个可分发 Skills；明确输入输出、调用条件、失败、安全和复用边界 |
| 工程验证与安全审计 20% | per-Agent Principal、最小工具可见性、Outbox、Trace、Dashboard、E2EE、RBAC、轮换、Tombstone 和自动化测试 |
| 开放 / 开源贡献 5% | MIT、标准 MCP、SQLite 参考实现、AgentTeams YAML、可运行 Demo 和迁移契约 |

## 选型与迁移

- AgentTeams：协同设计和部署基点，已有 Manager、Workers、Team YAML 和 Worker Skills 包。
- SQLite Outbox：本地优先场景的轻量可靠队列；事件契约可迁移至 RocketMQ，无需重构 Agent 工具接口。
- SQLite + sqlite-vec：默认本地数据层；规模化时可迁移 PolarDB PostgreSQL / pgvector。
- 内置 Trace + Dashboard：当前覆盖 Log/Trace；可映射 OpenTelemetry GenAI 并接入 LoongSuite 或 AgentScope Studio。
- Streamable HTTP MCP：MemoryVault 原生校验 Agent Principal；Higress 可叠加路由授权、限流和外部暴露。

## 当前运行证据

```bash
pnpm build
pnpm test
MEMORY_DB_PATH=/tmp/memory-vault-hospital-a.db memory-vault-demo-hospital-a
```

确定性 Demo 验证 3 个 Agent 职能、12 个审计事件、Policy 工具边界证明、人工审批、经验写回、Outbox 全完成和数据库无团队明文。
