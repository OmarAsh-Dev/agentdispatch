import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
const excluded=name=>['.git','.state','.ssh','node_modules','dist','build','.next','.cache','coverage'].includes(name)||/^\.env|^credentials|^auth\.json$/i.test(name);
// Local-only content identity. Symlinks and credential/state paths are never read.
export async function snapshotFiles(workspace){
  const files={};let count=0;
  async function walk(dir,relative=''){
    const entries=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for(const e of entries){if(excluded(e.name)||e.isSymbolicLink())continue;if(++count>50000)throw Error('Workspace exceeds fingerprint limit; narrow its registered scope');
      const full=join(dir,e.name),rel=relative+e.name;
      if(e.isDirectory())await walk(full,rel+'/');else if(e.isFile()){const info=await lstat(full);if(info.isSymbolicLink())continue;if(info.size>100*1024*1024)throw Error(`File too large to verify: ${rel}`);files[rel]=createHash('sha256').update(await readFile(full)).digest('hex');}
    }
  }
  await walk(workspace);return files;
}
export async function fingerprint(workspace,paths){const files=await snapshotFiles(workspace);const entries=(paths||Object.keys(files)).sort().map(p=>[p,files[p]||null]);return createHash('sha256').update(JSON.stringify(entries)).digest('hex');}
