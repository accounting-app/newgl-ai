import type { SQL } from "bun";

import type { UsageRepository } from "@/application/contracts";
import type { KeySource, UsageEntry, UsagePeriodSummary } from "@/domain/models";

type UsageAggregateRow = {
  key_source: KeySource;
  total_actions: string | number;
  total_tokens: string | number;
};

function startOfCurrentUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function createPostgresUsageRepository(sql: SQL): UsageRepository {
  return {
    async record(entry: UsageEntry) {
      await sql`
        insert into ai_usage (
          tenant_id, feature, model, key_source, actions,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
        ) values (
          ${entry.tenantId}, ${entry.feature}, ${entry.model}, ${entry.keySource}, ${entry.actions},
          ${entry.inputTokens}, ${entry.outputTokens}, ${entry.cacheReadTokens}, ${entry.cacheCreationTokens}, ${entry.costUsd}
        )
      `;
    },

    async summarizeCurrentPeriod(tenantId: string): Promise<UsagePeriodSummary> {
      const periodStart = startOfCurrentUtcMonth();

      const rows = await sql`
        select
          key_source,
          sum(actions)::bigint as total_actions,
          sum(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)::bigint as total_tokens
        from ai_usage
        where tenant_id = ${tenantId} and created_at >= ${periodStart}
        group by key_source
      `;

      const byKeySource: UsagePeriodSummary["byKeySource"] = {
        platform: { actions: 0, tokens: 0 },
        byok: { actions: 0, tokens: 0 }
      };
      let totalActions = 0;
      let totalTokens = 0;

      for (const raw of rows) {
        const row = raw as UsageAggregateRow;
        const actions = Number(row.total_actions);
        const tokens = Number(row.total_tokens);
        byKeySource[row.key_source] = { actions, tokens };
        totalActions += actions;
        totalTokens += tokens;
      }

      return { periodStart: periodStart.toISOString(), totalActions, totalTokens, byKeySource };
    }
  };
}
