import fs from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
const directory = path.resolve(process.argv[2] || "qa-artifacts/fixtures");
const binary = process.env.OPENCUT_FFMPEG_PATH;
if(!binary || !path.isAbsolute(binary)) throw Error("Set OPENCUT_FFMPEG_PATH to an installed FFmpeg executable.");
await fs.mkdir(directory,{recursive:true});
async function ffmpeg(args){await new Promise((resolve,reject)=>{const child=spawn(binary,["-hide_banner","-loglevel","error","-nostdin",...args],{windowsHide:true,stdio:["ignore","ignore","pipe"]});let error="";child.stderr.on("data",value=>error+=value);child.on("error",reject);child.on("close",code=>code===0?resolve():reject(Error(error)));});}
await Promise.all([
  ffmpeg(["-y","-f","lavfi","-i","testsrc2=size=640x360:rate=30:duration=6","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=6","-c:v","libvpx-vp9","-b:v","500k","-c:a","libopus","-shortest",path.join(directory,"motion.webm")]),
  ffmpeg(["-y","-f","lavfi","-i","aevalsrc=if(between(t\\,1\\,3)\\,0\\,0.2*sin(2*PI*660*t)):s=48000:d=5","-c:a","pcm_s16le",path.join(directory,"tone-and-silence.wav")]),
  ffmpeg(["-y","-f","lavfi","-i","color=c=0x13e5b4:s=320x180:d=1","-frames:v","1",path.join(directory,"mint.png")])
]);
await fs.writeFile(path.join(directory,"captions.srt"),"1\n00:00:00,500 --> 00:00:02,000\nFresh code. Your story.\n\n2\n00:00:02,300 --> 00:00:04,500\nBuilt to grow.\n","utf8");
console.log(JSON.stringify({directory,generated:["motion.webm","tone-and-silence.wav","mint.png","captions.srt"]}));
