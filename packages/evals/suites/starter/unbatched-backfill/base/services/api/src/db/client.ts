import { Pool, type PoolClient } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

/** Run `fn` inside one transaction on a dedicated connection. */
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
