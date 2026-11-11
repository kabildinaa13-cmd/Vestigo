// Local presentation mode uses scripts/excel-export-server.mjs for persistent
// uploads. This shim keeps the optional Cloudflare upload route importable when
// Miniflare is deliberately disabled to coexist with other local platforms.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Local-only persistence for source metadata. No cloud connection is made.
const dataDirectory = resolve(process.env.VESTIGO_ANALYTICS_ROOT || process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });
const db = new DatabaseSync(resolve(dataDirectory, "vestigo-platform.sqlite"));
db.exec("PRAGMA busy_timeout = 5000");
function prepare(sql: string, values: any[] = []): any {
  return {
    bind: (...args: any[]) => prepare(sql, args),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    first: async () => db.prepare(sql).get(...values) ?? null,
    run: () => { db.prepare(sql).run(...values); return { success: true }; },
  };
}
export const env: Record<string, any> = {
  DB: {
    prepare,
    batch: async (statements: any[]) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  },
};
