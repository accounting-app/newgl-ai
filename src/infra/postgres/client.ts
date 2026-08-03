import { SQL } from "bun";

let client: SQL | null = null;

export function getSql(): SQL {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set — required for the ai_* tables.");
    }
    client = new SQL(url);
  }
  return client;
}
