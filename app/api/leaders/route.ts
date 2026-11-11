import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
import { NextRequest, NextResponse } from "next/server";
import { loadRegistry } from "@/app/lib/analytics-data";

type RegistryEntity = import("@/app/lib/analytics-data").AnalyticsEntity;

type LeaderGroup = {
  iin: string;
  name: string;
  entities: RegistryEntity[];
};

async function GETHandler(request: NextRequest) {
  const scoped = handleCaseAnalytics(request, "leaders"); if (scoped) return scoped;
const registry = loadRegistry();

  const requestedIin = request.nextUrl.searchParams.get("iin")?.replace(/\D/g, "") ?? "";
  const groups = new Map<string, LeaderGroup>();

  for (const entity of registry.entities as RegistryEntity[]) {
    if (!entity.headIin || !entity.head) continue;
    const group = groups.get(entity.headIin) ?? {
      iin: entity.headIin,
      name: entity.head,
      entities: [],
    };
    group.entities.push(entity);
    groups.set(entity.headIin, group);
  }

  const leaders = [...groups.values()]
    .filter((leader) => leader.entities.length > 1)
    .map((leader) => ({
      ...leader,
      entities: leader.entities.sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name, "ru")),
    }))
    .sort((a, b) => b.entities.length - a.entities.length || a.name.localeCompare(b.name, "ru"));

  if (requestedIin) {
    const leader = leaders.find((item) => item.iin === requestedIin) ?? null;
    return NextResponse.json(
      { leader },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    { leaders, total: leaders.length },
    { headers: { "cache-control": "no-store" } },
  );
}
