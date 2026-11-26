const {execFile,spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {existsSync}=require('node:fs');
const {promisify}=require('node:util');
const net=require('node:net');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');

const runFile=promisify(execFile);

async function vulkanDevice(executable){
  if(process.env.DSH_QWEN_BACKEND==='cpu'||!existsSync(executable))return null;
  try{
    const {stdout,stderr}=await runFile(executable,['--list-devices'],{cwd:path.dirname(executable),windowsHide:true,timeout:5000});
    const line=(stdout+'\n'+stderr).match(/^\s*(Vulkan\d+):\s*(.+)$/im);
    return line?{id:line[1],label:line[2].replace(/\s*\(.*$/,'').trim()}:null;
  }catch{return null;}
}

function bundledModel(app){
  const root=path.join(path.dirname(process.execPath),'local-model');
  const executable=path.join(root,'llama-server.exe');
  const vulkan=path.join(root,'vulkan','llama-server.exe');
  const weights=path.join(root,'qwen.gguf');
  if(!existsSync(executable)||!existsSync(weights))return null;

  const detection=vulkanDevice(vulkan);
  let child,starting,backend,closing=false;
  app.once('before-quit',()=>{
    closing=true;
    child?.kill();
  });

  async function startServer(binary,device){
    const port=await freePort();
    if(closing)throw Error('应用正在退出。');
    const base='http://127.0.0.1:'+port;
    const token=randomBytes(32).toString('hex');
    const graphics=device?['--device',device.id,'-ngl','99']:['-ngl','0'];
    const worker=spawn(binary,[
      '-m',weights,'--host','127.0.0.1','--port',String(port),
      '-c','8192','-n','1024','--temp','0','--repeat-penalty','1.15',
      '--alias','qwen-local','--api-key',token,'--no-webui',...graphics
    ],{cwd:path.dirname(binary),windowsHide:true,stdio:'ignore'});
    child=worker;
    let failed=false;
    let ready=false;
    worker.once('error',()=>{failed=true;});
    worker.once('close',()=>{
      failed=true;
      if(child===worker){
        child=null;
        backend=null;
        if(ready)starting=null;
      }
    });
    const deadline=Date.now()+(device?14000:26000);
    while(!closing&&!failed&&Date.now()<deadline){
      try{
        const response=await fetch(base+'/health',{signal:AbortSignal.timeout(650)});
        if(response.ok&&!failed&&!closing){
          ready=true;
          backend=device?{kind:'vulkan',device:device.label}:{kind:'cpu'};
          return {url:base+'/v1/chat/completions',key:token};
        }
      }catch{}
      await delay(250);
    }
    worker.kill();
    throw Error('本地 Qwen 未能启动，请确认模型文件和运行时完整。');
  }

  function start(){
    if(starting)return starting;
    starting=(async()=>{
      const device=await detection;
      if(device&&!closing){
        try{return await startServer(vulkan,device);}
        catch(error){if(closing)throw error;}
      }
      return startServer(executable,null);
    })().catch(error=>{starting=null;throw error;});
    return starting;
  }
  start.backend=()=>backend??null;
  return start;
}

function freePort(){
  return new Promise((resolve,reject)=>{
    const listener=net.createServer();
    listener.once('error',reject);
    listener.listen(0,'127.0.0.1',()=>{
      const {port}=listener.address();
      listener.close(error=>error?reject(error):resolve(port));
    });
  });
}

module.exports={bundledModel};
