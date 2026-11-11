import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
export const POST=withAuthenticatedApi(POSTHandler);
import { NextRequest, NextResponse } from "next/server";
import { createEpisode, listEpisodes, openDatabase } from "@/app/lib/vestigo-db.mjs";

import {localWriteAllowed} from "@/app/lib/local-request.mjs";

export const dynamic = "force-dynamic";

async function GETHandler(request: NextRequest) {
  const caseId = request.nextUrl.searchParams.get("caseId") ?? "";
  const db = openDatabase();
  try { return NextResponse.json({ episodes: listEpisodes(db, caseId) }); }
  finally { db.close(); }
}

async function POSTHandler(request: NextRequest) {
  if(!localWriteAllowed(request))return NextResponse.json({error:"Недопустимый источник запроса"},{status:403});
  const db = openDatabase();
  try {
    const episode = createEpisode(db, await request.json());
    return NextResponse.json({ episode }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Не удалось создать эпизод" }, { status: 400 });
  } finally { db.close(); }
}
