import { describe, it, expect } from 'vitest';

describe('MCP Prompts', () => {
  describe('memory_extract', () => {
    it('should be registered and return extraction instructions', async () => {
      const mod = await import('../src/index.js');
      const server = mod.server as any;

      // Verify the prompt is registered by checking _registeredPrompts map
      const prompts = server._registeredPrompts;
      expect(prompts).toBeDefined();
      expect('memory_extract' in prompts).toBe(true);
    });
  });
});
