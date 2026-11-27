const {bundledModel}=require('./local-model.cjs');
const {bundledTranslator}=require('./local-translation.cjs');
const {printBilingual}=require('./bilingual-print.cjs');
const {app, BrowserWindow, ipcMain, dialog, safeStorage, shell} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID}=require('node:crypto');
app.setName('Dsh文献翻译');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let mainWindow, pending=Promise.resolve();
  const files=[];
  let recent=[], recentPath,windowMode='tabs',makeWindow;
  const occupiedWindows=new WeakSet();
  const openedFiles=new WeakMap();
  const savingPaths=new Set();
  const recentId=file=>createHash('sha256').update(file).digest('hex');
  async function sendPdf(win,file){
    const name=path.basename(file);
    if(!/\.pdf$/i.test(name)||!win||win.isDestroyed())return;
    try{
      if(!(await fs.promises.stat(file)).isFile())throw Error('READ_ERROR');
      const bytes=await fs.promises.readFile(file);
      if(win.isDestroyed())return;
      occupiedWindows.add(win);
      const fileId=randomUUID();
      if(!openedFiles.has(win))openedFiles.set(win,new Map());
      openedFiles.get(win).set(fileId,{file,hash:createHash('sha256').update(bytes).digest('hex')});
      const fileScope=recentId(path.normalize(file).toLowerCase());
      win.webContents.send('dsh-open-pdf',{name,bytes,fileId,fileScope});
      rememberPdf(file);
    }catch(error){
      if(!win.isDestroyed())win.webContents.send('dsh-open-pdf',{name,error:error.code??'READ_ERROR'});
    }
  }
  function rememberPdf(file){
    recent=[file,...recent.filter(item=>item.toLowerCase()!==file.toLowerCase())].slice(0,12);
    saveLibrarySettings();
  }
  function saveLibrarySettings(){
    if(recentPath){
      try{fs.writeFileSync(recentPath,JSON.stringify({files:recent,windowMode}));}catch{}
    }
  }
  async function openPdfByMode(win,file){
    const target=windowMode==='windows'&&occupiedWindows.has(win)?await makeWindow():win;
    await sendPdf(target,file);
  }
  function queueFiles(args,workingDirectory){
    for(const arg of args){
      if(!arg.startsWith('-')&&/\.pdf$/i.test(arg))files.push(path.resolve(workingDirectory,arg));
    }
    if(!mainWindow||mainWindow.isDestroyed())mainWindow=BrowserWindow.getAllWindows()[0];
    if(!mainWindow)return;
    pending=pending.then(async()=>{
      while(files.length&&mainWindow&&!mainWindow.isDestroyed()){
        const file=files.shift();
        await openPdfByMode(mainWindow,file);
      }
    });
  }
  queueFiles(process.argv.slice(app.isPackaged?1:2),process.cwd());
  app.on('second-instance', (_event,args,workingDirectory)=>{
    const win=BrowserWindow.getAllWindows()[0];
    if(win?.isMinimized())win.restore();
    win?.focus();
    queueFiles(args.slice(app.isPackaged?1:2),workingDirectory);
  });
  app.whenReady().then(async () => {
    recentPath=process.env.DSH_RECENT_FILE??path.join(app.getPath('userData'),'recent-pdfs.json');
    try{
      const saved=JSON.parse(fs.readFileSync(recentPath,'utf8'));
      windowMode=saved?.windowMode==='windows'?'windows':'tabs';
      const entries=Array.isArray(saved)?saved:saved?.files;
      if(Array.isArray(entries))recent=entries.filter(item=>typeof item==='string'&&path.isAbsolute(item)&&/\.pdf$/i.test(item)).slice(0,12);
    }catch{}
    const settingsDir = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
    const settingsPath = process.env.DSH_SETTINGS_FILE ?? path.join(settingsDir, 'settings.json');
    process.env.DSH_SETTINGS_FILE=settingsPath;
    let aiProfiles=[],settingsReadFailed=false,saved={};
    try{
      const parsed=JSON.parse(fs.readFileSync(settingsPath,'utf8').replace(/^\uFEFF/,''));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid settings object');
      saved=parsed;
    }catch(error){settingsReadFailed=error.code!=='ENOENT';}
    function unlockKey(value){
      if(typeof value==='string')return value;
      if(typeof value?.windowsEncrypted==='string'){
        try{return safeStorage.decryptString(Buffer.from(value.windowsEncrypted,'base64'));}catch{return '';}
      }
      return '';
    }
    if(Array.isArray(saved.aiProfiles)){
      aiProfiles=saved.aiProfiles.filter(item=>item&&typeof item.name==='string'&&typeof item.url==='string'&&typeof item.model==='string')
        .slice(0,16).map(item=>({name:item.name,url:item.url,model:item.model,key:unlockKey(item.key),thinking:item.thinking==='enabled'?'enabled':''}));
    }
    for (const [key, stored] of Object.entries(saved)) {
      let value=stored;
      if(key.endsWith('_KEY')&&typeof stored?.windowsEncrypted==='string'){
        try{value=safeStorage.decryptString(Buffer.from(stored.windowsEncrypted,'base64'));}
        catch{continue;}
      }
      if (['DSH_GOOGLE_KEY','DSH_YOUDAO_APP_ID','DSH_YOUDAO_KEY','DSH_BAIDU_APP_ID','DSH_BAIDU_KEY','DSH_DEEPL_KEY','DSH_TRANSLATE_URL','DSH_TRANSLATE_KEY','DSH_AI_URL','DSH_AI_KEY','DSH_AI_MODEL','DSH_AI_THINKING'].includes(key) && typeof value === 'string') process.env[key] ??= value;
    }
    process.env.DSH_PORT ??= '8766';
    const {setBundledModelStarter}=await import('./ai.mjs');
    setBundledModelStarter(bundledModel(app));
    const {ready,setSettingsProtection,setLocalTranslator} = await import('./server.mjs');
    setLocalTranslator(bundledTranslator(app));
    setSettingsProtection(value=>{
      if(!safeStorage.isEncryptionAvailable())throw Error('Windows 本机加密暂不可用，无法保存服务密钥。');
      return {windowsEncrypted:safeStorage.encryptString(value).toString('base64')};
    },aiProfiles,settingsReadFailed);
    const origin = await ready;
    async function createWindow(){
      const win = new BrowserWindow({width:1360,height:920,minWidth:680,minHeight:500,title:'Dsh文献翻译',icon:path.join(__dirname,'dsh-icon.png'),autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'preload.cjs')}});
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
      await win.loadURL(origin);
      return win;
    }
    makeWindow=createWindow;
    ipcMain.handle('dsh-new-window',async event=>{
      if(event.senderFrame!==event.sender.mainFrame||new URL(event.senderFrame.url).origin!==origin)return;
      await createWindow();
    });
    ipcMain.handle('dsh-print-bilingual',async(event,pages)=>{
      if(event.senderFrame!==event.sender.mainFrame||new URL(event.senderFrame.url).origin!==origin)throw Error('打印请求来源无效。');
      return printBilingual(pages);
    });
    function openSender(event){
      return event.senderFrame===event.sender.mainFrame&&new URL(event.senderFrame.url).origin===origin?BrowserWindow.fromWebContents(event.sender):null;
    }
    ipcMain.handle('dsh-reveal-open-pdf',(event,id)=>{
      const win=openSender(event);
      const entry=win&&openedFiles.get(win)?.get(id);
      if(!entry||!fs.existsSync(entry.file))throw Error('文件已移动或删除。');
      shell.showItemInFolder(entry.file);
    });
    ipcMain.handle('dsh-save-open-pdf',async(event,id,data)=>{
      const win=openSender(event);
      const entry=win&&openedFiles.get(win)?.get(id);
      if(!entry||!(data instanceof Uint8Array)||data.length<5||Buffer.from(data.subarray(0,5)).toString()!=='%PDF-')throw Error('无法保存这个 PDF。');
      const {file}=entry,key=file.toLowerCase();
      if(savingPaths.has(key))throw Error('此文件正在保存。');
      savingPaths.add(key);
      const temp=path.join(path.dirname(file),'.dsh-'+randomUUID()+'.tmp');
      try{
        const info=await fs.promises.lstat(file);
        if(!info.isFile())throw Error('原路径已改变，请另存副本。');
        await fs.promises.writeFile(temp,data,{flag:'wx',mode:info.mode});
        const actual=createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
        if(actual!==entry.hash)throw Error('原文件已被其他程序修改，请另存副本。');
        await fs.promises.rename(temp,file);
        entry.hash=createHash('sha256').update(data).digest('hex');
      }finally{
        await fs.promises.rm(temp,{force:true}).catch(()=>{});
        savingPaths.delete(key);
      }
    });
    ipcMain.handle('dsh-pick-pdfs',async event=>{
      const win=openSender(event);
      if(!win)return;
      const result=await dialog.showOpenDialog(win,{title:'打开 PDF',properties:['openFile','multiSelections'],filters:[{name:'PDF 文献',extensions:['pdf']}]});
      if(!result.canceled)for(const file of result.filePaths)await openPdfByMode(win,file);
    });
    ipcMain.handle('dsh-route-dropped-pdf',async(event,file)=>{
      const win=openSender(event);
      if(!win||typeof file!=='string'||!path.isAbsolute(file)||!/\.pdf$/i.test(file))return false;
      await openPdfByMode(win,path.normalize(file));
      return true;
    });
    ipcMain.handle('dsh-remember-dropped-pdf',async(event,file)=>{
      if(!openSender(event)||typeof file!=='string'||!path.isAbsolute(file)||!/\.pdf$/i.test(file))return;
      try{if((await fs.promises.stat(file)).isFile())rememberPdf(path.normalize(file));}catch{}
    });
    ipcMain.handle('dsh-recent-pdfs',event=>{
      if(!openSender(event))return [];
      return recent.map(file=>({id:recentId(file),name:path.basename(file)}));
    });
    ipcMain.handle('dsh-open-recent',async(event,id)=>{
      const win=openSender(event);
      const file=recent.find(entry=>recentId(entry)===id);
      if(win&&file)await openPdfByMode(win,file);
    });
    ipcMain.handle('dsh-window-mode',event=>openSender(event)?windowMode:null);
    ipcMain.handle('dsh-set-window-mode',(event,mode)=>{
      if(openSender(event)&&['tabs','windows'].includes(mode)){windowMode=mode;saveLibrarySettings();}
    });
    ipcMain.on('dsh-book-state',(event,hasBooks)=>{
      const win=openSender(event);
      if(!win)return;
      if(hasBooks===true)occupiedWindows.add(win);
      else occupiedWindows.delete(win);
    });
    mainWindow=await createWindow();
    queueFiles([],process.cwd());
  }).catch(error=>{
    const message=error.code==='EADDRINUSE'
      ?'本地端口 '+process.env.DSH_PORT+' 正被其他程序使用。请关闭占用该端口的程序，再重新打开 Dsh文献翻译。'
      :error.message;
    dialog.showErrorBox('Dsh文献翻译',message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}




