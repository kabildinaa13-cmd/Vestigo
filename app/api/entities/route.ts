import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { handleCaseAnalytics } from "@/app/lib/case-analytics.mjs";
// Read the live database rather than silently substituting a bundled snapshot.
async function GETHandler(request: Request) {
  const scoped = handleCaseAnalytics(request, "entities"); if (scoped) return scoped;
  const url = new URL(request.url);
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.VESTIGO_SERVICE_PORT || "4418"}/entities${url.search}`,
      { cache: "no-store", signal: AbortSignal.timeout(15000), headers: { "x-vestigo-internal": process.env.VESTIGO_INTERNAL_SECRET || "" } });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Локальный сервис базы не отвечает. Перезапустите Vestigo." }, { status: 503 });
  }
}
