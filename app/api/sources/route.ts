import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import { ensurePlatformSchema } from "../../../db/runtime";

async function GETHandler() {
  try {
    const database = await ensurePlatformSchema();
    const result = await database
      .prepare(
        "SELECT id, name, url, region, categories_count AS categoriesCount, status FROM sources ORDER BY created_at DESC LIMIT 100",
      )
      .all();
    return Response.json({ sources: result.results });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Не удалось прочитать источники" },
      { status: 500 },
    );
  }
}

async function POSTHandler(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: string;
      name?: string;
      url?: string;
      region?: string;
      categoriesCount?: number;
      status?: string;
    };
    const name = payload.name?.trim() ?? "";
    const url = payload.url?.trim() ?? "";
    if (!name || !url) {
      return Response.json({ error: "Название и ссылка обязательны" }, { status: 400 });
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:") {
      return Response.json({ error: "Разрешены только HTTPS-источники" }, { status: 400 });
    }

    const database = await ensurePlatformSchema();
    const normalizedUrl = parsedUrl.toString();
    const existing = await database
      .prepare(
        "SELECT id, name, url, region, categories_count AS categoriesCount, status FROM sources WHERE url = ? LIMIT 1",
      )
      .bind(normalizedUrl)
      .first();
    if (existing) return Response.json({ source: existing, existing: true });

    const source = {
      id: payload.id ?? crypto.randomUUID(),
      name,
      url: normalizedUrl,
      region: payload.region?.trim() || "Карагандинская область",
      categoriesCount: Number.isFinite(payload.categoriesCount) ? Number(payload.categoriesCount) : 0,
      status: payload.status?.trim() || "Ожидает анализа",
    };
    await database
      .prepare(
        "INSERT INTO sources (id, name, url, region, categories_count, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        source.id,
        source.name,
        source.url,
        source.region,
        source.categoriesCount,
        source.status,
        "local-user",
      )
      .run();
    return Response.json({ source }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Не удалось добавить источник" },
      { status: 500 },
    );
  }
}
