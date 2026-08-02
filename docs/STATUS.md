# MemoryVault 项目状态

## 当前定位

MemoryVault 已从个人 MCP 记忆服务器升级为可运行的 Agent MemoryOps 基础设施，核心闭环和医院 A 示例已实现。

## 已完成

- 25 个 MCP Tools，支持 stdio 与 Streamable HTTP
- HTTP MCP per-Agent Principal：哈希凭据、角色工具白名单、tenant/project/space/actor 服务端绑定
- tenant/project/scope/space 精确隔离
- Agent Events、SQLite Outbox、重试、租约恢复和死信
- Memory Worker、脱敏、分类、置信度、人工审核和纠错
- approved Policy、policy_ref、memory_ref 和版本历史
- Workflow Gateway 强制 Writer、Reviewer、Human 顺序及幂等恢复
- AgentTeams Manager、Lead、Writer、Reviewer 和 4 个 Skills
- Space E2EE、签名邀请、密钥轮换、成员撤销和 RBAC Token
- 增量同步、Tombstone、远程失败缓存和重试
- Dashboard Trace、Outbox、Policy、Memory Review、Workflow Approval
- Dashboard 审批接口默认仅监听回环地址，远程访问要求认证反向代理
- 医院 A 确定性 E2E Demo 和自动化测试
- GOAI 项目介绍、演示脚本和 12 页赛事方案 PPT
- AgentTeams 官方 `agentteams.io/v1beta1` CR 结构与 Skills 契约自动验证
- AgentTeams consumer key 到 Lead/Writer/Reviewer Principal 的安全映射脚本
- 可独立部署的 `memory-vault-worker` 常驻 Outbox 消费者
- AgentTeams v1.2.0 Embedded + CoPaw + DeepSeek 真实模型闭环验证：3 个 Worker Running、Team `2/2 Ready`、角色工具隔离、Lead 启动、Writer 召回与交稿、Reviewer 独立审核、Human 审批、Manager 收尾均已通过
- 真实任务 `agentteams-hospital-a-20260802173847` 最终状态 `completed`，10 条审计事件全部消费完成，2 条团队记忆使用 Space E2EE，数据库无明文记忆行
- 真实运行证据见 [`docs/agentteams-real-run.md`](agentteams-real-run.md)

## 仍需增强

- AgentTeams 真实模型运行录像与复赛现场录屏
- AgentTeams v1.2.0 Embedded 的 Team MinIO 到 Global MinIO 交付物需要 Controller 运维桥接；等待上游提供原生跨命名空间交付
- OpenTelemetry GenAI / Metrics 接入
- Higress 外部网关部署样例
- SQLite 到 RocketMQ、PolarDB 的生产适配器
- 大规模并发、性能基准和长期故障注入
