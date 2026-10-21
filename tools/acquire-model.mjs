import fs from "node:fs/promises";
import {createWriteStream,createReadStream} from "node:fs";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import {Readable} from "node:stream";
import {createHash,randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const provenance=JSON.parse(await fs.readFile(path.join(root,"specs/modern-editor/MODEL-PROVENANCE.json"),"utf8"));
const directory=path.join(root,"apps/editor/resources/models");await fs.mkdir(directory,{recursive:true});
const target=path.join(directory,provenance.filename),temporary=path.join(directory,`${randomUUID()}.partial`);
async function digest(file){const hash=createHash("sha256");for await(const value of createReadStream(file))hash.update(value);return hash.digest("hex");}
if(await fs.stat(target).catch(()=>null)){
  if(await digest(target)!==provenance.sha256)throw Error("Existing model has a different identity. Move it aside explicitly before acquiring the pinned model.");
  console.log("Pinned model already verified.");
}else{
  try{
    const response=await fetch(provenance.download,{signal:AbortSignal.timeout(180000)});
    if(!response.ok||!response.body)throw Error(`Model download failed: ${response.status}`);
    let bytes=0;const limit=provenance.bytes;
    const body=Readable.from((async function*(){for await(const chunk of response.body){bytes+=chunk.length;if(bytes>limit)throw Error("Model exceeds its pinned byte count");yield chunk;}})());
    await pipeline(body,createWriteStream(temporary,{flags:"wx"}));
    if(bytes!==limit||await digest(temporary)!==provenance.sha256)throw Error("Downloaded model failed its pinned identity check");
    await fs.rename(temporary,target);console.log(`Verified ${provenance.filename}: ${provenance.sha256}`);
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
await fs.copyFile(path.join(root,"specs/modern-editor/licenses/Whisper-MIT.txt"),path.join(directory,"Whisper-MIT.txt"));
await fs.copyFile(path.join(root,"specs/modern-editor/MODEL-PROVENANCE.json"),path.join(directory,"MODEL-PROVENANCE.json"));
