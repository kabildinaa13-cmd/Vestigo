import {NextRequest,NextResponse} from "next/server";
import {requestUser} from "./app/lib/auth-request.mjs";
export function proxy(request:NextRequest){
 const pathname=request.nextUrl.pathname;
 if(pathname==="/login"||pathname.startsWith("/api/auth/")||pathname.startsWith("/_next/")||pathname==="/favicon.ico")return NextResponse.next();
 if(!requestUser(request)){
  if(pathname.startsWith("/api/")||pathname.startsWith("/local-service/"))return NextResponse.json({error:"Войдите по логину и паролю"},{status:401,headers:{"cache-control":"no-store"}});
  const url=new URL("/login",request.url);url.searchParams.set("next",pathname+request.nextUrl.search);return NextResponse.redirect(url,303);
 }
 const response=NextResponse.next();response.headers.set("cache-control","no-store");response.headers.set("vary","Cookie");return response;
}
export const config={matcher:["/((?!_next/static|_next/image|favicon.ico).*)"]};
