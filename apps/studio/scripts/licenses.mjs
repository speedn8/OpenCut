import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const entries=[];
for(const name of await fs.readdir(path.join(root,'node_modules'))){
 if(name.startsWith('.'))continue;
 const base=path.join(root,'node_modules',name);
 const candidates=name.startsWith('@')?(await fs.readdir(base)).map(n=>path.join(base,n)):[base];
 for(const dir of candidates){
  let pkg;try{pkg=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));}catch{continue;}
  const names=await fs.readdir(dir);
  const licenses=[];
  for(const file of names.filter(n=>/^(licen[cs]e|copying|notice)(\.|$|-)/i.test(n))){
   const full=path.join(dir,file);if(!(await fs.stat(full)).isFile())continue;
   licenses.push(`--- ${file} ---\n${await fs.readFile(full,'utf8')}`);
  }
  entries.push({name:pkg.name,version:pkg.version,license:pkg.license||'See package source',repository:typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url,text:licenses.join('\n')});
 }
}
entries.sort((a,b)=>a.name.localeCompare(b.name));
await fs.writeFile('THIRD_PARTY_LICENSES.txt','OpenCut Studio dependency notices\nIncludes development dependencies for completeness. Some packages are not bundled in the application.\n\n'+entries.map(e=>`${'='.repeat(72)}\n${e.name}@${e.version}\nLicense: ${typeof e.license==='string'?e.license:JSON.stringify(e.license)}\nSource: ${e.repository||'See npm package metadata'}\n${e.text}`).join('\n\n'));
console.log(`Recorded ${entries.length} package license notices.`);
