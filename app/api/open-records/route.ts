import {withAuthenticatedApi} from "@/app/lib/auth-request.mjs";
export const GET=withAuthenticatedApi(GETHandler);
import { NextRequest, NextResponse } from "next/server";

const RSP_URL = "https://rsp.gov.kz/ru/rsp/search?q=";
const DFO_URL = "https://opi.dfo.kz/ru/opi/list?flBlock=Active_%D0%A1%D0%B2%D0%BE%D0%B1%D0%BE%D0%B4%D0%BD%D0%BE&flBin=";

function decodeHtml(value: string) {
  const text = value
    // РСП добавляет случайные цифры в скрытые span-элементы как защиту
    // отображения номера. Они не являются частью БИН/ИИН.
    .replace(/<span\s+class="l\d+">[\s\S]*?<\/span>/gi, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Some public registry pages return UTF-8 text with an incorrect declared
  // charset. Repair only the characteristic mojibake sequence.
  if (!/[ÐÑ]/.test(text)) return text;
  try {
    return new TextDecoder("utf-8").decode(Uint8Array.from(text, (char) => char.charCodeAt(0)));
  } catch {
    return text;
  }
}

function tableRows(html: string) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decodeHtml(cell[1])),
  ).filter((cells) => cells.length > 1);
}

async function readUtf8(response: Response) {
  return new TextDecoder("utf-8").decode(await response.arrayBuffer());
}

async function lookupRsp(bin: string) {
  try {
    const response = await fetch(`${RSP_URL}${encodeURIComponent(bin)}`, {
      headers: { accept: "text/html", "user-agent": "Vestigo local analytics/1.0" },
      cache: "no-store",
    });
    if (!response.ok) return { status: "unavailable" as const };
    const row = tableRows(await readUtf8(response)).find((cells) => cells.join("").replace(/\D/g, "").includes(bin));
    if (!row || row.length < 6) return { status: "not-found" as const };
    return { status: "found" as const, name: row[2], activity: row[3], employees: row[4], businessCategory: row[5] };
  } catch {
    return { status: "unavailable" as const };
  }
}

async function lookupDfo(bin: string) {
  try {
    const response = await fetch(`${DFO_URL}${encodeURIComponent(bin)}`, {
      headers: { accept: "text/html", "user-agent": "Vestigo local analytics/1.0" },
      cache: "no-store",
    });
    if (!response.ok) return { status: "unavailable" as const };
    const row = tableRows(await readUtf8(response)).find((cells) => cells.join("").replace(/\D/g, "").includes(bin));
    if (!row) return { status: "not-found" as const };
    return { status: "found" as const, summary: row.slice(0, 5).join(" · ") };
  } catch {
    return { status: "unavailable" as const };
  }
}

async function GETHandler(request: NextRequest) {
  const bin = (request.nextUrl.searchParams.get("bin") ?? "").replace(/\D/g, "");
  if (bin.length !== 12) {
    return NextResponse.json({ error: "Укажите БИН/ИИН из 12 цифр." }, { status: 400 });
  }
  const [rsp, dfo] = await Promise.all([lookupRsp(bin), lookupDfo(bin)]);
  return NextResponse.json({ bin, checkedAt: new Date().toISOString(), rsp, dfo }, { headers: { "cache-control": "no-store" } });
}
