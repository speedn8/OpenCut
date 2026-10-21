import {describe, test, expect} from "bun:test";
import {EditorSession} from "../../apps/editor/src/session";
import {createProject, type EditorHost, type Project} from "../../packages/editor-core/src/index";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no}); return {promise,resolve,reject}; }
function hostFixture() {
  const projects = new Map<string,{project:Project;version:number}>();
  const writes: Array<{project:Project;expectedVersion:number|null}> = [];
  let gate: ReturnType<typeof deferred<void>> | null = null;
  let fail = false;
  const host: EditorHost = {
    async getEnvironment(){return {ffmpeg:true,ffprobe:true,version:"fixture",profile:"disposable",encoders:[]}},
    async listProjects(){return [...projects.values()].map(({project,version})=>({id:project.id,name:project.name,updatedAt:project.updatedAt,version,duration:0}))},
    async openProject(id){const stored=projects.get(id);if(!stored)throw Error("missing");return structuredClone(stored)},
    async saveProject(input){
      writes.push(structuredClone(input));
      const waiting=gate; gate=null;if(waiting)await waiting.promise;
      if(fail)throw Error("disk full");
      const previous=projects.get(input.project.id);
      if((previous?.version??null)!==input.expectedVersion)throw Error("storage conflict");
      const version=(previous?.version??0)+1;projects.set(input.project.id,{project:structuredClone(input.project),version});return {version};
    },
    async importMedia(){return []},async importCaptions(){return []},async exportProject(){return null},
    async createProxy(){throw Error("unused")},async analyzeSilence(){throw Error("unused")},async transcribeAsset(){throw Error("unused")},async cancelJob(){},
    onJobs(){return ()=>{}},onCloseRequested(){return ()=>{}},respondToClose(){}
  };
  return {host,projects,writes,blockNext(){return gate=deferred<void>()},setFailure(value:boolean){fail=value}};
}

