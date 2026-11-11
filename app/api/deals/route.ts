import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
import { NextRequest, NextResponse } from "next/server";
import { loadDeals } from "@/app/lib/analytics-data";

type Deal = ReturnType<typeof loadDeals>["deals"][number];

async function GETHandler(request: NextRequest) {
  const scoped = handleCaseAnalytics(request, "deals"); if (scoped) return scoped;
const data = loadDeals();

  const bin = request.nextUrl.searchParams.get("bin")?.replace(/\D/g, "") ?? "";
  if (!/^\d{12}$/.test(bin)) {
    return NextResponse.json({ deals: [], stats: { count: 0, total: 0, counterparties: 0 } });
  }
  const deals = (data.deals as Deal[]).filter((deal) => deal.supplier.bin === bin || deal.buyer.bin === bin);
  const counterparties = new Set(deals.map((deal) => deal.supplier.bin === bin ? deal.buyer.bin : deal.supplier.bin));
  return NextResponse.json(
    { deals, stats: { count: deals.length, total: deals.reduce((sum, deal) => sum + deal.amount, 0), counterparties: counterparties.size }, source: data.source },
    { headers: { "cache-control": "no-store" } },
  );
}
