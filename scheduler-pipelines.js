'use strict';

function createSchedulerPipelines({ syncAll, enrichBatch, clock = () => Date.now() }) {
  if (typeof syncAll !== 'function' || typeof enrichBatch !== 'function') throw new TypeError('scheduler pipeline functions are required');
  return {
    async sync(trigger = 'supabase_cron') {
      const started = clock();
      const results = await syncAll(trigger);
      return { results, duration_ms: Math.max(0, clock() - started) };
    },
    async enrich(limit = 1) {
      const started = clock();
      const result = await enrichBatch(limit);
      return { ...result, duration_ms: Math.max(0, clock() - started) };
    }
  };
}

module.exports = { createSchedulerPipelines };
