import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const evidence=path.resolve(process.argv[2]||path.join(root,"qa-artifacts",`desktop-${Date.now()}`));
const fixtures=path.resolve(process.argv[3]||path.join(evidence,"fixtures"));
const profile=path.join(evidence,"profile");
await fs.mkdir(evidence,{recursive:true});
const report={started:new Date().toISOString(),evidence,fixtures,checks:[],errors:[],console:[],mediaRequests:[]};
let app,page,electronPid;
async function step(name,action){const start=Date.now();try{const detail=await action();report.checks.push({name,status:"passed",milliseconds:Date.now()-start,detail});console.log(`PASS ${name}`);}catch(error){report.checks.push({name,status:"failed",milliseconds:Date.now()-start,error:String(error.stack||error)});throw error;}}
async function freePort(){await new Promise((resolve,reject)=>{const test=net.createServer();test.once("error",reject);test.listen(38851,"127.0.0.1",()=>test.close(resolve));});}
async function launch(){
  await freePort();
  const packaged=process.env.OPENCUT_TEST_EXECUTABLE;
  app=await electron.launch({executablePath:packaged||path.join(root,"node_modules/electron/dist/electron.exe"),args:packaged?[]:[path.join(root,"apps/editor")],env:{...process.env,OPENCUT_NEXT_DATA_DIR:profile},timeout:30000});
  electronPid=await app.evaluate(()=>process.pid);
  app.process().stdout?.on("data",value=>report.console.push(value.toString()));app.process().stderr?.on("data",value=>report.console.push(value.toString()));
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on("pageerror",error=>report.errors.push(error.stack||error.message));
  page.on("request",request=>{if(request.url().startsWith("app-media:"))report.mediaRequests.push(request.url());});
  await page.waitForURL("http://127.0.0.1:38851/");
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.unmaximize();window.setSize(1600,1000);});
  await page.getByRole("button",{name:"Create a project",exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector(".app-footer")?.textContent?.includes("FFmpeg ready"));
}
async function saved(){await page.getByRole("button",{name:"Saved locally",exact:true}).waitFor();}
async function input(label,value){await page.getByLabel(label,{exact:true}).fill(String(value));await page.getByLabel(label,{exact:true}).press("Enter");}
async function seek(seconds){const ruler=page.locator(".time-ruler");await ruler.click({position:{x:seconds*72+1,y:12}});}
async function current(){return page.evaluate(async()=>{const list=await window.editorHost.listProjects();return window.editorHost.openProject(list[0].id)});}
async function close(){const closed=page.waitForEvent("close");await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;await app.close();app=undefined;page=undefined;await freePort();}
async function nativeFiles(files){await app.evaluate(({dialog},paths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:paths});},files);}
async function waitForJob(type,timeout=90000){const card=page.locator(".job-card").filter({has:page.getByText(type,{exact:true})}).first();await expect(card.locator(".job-status")).toHaveText("completed",{timeout});return card.innerText();}
try{
  await step("Fresh desktop startup and native dependency discovery",async()=>{await launch();const env=await page.evaluate(()=>window.editorHost.getEnvironment());assert(env.ffmpeg&&env.ffprobe&&env.localTranscription);assert.equal(await page.evaluate(()=>typeof window.require),"undefined");return env;});
  await step("Create original project and resize canvas",async()=>{await page.getByRole("button",{name:"Create a project",exact:true}).click();await page.getByLabel("New project name").fill("Fresh Cut • Native QA");await page.getByRole("button",{name:/^Create project/}).click();await page.getByLabel("Project name",{exact:true}).waitFor();await input("Width",640);await input("Height",360);await saved();const value=await current();assert.equal(value.project.settings.width,640);return {id:value.project.id,storageVersion:value.version};});
  await step("Native import video, audio and image with metadata",async()=>{await nativeFiles(["motion.webm","tone-and-silence.wav","mint.png","spoken.wav"].map(name=>path.join(fixtures,name)));await page.getByRole("button",{name:"Import media",exact:true}).click();await expect(page.locator(".asset-card")).toHaveCount(4,{timeout:30000});await saved();const value=await current();assert.equal(Object.keys(value.project.assets).length,4);assert(Object.values(value.project.assets).find(asset=>asset.kind==="audio")?.peaks?.length);return Object.values(value.project.assets).map(({id,name,kind,duration,width,height})=>({id,name,kind,duration,width,height}));});
  await step("Timeline layering and static transform editing",async()=>{await page.getByRole("button",{name:"Add motion.webm",exact:true}).click();await page.getByRole("button",{name:"Add tone-and-silence.wav",exact:true}).click();await page.getByRole("button",{name:"Add mint.png",exact:true}).click();await input("Scale",.25);await input("Position X",180);await input("Position Y",-90);await input("Opacity",85);await saved();await expect(page.locator(".timeline-clip")).toHaveCount(3);const value=await current();const overlay=value.project.tracks.flatMap(track=>track.clips).find(clip=>clip.kind==="image");assert.equal(overlay.transform.scale,.25);return overlay;});
  await step("Playback clock, split, undo and redo",async()=>{await page.locator(".timeline-clip.video").first().click({position:{x:30,y:25}});await page.getByRole("button",{name:"Play",exact:true}).click();await expect(page.getByRole("button",{name:"Pause",exact:true})).toBeVisible();await page.waitForFunction(()=>document.querySelector(".timecode")?.textContent?.startsWith("00:01"));await page.getByRole("button",{name:"Pause",exact:true}).click();await seek(2);await page.getByRole("button",{name:"Split clip",exact:true}).click();await expect(page.locator(".timeline-clip")).toHaveCount(4);await page.getByRole("button",{name:"Undo",exact:true}).click();await expect(page.locator(".timeline-clip")).toHaveCount(3);await page.getByRole("button",{name:"Redo",exact:true}).click();await expect(page.locator(".timeline-clip")).toHaveCount(4);await saved();});
  await step("Fresh text overlay, caption import and decoded paused preview",async()=>{await page.getByTitle("Add text title (T)").click();await page.getByLabel("Text content").fill("FRESH CODE\nYOUR STORY");await input("Size",32);await nativeFiles([path.join(fixtures,"captions.srt")]);await page.getByTitle("Captions",{exact:true}).click();await page.getByRole("button",{name:"Import SRT",exact:true}).click();await expect(page.getByLabel("Caption text",{exact:true})).toHaveCount(2);await saved();await seek(2.5);await page.getByText("Decoding frame…",{exact:true}).waitFor({state:"hidden",timeout:10000});
    await expect(page.getByLabel("Project preview")).toHaveAttribute("data-rendered-tick","600000",{timeout:10000});
    const sample=await page.getByLabel("Project preview").evaluate(canvas=>{const pixels=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data,result=[];for(let y=0;y<36;y++)for(let x=0;x<64;x++){const index=((y*10+5)*canvas.width+x*10+5)*4;result.push(pixels[index],pixels[index+1],pixels[index+2]);}return result});
    await fs.writeFile(path.join(evidence,"preview-sample.rgb"),Buffer.from(sample));await page.screenshot({path:path.join(evidence,"fresh-editor.png")});return {textClips:1,captions:2,sampledRgbBytes:sample.length};});
  await step("Native MP4 export completes",async()=>{const output=path.join(evidence,"fresh-export.mp4");await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);await page.getByRole("button",{name:"Export",exact:true}).click();await page.getByRole("button",{name:"Export MP4 · H.264",exact:true}).click();const detail=await waitForJob("Native export");assert((await fs.stat(output)).size>1000);return {output,detail};});
  await step("Export decodes moving video and nonzero audio",async()=>{const binary=process.env.OPENCUT_FFMPEG_PATH;if(!binary)throw Error("Set OPENCUT_FFMPEG_PATH for decode QA");async function decode(args){return new Promise((resolve,reject)=>{const child=spawn(binary,["-hide_banner","-loglevel","error","-i",path.join(evidence,"fresh-export.mp4"),...args],{windowsHide:true,stdio:["ignore","pipe","pipe"]});const chunks=[];let error="";child.stdout.on("data",value=>chunks.push(value));child.stderr.on("data",value=>error+=value);child.on("error",reject);child.on("close",code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(error)));});}const frames=await decode(["-vf","fps=1,scale=64:36","-an","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);assert(frames.length>=64*36*3*5);const first=frames.subarray(0,6912),third=frames.subarray(13824,20736);assert(!first.equals(third));const audio=await decode(["-vn","-ac","1","-ar","8000","-f","s16le","pipe:1"]);let energy=0;for(let i=0;i<audio.length;i+=2)energy+=audio.readInt16LE(i)**2;assert(energy>1e6);return {decodedFrames:frames.length/6912,pcmBytes:audio.length,rms:Math.sqrt(energy/(audio.length/2))};});
  await step("Native close flushes, relaunch reopens exact saved project",async()=>{await saved();const before=await current();await close();await launch();await page.getByTitle("Projects",{exact:true}).click();await page.getByRole("button",{name:/Fresh Cut • Native QA/}).click();await page.getByLabel("Project name",{exact:true}).waitFor();await expect(page.locator(".timeline-clip")).toHaveCount(5);await expect(page.getByRole("button",{name:"Undo",exact:true})).toBeDisabled();const after=await current();assert.deepEqual(after.project,before.project);return {projectId:after.project.id,storageVersion:after.version};});
  await step("Offline model performs real caption generation",async()=>{await page.getByTitle("Media",{exact:true}).click();await page.locator(".asset-card").filter({has:page.getByText("spoken.wav",{exact:true})}).click();await page.getByTitle("Captions",{exact:true}).click();await page.getByRole("button",{name:"Transcribe selection",exact:true}).click();const detail=await waitForJob("Offline transcription",120000);await saved();const value=await current();const text=value.project.captions.map(caption=>caption.text).join(" ");assert(/fresh|modern|video|editor|local/i.test(text));await fs.writeFile(path.join(evidence,"transcript.txt"),text);return {detail,text,captionCount:value.project.captions.length};});
  await step("Completed proxy is persisted and consumed by the preview",async()=>{
    await page.locator(".jobs-drawer .panel-heading button").click();await page.getByTitle("Media",{exact:true}).click();
    await page.locator(".asset-card").filter({has:page.getByText("motion.webm",{exact:true})}).click();await page.getByTitle("Tools",{exact:true}).click();
    await page.getByRole("button",{name:"Create native proxy",exact:true}).click();await waitForJob("Create proxy");await page.locator(".jobs-drawer .panel-heading button").click();await saved();
    const value=await current(),asset=Object.values(value.project.assets).find(asset=>asset.name==="motion.webm");assert(asset.proxyUrl?.endsWith("/proxy"));
    await seek(.5);await page.getByTitle("Media",{exact:true}).click();await expect(page.getByText("PROXY ACTIVE",{exact:true}).first()).toBeVisible();
    await expect.poll(()=>report.mediaRequests.includes(asset.proxyUrl)).toBe(true);return {proxyUrl:asset.proxyUrl};
  });
  await step("Real SQLite write failure keeps window open and retry preserves changes",async()=>{
    let db=new DatabaseSync(path.join(profile,"state.sqlite"));db.exec("CREATE TRIGGER qa_fail_save BEFORE UPDATE ON projects BEGIN SELECT RAISE(FAIL,'QA simulated storage write failure'); END;");db.close();
    try{
      await page.getByLabel("Project name",{exact:true}).fill("Write failure retained edit");await page.getByLabel("Project name",{exact:true}).press("Enter");
      await expect(page.getByRole("alert")).toContainText("QA simulated storage write failure");
      await app.evaluate(({dialog})=>{globalThis.qaExitChoices=[];dialog.showMessageBox=async(_window,options)=>{globalThis.qaExitChoices.push(options.message);return {response:0,checkboxChecked:false}};});
      await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].close();});
      await expect.poll(()=>app.evaluate(()=>globalThis.qaExitChoices.length)).toBe(1);assert(!page.isClosed());
      await expect(page.getByLabel("Project name",{exact:true})).toHaveValue("Write failure retained edit");
    }finally{db=new DatabaseSync(path.join(profile,"state.sqlite"));db.exec("DROP TRIGGER qa_fail_save");db.close();}
    await page.getByRole("button",{name:/Save failed · retry/}).click();await saved();const value=await current();assert.equal(value.project.name,"Write failure retained edit");return {storageVersion:value.version,retained:value.project.name};
  });
  await step("CAS conflict can save a fresh copy while preserving external revision",async()=>{
    const original=await current();
    await page.evaluate(async(value)=>{const project={...value.project,name:"External revision preserved"};await window.editorHost.saveProject({project,expectedVersion:value.version})},original);
    await page.getByLabel("Project name",{exact:true}).fill("Conflicting local edit");await page.getByLabel("Project name",{exact:true}).press("Enter");
    await expect(page.getByRole("alert")).toContainText("STORAGE_CONFLICT");await page.getByRole("button",{name:"Save a copy",exact:true}).click();await saved();
    const list=await page.evaluate(()=>window.editorHost.listProjects());const copy=list.find(item=>item.id!==original.project.id);assert(copy);
    const originalAfter=await page.evaluate(id=>window.editorHost.openProject(id),original.project.id);assert.equal(originalAfter.project.name,"External revision preserved");
    const duplicate=await page.evaluate(id=>window.editorHost.openProject(id),copy.id);assert(duplicate.project.name.includes("Conflicting local edit"));assert.equal(duplicate.project.tracks.flatMap(track=>track.clips).length,5);
    return {original:originalAfter.project.id,originalName:originalAfter.project.name,copy:duplicate.project.id,copyName:duplicate.project.name};
  });
  await step("All app instances close and the application port is released",close);
  assert.deepEqual(report.errors,[]);report.status="passed";
}catch(error){report.status="failed";report.failure=String(error.stack||error);try{await page?.screenshot({path:path.join(evidence,"failure.png")});}catch{}console.error(error);process.exitCode=1;}
finally{if(app){
  // Windows Playwright may wrap Electron in cmd.exe; terminate the exact main
  // PID obtained from this disposable app, then its transport wrapper.
  try{process.kill(electronPid);}catch{}try{app.process().kill();}catch{}
  await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);
}report.finished=new Date().toISOString();await fs.writeFile(path.join(evidence,"desktop-verification.json"),JSON.stringify(report,null,2));console.log(`Evidence ${evidence}`);process.exit(process.exitCode||0);}
