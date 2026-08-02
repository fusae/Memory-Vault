import { describe, it, expect, vi } from 'vitest';

// 这里只验证 MCP tools 的注册逻辑是否正确
// 完整的 MCP 端到端测试需要 stdio transport，留到手动验证
describe('MCP Server tools', () => {
  it('should be importable without errors', async () => {
    // 验证模块可以正常加载（不启动 stdio）
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
    expect('memory_correct' in (mod.server as any)._registeredTools).toBe(true);
    expect('memory_review_decide' in (mod.server as any)._registeredTools).toBe(true);
    expect('policy_write' in (mod.server as any)._registeredTools).toBe(true);
    expect('policy_approve' in (mod.server as any)._registeredTools).toBe(true);
    expect('policy_list' in (mod.server as any)._registeredTools).toBe(true);
    expect('workflow_recall' in (mod.server as any)._registeredTools).toBe(true);
  });
});
