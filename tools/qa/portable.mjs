import {chromium,expect} from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import {spawn} from "node:child_process";
const executable=path.resolve(process.argv[2]),evidence=path.resolve(process.argv[3]);
const profile=path.join(evidence,"profile"),debugPort=38911,inspectorPort=38912;
await fs.mkdir(evidence,{recursive:true});
const report={started:new Date().toISOString(),executable,checks:[],errors:[]};let child,browser,page,mainPid;
async function free(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once("error",reject);server.listen(port,"127.0.0.1",()=>server.close(resolve));});}
async function endpoint(port,route){const limit=Date.now()+30000;while(Date.now()<limit){try{const response=await fetch(`http://127.0.0.1:${port}${route}`,{signal:AbortSignal.timeout(1000)});if(response.ok)return response.json();}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`Disposable debug endpoint ${port} did not start`);}
async function inspect(expression){
  const targets=await endpoint(inspectorPort,"/json/list");const target=targets.find(target=>target.webSocketDebuggerUrl);assert(target);
  const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Inspector evaluation timed out")),10000);socket.addEventListener("message",event=>{const message=JSON.parse(String(event.data));if(message.id!==1)return;clearTimeout(timer);if(message.error||message.result?.exceptionDetails)reject(Error(JSON.stringify(message)));else resolve(message.result.result?.value);});socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));});}finally{socket.close();}
}
async function step(name,action){const started=Date.now();try{const detail=await action();report.checks.push({name,status:"passed",milliseconds:Date.now()-started,detail});console.log(`PASS ${name}`);}catch(error){report.checks.push({name,status:"failed",error:String(error.stack||error)});throw error;}}
async function input(label,value){await page.getByLabel(label,{exact:true}).fill(String(value));await page.getByLabel(label,{exact:true}).press("Enter");}
async function seek(seconds){await page.locator(".time-ruler").click({position:{x:seconds*72+1,y:12}});}
try{
  await step("Portable wrapper starts its own model-equipped native editor",async()=>{
    await Promise.all([38851,debugPort,inspectorPort].map(free));
    child=spawn(executable,[`--remote-debugging-port=${debugPort}`,`--inspect=${inspectorPort}`],{env:{...process.env,OPENCUT_NEXT_DATA_DIR:profile},windowsHide:true,stdio:["ignore","pipe","pipe"]});
    child.on("error",error=>report.errors.push(error.message));
    await endpoint(debugPort,"/json/version");browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context=browser.contexts()[0];page=context.pages()[0]||await context.waitForEvent("page");await page.waitForURL("http://127.0.0.1:38851/",{timeout:30000});page.on("pageerror",error=>report.errors.push(error.message));
    mainPid=await inspect("process.pid");await page.getByRole("button",{name:"Create a project",exact:true}).waitFor();
    const environment=await page.evaluate(()=>window.editorHost.getEnvironment());assert(environment.ffmpeg&&environment.ffprobe&&environment.localTranscription);return {mainPid,environment};
  });
  await step("Portable UI authors and exports position, scale, rotation and opacity animation",async()=>{
    await page.getByRole("button",{name:"Create a project",exact:true}).click();await page.getByLabel("New project name").fill("Portable fresh animation");await page.getByRole("button",{name:/^Create project/}).click();await page.getByLabel("Project name",{exact:true}).waitFor();await input("Width",640);await input("Height",360);
    await page.getByTitle("Add text title (T)").click();await page.getByLabel("Text content").fill("FRESH\nOPENCUT NEXT");await input("Size",42);await input("Duration",2);
    await input("Position X",-100);await input("Scale",.6);await input("Rotation",-15);await input("Opacity",50);
    for(const property of ["Position X","Scale","Rotation","Opacity"])await page.getByRole("button",{name:`Add ${property} keyframe`,exact:true}).click();
    await seek(1.5);await input("Position X",100);await input("Scale",1.1);await input("Rotation",30);await input("Opacity",100);
    await page.getByRole("button",{name:"Saved locally",exact:true}).waitFor();
    const project=await page.evaluate(async()=>{const list=await window.editorHost.listProjects();return window.editorHost.openProject(list[0].id)});const keys=project.project.tracks.flatMap(track=>track.clips).flatMap(clip=>clip.keyframes);assert.equal(keys.length,8);
    const output=path.join(evidence,"portable-animation.mp4");await inspect(`process.mainModule.require('electron').dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(output)}});true`);
    await page.getByRole("button",{name:"Export",exact:true}).click();await page.getByRole("button",{name:"Export MP4 · H.264",exact:true}).click();await expect(page.locator(".job-card .job-status").first()).toHaveText("completed",{timeout:120000});assert((await fs.stat(output)).size>1000);
    await page.locator(".jobs-drawer .panel-heading button").click();await seek(1);await expect(page.getByLabel("Project preview")).toHaveAttribute("data-rendered-tick","240000");await page.screenshot({path:path.join(evidence,"portable-animation.png")});return {keys:keys.length,output,bytes:(await fs.stat(output)).size};
  });
  await step("Portable native close acknowledges saved project and launcher exits cleanly",async()=>{
    await page.getByRole("button",{name:"Saved locally",exact:true}).waitFor();const closed=page.waitForEvent("close");
    const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Portable wrapper did not exit")),30000);child.once("exit",(code)=>{clearTimeout(timer);resolve(code)});});
    await inspect("setTimeout(()=>process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(),100);true");await closed;await browser.close();browser=undefined;const code=await exited;assert.equal(code,0);await free(38851);return {exitCode:code};
  });
  assert.deepEqual(report.errors,[]);report.status="passed";
}catch(error){report.status="failed";report.failure=String(error.stack||error);try{await page?.screenshot({path:path.join(evidence,"failure.png")});}catch{}console.error(error);process.exitCode=1;}
finally{if(browser){try{if(mainPid)process.kill(mainPid)}catch{}await browser.close().catch(()=>{})}if(child?.exitCode===null)child.kill();report.finished=new Date().toISOString();await fs.writeFile(path.join(evidence,"portable-verification.json"),JSON.stringify(report,null,2));console.log(`Evidence ${evidence}`);process.exit(process.exitCode||0);}
