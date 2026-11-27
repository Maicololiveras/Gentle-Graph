import {spawn} from "node:child_process";
import {once} from "node:events";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

export async function openWindowsJob() {
  const script=fileURLToPath(new URL("./abc-job.ps1",import.meta.url));
  const host=spawn("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script],{
    windowsHide:true,stdio:["pipe","pipe","inherit"]
  });
  const done=once(host,"close").then(([code])=>code);
  done.catch(()=>{});
  host.stdin.on("error",()=>{}); // The response reader observes a closed host.
  const replies=createInterface({input:host.stdout})[Symbol.asyncIterator]();
  async function expect(message){
    const reply=await replies.next();
    if(reply.value!==message){
      if(reply.done) await done;
      throw Error("Windows benchmark job failed before "+message);
    }
  }
  try {await expect("ready");}
  catch(error){host.kill();throw error;}
  async function command(text){host.stdin.write(text+"\n");await expect("ok");}
  return {
    attach:pid=>command(String(pid)), release:()=>command("release"),
    async close(){host.stdin.end();if(await done!==0)throw Error("Windows benchmark job controller failed");}
  };
}
