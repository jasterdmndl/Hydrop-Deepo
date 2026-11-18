/**
 * Database port used by module repositories.
 *
 * Two adapters implement it:
 * - `pg` Pool for Supabase-hosted PostgreSQL (DATABASE_URL), used in production.
 * - PGlite (PostgreSQL compiled to WebAssembly) for isolated tests and an
 *   optional local development database without credentials.
 */
export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs one or more parameterless statements (used for migrations). */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Runs `fn` inside one transaction; commits on success, rolls back on error. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PgLikeClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

function wrapPgClient(client: PgLikeClient): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      // Without parameters, node-postgres uses the simple protocol, which
      // accepts several statements in one call.
      await client.query(sql);
    },
  };
}

export async function createPgDatabase(connectionString: string, ssl: boolean): Promise<Database> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  const base = wrapPgClient(pool);
  return {
    ...base,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn(wrapPgClient(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * @param dataDir Directory for persistent data, or undefined for in-memory.
 */
export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;

  interface PgliteLike {
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(sql: string): Promise<unknown>;
  }
  const wrap = (target: PgliteLike): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await target.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await target.exec(sql);
    },
  });

  return {
    ...wrap(db),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return db.transaction(async (inner) => fn(wrap(inner)));
    },
    async close() {
      await db.close();
    },
  };
}
