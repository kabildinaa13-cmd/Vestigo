import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { NextResponse } from "next/server";
import { getDashboard, openDatabase } from "@/app/lib/vestigo-db.mjs";

export const dynamic = "force-dynamic";

async function GETHandler() {
  const db = openDatabase();
  try {
    return NextResponse.json(getDashboard(db), { headers: { "cache-control": "no-store" } });
  } finally {
    db.close();
  }
}
