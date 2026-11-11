import {AsyncLocalStorage} from "node:async_hooks";
// Shared by request handlers and persistence modules; never supplied by a client header.
const identity=new AsyncLocalStorage();
export const currentUserId=()=>identity.getStore()?.id;
export const runAsUser=(user,work)=>identity.run(user,work);
