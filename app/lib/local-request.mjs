// Local installation only. This is CSRF defence, not a substitute for user authentication.
export function localWriteAllowed(request){
 const origin=request.headers.get("origin"),port=process.env.VESTIGO_SITE_PORT||"3200";
 if(request.headers.get("sec-fetch-site")==="cross-site")return false;
 return !origin||[`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`].includes(origin);
}
