import type { SQL } from "bun";

import type { CredentialRow, CredentialsRepository } from "@/application/contracts";

type CredentialDbRow = {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  last_four: string;
  model_override: string | null;
  validated_at: Date;
};

export function createPostgresCredentialsRepository(sql: SQL): CredentialsRepository {
  return {
    async upsert(tenantId, row) {
      await sql`
        insert into ai_credentials (tenant_id, ciphertext, iv, auth_tag, last_four, model_override, validated_at, updated_at)
        values (${tenantId}, ${row.ciphertext}, ${row.iv}, ${row.authTag}, ${row.lastFour}, ${row.modelOverride}, ${row.validatedAt}, now())
        on conflict (tenant_id) do update set
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          last_four = excluded.last_four,
          model_override = excluded.model_override,
          validated_at = excluded.validated_at,
          updated_at = now()
      `;
    },

    async find(tenantId): Promise<CredentialRow | null> {
      const rows = await sql`
        select ciphertext, iv, auth_tag, last_four, model_override, validated_at
        from ai_credentials
        where tenant_id = ${tenantId}
        limit 1
      `;
      if (rows.length === 0) return null;
      const row = rows[0] as CredentialDbRow;
      return {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        lastFour: row.last_four,
        modelOverride: row.model_override,
        validatedAt: row.validated_at.toISOString()
      };
    },

    async remove(tenantId) {
      await sql`delete from ai_credentials where tenant_id = ${tenantId}`;
    }
  };
}
