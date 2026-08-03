import { getSql } from "../../src/infra/postgres/client";

export async function localPostgresIsReachable(): Promise<boolean> {
  try {
    await getSql()`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Inserts a throwaway tenant row so ai_credentials/ai_usage FKs are satisfiable. */
export async function createTestTenant(name: string): Promise<string> {
  const sql = getSql();
  const rows = await sql`insert into tenants (name) values (${name}) returning id`;
  return (rows[0] as { id: string }).id;
}

/** Cascades to ai_credentials and ai_usage rows via their FK constraints. */
export async function deleteTestTenant(tenantId: string): Promise<void> {
  await getSql()`delete from tenants where id = ${tenantId}`.catch(() => {});
}
