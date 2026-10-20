import { spawn } from 'node:child_process';
import { chromium, expect } from 'playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const executable=path.resolve(process.env.STUDIO_TEST_EXE||'release/OpenCut-Studio-0.1.0-Windows.exe');
const evidence=path.resolve('../../../../desktop-evidence/portable-'+Date.now());
await fs.mkdir(evidence,{recursive:true});
const profile=path.join(evidence,'profile');
for(const port of [38841,38842,38843]){try{await fetch(`http://127.0.0.1:${port}/`);}catch{continue;}throw new Error(`Test port ${port} is already occupied`);}
const processHandle=spawn(executable,['--remote-debugging-port=38842','--inspect=38843'],{env:{...process.env,OPENCUT_STUDIO_DATA_DIR:profile},windowsHide:true,stdio:['ignore','pipe','pipe']});
let diagnostics='';processHandle.stderr.on('data',x=>diagnostics+=x);processHandle.stdout.on('data',x=>diagnostics+=x);
let browser,inspector;
const report={executable,evidence,checks:[],status:'FAIL'};
try{
 await expect.poll(async()=>{try{return (await fetch('http://127.0.0.1:38842/json/version')).status;}catch{return 0;}},{timeout:45000}).toBe(200);
 browser=await chromium.connectOverCDP('http://127.0.0.1:38842');
 const context=browser.contexts()[0];
 const page=context.pages()[0]||await context.waitForEvent('page');
 await page.waitForURL('http://127.0.0.1:38841/**',{timeout:30000});
 await page.getByRole('button',{name:'New project',exact:true}).click();
 await page.getByRole('button',{name:'Start editing',exact:true}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toHaveText('Saved locally');
 await page.screenshot({path:path.join(evidence,'portable-editor.png')});
 report.checks.push({check:'portable self-extraction, startup, create project and local save',status:'PASS',url:page.url()});
 const targets=await (await fetch('http://127.0.0.1:38843/json/list')).json();
 inspector=new WebSocket(targets[0].webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{inspector.onopen=resolve;inspector.onerror=reject;});
 let id=0;const pending=new Map();
 inspector.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}};
 const evaluate=expression=>new Promise(resolve=>{const request=++id;pending.set(request,resolve);inspector.send(JSON.stringify({id:request,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
 const identity=await evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows().map(w=>w.webContents.getURL())');
 expect(identity.result.result.value).toEqual([page.url()]);
 const closed=page.waitForEvent('close',{timeout:30000});
 await evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].close()');
 inspector.close();inspector=undefined;
 await closed;
 await expect.poll(async()=>{try{await fetch('http://127.0.0.1:38841/');return false;}catch{return true;}},{timeout:15000}).toBe(true);
 await expect.poll(()=>processHandle.exitCode,{timeout:60000}).not.toBeNull();
 report.checks.push({check:'portable clean close',status:'PASS',exitCode:processHandle.exitCode});
 report.status='PASS';
}catch(error){report.failure=error.stack;process.exitCode=1;}
finally{inspector?.close();if(browser)await browser.close().catch(()=>{});if(processHandle.exitCode===null)processHandle.kill();await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(evidence,'diagnostics.log'),diagnostics);console.log(JSON.stringify(report,null,2));}
