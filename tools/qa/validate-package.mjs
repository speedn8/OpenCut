import * as asar from "@electron/asar";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.."),app=path.join(root,"apps/editor"),resources=path.join(app,"release/win-unpacked/resources"),archive=path.join(resources,"app.asar");
const digest=buffer=>createHash("sha256").update(buffer).digest("hex");
const extract=file=>asar.extractFile(archive,file.split("/").join(path.sep));
const paths=asar.listPackage(archive).map(file=>file.replaceAll("\\","/").replace(/^\//,""));
const report={archive,archiveSha256:digest(await fs.readFile(archive)),matched:[],rejected:[],dependencyLicenses:[],model:{}};
for(const file of paths){
  if(/(^|\/)(tests|profile|browser-session)(\/|$)|\.sqlite(?:-|$)|\.env(?:\.|$)|\.map$/u.test(file))report.rejected.push(file);
  if(file.startsWith("dist/")||file.startsWith("electron/")&&file.endsWith(".cjs")){
    try{const source=await fs.readFile(path.join(app,file)),bundled=extract(file);if(digest(source)!==digest(bundled))throw Error(`Packaged mismatch: ${file}`);report.matched.push({path:file,sha256:digest(source)});}catch(error){if(error.code!=="EISDIR")throw error;}
  }
}
for(const file of ["node_modules/react/LICENSE","node_modules/react-dom/LICENSE","node_modules/scheduler/LICENSE"]){const body=extract(file);if(body.length<100)throw Error(`Missing dependency license ${file}`);report.dependencyLicenses.push(file);}
const model=JSON.parse(await fs.readFile(path.join(root,"specs/modern-editor/MODEL-PROVENANCE.json"),"utf8"));
const modelPath=path.join(resources,"models",model.filename),modelBody=await fs.readFile(modelPath);if(digest(modelBody)!==model.sha256||modelBody.length!==model.bytes)throw Error("Packaged model identity differs");
await fs.access(path.join(resources,"models/Whisper-MIT.txt"));await fs.access(path.join(app,"release/win-unpacked/LICENSE.electron.txt"));await fs.access(path.join(app,"release/win-unpacked/LICENSES.chromium.html"));
report.model={name:model.filename,bytes:modelBody.length,sha256:digest(modelBody),license:"MIT"};
if(report.rejected.length)throw Error(`Excluded artifacts found: ${report.rejected.join(",")}`);
report.status="passed";const output=path.resolve(process.argv[2]||path.join(root,"qa-artifacts/package-validation.json"));await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,matchedFiles:report.matched.length,excludedFound:report.rejected.length,model:report.model,output}));
