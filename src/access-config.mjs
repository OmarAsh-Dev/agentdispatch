export function codexFullAccessEdits(config={}){
  const edits=[];const set=(keyPath,value)=>edits.push({keyPath,value,mergeStrategy:'replace'});
  const key=name=>JSON.stringify(name);
  set('approval_policy','never');
  set(config.default_permissions?'default_permissions':'sandbox_mode',config.default_permissions?':danger-full-access':'danger-full-access');
  const toolModes=(prefix,settings={})=>{
    set(`${prefix}.default_tools_approval_mode`,'approve');
    for(const name of Object.keys(settings.tools||{}))set(`${prefix}.tools.${key(name)}.approval_mode`,'approve');
  };
  toolModes('apps._default',config.apps?._default);
  for(const [name,settings] of Object.entries(config.apps||{}))if(name!=='_default'){
    const prefix=`apps.${key(name)}`;toolModes(prefix,settings);
    for(const [link,entry] of Object.entries(settings.links||{}))toolModes(`${prefix}.links.${key(link)}`,entry);
  }
  for(const [name,settings] of Object.entries(config.mcp_servers||{}))toolModes(`mcp_servers.${key(name)}`,settings);
  for(const [plugin,settings] of Object.entries(config.plugins||{}))for(const [name,server] of Object.entries(settings.mcp_servers||{}))toolModes(`plugins.${key(plugin)}.mcp_servers.${key(name)}`,server);
  return edits;
}
export function openCodeFullAccessConfig(config={}){
  const result=structuredClone(config);result.permission='allow';result.agent??={};
  for(const name of new Set(['build','plan','general','explore',...Object.keys(result.agent)]))result.agent[name]={...result.agent[name],permission:'allow'};
  return result;
}
