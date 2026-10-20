import { _electron as electron, expect } from 'playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const evidence=path.resolve(root,'../../../../desktop-evidence/workflow-'+Date.now());
await fs.mkdir(evidence,{recursive:true});
const profile=path.join(evidence,'profile');
const report={started:new Date().toISOString(),evidence,checks:[],errors:[],remoteRequests:[]};
const record=(check,details)=>{report.checks.push({check,status:'PASS',details});console.log(check,JSON.stringify(details??''));};
let app,page;
async function launch(){
 try { const busy=await fetch('http://127.0.0.1:38841/');await busy.arrayBuffer();throw new Error('The Studio test port is already occupied'); } catch(error){if(error.message==='The Studio test port is already occupied')throw error;}
 app=await electron.launch({executablePath:process.env.STUDIO_TEST_EXE||path.join(root,'node_modules/electron/dist/electron.exe'),args:process.env.STUDIO_TEST_EXE?[]:[root],env:{...process.env,OPENCUT_STUDIO_DATA_DIR:profile},timeout:30000});
 page=await app.firstWindow();
 page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith('http://127.0.0.1:38841/'))report.remoteRequests.push(r.url());});
 await app.evaluate(({BrowserWindow,session},out)=>{
   const w=BrowserWindow.getAllWindows()[0];w.unmaximize();w.setBounds({x:60,y:60,width:1440,height:960});
   globalThis.studioTestDownloads=[];
   session.defaultSession.on('will-download',(_e,item)=>{
     item.setSavePath(out);
     item.once('done',(_event,state)=>globalThis.studioTestDownloads.push({state,bytes:item.getReceivedBytes(),file:item.getSavePath()}));
   });
 },path.join(evidence,'workflow-export.mp4'));
 await page.waitForLoadState('networkidle');
 const isolation=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});
 expect(isolation).toEqual({sandbox:true,contextIsolation:true,nodeIntegration:false});
 expect(await page.evaluate(()=>typeof window.require)).toBe('undefined');
}
async function close(){
 const proc=app.process();
 const exited=new Promise(resolve=>proc.once('exit',resolve));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 let timeout;
 try{await Promise.race([exited,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Save/close timed out')),15000)})]);}finally{clearTimeout(timeout);}
 app=undefined;
}
try {
 await launch();
 await page.getByRole('button',{name:'New project',exact:true}).click();
 await page.getByRole('button',{name:'Start editing',exact:true}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toBeVisible();
 const projectUrl=page.url();
 record('create project',{projectUrl});
 const files=await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');
   const draw=n=>{ctx.fillStyle='#122331';ctx.fillRect(0,0,320,180);ctx.fillStyle='#35d4b6';ctx.fillRect(15+n%220,50,65,65);ctx.fillStyle='white';ctx.font='18px Arial';ctx.fillText('LOCAL STUDIO / '+n,15,28);};
   draw(0);const png=canvas.toDataURL('image/png').split(',')[1];
   const stream=canvas.captureStream(24);const chunks=[];
   const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:500000});
   const completed=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=resolve;});
   recorder.start();for(let n=0;n<48;n++){draw(n*4);await new Promise(r=>setTimeout(r,1000/24));}recorder.stop();await completed;stream.getTracks().forEach(t=>t.stop());
   const b64=blob=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});
   return {png,webm:await b64(new Blob(chunks,{type:recorder.mimeType}))};
 });
 await fs.writeFile(path.join(evidence,'motion.webm'),Buffer.from(files.webm,'base64'));
 await fs.writeFile(path.join(evidence,'title.png'),Buffer.from(files.png,'base64'));
 const samples=96000,rate=48000,wav=Buffer.alloc(44+samples*2);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(7000*Math.sin(i*2*Math.PI*440/rate)),44+i*2);
 await fs.writeFile(path.join(evidence,'tone.wav'),wav);
 await page.locator('input[type=file]').setInputFiles(['motion.webm','tone.wav','title.png'].map(n=>path.join(evidence,n)));
 for(const name of ['motion.webm','tone.wav','title.png'])await expect(page.getByRole('button',{name:`Add ${name} to timeline`,exact:true})).toBeAttached({timeout:30000});
 record('import video audio image');
 await page.getByRole('button',{name:'Add motion.webm to timeline',exact:true}).click({force:true});
 await page.getByRole('button',{name:'Add tone.wav to timeline',exact:true}).click({force:true});
 await expect(page.locator('[data-timeline-element]')).toHaveCount(2);
 const clip=page.locator('[data-timeline-element][aria-label="motion.webm clip"]');
 await clip.locator('button').first().click();
 await page.getByRole('button',{name:'Play preview',exact:true}).click();
 await page.waitForTimeout(750);
 await page.getByRole('button',{name:'Pause playback',exact:true}).click();
 await page.screenshot({path:path.join(evidence,'03-preview.png')});
 record('preview playback');
 await page.getByRole('button',{name:'Split element',exact:true}).click();
 await expect(page.locator('[data-timeline-element]')).toHaveCount(3);
 await page.keyboard.press('Control+z');
 await expect(page.locator('[data-timeline-element]')).toHaveCount(2);
 await page.keyboard.press('Control+Shift+z');
 await expect(page.locator('[data-timeline-element]')).toHaveCount(3);
 record('split undo redo');
 await page.getByRole('button',{name:'Save project'}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toHaveText('Saved locally');
 await close();
 await launch();
 await page.goto(projectUrl);
 await expect(page.locator('[data-timeline-element]')).toHaveCount(3,{timeout:30000});
 for(const name of ['motion.webm','tone.wav','title.png'])await expect(page.getByRole('button',{name:`Add ${name} to timeline`,exact:true})).toBeAttached();
 record('save close relaunch reopen',{clips:3,assets:3});
 await page.screenshot({path:path.join(evidence,'04-reopened.png')});
 await page.getByRole('button',{name:'Export',exact:true}).click();
 await page.getByRole('button',{name:'Export',exact:true}).last().click();
 await expect.poll(()=>app.evaluate(()=>globalThis.studioTestDownloads[0]?.state),{timeout:90000}).toBe('completed');
 const out=await fs.stat(path.join(evidence,'workflow-export.mp4'));
 if(out.size<2000)throw new Error('Export is unexpectedly small');
 const exported=await fs.readFile(path.join(evidence,'workflow-export.mp4'));
 const decoded=await page.evaluate(async(bytes)=>{
   const data=Uint8Array.from(bytes),blob=new Blob([data],{type:'video/mp4'}),url=URL.createObjectURL(blob);
   const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=url;
   await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Exported video failed to load'));});
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');
   const frames=[];
   for(const t of [0.3,1.3]){
     video.currentTime=t;await new Promise(resolve=>video.onseeked=resolve);ctx.drawImage(video,0,0,320,180);
     const pixels=ctx.getImageData(0,0,320,180).data;let energy=0,checksum=0;for(let i=0;i<pixels.length;i+=4){energy+=pixels[i]+pixels[i+1]+pixels[i+2];checksum=(checksum+pixels[i]*(i+1)+pixels[i+1])%1000000007;}frames.push({time:t,energy,checksum});
   }
   const audioContext=new AudioContext();const audio=await audioContext.decodeAudioData(data.buffer.slice(0));
   let sum=0;const channel=audio.getChannelData(0);for(const x of channel)sum+=x*x;
   const result={duration:video.duration,width:video.videoWidth,height:video.videoHeight,frames,audio:{duration:audio.duration,channels:audio.numberOfChannels,sampleRate:audio.sampleRate,rms:Math.sqrt(sum/channel.length)}};
   await audioContext.close();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);return result;
 },[...exported]);
 expect(decoded.duration).toBeGreaterThan(1.8);expect(decoded.duration).toBeLessThan(2.4);expect(decoded.width).toBe(320);expect(decoded.height).toBe(180);
 expect(decoded.frames.every(f=>f.energy>1000000)).toBe(true);expect(decoded.frames[0].checksum).not.toBe(decoded.frames[1].checksum);expect(decoded.audio.rms).toBeGreaterThan(0.05);
 record('MP4 video and audio export',{bytes:out.size,decoded});
 await page.screenshot({path:path.join(evidence,'05-exported.png')});
 await page.evaluate(()=>{globalThis.studioOriginalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('Generated quota-failure fixture','QuotaExceededError');};});
 await page.getByRole('button',{name:'Add title.png to timeline',exact:true}).click({force:true});
 await expect(page.locator('[data-timeline-element]')).toHaveCount(4);
 await page.getByRole('button',{name:'Save project'}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toHaveText('Save failed — retry');
 await app.evaluate(({dialog})=>{globalThis.studioCloseDialogs=[];dialog.showMessageBox=async(_window,options)=>{globalThis.studioCloseDialogs.push({message:options.message,buttons:options.buttons});return {response:0,checkboxChecked:false};};});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 await expect.poll(()=>app.evaluate(()=>globalThis.studioCloseDialogs.length)).toBe(1);
 expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(1);
 await page.screenshot({path:path.join(evidence,'06-save-failure-keeps-editor.png')});
 record('failed save blocks close and keeps editing');
 await page.evaluate(()=>{IDBObjectStore.prototype.put=globalThis.studioOriginalPut;delete globalThis.studioOriginalPut;});
 await page.getByRole('button',{name:'Save project'}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toHaveText('Saved locally');
 await close();
 await launch();await page.goto(projectUrl);
 await expect(page.locator('[data-timeline-element]')).toHaveCount(4,{timeout:30000});
 record('save retry persists previously failed edit');
 await page.getByRole('button',{name:'Text',exact:true}).first().click();
 const previousIds=await page.locator('[data-timeline-element]').evaluateAll(es=>es.map(e=>e.getAttribute('data-timeline-element')));
 await page.getByRole('button',{name:'Add Default text to timeline',exact:true}).click({force:true});
 await expect(page.locator('[data-timeline-element]')).toHaveCount(5);
 const textId=(await page.locator('[data-timeline-element]').evaluateAll(es=>es.map(e=>e.getAttribute('data-timeline-element')))).find(id=>!previousIds.includes(id));
 await page.locator(`[data-timeline-element="${textId}"] button`).first().click();
 await page.locator('textarea').first().fill('Created locally. Ready to make it yours.');
 await page.locator('header input[type=text]').click();
 await page.locator('header input[type=text]').fill('Studio QA');
 await page.locator('header input[type=text]').press('Enter');
 await page.getByRole('button',{name:'Save project'}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toHaveText('Saved locally');
 await page.screenshot({path:path.join(evidence,'07-text-and-rename.png')});
 await close();await launch();await page.goto(projectUrl);
 await expect(page.locator('[data-timeline-element]')).toHaveCount(5,{timeout:30000});
 await expect(page.locator('header input[type=text]')).toHaveValue('Studio QA');
 await page.locator(`[data-timeline-element="${textId}"] button`).first().click();
 await expect(page.locator('textarea').first()).toHaveValue('Created locally. Ready to make it yours.');
 record('text overlay edit and project rename persist');
 await page.getByRole('button',{name:'Project thumbnail',exact:true}).click();
 await page.getByRole('menuitem',{name:'Exit project',exact:true}).click();
 await expect(page).toHaveURL('http://127.0.0.1:38841/projects');
 await page.getByRole('button',{name:'New project',exact:true}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Import',exact:true})).toBeVisible();
 await page.keyboard.press('Control+z');await page.keyboard.press('Control+Shift+z');
 await expect(page.locator('[data-timeline-element]')).toHaveCount(0);
 await page.getByRole('button',{name:'Save project'}).click();
 await expect(page.getByRole('button',{name:'Save project'})).toHaveText('Saved locally');
 record('project switch isolates undo and redo');
 await close();
 // Expected errors from the deliberate failed-write fixture are recorded,
 // while unexpected page errors still fail this workflow.
 if(report.errors.length)throw new Error('Renderer errors: '+report.errors.join('; '));
 if(report.remoteRequests.length)throw new Error('Unexpected remote requests');
 record('no renderer errors or remote requests');
 report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;console.error(error);if(page)await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{if(app)await close().catch(async()=>{await app?.evaluate(({app})=>app.exit(1)).catch(()=>{});app?.process().kill();});report.finished=new Date().toISOString();await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',path.join(evidence,'report.json'));}
