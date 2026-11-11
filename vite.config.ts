import vinext from "vinext";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import {requestUser,authWriteAllowed} from "./app/lib/auth-request.mjs";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 3200,
    strictPort: true,
    proxy: {
      "/local-service": {
        target: `http://127.0.0.1:${process.env.VESTIGO_SERVICE_PORT || "4418"}`,
        rewrite: (url: string) => url.replace(/^\/local-service/, ""),
        proxyTimeout: 300000,
        headers: { "x-vestigo-internal": process.env.VESTIGO_INTERNAL_SECRET || "" },
      },
    },
    watch: {
      ignored: ["**/data/**", "**/exports/**", "**/uploads/**", "**/.venv/**", "**/vendor/**"],
    },
  },
  resolve: { alias: { "cloudflare:workers": resolve(process.cwd(), "app/lib/cloudflare-workers-local.ts") } },
  plugins: [{
    name: "vestigo-private-storage",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname: string;
        try { pathname = decodeURIComponent((request.url || "").split("?")[0]).replace(/\\/g, "/"); }
        catch { response.writeHead(400); response.end(); return; }
        if (/(^|\/)data(\/|$)/i.test(pathname)) {
          response.writeHead(403, { "cache-control": "no-store" });
          response.end("Доступ к хранилищу выполняется через API документов");
          return;
        }
        // Vite's proxy runs before framework middleware. Authenticate this
        // separate path before it can receive the internal service credential.
        if(pathname==="/local-service"||pathname.startsWith("/local-service/")){
          try{
            const headers=new Headers();for(const [key,value] of Object.entries(request.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join("; "):value);
            const authRequest=new Request(`http://${request.headers.host||"localhost:3200"}${request.url}`,{method:request.method,headers});
            const status=!authWriteAllowed(authRequest)?403:!requestUser(authRequest)?401:0;
            if(status){response.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify({error:status===401?"Войдите по логину и паролю":"Недопустимый источник запроса"}));return;}
          }catch{response.writeHead(503,{"cache-control":"no-store"});response.end("Проверка входа недоступна");return;}
        }
        next();
      });
    },
  }, vinext()],
});
