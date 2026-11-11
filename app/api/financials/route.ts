import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
import { NextRequest, NextResponse } from "next/server";
import { loadFinancials } from "@/app/lib/analytics-data";

export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const scoped = handleCaseAnalytics(request, "financials"); if (scoped) return scoped;
const analytics = loadFinancials();

  const bin = (request.nextUrl.searchParams.get("bin") ?? "").replace(/\D/g, "");
  if (!/^\d{12}$/.test(bin)) {
    return NextResponse.json({ error: "Укажите БИН/ИИН из 12 цифр." }, { status: 400 });
  }

  const entities = analytics.entities as Record<string, unknown>;
  return NextResponse.json({
    entity: entities[bin] ?? null,
    generatedAt: analytics.generatedAt,
    methodology: analytics.methodology,
    audit: analytics.audit,
  }, { headers: { "Cache-Control": "no-store" } });
}
