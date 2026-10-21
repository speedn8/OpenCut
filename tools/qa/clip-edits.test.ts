import {test,expect} from "bun:test";
import {createProject,createClip,applyCommand,secondsToTicks,frameTicks} from "../../packages/editor-core/src/index";
import {sourceSeconds,speedPatch,clipPeaks,availableTrack} from "../../apps/editor/src/clip-edits";
import {mapTranscription} from "../../apps/editor/src/captions";

test("fractional-speed preview remains on a finite valid source clock at arbitrary playback ticks",()=>{
  const asset={id:"source",name:"source",kind:"video" as const,duration:secondsToTicks(10),hasAudio:true,url:"app-media://media/source"};
  const clip=createClip({asset,duration:secondsToTicks(5)});clip.speed=.75;clip.sourceIn=33001;clip.start=120003;
  for(let offset=0;offset<10000;offset+=137){const actual=sourceSeconds(clip,clip.start+offset);expect(Number.isFinite(actual)).toBe(true);expect(Math.abs(actual-(clip.sourceIn+offset*.75)/240000)).toBeLessThanOrEqual(1/240000);}
});
test("speed edit preserves source bounds, scales fades and retains off-clip interpolation context",()=>{
  const project=createProject(),asset={id:"source",name:"source",kind:"video" as const,duration:secondsToTicks(5),hasAudio:true,url:"app-media://media/source"};
  const clip=createClip({asset});clip.fadeIn=24000;clip.fadeOut=48000;
  clip.keyframes=[{id:"before",property:"x",time:-24000,value:0,easing:"smooth"},{id:"after",property:"x",time:secondsToTicks(6),value:200,easing:"linear"}];
  const ready=applyCommand(project,{type:"batch",commands:[{type:"asset.add",assets:[asset]},{type:"clip.add",trackId:project.tracks[0].id,clip}]});
  const patch=speedPatch(clip,1.75,project.settings.frameRate);const edited=applyCommand(ready,{type:"clip.update",clipId:clip.id,patch}).tracks[0].clips[0];
  expect(edited.duration%frameTicks(project.settings.frameRate)).toBe(0);expect(Math.ceil(edited.duration*edited.speed)).toBeLessThanOrEqual(asset.duration);
  expect(edited.keyframes[0].time).toBeLessThan(0);expect(edited.keyframes[1].time).toBeGreaterThan(edited.duration);expect(edited.fadeIn+edited.fadeOut).toBeLessThan(edited.duration);
});
test("transcription mapping uses source trim, current timeline offset and speed with clipped cue bounds",()=>{
  const asset={id:"source",name:"source",kind:"audio" as const,duration:secondsToTicks(20),hasAudio:true,url:"app-media://media/source"};
  const clip=createClip({asset,start:secondsToTicks(10),duration:secondsToTicks(4)});clip.sourceIn=secondsToTicks(3);clip.speed=2;
  const result=mapTranscription([{start:0,end:secondsToTicks(4),text:"crosses left"},{start:secondsToTicks(5),end:secondsToTicks(6),text:"inside"},{start:secondsToTicks(10),end:secondsToTicks(14),text:"crosses right"},{start:secondsToTicks(15),end:secondsToTicks(17),text:"outside"}],clip);
  expect(result.map(({start,end,text})=>({start,end,text}))).toEqual([{start:secondsToTicks(10),end:secondsToTicks(10.5),text:"crosses left"},{start:secondsToTicks(11),end:secondsToTicks(11.5),text:"inside"},{start:secondsToTicks(13.5),end:secondsToTicks(14),text:"crosses right"}]);
  expect(mapTranscription([{start:NaN,end:Infinity,text:"bad"}],clip)).toEqual([]);
});
test("waveform selects the trimmed retimed source region and preserves transients under aggregation",()=>{
  const source={duration:800,peaks:[.1,.2,.3,.4,.5,.6,.7,1]};
  expect(clipPeaks(source,{sourceIn:200,duration:200,speed:1})).toEqual([.3,.4]);
  expect(clipPeaks(source,{sourceIn:200,duration:200,speed:2})).toEqual([.3,.4,.5,.6]);
  expect(clipPeaks(source,{sourceIn:400,duration:800,speed:1},2)).toEqual([.6,1]);
  expect(clipPeaks(source,{sourceIn:800,duration:50,speed:1})).toEqual([]);expect(clipPeaks(undefined,{sourceIn:0,duration:50,speed:1})).toEqual([]);
});
test("default track placement avoids occupied or locked lanes while respecting half-open edit boundaries",()=>{
  const project=createProject(),asset={id:"source",name:"source",kind:"video" as const,duration:240000,hasAudio:true,url:"app-media://media/source"};
  const clip=createClip({asset});project.tracks[0].clips.push(clip);
  expect(availableTrack(project,"video",0,240000)).toBeUndefined();expect(availableTrack(project,"video",240000,240000)?.id).toBe(project.tracks[0].id);
  expect(availableTrack(project,"video",0,240000,project.tracks[0].id,clip.id)?.id).toBe(project.tracks[0].id);
  project.tracks[0].locked=true;expect(availableTrack(project,"video",240000,240000)).toBeUndefined();
});
