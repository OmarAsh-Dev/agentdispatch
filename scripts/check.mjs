import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for(const folder of ['src','scripts','tests'])for(const file of await readdir(new URL(`../${folder}/`,import.meta.url))){if(!file.endsWith('.mjs'))continue;const result=spawnSync(process.execPath,['--check',fileURLToPath(new URL(`../${folder}/${file}`,import.meta.url))],{encoding:'utf8',windowsHide:true});if(result.status){console.error(result.stderr);process.exit(1);}}
console.log('All JavaScript files pass syntax checks.');
