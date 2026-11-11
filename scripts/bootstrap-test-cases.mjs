import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

// Only a fresh default installation receives the explicitly published test set.
// Existing databases and explicitly selected data directories are never changed.
export function bootstrapTestCases(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")){
  if(process.env.VESTIGO_DATA_DIR)return;
  const data=path.join(root,"data"),source=path.join(root,"examples","test-cases");
  const database=path.join(data,"vestigo.sqlite");
  if(fs.existsSync(database)||!fs.existsSync(path.join(source,"vestigo.sqlite")))return;
  fs.mkdirSync(path.join(data,"uploads"),{recursive:true});
  for(const file of fs.readdirSync(path.join(source,"uploads"))){
    if(!/^[0-9a-f-]{36}\.original$/i.test(file))throw new Error("Unexpected test document filename");
    const target=path.join(data,"uploads",file);
    if(!fs.existsSync(target))fs.copyFileSync(path.join(source,"uploads",file),target,fs.constants.COPYFILE_EXCL);
  }
  fs.copyFileSync(path.join(source,"vestigo.sqlite"),database,fs.constants.COPYFILE_EXCL);
  console.log("Vestigo: installed bundled test cases 777 and TEST-C1.");
}
