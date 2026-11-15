import { fileURLToPath } from 'node:url';
export function packagedCodex(){
  const target=process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
  const root=fileURLToPath(new URL('../node_modules/@openai/codex/',import.meta.url));
  const vendor=new URL(`../node_modules/@openai/codex-win32-${process.arch}/vendor/${target}/`,import.meta.url);
  return {command:fileURLToPath(new URL('bin/codex.exe',vendor)),prefixArgs:[],env:{CODEX_MANAGED_PACKAGE_ROOT:root,CODEX_MANAGED_BY_NPM:'1'}};
}
