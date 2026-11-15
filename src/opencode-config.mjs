import { randomBytes } from 'node:crypto';
import { validateBaseUrl } from './core.mjs';
export function openCodeRuntime(runtime,config={}){
  const auth=config.openCodeAuth||'password';
  if(!['password','none'].includes(auth))throw Error('Invalid OpenCode auth mode');
  validateBaseUrl(runtime.openCodeUrl);
  return {...runtime,openCodePassword:auth==='none'?null:runtime.openCodePassword||randomBytes(32).toString('hex')};
}
