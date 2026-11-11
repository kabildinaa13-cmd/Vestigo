import { env } from "../app/lib/cloudflare-workers-local";

export async function ensurePlatformSchema() {
  const database = env.DB;
  if (!database) throw new Error("Хранилище платформы недоступно");

  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT 'Карагандинская область',
        categories_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Ожидает анализа',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    database.prepare(
      "CREATE INDEX IF NOT EXISTS sources_created_at_idx ON sources (created_at)",
    ),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        object_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Ожидает настройки шаблона',
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    database.prepare(
      "CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads (created_at)",
    ),
  ]);

  return database;
}
