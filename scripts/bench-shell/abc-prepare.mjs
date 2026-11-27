// Wait for the controller to assign this process to its Windows job before
// launching a preparation command that may itself start background children.
import {spawnSync} from "node:child_process";
process.once("message",()=>{
  process.disconnect();
  const [command,...args]=process.argv.slice(2);
  const result=spawnSync(command,args,{windowsHide:true,stdio:"inherit"});
  if(result.error)throw result.error;
  process.exitCode=result.status ?? 1;
});
