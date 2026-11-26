const {spawn}=require('node:child_process');
const {existsSync}=require('node:fs');
const path=require('node:path');
const {createInterface}=require('node:readline');

function bundledTranslator(app){
  const root=path.join(path.dirname(process.execPath),'mt');
  const python=path.join(root,'py','python.exe');
  if(!existsSync(python)||!existsSync(path.join(root,'model','model','model.bin')))return null;

  let child,nextId=0;
  const pending=new Map();
  function getWorker(){
    if(child)return child;
    const worker=spawn(python,['-X','utf8','-W','ignore','translation-worker.py'],{
      cwd:root,windowsHide:true,stdio:['pipe','pipe','ignore']
    });
    child=worker;
    function fail(){
      if(child!==worker)return;
      child=null;
      for(const request of pending.values())request.finish(Error('无法启动或继续运行本地翻译引擎。'));
    }
    worker.once('error',fail);
    worker.once('close',fail);
    worker.stdin.on('error',fail);
    createInterface({input:worker.stdout}).on('line',line=>{
      try{
        const {id,result,error}=JSON.parse(line);
        pending.get(id)?.finish(error?Error(error):null,result);
      }catch{worker.kill();}
    });
    return worker;
  }
  app.once('before-quit',()=>child?.kill());

  return function translate(text,signal){
    signal.throwIfAborted();
    const worker=getWorker(),id=++nextId;
    return new Promise((resolve,reject)=>{
      function finish(error,result){
        clearTimeout(timer);
        pending.delete(id);
        signal.removeEventListener('abort',abort);
        if(error)reject(error);
        else resolve(result);
      }
      function abort(){
        finish(signal.reason);
        if(child===worker&&!pending.size){
          child=null;
          worker.kill();
        }
      }
      const timer=setTimeout(()=>{finish(Error('本地翻译超时，请重试。'));worker.kill();},30000);
      pending.set(id,{finish});
      signal.addEventListener('abort',abort,{once:true});
      worker.stdin.write(JSON.stringify({id,text})+'\n','utf8',error=>{if(error)finish(error);});
    });
  };
}
module.exports={bundledTranslator};
