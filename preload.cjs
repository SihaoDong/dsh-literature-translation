const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('dshDesktop',{
  newWindow(){return ipcRenderer.invoke('dsh-new-window');},
  printBilingual(pages){return ipcRenderer.invoke('dsh-print-bilingual',pages);},
  windowMode(){return ipcRenderer.invoke('dsh-window-mode');},
  setWindowMode(mode){return ipcRenderer.invoke('dsh-set-window-mode',mode);},
  reportBooks(hasBooks){ipcRenderer.send('dsh-book-state',hasBooks);},
  saveOpenPdf(id,bytes){return ipcRenderer.invoke('dsh-save-open-pdf',id,bytes);},
  pickPdfs(){return ipcRenderer.invoke('dsh-pick-pdfs');},
  routeDroppedPdf(file){
    const filePath=webUtils.getPathForFile(file);
    return filePath?ipcRenderer.invoke('dsh-route-dropped-pdf',filePath):false;
  },
  rememberDroppedPdf(file){
    const filePath=webUtils.getPathForFile(file);
    if(filePath)return ipcRenderer.invoke('dsh-remember-dropped-pdf',filePath);
  },
  recentPdfs(){return ipcRenderer.invoke('dsh-recent-pdfs');},
  openRecent(id){return ipcRenderer.invoke('dsh-open-recent',id);},
  onOpenPdf(callback){ipcRenderer.on('dsh-open-pdf',(_event,file)=>callback(file));}
});