describe("session save and navigation boundaries",()=>{
  test("drains edits made while a real asynchronous save is in flight using acknowledged CAS versions",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("Initial");
    const gate=f.blockNext();session.dispatch({type:"project.rename",name:"First edit"});const saving=session.flush();
    await Promise.resolve();expect(f.writes.at(-1)?.project.name).toBe("First edit");
    session.dispatch({type:"project.rename",name:"Edit during write"});gate.resolve();await saving;
    const id=session.getSnapshot().project!.id;
    expect(f.projects.get(id)?.project.name).toBe("Edit during write");
    expect(f.writes.map(write=>write.expectedVersion)).toEqual([null,1,2]);
    expect(session.getSnapshot().dirty).toBe(false);
  });
  test("failed save retains dirty project and blocks switching, then retry persists it",async()=>{
    const f=hostFixture(),other=createProject({id:"other",name:"Other"});f.projects.set(other.id,{project:other,version:1});
    const session=new EditorSession(f.host);await session.create("Original");const id=session.getSnapshot().project!.id;
    session.dispatch({type:"project.rename",name:"Unsaved title"});f.setFailure(true);
    await expect(session.open("other")).rejects.toThrow("disk full");
    expect(session.getSnapshot().project?.id).toBe(id);expect(session.getSnapshot().dirty).toBe(true);
    expect(session.getSnapshot().saving).toBe(false);expect(session.getSnapshot().busy).toBe(false);
    f.setFailure(false);await session.flush();await session.open("other");
    expect(f.projects.get(id)?.project.name).toBe("Unsaved title");expect(session.getSnapshot().project?.id).toBe("other");
  });
  test("a storage conflict cannot overwrite an externally saved project",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("Original");const id=session.getSnapshot().project!.id;
    const stored=f.projects.get(id)!;f.projects.set(id,{project:{...stored.project,name:"External"},version:stored.version+1});
    session.dispatch({type:"project.rename",name:"Stale edit"});await expect(session.flush()).rejects.toThrow("storage conflict");
    expect(f.projects.get(id)?.project.name).toBe("External");expect(session.getSnapshot().dirty).toBe(true);
  });
  test("history and undo cannot leak across reopened projects",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("A");const first=session.getSnapshot().project!.id;
    session.dispatch({type:"project.rename",name:"A edited"});await session.flush();await session.create("B");
    const second=session.getSnapshot().project!.id;session.dispatch({type:"project.rename",name:"B edited"});await session.open(first);
    expect(session.getSnapshot().canUndo).toBe(false);session.undo();expect(session.getSnapshot().project?.name).toBe("A edited");
    expect(f.projects.get(second)?.project.name).toBe("B edited");await session.flush();
  });
  test("all concurrent flush callers await the same write and do not create duplicate versions",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("A");session.dispatch({type:"project.rename",name:"B"});
    const gate=f.blockNext(),one=session.flush(),two=session.flush(),three=session.flush();
    await Promise.resolve();expect(f.writes.length).toBe(2);gate.resolve();await Promise.all([one,two,three]);
    expect(f.writes.length).toBe(2);expect(session.getSnapshot().dirty).toBe(false);
  });
  test("switch drains an already-open native import into the original project before saving",async()=>{
    const f=hostFixture(),other=createProject({id:"other",name:"Other"});f.projects.set(other.id,{project:other,version:1});
    const session=new EditorSession(f.host);await session.create("Original");const id=session.getSnapshot().project!.id;
    const gate=deferred<any[]>();f.host.importMedia=()=>gate.promise;const importing=session.importMedia();const switching=session.open("other");
    expect(session.getSnapshot().busy).toBe(true);expect(session.getSnapshot().project?.id).toBe(id);
    await expect(session.importMedia()).rejects.toThrow("switching");
    gate.resolve([{id:"asset1",name:"original.wav",kind:"audio",duration:240000,hasAudio:true,url:"app-media://media/asset1"}]);
    await Promise.all([importing,switching]);
    expect(f.projects.get(id)?.project.assets.asset1.name).toBe("original.wav");
    expect(session.getSnapshot().project?.id).toBe("other");expect(session.getSnapshot().project?.assets.asset1).toBeUndefined();
  });
  test("close preparation waits for a pending caption dialog and persists its result",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("Original");const id=session.getSnapshot().project!.id;
    const gate=deferred<any[]>();f.host.importCaptions=()=>gate.promise;const importing=session.importCaptions();let acknowledged=false;
    const closing=session.prepareClose().then(()=>{acknowledged=true});await Promise.resolve();expect(acknowledged).toBe(false);
    gate.resolve([{id:"caption1",start:0,end:240000,text:"Pending import"}]);await Promise.all([importing,closing]);
    expect(acknowledged).toBe(true);expect(f.projects.get(id)?.project.captions[0].text).toBe("Pending import");expect(session.getSnapshot().dirty).toBe(false);
  });
  test("save a copy recovers every edit from a CAS conflict without overwriting the external project",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("Original");const original=session.getSnapshot().project!;
    session.dispatch({type:"project.rename",name:"Local edits"});session.dispatch({type:"marker.add",marker:{id:"marker",time:240000,label:"Preserved edit",color:"#ffffff"}});
    const external={...structuredClone(original),name:"External saved edit"};f.projects.set(original.id,{project:external,version:2});
    await expect(session.flush()).rejects.toThrow("storage conflict");await session.saveCopy();
    const copy=session.getSnapshot().project!;expect(copy.id).not.toBe(original.id);expect(copy.name).toBe("Local edits copy");expect(copy.markers[0].label).toBe("Preserved edit");
    expect(f.projects.get(original.id)?.project.name).toBe("External saved edit");expect(f.writes.at(-1)?.expectedVersion).toBeNull();expect(session.getSnapshot().dirty).toBe(false);
  });
  test("a failed copy write leaves the original dirty model and undo history available",async()=>{
    const f=hostFixture(),session=new EditorSession(f.host);await session.create("Original");session.dispatch({type:"project.rename",name:"Keep this"});const before=session.getSnapshot().project;
    f.setFailure(true);await expect(session.saveCopy()).rejects.toThrow("disk full");expect(session.getSnapshot().project).toBe(before);expect(session.getSnapshot().dirty).toBe(true);expect(session.getSnapshot().canUndo).toBe(true);
    f.setFailure(false);await session.flush();
  });
  test("late queued replies and progress events cannot regress a completed native job",()=>{
    const f=hostFixture(),session=new EditorSession(f.host),job={id:"job",type:"proxy" as const,status:"running" as const,progress:.8};
    session.receiveJob(job);session.receiveJob({...job,status:"queued",progress:0});expect(session.getSnapshot().jobs[0].status).toBe("running");
    session.receiveJob({...job,progress:.1});expect(session.getSnapshot().jobs[0].progress).toBe(.8);
    session.receiveJob({...job,status:"completed",progress:1,result:{ready:true}});session.receiveJob({...job,status:"running",progress:.95});expect(session.getSnapshot().jobs[0].status).toBe("completed");expect(session.getSnapshot().jobs[0].result).toEqual({ready:true});
  });
});
