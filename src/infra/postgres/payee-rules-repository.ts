import type { SQL } from "bun";

import type { PayeeRulesRepository } from "@/application/contracts";
import type { PayeeRuleRow, PayeeRuleSource } from "@/domain/models";

type PayeeRuleDbRow = {
  normalized_payee: string;
  canonical_payee: string;
  account_id: string | null;
  source: PayeeRuleSource;
  confirmed_count: number | string;
};

export function createPostgresPayeeRulesRepository(sql: SQL): PayeeRulesRepository {
  return {
    async findByNormalizedKeys(tenantId, normalizedKeys): Promise<Map<string, PayeeRuleRow>> {
      const map = new Map<string, PayeeRuleRow>();
      if (normalizedKeys.length === 0) return map;

      const rows = await sql`
        select normalized_payee, canonical_payee, account_id, source, confirmed_count
        from payee_rules
        where tenant_id = ${tenantId} and normalized_payee IN ${sql(normalizedKeys)}
      `;

      for (const raw of rows) {
        const row = raw as PayeeRuleDbRow;
        map.set(row.normalized_payee, {
          normalizedPayee: row.normalized_payee,
          canonicalPayee: row.canonical_payee,
          accountId: row.account_id,
          source: row.source,
          confirmedCount: Number(row.confirmed_count)
        });
      }
      return map;
    },

    async upsertMany(tenantId, rules) {
      // One statement per rule rather than a single multi-row INSERT: rule
      // batches here are at most a few hundred rows (one CSV import), this
      // isn't a hot path, and it keeps the conflict-resolution logic (don't
      // let an AI guess clobber a user-confirmed account) easy to read.
      for (const rule of rules) {
        const confirmedIncrement = rule.source === "user" ? 1 : 0;
        await sql`
          insert into payee_rules (tenant_id, normalized_payee, canonical_payee, account_id, source, confirmed_count)
          values (${tenantId}, ${rule.normalizedPayee}, ${rule.canonicalPayee}, ${rule.accountId}, ${rule.source}, ${confirmedIncrement})
          on conflict (tenant_id, normalized_payee) do update set
            canonical_payee = case
              when ${rule.overwriteCanonicalPayee} then excluded.canonical_payee
              else payee_rules.canonical_payee
            end,
            account_id = coalesce(excluded.account_id, payee_rules.account_id),
            source = case when excluded.source = 'user' then 'user' else payee_rules.source end,
            confirmed_count = payee_rules.confirmed_count + ${confirmedIncrement},
            updated_at = now()
        `;
      }
    }
  };
}
