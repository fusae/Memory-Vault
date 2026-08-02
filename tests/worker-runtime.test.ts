import { describe, expect, it, vi } from 'vitest';
import { runMemoryWorkerLoop } from '../src/worker.js';

describe('Memory Worker runtime', () => {
  it('processes immediately and stops cleanly', async () => {
    const controller = new AbortController();
    const processBatch = vi.fn().mockResolvedValue({ processed: 3, failed: 0, deadLettered: 0 });
    const results: unknown[] = [];

    await runMemoryWorkerLoop({ processBatch }, {
      signal: controller.signal,
      batchSize: 25,
      pollMs: 100,
      onBatch: result => {
        results.push(result);
        controller.abort();
      },
    });

    expect(processBatch).toHaveBeenCalledOnce();
    expect(processBatch).toHaveBeenCalledWith(25);
    expect(results).toEqual([{ processed: 3, failed: 0, deadLettered: 0 }]);
  });

  it('continues after a batch-level failure', async () => {
    const controller = new AbortController();
    const failure = new Error('temporary database failure');
    const processBatch = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ processed: 1, failed: 0, deadLettered: 0 });
    const onError = vi.fn();

    await runMemoryWorkerLoop({ processBatch }, {
      signal: controller.signal,
      pollMs: 100,
      onError,
      onBatch: () => controller.abort(),
    });

    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
