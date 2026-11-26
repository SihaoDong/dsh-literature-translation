import {joinTranslationParts} from './text-chunks.mjs';
import * as pdfjsLibrary from '/pdf/build/pdf.mjs';
import {extractPdfPages,exportAnnotatedPdf,rotatePdfPages,parsePageRanges,exportPdfWithoutPages,insertBlankPdfPages,transferPdfPages,cropPdfPages,getPdfCropEdits} from './pdf-notes.mjs';
import {addDocumentTools,chunks,documentStorageKey,normalizePdfText,translationUsage} from './document-tools.mjs';
import {getDocument,GlobalWorkerOptions,TextLayer} from '/pdf/build/pdf.mjs';
GlobalWorkerOptions.workerSrc='/pdf/build/pdf.worker.mjs';
const $=id=>document.getElementById(id);
const docs=[];
let selectionRequest,automaticRequest,pageView,comparisonRequest,latestTranslation;
let inputMode=false,inputModeResult='',inputModeInfo,readingBeforeInput;
let active=null, renderId=0, task=null, selection='', requestId=0;
const control=$('file');
const status=msg=>{$('status').textContent=msg;};
for(const [triggerId,panelId] of [
  ['file-menu-trigger','document-actions'],
  ['translation-menu-trigger','translation-actions'],
  ['more-reader-display','reader-display-actions']
]){
  const trigger=$(triggerId),panel=$(panelId);
  panel.addEventListener('beforetoggle',event=>{
    if(event.newState!=='open')return;
    const anchor=trigger.getBoundingClientRect();
    panel.style.top=anchor.bottom+4+'px';
    panel.style.left=Math.max(8,Math.min(anchor.left,innerWidth-(panelId==='reader-display-actions'?164:250)))+'px';
  });
  panel.addEventListener('click',event=>{
    if(event.target.closest('button')&&panel.matches(':popover-open'))panel.hidePopover();
  });
}
const motionPreference=matchMedia('(prefers-reduced-motion: no-preference)');
motionPreference.addEventListener('change',()=>{
  if(!motionPreference.matches)$('result').getAnimations().forEach(animation=>animation.cancel());
});
const noteKey=(pdf,scope)=>'dsh-notes:'+(scope?scope+':':'')+pdf.fingerprints[0];
function notesFor(key){
  try{
    const saved=JSON.parse(localStorage.getItem(key));
    return Array.isArray(saved)?saved:[];
  }catch{return [];}
}
$('legacy-note-recover').onclick=()=>{
  const doc=active;
  if(!doc?.fileScope)return;
  const legacy=noteKey(doc.pdf),draft=notesFor(legacy);
  if(!draft.length){notes();return;}
  try{
    const merged=[...doc.notes,...draft];
    localStorage.setItem(doc.key,JSON.stringify(merged));
    localStorage.removeItem(legacy);
    doc.notes=merged;
    notes();drawHighlights();
    status('已恢复旧版批注草稿。');
  }catch{status('无法恢复旧版批注草稿。');}
};
function notes(){
  $('save-original-pdf').hidden=!active?.fileId;
  $('save-original-pdf').disabled=!active?.notes.length||Boolean(active.saving);
  $('save-annotation-copy').disabled=!active;
  $('legacy-note-recover').hidden=!active?.fileScope||!notesFor(noteKey(active.pdf)).length;
  $('notes').replaceChildren();
  if(!active)return;
  const doc=active;
  for(const note of doc.notes){
    const row=document.createElement('div');row.className='note';
    const page=document.createElement('button');page.textContent='第 '+note.page+' 页';page.onclick=()=>go(note.page);
    const del=document.createElement('button');
    del.textContent=note.cropBox?'撤销裁剪':note.rotateBy?'撤销旋转':note.removeRef?'撤销删除':(note.editRef||note.styleRef)?'撤销修改':'删除';
    del.onclick=()=>{
      doc.notes=doc.notes.filter(item=>item!==note);
      saveNotes(doc);notes();drawHighlights();
      if(note.rotateBy&&active===doc)refreshRotatedThumbnails(doc,[note.page]);
      if(note.removeRef||note.editRef||note.styleRef)void showEmbeddedNotes();
    };
    row.append(page,del,document.createTextNode((note.removeRef?'待删除 · ':(note.editRef||note.styleRef)?'待修改 · ':'')+note.text));
    if(note.translation){
      const translation=document.createElement('p');translation.className='note-translation';translation.textContent=note.translation;row.append(translation);
    }
    $('notes').append(row);
  }
}
function saveNotes(doc){try{localStorage.setItem(doc.key,JSON.stringify(doc.notes));}catch{status('批注保存失败。');}}
function tabs(){
  const strip=$('tabs'),scrollLeft=strip.scrollLeft,hadFocus=strip.contains(document.activeElement);
  let activeGroup;
  strip.replaceChildren();
  window.dshDesktop?.reportBooks?.(docs.length>0);
  for(const doc of docs){
    const group=document.createElement('div');
    const select=document.createElement('button');select.textContent=select.title=doc.name;select.setAttribute('aria-current',String(doc===active));select.onclick=()=>activate(doc);
    const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label','关闭 '+doc.name);
    close.onclick=()=>{const index=docs.indexOf(doc);docs.splice(index,1);if(active===doc)activate(docs[index]??docs[index-1]??null);else{tabs();void refreshSelectionHistory();}void doc.pdf.destroy();};
    group.append(select,close);strip.append(group);
    if(doc===active)activeGroup=group;
  }
  strip.scrollLeft=scrollLeft;
  if(activeGroup){
    const view=strip.getBoundingClientRect(),tab=activeGroup.getBoundingClientRect();
    if(tab.left<view.left)strip.scrollLeft+=tab.left-view.left;
    else if(tab.right>view.right)strip.scrollLeft+=tab.right-view.right;
    if(hadFocus)activeGroup.firstElementChild.focus({preventScroll:true});
  }
}
const readerFullscreen=$('reader-fullscreen');
async function toggleReaderFullscreen(){
  try{
    if(document.fullscreenElement)await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }catch{status('无法切换全屏。');}
}
readerFullscreen.onclick=toggleReaderFullscreen;
document.addEventListener('fullscreenchange',()=>{
  const enabled=Boolean(document.fullscreenElement);
  readerFullscreen.setAttribute('aria-pressed',String(enabled));
  readerFullscreen.textContent=enabled?'退出全屏':'全屏';
});
function activate(doc){
  if(inputMode)setInputTranslationMode(false);
  cancelShapeDrag();
  flushReadingScroll();
  clearWordDictionary();
  clearTimeout(selectionTimer);clearComparison();selectionRequest?.abort();selectionRequest=null;automaticRequest=null;hidePdfSelectionMenu();$('result').removeAttribute('aria-busy');active=doc;clearDocumentTools();showQuestionSelection();refreshOutline(doc);resetThumbnails();void refreshSelectionHistory();selection='';requestId++;
  $('append-selection').checked=Boolean(doc?.appendSelection);$('lock').checked=Boolean(doc?.lockTranslation);$('source').value=doc?.source??'';$('result').textContent=doc?.result??'';latestTranslation=doc?.translationInfo;showSelectionService(latestTranslation);updateCopyButton();status('');tabs();notes();void render(doc?.readingScroll);void showEmbeddedNotes();
}
let readingScrollRender=0;
async function render(restorePosition){
  const id=++renderId, doc=active;
  task?.cancel();pageView=null;setPointMark(null);setRegionMode(false);
  $('continuous-toggle').setAttribute('aria-pressed',String(Boolean(doc?.continuous)));
  $('continuous').hidden=!doc?.continuous;
  $('scroll').hidden=Boolean(doc?.continuous);
  $('empty').hidden=Boolean(doc);$('paper').replaceChildren();
  document.dispatchEvent(new Event('dsh-page-change'));
  $('page').value=doc?.page??1;$('page').max=doc?.pdf.numPages??1;
  $('total').textContent='/ '+(doc?.pdf.numPages??0);
  syncZoom(doc?.scale??1);
  zoomSelect.disabled=!doc;
  $('fit').setAttribute('aria-pressed',String(Boolean(doc?.fit)));
  if(!doc?.continuous&&continuousDoc){
    continuousViewer?.linkService.setDocument(null);
    continuousViewer?.setDocument(null);
    continuousDoc=null;
  }
  if(!doc)return;
  if(doc.continuous){await renderContinuous(doc,id,restorePosition);return;}
  try{
    const page=await doc.pdf.getPage(doc.page);
    if(id!==renderId)return;
    const rotation=(page.rotate+doc.rotation)%360;
    if(doc.fit){
      const scroll=$('scroll'), style=getComputedStyle(scroll);
      const available=scroll.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      const scale=available/page.getViewport({scale:1,rotation}).width;
      if(scale>0)doc.scale=Math.max(.1,Math.min(4,scale-.001));
    }
    syncZoom(doc.scale);
    const view=page.getViewport({scale:doc.scale,rotation});
    const textView=page.getViewport({scale:doc.scale,rotation:0});
    const canvas=document.createElement('canvas'), layer=document.createElement('div');
    const density=window.devicePixelRatio||1;
    canvas.width=Math.ceil(view.width*density);canvas.height=Math.ceil(view.height*density);
    canvas.style.width=view.width+'px';canvas.style.height=view.height+'px';
    layer.className='textLayer';layer.style.setProperty('--total-scale-factor',view.scale);
    layer.style.setProperty('--scale-round-x','1px');layer.style.setProperty('--scale-round-y','1px');layer.style.transformOrigin='top left';
    const translations={90:[view.width,0],180:[view.width,view.height],270:[0,view.height]};
    if(rotation){
      const [x,y]=translations[rotation];
      layer.style.transform='translate('+x+'px,'+y+'px) rotate('+rotation+'deg)';
    }
    $('paper').append(canvas,layer);
    const currentView={doc,page:doc.page,viewport:view,embeddedHighlights:[]};
    pageView=currentView;
    drawHighlights();
    void page.getAnnotations().then(annotations=>{
      if(pageView!==currentView)return;
      addSinglePageLinks(currentView,annotations);
      currentView.embeddedHighlights=annotations.flatMap(annotation=>{
        if(!['Highlight','Underline','StrikeOut','Squiggly'].includes(annotation.subtype)||annotation.hasAppearance||!annotation.quadPoints?.length)return [];
        const points=Array.from(annotation.quadPoints),quads=[];
        for(let index=0;index+7<points.length;index+=8)quads.push(points.slice(index,index+8));
        return [{page:currentView.page,quads,color:annotation.color,markup:annotation.subtype}];
      });
      drawHighlights();
    }).catch(()=>{});

    task=page.render({canvas,viewport:view,transform:[density,0,0,density,0,0]});
    await Promise.all([task.promise,new TextLayer({textContentSource:page.streamTextContent(),container:layer,viewport:textView}).render()]);
    if(id===renderId){
      $('scroll').scrollTo({top:0,left:0,behavior:'instant'});
      restoreReadingScroll(doc,restorePosition);
      readingScrollRender=id;
    }
  }catch(error){if(id===renderId&&error.name!=='RenderingCancelledException')status('PDF 显示失败：'+error.message);}
}
async function load(files,{dropped=false,fileId,fileScope}={}){
  await initialEngines;
  for(const file of files){
    if(!/\.pdf$/i.test(file.name))continue;
    try{
      const bytes=await file.arrayBuffer();
      const loading=getDocument({data:bytes.slice(0),cMapUrl:'/pdf/cmaps/',standardFontDataUrl:'/pdf/standard_fonts/',wasmUrl:'/pdf/wasm/'});
      loading.onPassword=async(update,reason)=>{const password=await askForText(reason===2?'密码有误，请重试':'请输入 PDF 密码','','password');if(password===null)void loading.destroy();else update(password);};
      const pdf=await loading.promise;
      const key=noteKey(pdf,fileScope);
      const reading=restoreReading(pdf);
      const doc={pdf,key,bytes,fileId,fileScope,name:file.name,...reading,source:'',result:'',notes:notesFor(key)};
      docs.push(doc);activate(doc);
      if(dropped)void Promise.resolve().then(()=>window.dshDesktop?.rememberDroppedPdf?.(file)).catch(()=>{});
    }catch(error){status('打开 '+file.name+' 失败：'+error.message);}
  }
}
function goBoundary(end){
  if(!active)return;
  if(!active.continuous){go(end?active.pdf.numPages:1);return;}
  const view=$('continuous');
  view.scrollTop=end?view.scrollHeight:0;
}
$('first-page').onclick=()=>goBoundary(false);
$('last-page').onclick=()=>goBoundary(true);
function go(value){if(active&&Number.isFinite(value)){const next=Math.max(1,Math.min(active.pdf.numPages,Math.trunc(value)));if(next!==active.page){clearTimeout(selectionTimer);selection='';clearSelectionDictionary();}clearRegionStatus();active.page=next;saveReading(active);return render();}}
const zoomSelect=$('zoom'),customZoom=new Option('','');
customZoom.disabled=true;
function syncZoom(scale){
  const percent=String(Math.round(scale*100));
  customZoom.remove();
  if(![...zoomSelect.options].some(option=>option.value===percent)){
    customZoom.value=percent;
    customZoom.textContent=percent+'%';
    zoomSelect.prepend(customZoom);
  }
  zoomSelect.value=percent;
}
function setZoom(scale){
  if(!active)return;
  active.fit=false;active.scale=Math.max(.5,Math.min(3,scale));
  saveReading(active);void render();
}
function zoom(delta){if(active)setZoom(active.scale+delta);}
function zoomWithWheel(event){
  if(!active||!event.ctrlKey||!event.deltaY)return;
  event.preventDefault();
  const doc=active;
  const units=event.deltaMode===1?16:event.deltaMode===2?120:1;
  const factor=Math.exp(-Math.max(-150,Math.min(150,event.deltaY*units))*.003);
  const next=Math.round(Math.max(.5,Math.min(3,doc.scale*factor))*100)/100;
  if(next===doc.scale)return;
  if(doc.continuous){
    if(!viewerReady||continuousDoc!==doc)return;
    doc.fit=false;
    $('fit').setAttribute('aria-pressed','false');
    continuousViewer.updateScale({scaleFactor:next/doc.scale,origin:[event.clientX,event.clientY]});
    saveReading(doc);
  }else{
    setZoom(next);
  }
}
for(const surface of [$('scroll'),$('continuous')]){
  surface.addEventListener('wheel',zoomWithWheel,{passive:false});
}
zoomSelect.onchange=()=>setZoom(Number(zoomSelect.value)/100);
const wordDictionary=$('word-dictionary');
let dictionaryRequest, dictionaryFromPdfSelection=false;
function clearSelectionDictionary(){
  if(dictionaryFromPdfSelection)clearWordDictionary();
}
function clearWordDictionary(){
  dictionaryRequest?.abort();
  dictionaryRequest=null;
  dictionaryFromPdfSelection=false;
  wordDictionary.hidden=true;
  wordDictionary.replaceChildren();
}
function lookupWord(text,isCurrent,{fromPdfSelection=false}={}){
  clearWordDictionary();
  dictionaryFromPdfSelection=fromPdfSelection;
  const controller=new AbortController();
  dictionaryRequest=controller;
  void showWordDictionary(text,controller.signal,isCurrent).catch(()=>{});
}
async function showWordDictionary(word,signal,isCurrent){
  word=word.toLowerCase();
  if(!/^[a-z][a-z'-]{0,49}$/.test(word))return;
  await initialEngines;
  if(signal.aborted||!isCurrent())return;
  const engineName=$('engine').value;
  if(engineName==='local'||engineName==='local-qwen')return;
  if(engineName==='ai'){
    const capabilities=await fetch('/capabilities',{signal});
    if(!capabilities.ok||(await capabilities.json()).localAIActive)return;
  }
  const response=await fetch('/dictionary/'+word,{signal});
  if(!response.ok)return;
  const entries=await response.json();
  if(signal.aborted||!isCurrent()||!entries.length)return;
  const title=document.createElement('h2');
  title.textContent='英语词典 · '+word;
  const list=document.createElement('ul');
  for(const meaning of entries.flatMap(entry=>entry.meanings??[]).slice(0,6)){
    const definition=meaning.definitions?.[0]?.definition;
    if(!definition)continue;
    const item=document.createElement('li');
    item.textContent=meaning.partOfSpeech+' · '+definition;
    list.append(item);
  }
  wordDictionary.append(title,list);
  const seen=new Set();
  for(const {text,audio} of entries.flatMap(entry=>entry.phonetics??[])){
    if(!text||seen.has(text+'|'+audio))continue;
    seen.add(text+'|'+audio);
    const row=document.createElement('div');
    row.textContent=text+' ';
    if(/^https:\/\/api\.dictionaryapi\.dev\/media\/pronunciations\/en\/[a-z0-9_.-]+\.mp3$/i.test(audio)){
      const player=document.createElement('audio');
      player.controls=true;
      player.preload='none';
      player.src=audio;
      player.setAttribute('aria-label',audio.endsWith('-us.mp3')?'美式发音':audio.endsWith('-uk.mp3')?'英式发音':'单词发音');
      player.addEventListener('error',()=>{player.replaceWith(document.createTextNode('录音暂不可用'));},{once:true});
      row.append(player);
    }
    wordDictionary.append(row);
  }
  const speech=window.speechSynthesis;
  if(speech){
    const voices=document.createElement('div');
    voices.className='actions';
    const addVoices=()=>{
      voices.replaceChildren();
      for(const [locale,label] of [['en-US','美式朗读'],['en-GB','英式朗读']]){
        const voice=speech.getVoices().find(v=>v.localService&&v.lang===locale);
        if(!voice)continue;
        const button=document.createElement('button');
        button.type='button';
        button.textContent=label;
        button.onclick=()=>{
          speech.cancel();
          const utterance=new SpeechSynthesisUtterance(word);
          utterance.voice=voice;
          utterance.lang=locale;
          speech.speak(utterance);
        };
        voices.append(button);
      }
    };
    addVoices();
    if(!voices.childElementCount)speech.addEventListener('voiceschanged',addVoices,{once:true,signal});
    wordDictionary.append(voices);
  }
  const credit=document.createElement('a');
  credit.textContent='词条来源：Wiktionary';
  credit.href='https://en.wiktionary.org/wiki/'+encodeURIComponent(word);
  credit.target='_blank';
  credit.rel='noopener noreferrer';
  wordDictionary.append(credit);
  wordDictionary.hidden=false;
}
function shownAiModel(model,thinking){
  return model&&thinking?model+'（思考模式）':model;
}
function showSelectionService(entry){
  const meta=$('selection-result-service');
  const engine=entry?.engine&&[...$('engine').options].find(option=>option.value===entry.engine);
  const source=entry?.model||engine?.label.replace(/（需配置）$/,'');
  const label=[source,translationUsage(entry?.usage).text()].filter(Boolean).join(' · ');
  meta.textContent=label;
  meta.hidden=!label;
}
async function translate({automatic=false,originPage,manual=false}={}){
  clearComparison();
  const input=$(manual?'input-translation-text':'source'),text=input.value.trim();
  if(!text){status('请选择或输入原文。');return;}
  const id=++requestId, doc=manual?null:active,page=originPage??doc?.page;
  const manualId=manual?crypto.randomUUID():undefined;
  selectionRequest?.abort();
  const controller=new AbortController();
  selectionRequest=controller;
  if(manual)$('source').value=text;
  lookupWord(text,()=>input.value.trim()===text);
  automaticRequest=automatic?controller:null;
  status('正在翻译…'); $('result').setAttribute('aria-busy','true');updateCopyButton();
  let manualEntry;
  try{
    await initialEngines;
    controller.signal.throwIfAborted();
    const direction=$('translation-direction').value;
    const engine=$('engine').value, fallback=$('fallback-engine').value;
    const split=$('split-paragraphs').checked;
    const paragraphs=split?text.split(/\r?\n(?:[ \t]*\r?\n)+|\r?\n(?=[ \t]{2,}\S)/u).map(part=>part.trim()).filter(Boolean):[text];
    if(manual)manualEntry={entryId:manualId,text,engine,direction,paragraphs,createdAt:Date.now()};
    let result,model=engine==='local-qwen'?'本地 Qwen 2.5':undefined,usedFallback=false;
    let usage=translationUsage();
    let allowFallback=!['local','local-qwen','ai'].includes(engine);
    try{
      const capabilities=engine==='ai'?await getCapabilities(controller.signal):null;
      if(capabilities){
        allowFallback=!capabilities.localAIActive;
        model=capabilities.localAIActive?'本地 Qwen 2.5':shownAiModel(capabilities.aiModel,capabilities.aiThinking);
      }
      result=await translateParagraphs(paragraphs,engine,controller.signal,direction,capabilities?.aiService??null,usage.add);
    }catch(error){
      if(!allowFallback||!fallback||fallback===engine||controller.signal.aborted||id!==requestId||error.code==='AI_SERVICE_CHANGED')throw error;
      const label=$('fallback-engine').selectedOptions[0].textContent;
      status('主引擎失败，正在使用 '+label+'…');
      const service=fallback==='ai'?await getCapabilities(controller.signal):null;
      model=fallback==='local-qwen'||service?.localAIActive?'本地 Qwen 2.5':shownAiModel(service?.aiModel,service?.aiThinking);
      usage=translationUsage();
      result=await translateParagraphs(paragraphs,fallback,controller.signal,direction,service?.aiService??null,usage.add);
      usedFallback=true;
    }
    if(id!==requestId)return;
    const resultPanel=$('result');
    resultPanel.textContent=result;
    if(motionPreference.matches){
      resultPanel.getAnimations().forEach(animation=>animation.cancel());
      const easing=getComputedStyle(resultPanel).getPropertyValue('--dsh-motion-quick').trim();
      resultPanel.animate([{opacity:.65,transform:'translateY(2px)'},{opacity:1,transform:'translateY(0)'}],{duration:110,easing});
    }
    latestTranslation={text,engine:usedFallback?fallback:engine,paragraphs,direction,model,usage:usage.snapshot()};
    showSelectionService(latestTranslation);
    if(manual){
      inputModeResult=result;inputModeInfo=latestTranslation;
      void addSelectionHistory(null,{...manualEntry,...latestTranslation,result});
    }
    if(doc){
      doc.result=result;doc.translationInfo=latestTranslation;
      void addSelectionHistory(doc,{...latestTranslation,result,page,createdAt:Date.now()});
    }
    status(usedFallback?'已使用备用引擎：'+$('engine').querySelector('[value='+fallback+']').textContent:'');
  }catch(error){
    if(id===requestId){
      status(error.message);
      if(manualEntry&&!controller.signal.aborted)void addSelectionHistory(null,{...manualEntry,result:''});
    }
  }
  finally{if(id===requestId){selectionRequest=null;automaticRequest=null;$('result').removeAttribute('aria-busy');updateCopyButton();}}
}
$('open').onclick=()=>{void choosePdf();};control.onchange=()=>{void load([...control.files]);control.value='';};
document.addEventListener('dragover',event=>{event.preventDefault();});
document.addEventListener('drop',async event=>{
  event.preventDefault();
  const files=[...event.dataTransfer.files];
  for(const file of files){
    if(!/\.pdf$/i.test(file.name))continue;
    try{if(await window.dshDesktop?.routeDroppedPdf?.(file))continue;}
    catch(error){status('无法打开拖入的文件 '+file.name+'：'+error.message);continue;}
    await load([file],{dropped:true});
  }
});
$('prev').onclick=()=>{if(active)go(active.page-1);};$('next').onclick=()=>{if(active)go(active.page+1);};
$('page').onchange=()=>go($('page').valueAsNumber);$('out').onclick=()=>zoom(-.25);$('in').onclick=()=>zoom(.25);

let selectionTimer,previousSelectionRange,dragging=false;
for(const surface of [$('paper'),$('continuous')])surface.addEventListener('pointerdown',()=>{dragging=true;clearTimeout(selectionTimer);});
document.addEventListener('pointerup',()=>{if(dragging){dragging=false;scheduleSelection();}});
document.addEventListener('pointercancel',()=>{dragging=false;});
document.addEventListener('selectionchange',()=>{if(!dragging)scheduleSelection();});
function cancelInputTranslationRequest(){
  requestId++;
  selectionRequest?.abort();selectionRequest=null;automaticRequest=null;
  $('result').removeAttribute('aria-busy');
  clearWordDictionary();clearComparison();status('');
}
function setInputTranslationMode(enabled){
  if(inputMode===enabled)return;
  inputMode=enabled;
  cancelInputTranslationRequest();
  clearTimeout(selectionTimer);hidePdfSelectionMenu();
  if(!enabled)inputEditorMenu.hidePopover();
  const source=$('source'),result=$('result'),panel=$('input-translation-panel');
  if(enabled){
    const view=$(active?.continuous?'continuous':'scroll');
    readingBeforeInput={source:source.value,result:result.textContent,info:latestTranslation,view,top:view.scrollTop,left:view.scrollLeft};
  }
  $('reader').classList.toggle('input-translation-active',enabled);
  $('input-translation-mode').setAttribute('aria-pressed',String(enabled));
  panel.hidden=!enabled;
  $('selection-source-editor').hidden=enabled;
  $('selection-history').hidden=enabled;
  if(enabled){
    selectWorkspace('selection');
    source.value=inputModeInfo?.text??'';
    result.textContent=inputModeResult;latestTranslation=inputModeInfo;
    $('input-translation-text').focus();
  }else{
    const previous=readingBeforeInput;
    source.value=previous.source;result.textContent=previous.result;latestTranslation=previous.info;
    previous.view.scrollTo({top:previous.top,left:previous.left,behavior:'instant'});
    readingBeforeInput=null;
  }
  showSelectionService(latestTranslation);
  updateCopyButton();
}
$('input-translation-mode').onclick=()=>setInputTranslationMode(!inputMode);
$('input-translation-close').onclick=()=>{
  setInputTranslationMode(false);
  $('translation-menu-trigger').focus();
};
$('input-translation-panel').onsubmit=event=>{event.preventDefault();void translate({manual:true});};
$('input-translation-clear').onclick=()=>{
  cancelInputTranslationRequest();
  $('input-translation-text').value='';
  $('source').value='';$('result').textContent='';
  inputModeResult='';inputModeInfo=latestTranslation=undefined;
  showSelectionService();updateCopyButton();
  $('input-translation-text').focus();
};
function scheduleSelection(){
  clearTimeout(selectionTimer);
  selectionTimer=setTimeout(()=>{
    if(!active||inputMode)return;
    const range=getSelection();
    const container=active.continuous?$('continuous-pages'):$('paper');
    const inText=node=>node&&container.contains(node)&&(node.nodeType===1?node:node.parentElement)?.closest('.textLayer');
    if(!range?.rangeCount||range.isCollapsed||!inText(range.anchorNode)||!inText(range.focusNode)){
      previousSelectionRange=null;
      return;
    }
    const selected=range.getRangeAt(0);
    const text=normalizePdfText(range.toString());
    if(!text)return;
    if(text===selection&&previousSelectionRange&&
       selected.startContainer===previousSelectionRange.startContainer&&selected.startOffset===previousSelectionRange.startOffset&&
       selected.endContainer===previousSelectionRange.endContainer&&selected.endOffset===previousSelectionRange.endOffset)return;
    previousSelectionRange=selected.cloneRange();
    selection=text;
    if($('lock').checked){
      if($('work-selection').hidden)return;
      const doc=active;
      lookupWord(text,()=>active===doc&&$('lock').checked&&normalizePdfText(getSelection()?.toString()??'')===text,{fromPdfSelection:true});
      return;
    }
    const previous=$('source').value.trim();
    const original=$('append-selection').checked&&previous?normalizePdfText(previous+'\n'+text):text;
    $('source').value=original;active.source=original;updateCopyButton();
    if($('auto').checked){
      selectWorkspace('selection');
      const scroller=$('translation-scroll');
      const viewport=scroller.getBoundingClientRect();
      const title=$('result').previousElementSibling.getBoundingClientRect();
      if(title.top<viewport.top||title.bottom+44>viewport.bottom){
        scroller.scrollTop+=title.top-viewport.top;
      }
      const start=selected.startContainer;
      const element=start.nodeType===1?start:start.parentElement;
      const originPage=Number(element?.closest('.page')?.dataset.pageNumber)||active.page;
      void translate({automatic:true,originPage});}
  },120);
}
$('source').oninput=()=>{clearWordDictionary();clearComparison();if(active)active.source=$('source').value;updateCopyButton();};
$('translate').onclick=()=>{void translate();};
const sourceMenu=document.createElement('div');
sourceMenu.className='source-context';
sourceMenu.setAttribute('popover','auto');
const retranslate=document.createElement('button');
retranslate.type='button';
retranslate.textContent='重新翻译原文';
sourceMenu.append(retranslate);
document.body.append(sourceMenu);
$('source').addEventListener('contextmenu',event=>{
  if(!$('source').value.trim())return;
  event.preventDefault();
  sourceMenu.showPopover();
  sourceMenu.style.left=Math.min(event.clientX,innerWidth-sourceMenu.offsetWidth)+'px';
  sourceMenu.style.top=Math.min(event.clientY,innerHeight-sourceMenu.offsetHeight)+'px';
  retranslate.focus();
});
retranslate.onclick=()=>{
  sourceMenu.hidePopover();
  $('source').focus();
  void translate();
};
const inputEditor=$('input-translation-text');
const inputEditorMenu=document.createElement('div');
inputEditorMenu.className='source-context';
inputEditorMenu.setAttribute('popover','auto');
function editorMenuAction(label,action){
  const button=document.createElement('button');
  button.type='button';
  button.textContent=label;
  button.onclick=async()=>{
    inputEditorMenu.hidePopover();
    inputEditor.focus();
    try{await action();}
    catch{status('无法'+label+'，请检查剪贴板权限。');}
  };
  inputEditorMenu.append(button);
  return button;
}
const inputCopy=editorMenuAction('复制',()=>navigator.clipboard.writeText(inputEditor.value.slice(inputEditor.selectionStart,inputEditor.selectionEnd)));
const inputPaste=editorMenuAction('粘贴',async()=>{
  const text=await navigator.clipboard.readText();
  if(!inputMode)return;
  inputEditor.setRangeText(text,inputEditor.selectionStart,inputEditor.selectionEnd,'end');
  inputEditor.dispatchEvent(new Event('input',{bubbles:true}));
});
editorMenuAction('全选',()=>inputEditor.select());
document.body.append(inputEditorMenu);
inputEditor.addEventListener('contextmenu',event=>{
  event.preventDefault();
  inputCopy.disabled=inputEditor.selectionStart===inputEditor.selectionEnd;
  inputEditorMenu.showPopover();
  const bounds=inputEditor.getBoundingClientRect();
  const x=event.clientX||bounds.left,y=event.clientY||bounds.top;
  inputEditorMenu.style.left=Math.max(0,Math.min(x,innerWidth-inputEditorMenu.offsetWidth))+'px';
  inputEditorMenu.style.top=Math.max(0,Math.min(y,innerHeight-inputEditorMenu.offsetHeight))+'px';
  (inputCopy.disabled?inputPaste:inputCopy).focus();
});
inputEditor.oninput=()=>{if(selectionRequest)cancelInputTranslationRequest();};
function updateCopyButton(){
  $('copy').disabled=Boolean(selectionRequest)||!$('result').textContent||
    latestTranslation?.text!==$('source').value.trim();
}
updateCopyButton();
$('copy').onclick=async()=>{
  updateCopyButton();
  if($('copy').disabled)return;
  try{await navigator.clipboard.writeText($('result').textContent);status('译文已复制。');}
  catch{status('无法写入剪贴板。');}
};
$('mark').onclick=async()=>{if(!active)return;const doc=active,page=doc.page;const text=await askForText('输入本页批注',selection);if(text?.trim()){doc.notes.push({page,text:text.trim()});saveNotes(doc);notes();}};


async function translateParagraphs(paragraphs,engine,signal,direction,aiService,onUsage){
  if(engine==='ai'&&aiService===undefined)aiService=await getAiService(signal);
  if(engine!=='ai')aiService=undefined;
  const translation=[];
  for(const paragraph of paragraphs){
    const parts=engine==='mymemory'?chunks(paragraph,490):engine==='baidu'?chunks(paragraph,950):[paragraph];
    const translated=[];
    for(const part of parts){
      signal.throwIfAborted();
      translated.push(await translateText(part,engine,signal,{direction,aiService,onUsage}));
    }
    translation.push(joinTranslationParts(translated));
  }
  return translation.join('\n\n');
}
async function translateText(text,engine,signal,{useGlossary=true,direction='en-zh',aiService,onUsage}={}){
  const glossary=(engine==='ai'||engine==='local-qwen')&&useGlossary?$('glossary').value:undefined;
  const response=await fetch('/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,engine,glossary,direction,aiService}),signal});
  const data=await response.json().catch(()=>null);
  if(!response.ok){
    const fallback=response.status===413?'原文过长，请缩短后重试。':'翻译失败，请检查服务设置后重试。';
    const error=Error(data?.error??fallback);
    error.code=data?.code;
    throw error;
  }
  if(typeof data?.result!=='string')throw Error('翻译服务未返回译文。');
  const {input,output,reasoning}=data.usage??{};
  if(Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0){
    const validReasoning=Number.isSafeInteger(reasoning)&&reasoning>=0&&reasoning<=output;
    onUsage?.(validReasoning?{input,output,reasoning}:{input,output});
  }
  return data.result;
}
const clearDocumentTools=addDocumentTools({getActive:()=>active,go,translateText,status,recognizePage,getCapabilities,getQuestionModel});
const engine=$('engine');
const fallbackEngine=$('fallback-engine'), compareEngine=$('compare-engine');
for(const option of engine.options)compareEngine.append(option.cloneNode(true));
compareEngine.value='libre';
for(const option of engine.options)fallbackEngine.append(option.cloneNode(true));
try{const saved=localStorage.getItem('dsh-fallback-engine');if([...fallbackEngine.options].some(option=>option.value===saved))fallbackEngine.value=saved;}catch{}
fallbackEngine.onchange=()=>{try{localStorage.setItem('dsh-fallback-engine',fallbackEngine.value);}catch{}};
let activeAiModel='',aiRunsLocally=false;
function showFullTranslationEngine(){
  const detail=$('full-engine-detail');
  if(engine.value==='local'||engine.value==='local-qwen'||(engine.value==='ai'&&aiRunsLocally)){
    detail.textContent='新任务 · '+(engine.value==='local'?'本地轻量翻译':'本地 Qwen 2.5')+' · 在本机逐页翻译';
  }else if(engine.value==='ai'&&!activeAiModel){
    detail.textContent='请先在服务设置中配置 AI 模型。';
  }else{
    const model=engine.value==='ai'?activeAiModel:engine.selectedOptions[0]?.textContent;
    detail.textContent='新任务 · '+model+' · 逐页将文字发送给所选服务';
  }
}
const savedEngine=localStorage.getItem('dsh-engine');
let engineChosen=[...engine.options].some(option=>option.value===savedEngine);
let engineCapabilities;
const resetEngine=$('reset-translation-engine');
function updateAutomaticEngine(){
  resetEngine.hidden=!engineChosen;
  if(!engineChosen&&engineCapabilities){
    const englishToChinese=$('translation-direction').value==='en-zh';
    engine.value=englishToChinese&&engineCapabilities.local?'local':engineCapabilities.bundledAI?'local-qwen':'mymemory';
  }
  showFullTranslationEngine();
}
if(engineChosen)engine.value=savedEngine;
resetEngine.hidden=!engineChosen;
engine.onchange=()=>{
  engineChosen=true;
  updateAutomaticEngine();
  localStorage.setItem('dsh-engine',engine.value);
  if(!inputMode&&!$('work-selection').hidden&&$('source').value.trim())void translate();
};

resetEngine.onclick=()=>{
  engineChosen=false;
  localStorage.removeItem('dsh-engine');
  updateAutomaticEngine();
  engine.focus();
  if(!inputMode&&!$('work-selection').hidden&&$('source').value.trim())void translate();
};
let settingsReadFailed=false;
const settingsReadWarning='服务设置读取失败，已按默认配置打开。请检查后重新保存服务设置。';
async function refreshEngines(){
  const response=await fetch('/capabilities');
  if(!response.ok)throw Error('Unable to read service capabilities');
  const capabilities=await response.json();
  engineCapabilities=capabilities;
  if(capabilities.settingsReadFailed&&!settingsReadFailed)status(settingsReadWarning);
  settingsReadFailed=Boolean(capabilities.settingsReadFailed);
  const activeModel=$('active-ai-model');
  activeAiModel=capabilities.aiModel??'';
  aiRunsLocally=Boolean(capabilities.localAIActive);
  const model=capabilities.localAIActive?'本地 Qwen 2.5':shownAiModel(capabilities.aiModel,capabilities.aiThinking);
  activeModel.hidden=!model;
  activeModel.textContent=model?'默认 AI 模型 · '+model:'';
  $('ai-model-preset').querySelector('[value=qwen-local]').disabled=!capabilities.bundledAI;
  for(const [key,name] of Object.entries({local:'本地轻量翻译','local-qwen':'本地 Qwen 双向翻译',google:'谷歌云翻译',youdao:'有道翻译',baidu:'百度翻译',libre:'LibreTranslate',deepl:'DeepL',ai:'AI 学术翻译'})){
    for(const select of [engine,fallbackEngine,compareEngine])select.querySelector('[value='+key+']').textContent=name+((key==='local-qwen'?capabilities.bundledAI:capabilities[key])?'':'（需配置）');
  }
  updateAutomaticEngine();
}
showFullTranslationEngine();
const initialEngines=refreshEngines().catch(()=>{});
window.addEventListener('focus',()=>{void refreshEngines().catch(()=>{});});
const settingsDialog=$('settings-dialog'),settingsForm=$('settings-form');
async function showLocalModelBackend(){
  const label=$('local-model-backend');
  try{
    const {bundledAI,bundledBackend}=await getCapabilities();
    label.hidden=!bundledAI;
    label.textContent=bundledBackend?.kind==='vulkan'?'本地 Qwen · GPU（Vulkan） · '+bundledBackend.device:
      bundledBackend?.kind==='cpu'?'本地 Qwen · CPU':'本地 Qwen · 尚未启动，首次请求时自动选择设备';
  }catch{label.hidden=true;}
}
$('settings').addEventListener('click',()=>{void showLocalModelBackend();});
const aiPreset=$('ai-model-preset');
const deepSeekUrl='https://api.deepseek.com/chat/completions';
const bundledAiUrl='http://127.0.0.1/dsh-local';
const aiUrl=settingsForm.elements.namedItem('DSH_AI_URL');
const aiModel=settingsForm.elements.namedItem('DSH_AI_MODEL');
const aiKey=settingsForm.elements.namedItem('DSH_AI_KEY'),clearAiKey=$('clear-ai-key');
const modelsButton=$('deepseek-models'),modelsList=$('deepseek-model-list');
const modelsSelect=$('deepseek-model-select'),modelsResult=$('deepseek-model-result');
let modelsRequest,modelsForUrl,availableModels=[];
function showDeepSeekModelDetails(){
  const model=availableModels.find(item=>item.id===modelsSelect.value);
  const input=model?.input?.map(value=>value==='image'?'图像':'文本').join('、');
  const details=[
    model?.contextWindow?'上下文 '+model.contextWindow.toLocaleString()+' token':'',
    model?.maxOutputTokens?'输出上限 '+model.maxOutputTokens.toLocaleString()+' token':'',
    input?'输入：'+input:''
  ].filter(Boolean);
  modelsResult.textContent=details.join(' · ');
  modelsResult.hidden=!details.length;
}
modelsButton.onclick=async()=>{
  const controller=new AbortController();
  modelsRequest=controller;
  modelsButton.disabled=true;
  const requestedUrl=aiUrl.value.trim();
  modelsList.hidden=true;
  modelsResult.hidden=false;
  modelsResult.textContent='正在读取模型列表…';
  try{
    const currentKey=clearAiKey.checked?'':aiKey.value.trim()||undefined;
    const official=URL.canParse(requestedUrl)&&new URL(requestedUrl).origin==='https://api.deepseek.com';
    const useSavedOfficial=official&&currentKey===undefined;
    const response=await fetch(useSavedOfficial?'/deepseek-models':'/compatible-models',{
      method:'POST',signal:controller.signal,
      ...(useSavedOfficial?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify({url:requestedUrl,key:currentKey})})
    });
    const data=await response.json();
    if(aiUrl.value.trim()!==requestedUrl||controller.signal.aborted)return;
    if(!response.ok)throw Error(data.error??'无法读取模型列表。');
    modelsForUrl=requestedUrl;
    modelsSelect.replaceChildren(new Option('选择模型',''),...data.map(({id,name})=>new Option(name===id?id:name+' · '+id,id)));
    availableModels=data;
    modelsList.hidden=!data.length;
    if(data.length){
      modelsSelect.value=data.some(({id})=>id===aiModel.value)?aiModel.value:'';
      showDeepSeekModelDetails();
    }else{
      modelsResult.textContent='服务未返回可选模型，可手动输入。';
    }
  }catch(error){
    if(!controller.signal.aborted)modelsResult.textContent=error.message;
  }finally{
    if(modelsRequest===controller){modelsRequest=null;modelsButton.disabled=false;}
  }
};
modelsSelect.onchange=()=>{
  if(!modelsSelect.value){showDeepSeekModelDetails();return;}
  if(aiUrl.value.trim()!==modelsForUrl){
    modelsSelect.value='';
    modelsResult.hidden=false;
    modelsResult.textContent='接口地址已变更，请重新读取模型列表。';
    return;
  }
  aiModel.value=modelsSelect.value;
  syncAiPreset();
  showDeepSeekModelDetails();
};
aiUrl.addEventListener('input',()=>{
  modelsRequest?.abort();
  modelsList.hidden=modelsResult.hidden=true;
});
settingsDialog.addEventListener('close',()=>{
  modelsRequest?.abort();
  modelsList.hidden=modelsResult.hidden=true;
});
const balanceButton=$('deepseek-balance'),balanceResult=$('deepseek-balance-result');
let balanceRequest;
balanceButton.onclick=async()=>{
  const controller=new AbortController();
  balanceRequest=controller;
  balanceButton.disabled=true;
  balanceResult.hidden=false;
  balanceResult.textContent='正在查询 DeepSeek 余额…';
  try{
    const response=await fetch('/deepseek-balance',{method:'POST',signal:controller.signal});
    const data=await response.json();
    if(!response.ok)throw Error(data.error??'无法查询 DeepSeek 余额。');
    const totals=data.balances.map(({currency,total})=>currency+' '+total);
    balanceResult.textContent=[...totals,data.available?'可调用 API':'当前余额不足以调用 API'].join(' · ');
  }catch(error){
    if(!controller.signal.aborted)balanceResult.textContent=error.message;
  }finally{
    if(balanceRequest===controller){balanceRequest=null;balanceButton.disabled=false;}
  }
};
settingsDialog.addEventListener('close',()=>{
  balanceRequest?.abort();
  balanceResult.hidden=true;
  balanceResult.textContent='';
});
clearAiKey.onchange=()=>{aiKey.disabled=clearAiKey.checked;};
function syncAiPreset(){
  const supported=URL.canParse(aiUrl.value)&&new URL(aiUrl.value).origin==='https://api.deepseek.com'&&
    ['deepseek-flash','deepseek-v4-pro'].includes(aiModel.value);
  $('ai-thinking-option').hidden=!supported;
  settingsForm.elements.namedItem('DSH_AI_THINKING').disabled=!supported;
  if(aiUrl.value===bundledAiUrl&&aiModel.value==='qwen-local'){aiPreset.value='qwen-local';return;}
  aiPreset.value=aiUrl.value===deepSeekUrl&&['deepseek-flash','deepseek-v4-pro'].includes(aiModel.value)?aiModel.value:'custom';
}
aiPreset.onchange=()=>{
  if(aiPreset.value==='custom'){aiUrl.focus();return;}
  aiUrl.value=aiPreset.value==='qwen-local'?bundledAiUrl:deepSeekUrl;
  aiModel.value=aiPreset.value;
  syncAiPreset();
};
for(const field of [aiUrl,aiModel])field.addEventListener('input',syncAiPreset);
fetch('/settings').then(response=>{$('settings').hidden=!response.ok;}).catch(()=>{});
$('settings').onclick=async()=>{
  const response=await fetch('/settings');
  if(!response.ok)return;
  settingsForm.reset();
  aiKey.disabled=false;
  for(const [key,value] of Object.entries(await response.json()))settingsForm.elements.namedItem(key).value=value;
  if(!aiUrl.value&&!aiModel.value){
    aiPreset.value='deepseek-flash';
    aiPreset.onchange();
  }else syncAiPreset();
  $('settings-status').textContent=settingsReadFailed?settingsReadWarning:'';
  settingsDialog.showModal();
};
$('settings-close').onclick=()=>settingsDialog.close();
const settingsBackupType='dsh-service-settings';
const portableSettingsKeys=['DSH_AI_URL','DSH_AI_MODEL','DSH_AI_THINKING','DSH_TRANSLATE_URL','DSH_BAIDU_APP_ID','DSH_YOUDAO_APP_ID'];
function portableSettingsValue(key,value){
  if(typeof value!=='string'||value.length>2048)throw Error('备份中的服务设置格式无效。');
  if(key==='DSH_AI_THINKING'&&value!==''&&value!=='enabled')throw Error('备份中的 DeepSeek 思考模式无效。');
  if(!value||!key.endsWith('_URL'))return value;
  let url;
  try{url=new URL(value);}catch{throw Error('备份中的服务地址无效。');}
  if(!['http:','https:'].includes(url.protocol))throw Error('备份中的服务地址必须使用 HTTP 或 HTTPS。');
  url.username=url.password=url.search=url.hash='';
  return url.href;
}
$('settings-export').onclick=async()=>{
  try{
    const response=await fetch('/settings');
    if(!response.ok)throw Error('无法读取服务设置。');
    const saved=await response.json();
    const values=Object.fromEntries(portableSettingsKeys.map(key=>[key,portableSettingsValue(key,saved[key]??'')]));
    const data=JSON.stringify({type:settingsBackupType,version:1,values},null,2);
    const url=URL.createObjectURL(new Blob([data],{type:'application/json;charset=utf-8'}));
    const link=document.createElement('a');
    link.href=url;link.download='Dsh-服务设置.json';
    link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    $('settings-status').textContent='已导出服务设置。';
  }catch(error){$('settings-status').textContent=error.message;}
};
const settingsFileInput=$('settings-file');
$('settings-import').onclick=()=>settingsFileInput.click();
settingsFileInput.onchange=async()=>{
  const file=settingsFileInput.files[0];
  settingsFileInput.value='';
  if(!file)return;
  try{
    if(file.size>32768)throw Error('服务设置文件过大。');
    const backup=JSON.parse(await file.text());
    if(backup?.type!==settingsBackupType||backup.version!==1||!backup.values||typeof backup.values!=='object'){
      throw Error('请选择 Dsh 服务设置备份文件。');
    }
    const entries=[];
    for(const key of portableSettingsKeys){
      if(!Object.hasOwn(backup.values,key))continue;
      entries.push([key,portableSettingsValue(key,backup.values[key])]);
    }
    if(!entries.length)throw Error('备份中没有可导入的服务设置。');
    if((Object.hasOwn(backup.values,'DSH_AI_URL')||Object.hasOwn(backup.values,'DSH_AI_MODEL'))&&
        !Object.hasOwn(backup.values,'DSH_AI_THINKING'))entries.push(['DSH_AI_THINKING','']);
    for(const [key,value] of entries)settingsForm.elements.namedItem(key).value=value;
    for(const input of settingsForm.querySelectorAll('input[type=password]'))input.value='';
    clearAiKey.checked=false;aiKey.disabled=false;
    syncAiPreset();
    $('settings-status').textContent='已填入备份设置，确认后点击保存。';
  }catch(error){$('settings-status').textContent=error.message;}
};
settingsForm.onsubmit=async event=>{
  event.preventDefault();
  const button=settingsForm.querySelector('button[type=submit]');
  button.disabled=true;
  try{
    const payload=Object.fromEntries([...new FormData(settingsForm)].filter(([key,value])=>value||!key.endsWith('_KEY')));
    if(clearAiKey.checked)payload.DSH_AI_KEY='';
    if(!Object.hasOwn(payload,'DSH_AI_THINKING'))payload.DSH_AI_THINKING='';
    const response=await fetch('/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!response.ok)throw Error((await response.json().catch(()=>({}))).error??'无法保存设置。');
    settingsReadFailed=false;
    settingsDialog.close();
    status('服务设置已保存。');
    await refreshEngines();
  }catch(error){$('settings-status').textContent=error.message;}
  finally{button.disabled=false;}
};


function askForShapeStyle(style){
  const dialog=document.createElement('dialog');
  const form=document.createElement('form');
  form.method='dialog';
  const color=document.createElement('input');
  color.type='color';color.value=style.color;
  const colorLabel=document.createElement('label');
  colorLabel.append('颜色',color);
  const width=document.createElement('select');
  for(const value of [1,2,4,6])width.add(new Option(value+' 磅',String(value)));
  width.value=String([1,2,4,6].includes(style.width)?style.width:2);
  const widthLabel=document.createElement('label');
  widthLabel.append('线宽',width);
  const submit=document.createElement('button'),cancel=document.createElement('button');
  submit.textContent='确定';submit.value='accept';cancel.textContent='取消';cancel.value='cancel';
  form.append(colorLabel,widthLabel,submit,cancel);dialog.append(form);document.body.append(dialog);
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>{
      resolve(dialog.returnValue==='accept'?{color:color.value,width:Number(width.value)}:null);
      dialog.remove();
    },{once:true});
    dialog.showModal();
  });
}

function askForText(label,value,type='text'){
  const dialog=document.createElement('dialog'),form=document.createElement('form');
  form.method='dialog';
  const fieldLabel=document.createElement('label'),input=document.createElement(type==='multiline'?'textarea':'input');
  fieldLabel.textContent=label;
  if(type!=='multiline')input.type=type;
  input.value=value;input.autofocus=true;fieldLabel.append(input);
  const submit=document.createElement('button'),cancel=document.createElement('button');
  submit.textContent='确定';submit.value='accept';cancel.textContent='取消';cancel.value='cancel';
  form.append(fieldLabel,submit,cancel);dialog.append(form);document.body.append(dialog);
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>{
      resolve(dialog.returnValue==='accept'?input.value:null);
      dialog.remove();
    },{once:true});
    dialog.showModal();input.focus();input.select();
  });
}

$('extract').onclick=()=>{void extractPageSelection(active,active?.page);};
async function extractPageSelection(doc,page){
  if(!doc){status('请先打开 PDF。');return;}
  const ranges=await askForText('输入要提取的页码，例如 1,3-5',String(page));
  if(ranges===null)return;
  try{
    const bytes=await extractPdfPages(doc.bytes,ranges,doc.notes.slice());
    downloadPagePdf(doc.name,bytes,'提取页面');
    status('已导出选定页面。');
  }catch(error){status('页面提取失败：'+error.message);}
}

function downloadPagePdf(name,bytes,suffix){
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
  const link=document.createElement('a');
  link.href=url;
  link.download=name.replace(/\.pdf$/i,'')+'-'+suffix+'.pdf';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function exportWithInsertedPages(doc,page,mode='blank'){
  const dialog=$('blank-pages-dialog');
  const anchor=$('blank-pages-anchor'),count=$('blank-pages-count');
  if(dialog.open)return;
  const file=$('insert-pdf-file'),range=$('insert-pdf-range');
  const fromFile=mode!=='blank',replace=mode==='replace';
  const title=replace?'替换页面并另存':fromFile?'插入 PDF 并另存':'插入空白页并另存';
  $('blank-pages-position-field').hidden=replace;
  $('blank-pages-anchor-label').textContent=replace?'起始替换页':'参考页码';
  $('insert-pdf-file-label').textContent=replace?'替换来源 PDF':'要插入的 PDF';
  $('insert-pdf-range-label').textContent=replace?'来源页码':'插入文件的页码';
  $('insert-pdf-submit').textContent=replace?'替换并另存':'插入并另存';
  $('blank-pages-title').textContent=title;
  $('insert-pdf-inputs').hidden=!fromFile;
  $('blank-pages-count-field').hidden=fromFile;
  count.disabled=fromFile;
  file.disabled=!fromFile;
  file.value='';
  range.value='';
  anchor.max=String(doc.pdf.numPages);
  anchor.value=String(page);
  $('blank-pages-position').value='after';
  count.value='1';
  const confirmed=await new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='insert'),{once:true});
    dialog.returnValue='';
    dialog.showModal();
    anchor.select();
  });
  if(!confirmed)return;
  try{
    const options={pageNumber:anchor.valueAsNumber,ranges:range.value,replace,before:$('blank-pages-position').value==='before'};
    const notes=doc.notes.slice();
    const bytes=fromFile?
      await transferPdfPages(doc.bytes,new Uint8Array(await file.files[0].arrayBuffer()),options,notes):
      await insertBlankPdfPages(doc.bytes,{...options,count:count.valueAsNumber},notes);
    downloadPagePdf(doc.name,bytes,replace?'替换页面':fromFile?'插入PDF':'插入空白页');
    status(replace?'已另存替换页面后的 PDF。':fromFile?'已另存合并后的 PDF。':'已另存插入空白页后的 PDF。');
  }catch(error){status((replace?'无法替换页面：':'无法插入页面：')+error.message);}
}

async function exportWithoutPages(doc,page){
  const ranges=await askForText('输入要删除的页码，结果将另存为 PDF',String(page));
  if(ranges===null)return;
  try{
    const bytes=await exportPdfWithoutPages(doc.bytes,ranges,doc.notes.slice());
    downloadPagePdf(doc.name,bytes,'删除页面');
    status('已另存删除所选页面后的 PDF。');
  }catch(error){status('页面删除失败：'+error.message);}
}

async function exportCroppedPages(doc,page){
  const dialog=$('crop-pages-dialog');
  const form=$('crop-pages-form');
  const first=$('crop-first'),last=$('crop-last'),subset=$('crop-subset');
  const preview=$('crop-preview'),zone=$('crop-zone'),canvas=$('crop-canvas'),aspect=$('crop-aspect');
  const previewPage=$('crop-preview-page'),previous=$('crop-preview-prev'),next=$('crop-preview-next');
  const total=doc.pdf.numPages;
  const margins=['top','right','bottom','left'].map(edge=>$('crop-'+edge));
  const pointsPerCm=72/2.54;
  if(dialog.open)return;
  form.reset();
  first.max=last.max=previewPage.max=String(total);
  $('crop-preview-total').textContent='/ '+total;
  first.value=last.value=String(page);
  $('crop-message').textContent='';
  zone.hidden=true;
  let widthCm,heightCm,drag,renderTask,lockedRatio,shownPage,previewGeneration=0;
  function updateZone(){
    if(!widthCm||!heightCm)return;
    const [top,right,bottom,left]=margins.map(el=>Math.max(0,el.valueAsNumber||0));
    zone.hidden=left+right>=widthCm||top+bottom>=heightCm;
    if(!zone.hidden)Object.assign(zone.style,{
      top:(100*top/heightCm)+'%',right:(100*right/widthCm)+'%',
      bottom:(100*bottom/heightCm)+'%',left:(100*left/widthCm)+'%'
    });
  }
  function previewPoint(event){
    const {left,top,width,height}=preview.getBoundingClientRect();
    return [Math.min(1,Math.max(0,(event.clientX-left)/width)),Math.min(1,Math.max(0,(event.clientY-top)/height))];
  }
  function updateDrag(event){
    if(!drag||drag.id!==event.pointerId)return;
    let [x,y]=previewPoint(event);
    const [x0,y0]=drag.start;
    if(aspect.checked){
      const ratio=lockedRatio?lockedRatio*heightCm/widthCm:1;
      const dx=x-x0,dy=y-y0;
      const sx=Math.sign(dx)||(x0<=.5?1:-1),sy=Math.sign(dy)||(y0<=.5?1:-1);
      const availableWidth=sx>0?1-x0:x0;
      const availableHeight=sy>0?1-y0:y0;
      const width=Math.min(Math.max(Math.abs(dx),Math.abs(dy)*ratio),availableWidth,availableHeight*ratio);
      x=x0+sx*width;y=y0+sy*width/ratio;
    }
    if(Math.abs(x-x0)<.01||Math.abs(y-y0)<.01)return;
    const values=[Math.min(y,y0)*heightCm,(1-Math.max(x,x0))*widthCm,
      (1-Math.max(y,y0))*heightCm,Math.min(x,x0)*widthCm];
    margins.forEach((el,i)=>el.value=values[i].toFixed(2));
    updateZone();
  }
  preview.onpointerdown=event=>{
    if(event.button!==0||!widthCm||!heightCm)return;
    drag={id:event.pointerId,start:previewPoint(event)};
    preview.setPointerCapture(event.pointerId);
  };
  preview.onpointermove=updateDrag;
  preview.onpointerup=event=>{updateDrag(event);drag=null;};
  preview.onlostpointercapture=()=>{drag=null;};
  aspect.onchange=()=>{
    lockedRatio=undefined;
    if(!aspect.checked||!widthCm||!heightCm)return;
    const [top,right,bottom,left]=margins.map(el=>el.valueAsNumber);
    const width=(widthCm-left-right)/widthCm,height=(heightCm-top-bottom)/heightCm;
    if(width>0&&height>0)lockedRatio=(width/height)*(widthCm/heightCm);
  };
  for(const input of margins)input.oninput=updateZone;
  const closed=new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});
  });
  dialog.returnValue='';
  async function renderPreview(number){
    shownPage=Math.max(1,Math.min(total,number));
    previewPage.value=String(shownPage);
    previous.disabled=shownPage===1;
    next.disabled=shownPage===total;
    const generation=++previewGeneration;
    renderTask?.cancel();
    widthCm=heightCm=0;
    drag=null;
    zone.hidden=true;
    canvas.style.visibility='hidden';
    $('crop-message').textContent='';
    try{
      const pdfPage=await doc.pdf.getPage(shownPage);
      if(generation!==previewGeneration)return;
      const viewport=pdfPage.getViewport({scale:1});
      const view=pdfPage.getViewport({scale:Math.min(242/viewport.width,310/viewport.height)});
      const buffer=document.createElement('canvas');
      buffer.width=Math.ceil(view.width);
      buffer.height=Math.ceil(view.height);
      renderTask=pdfPage.render({canvasContext:buffer.getContext('2d'),viewport:view,background:'#fff'});
      await renderTask.promise;
      if(generation!==previewGeneration)return;
      preview.style.width=view.width+'px';
      preview.style.height=view.height+'px';
      canvas.width=buffer.width;
      canvas.height=buffer.height;
      canvas.getContext('2d').drawImage(buffer,0,0);
      canvas.style.visibility='';
      widthCm=viewport.width/pointsPerCm;
      heightCm=viewport.height/pointsPerCm;
      updateZone();
    }catch(error){
      if(generation===previewGeneration)$('crop-message').textContent='预览不可用，可输入裁剪边距。';
    }
  }
  previous.onclick=()=>{void renderPreview(shownPage-1);};
  next.onclick=()=>{void renderPreview(shownPage+1);};
  previewPage.onchange=()=>{void renderPreview(Number.isInteger(previewPage.valueAsNumber)?previewPage.valueAsNumber:shownPage);};
  previewPage.onkeydown=event=>{
    if(event.key==='Enter'){event.preventDefault();previewPage.onchange();}
  };
  dialog.showModal();
  void renderPreview(page);
  const confirmed=await closed;
  previewGeneration++;
  previous.onclick=next.onclick=previewPage.onchange=previewPage.onkeydown=null;
  renderTask?.cancel();
  preview.onpointerdown=preview.onpointermove=preview.onpointerup=preview.onlostpointercapture=null;
  for(const input of margins)input.oninput=null;
  aspect.onchange=null;
  if(confirmed!=='crop'&&confirmed!=='queue-crop')return;
  try{
    const options={first:first.valueAsNumber,last:last.valueAsNumber,subset:subset.value,margins:margins.map(el=>el.valueAsNumber)};
    if(confirmed==='queue-crop'){
      const source=doc.bytes;
      const edits=await getPdfCropEdits(source,options);
      if(doc.bytes!==source||doc.saving)throw Error('PDF 正在保存或已更新，请重新打开裁剪。');
      for(const edit of edits)doc.notes.push({...edit,text:'待保存 · 裁剪页面'});
      saveNotes(doc);
      if(active===doc){
        notes();
        status(doc.fileId?'页面裁剪待保存。按 Ctrl+S 写入原 PDF。':'页面裁剪待保存。请另存 PDF。');
      }
      return;
    }
    const bytes=await cropPdfPages(doc.bytes,options,doc.notes.slice());
    downloadPagePdf(doc.name,bytes,'裁剪页面');
    status('已另存裁剪后的 PDF。');
  }catch(error){status('页面裁剪失败：'+error.message);}
}

async function editRotationRange(doc,page,saveCopy){
  const dialog=$('rotate-pages-dialog'),range=$('rotate-pages-range'),angle=$('rotate-pages-angle');
  if(dialog.open)return;
  range.value=String(page);
  angle.value='90';
  $('rotate-pages-title').textContent=saveCopy?'批量旋转并另存':'旋转页面';
  dialog.querySelector('[value=rotate]').textContent=saveCopy?'旋转并另存':'加入待保存修改';
  dialog.returnValue='';
  const confirmed=await new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='rotate'),{once:true});
    dialog.showModal();
    range.select();
  });
  if(!confirmed)return;
  try{
    if(!saveCopy){
      const turn=Number(angle.value);
      const pages=parsePageRanges(range.value,doc.pdf.numPages);
      const direction=turn===-90?'逆时针':'顺时针';
      doc.notes.push(...Array.from(pages,index=>({
        page:index+1,text:'待保存 · '+direction+'旋转 '+Math.abs(turn)+'°',rotateBy:turn
      })));
      saveNotes(doc);
      if(active===doc){
        notes();
        refreshRotatedThumbnails(doc,Array.from(pages,index=>index+1));
        status(doc.fileId?'页面旋转待保存。按 Ctrl+S 写入原 PDF。':'页面旋转待保存。请另存 PDF。');
      }
      return;
    }
    const bytes=await rotatePdfPages(doc.bytes,range.value,Number(angle.value),doc.notes.slice());
    downloadPagePdf(doc.name,bytes,'批量旋转');
    status('已另存批量旋转后的 PDF。');
  }catch(error){status('页面旋转失败：'+error.message);}
}

async function exportRotatedPage(doc,page,angle){
  try{
    const bytes=await rotatePdfPages(doc.bytes,String(page),angle,doc.notes.slice());
    downloadPagePdf(doc.name,bytes,'旋转第'+page+'页');
    status('已另存旋转第 '+page+' 页的 PDF。');
  }catch(error){status('页面旋转失败：'+error.message);}
}

$('save-original-pdf').onclick=async()=>{
  const doc=active;
  if(!doc?.fileId||!doc.notes.length||doc.saving)return;
  doc.saving=true;
  notes();
  try{
    const snapshot=doc.notes.slice();
    const bytes=await exportAnnotatedPdf(doc.bytes,snapshot,doc.pdf.fingerprints[0]);
    const updatedPdf=await getDocument({data:bytes.slice(),cMapUrl:'/pdf/cmaps/',standardFontDataUrl:'/pdf/standard_fonts/',wasmUrl:'/pdf/wasm/'}).promise;
    try{await window.dshDesktop.saveOpenPdf(doc.fileId,bytes);}
    catch(error){await updatedPdf.destroy();throw error;}
    const previousPdf=doc.pdf;
    const previousKey=doc.key;
    doc.bytes=bytes;
    doc.pdf=updatedPdf;
    saveReading(doc);
    embeddedCache.delete(doc);
    if(continuousDoc===doc)continuousDoc=null;
    doc.key=noteKey(updatedPdf,doc.fileScope);
    doc.notes=doc.notes.filter(note=>!snapshot.includes(note));
    if(previousKey!==doc.key)localStorage.removeItem(previousKey);
    saveNotes(doc);
    if(active===doc){notes();refreshRotatedThumbnails(doc,snapshot.filter(note=>note.rotateBy||note.cropBox).map(note=>note.page));void render(doc.readingScroll);void showEmbeddedNotes();status(snapshot.some(note=>note.rotateBy||note.cropBox)?'已保存页面修改到原 PDF。':'已保存批注到原 PDF。');}
    void previousPdf.destroy().catch(()=>{});
  }catch(error){if(active===doc)status(error.message);}
  finally{doc.saving=false;if(active===doc)notes();}
};
$('save-annotation-copy').onclick=()=>$('save-notes').click();
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.isComposing||document.querySelector('dialog[open]'))return;
  if(event.code==='F11'){
    event.preventDefault();
    void toggleReaderFullscreen();
    return;
  }
  if(event.ctrlKey&&!event.altKey&&event.code==='Tab'&&active&&docs.length>1){
    event.preventDefault();
    const index=docs.indexOf(active), step=event.shiftKey?-1:1;
    activate(docs[(index+step+docs.length)%docs.length]);
    return;
  }
  if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&event.code==='KeyF'){
    event.preventDefault();$('find').open=true;$('find-input').focus();return;
  }
  if(active?.fileId&&event.ctrlKey&&!event.shiftKey&&!event.altKey&&event.code==='KeyS'){
    event.preventDefault();$('save-original-pdf').click();return;
  }
  if(active&&event.ctrlKey&&event.shiftKey&&!event.altKey&&event.code==='KeyS'){
    event.preventDefault();$('save-annotation-copy').click();return;
  }
  if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&event.code==='KeyO'){
    event.preventDefault();void choosePdf();return;
  }
  if(!active||event.ctrlKey||event.altKey||event.metaKey||event.target.closest?.('input,textarea,select,button,[contenteditable],#translation-panel'))return;
  const stepPage=direction=>{
    if(!active.continuous){go(active.page+direction);return;}
    const view=$('continuous');
    view.scrollTop+=direction*Math.max(1,view.clientHeight-32);
  };
  const actions={
    PageUp:()=>stepPage(-1),PageDown:()=>stepPage(1),
    Home:()=>goBoundary(false),End:()=>goBoundary(true),
    '+':()=>zoom(.25),'-':()=>zoom(-.25)
  };
  const action=Object.hasOwn(actions,event.key)?actions[event.key]:null;
  if(action){event.preventDefault();action();}
});

async function refreshOutline(doc){
  const list=$('outline-list');
  list.replaceChildren();
  $('outline').hidden=!doc;
  if(!doc)return;
  try{
    const items=await doc.pdf.getOutline();
    if(active!==doc)return;
    if(items?.length)list.append(outlineItems(doc,items));
    else list.textContent='这份 PDF 没有内嵌目录。';
  }catch{
    if(active===doc)list.textContent='无法读取文档目录。';
  }
}
async function openPdfDestination(doc,target){
  const pdf=doc.pdf;
  const destination=typeof target==='string'?await pdf.getDestination(target):target;
  if(!Array.isArray(destination)||!destination.length)throw Error('链接目标无效。');
  const ref=destination[0];
  const index=typeof ref==='number'?ref:await pdf.getPageIndex(ref);
  if(!Number.isInteger(index)||index<0||index>=pdf.numPages)throw Error('链接页码无效。');
  if(active!==doc||doc.pdf!==pdf)return;
  if(doc.continuous&&continuousDoc===doc&&viewerReady){
    continuousViewer.scrollPageIntoView({pageNumber:index+1,destArray:destination});
    doc.fit=continuousViewer.currentScaleValue==='page-width';
    return;
  }
  if(destination[1]?.name!=='XYZ')return go(index+1);
  const [, ,left,top,scale]=destination;
  const scroll=$('scroll'),paper=$('paper');
  let previousPoint;
  if(pageView?.doc===doc&&pageView.page===index+1){
    const outer=scroll.getBoundingClientRect(),inner=paper.getBoundingClientRect();
    previousPoint=pageView.viewport.convertToPdfPoint(outer.left-inner.left,outer.top-inner.top);
  }
  if(Number.isFinite(scale)&&scale>0){
    doc.fit=false;
    doc.scale=Math.max(.5,Math.min(3,scale));
  }
  const navigation=go(index+1),navigationId=renderId;
  await navigation;
  if(active!==doc||doc.pdf!==pdf||renderId!==navigationId||pageView?.doc!==doc||pageView.page!==index+1)return;
  const {viewport}=pageView;
  const x=Number.isFinite(left)?left:previousPoint?.[0]??viewport.viewBox[0];
  const y=Number.isFinite(top)?top:previousPoint?.[1]??viewport.viewBox[3];
  const [offsetX,offsetY]=viewport.convertToViewportPoint(x,y);
  const outer=scroll.getBoundingClientRect(),inner=paper.getBoundingClientRect();
  scroll.scrollTo({
    left:scroll.scrollLeft+inner.left-outer.left+offsetX,
    top:scroll.scrollTop+inner.top-outer.top+offsetY,
    behavior:'instant'
  });
  rememberReadingScroll(doc,scroll);
}
function addSinglePageLinks(view,annotations){
  view.links=[];
  for(const annotation of annotations){
    if(annotation.subtype!=='Link'||!annotation.dest||annotation.rect?.length!==4||
      !annotation.rect.every(Number.isFinite))continue;
    const [x1,y1,x2,y2]=view.viewport.convertToViewportRectangle(annotation.rect);
    const left=Math.min(x1,x2),top=Math.min(y1,y2),right=Math.max(x1,x2),bottom=Math.max(y1,y2);
    if(left===right||top===bottom)continue;
    const button=document.createElement('button');
    button.type='button';button.className='pdf-page-link';
    button.setAttribute('aria-label','文档内链接 '+(view.links.length+1));
    Object.assign(button.style,{left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});
    const open=async()=>{
      if(pageView!==view)return;
      try{await openPdfDestination(view.doc,annotation.dest);}
      catch{if(pageView===view)status('无法打开 PDF 内部链接。');}
    };
    button.onclick=open;
    view.links.push({left,top,right,bottom,open});
    $('paper').append(button);
  }
}
function outlineItems(doc,items){
  const group=document.createElement('ul');
  for(const item of items){
    const li=document.createElement('li');
    if(item.dest){
      const button=document.createElement('button');
      button.textContent=item.title;
      button.onclick=async()=>{
        try{
          await openPdfDestination(doc,item.dest);
        }catch{if(active===doc)status('无法跳转到该章节。');}
      };
      li.append(button);
    }else{
      li.append(document.createTextNode(item.title));
    }
    if(item.items.length)li.append(outlineItems(doc,item.items));
    group.append(li);
  }
  return group;
}
$('outline').hidden=true;

$('fit').onclick=()=>{
  if(!active)return;
  active.fit=!active.fit;
  saveReading(active);
  void render();
};
let fitFrame;
let readingWidth=$('scroll').clientWidth;
new ResizeObserver(()=>{
  const width=$('scroll').clientWidth;
  if(width===readingWidth)return;
  readingWidth=width;
  cancelAnimationFrame(fitFrame);
  if(active?.fit)fitFrame=requestAnimationFrame(()=>{if(active?.fit)void render();});
}).observe($('scroll'));
let continuousReadingWidth=0;
new ResizeObserver(()=>{
  const width=$('continuous').clientWidth;
  if(width===continuousReadingWidth)return;
  continuousReadingWidth=width;
  if(width&&viewerReady&&active?.continuous&&active.fit&&active===continuousDoc){
    continuousViewer.currentScaleValue='page-width';
  }
}).observe($('continuous'));

function readingKey(pdf){return 'dsh-reading:'+pdf.fingerprints[0];}
function restoreReading(pdf){
  let state;
  try{state=JSON.parse(localStorage.getItem(readingKey(pdf)));}catch{}
  return {
    page:Number.isInteger(state?.page)?Math.max(1,Math.min(pdf.numPages,state.page)):1,
    scale:Number.isFinite(state?.scale)?Math.max(.1,Math.min(4,state.scale)):1,
    fit:state?.fit===true,
    rotation:[0,90,180,270].includes(state?.rotation)?state.rotation:0,
    continuous:state?.viewMode!=='single',
    readingScroll:state?.readingScroll
  };
}
function saveReading({pdf,page,scale,fit,rotation,continuous,readingScroll}){
  const position=readingScroll?.page===page?readingScroll:undefined;
  try{localStorage.setItem(readingKey(pdf),JSON.stringify({page,scale,fit,rotation,continuous,viewMode:continuous?"continuous":"single",readingScroll:position}));}catch{}
}
let pendingReadingDoc,readingScrollTimer;
function flushReadingScroll(){
  clearTimeout(readingScrollTimer);
  if(!pendingReadingDoc)return;
  const doc=pendingReadingDoc;
  pendingReadingDoc=null;
  saveReading(doc);
}
window.addEventListener('pagehide',flushReadingScroll);
function rememberReadingScroll(doc,view){
  if(inputMode)return;
  const page=doc.continuous?continuousViewer?.getPageView(doc.page-1)?.div:null;
  if(doc.continuous&&!page)return;
  doc.readingScroll={page:doc.page,scale:doc.scale,rotation:doc.rotation,continuous:doc.continuous,
    top:view.scrollTop-(page?.offsetTop??0),left:view.scrollLeft};
  pendingReadingDoc=doc;
  clearTimeout(readingScrollTimer);
  readingScrollTimer=setTimeout(flushReadingScroll,180);
}
function restoreReadingScroll(doc,position){
  if(position?.page!==doc.page||position.continuous!==doc.continuous||position.rotation!==doc.rotation||
     Math.abs(position.scale-doc.scale)>.001||!Number.isFinite(position.top)||!Number.isFinite(position.left))return;
  const page=doc.continuous?continuousViewer?.getPageView(doc.page-1)?.div:null;
  const view=$(doc.continuous?'continuous':'scroll');
  view.scrollTo({top:position.top+(page?.offsetTop??0),left:position.left,behavior:'instant'});
}
$('scroll').addEventListener('scroll',()=>{
  if(active&&!active.continuous&&readingScrollRender===renderId)rememberReadingScroll(active,$('scroll'));
},{passive:true});
$('continuous').addEventListener('scroll',()=>{
  if(active?.continuous&&active===continuousDoc&&viewerReady)rememberReadingScroll(active,$('continuous'));
},{passive:true});

const glossaryField=$('glossary');
try{glossaryField.value=localStorage.getItem('dsh-ai-glossary')??'';}catch{}
glossaryField.onchange=()=>{
  try{localStorage.setItem('dsh-ai-glossary',glossaryField.value);}catch{status('无法保存术语表。');}
};

const embeddedCache=new WeakMap();

const embeddedNoteNames={
  Highlight:'高亮',Underline:'下划线',StrikeOut:'删除线',Squiggly:'波浪线',
  Text:'评论',FreeText:'页面文字',Square:'矩形批注',Circle:'椭圆批注',
  Line:'线条批注',Ink:'手绘批注',Stamp:'图章'
};
function isDshShape(annotation){return annotation.titleObj?.str==='Dsh文献翻译'&&['Square','Circle','Line'].includes(annotation.subtype);}
function canStyleEmbeddedShape(annotation){
  return !(annotation.annotationFlags&192)&&(isDshShape(annotation)||
    (!annotation.hasAppearance&&['Square','Circle'].includes(annotation.subtype)&&
      (annotation.borderStyle?.style??1)===1));
}
function showEmbeddedPopup(doc,container,viewport,comment,trigger){
  const [x1,y1,x2,y2]=viewport.convertToViewportRectangle(comment.rect);
  document.querySelector('.embedded-note-popup')?.remove();
  const popup=document.createElement('section');
  popup.className='embedded-note-popup';
  popup.setAttribute('role','dialog');
  popup.setAttribute('aria-label',comment.name||'PDF 批注');
  const close=document.createElement('button');
  close.type='button';
  close.textContent='关闭批注';
  const body=document.createElement('div');
  body.textContent=comment.body;
  body.style.whiteSpace='pre-wrap';
  body.style.overflowWrap='anywhere';
  popup.append(close,body);
  const scroll=$(doc.continuous?'continuous':'scroll').getBoundingClientRect();
  const page=container.getBoundingClientRect();
  const anchor={right:page.left+Math.max(x1,x2),top:page.top+Math.min(y1,y2)};
  const width=Math.min(320,scroll.width-24);
  Object.assign(popup.style,{
    position:'absolute',zIndex:'9',width:width+'px',maxHeight:Math.min(240,scroll.height/2)+'px',
    left:Math.max(scroll.left+12,Math.min(anchor.right+8,scroll.right-width-12))-page.left+'px',
    top:Math.max(scroll.top+12,Math.min(anchor.top,scroll.top+scroll.height/2))-page.top+'px',
    overflow:'auto',padding:'12px',border:'1px solid #adc6c3',borderRadius:'6px',
    color:'#172d32',background:'#fff',boxShadow:'0 4px 14px #252a2740'
  });
  const dismiss=()=>{popup.remove();if(trigger?.isConnected)trigger.focus({preventScroll:true});};
  close.onclick=dismiss;
  popup.onkeydown=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}
  };
  container.append(popup);
  close.focus({preventScroll:true});
}
async function showEmbeddedNotes(){
  const list=$('embedded-notes'),doc=active;
  list.replaceChildren();
  if(!doc||$('work-notes').hidden)return;
  const pdf=doc.pdf;
  if(!embeddedCache.has(doc)){
    const saved=(async()=>{
      const comments=[];
      for(let page=1;page<=pdf.numPages;page++){
        const annotations=await (await pdf.getPage(page)).getAnnotations();
        for(const annotation of annotations){
          if(annotation.subtype==='Popup')continue;
          const name=annotation.lineEndings?.[1]==='ClosedArrow'&&annotation.subtype==='Line'?'箭头批注':embeddedNoteNames[annotation.subtype];
          const body=annotation.contentsObj?.str?.trim();
          const text=body||name;
          if(typeof text==='string'&&text)comments.push({page,text,body,name,richText:annotation.richText,shapeStyle:canStyleEmbeddedShape(annotation)?{color:'#'+Array.from(annotation.color??[0,0,0],value=>value.toString(16).padStart(2,'0')).join(''),width:annotation.borderStyle?.width}:null,id:name?annotation.id:null,subtype:annotation.subtype,rect:annotation.rect});
        }
      }
      return comments;
    })();
    embeddedCache.set(doc,saved);
    saved.catch(()=>embeddedCache.delete(doc));
  }
  list.textContent='正在读取 PDF 内嵌批注…';
  try{
    const comments=await embeddedCache.get(doc);
    if(active!==doc||doc.pdf!==pdf||$('work-notes').hidden)return;
    list.replaceChildren();
    if(!comments.length)return;
    const title=document.createElement('h3');title.textContent='PDF 内嵌批注';list.append(title);
    const bodies=[];
    const removed=new Set(doc.notes.flatMap(note=>note.removeRef?[note.removeRef]:[]));
    for(const savedComment of comments){
      if(removed.has(savedComment.id))continue;
      const draft=doc.notes.find(note=>note.editRef===savedComment.id);
      const comment=draft?{...savedComment,text:draft.text||savedComment.name,body:draft.text}:savedComment;
      const row=document.createElement('div');row.className='note';
      if(comment.id)row.dataset.annotationId=comment.id;
      row.dataset.annotationPage=comment.page;
      const link=document.createElement('button');link.textContent='第 '+comment.page+' 页';
      const locate=async(openPopup,trigger)=>{
        if(active!==doc||doc.pdf!==pdf)return;
        const navigation=go(comment.page),navigationId=renderId;
        await navigation;
        if(active!==doc||doc.pdf!==pdf||renderId!==navigationId||doc.page!==comment.page)return;
        if(comment.rect?.length!==4||!comment.rect.every(Number.isFinite))return;
        const view=doc.continuous?continuousViewer?.getPageView(comment.page-1):pageView;
        const container=doc.continuous?view?.div:$('paper');
        if(!view?.viewport||!container)return;

        const [x1,y1,x2,y2]=view.viewport.convertToViewportRectangle(comment.rect);
        document.querySelector('.embedded-note-location')?.remove();
        const marker=document.createElement('div');
        marker.className='embedded-note-location';
        marker.setAttribute('aria-hidden','true');
        Object.assign(marker.style,{
          position:'absolute',pointerEvents:'none',zIndex:'8',
          left:Math.min(x1,x2)+'px',top:Math.min(y1,y2)+'px',
          width:Math.max(4,Math.abs(x1-x2))+'px',height:Math.max(4,Math.abs(y1-y2))+'px',
          outline:'2px solid #007c78',outlineOffset:'2px'
        });
        container.append(marker);
        marker.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
        setTimeout(()=>marker.remove(),2200);
        if(!openPopup)return;
        showEmbeddedPopup(doc,container,view.viewport,comment,trigger);
      };
      link.onclick=()=>locate(false,link);
      row.append(link);
      if(/^\d+R\d*$/.test(comment.id??'')&&comment.rect?.length===4){
        const remove=document.createElement('button');
        remove.type='button';
        remove.textContent='标记删除';
        remove.dataset.noteAction='remove';
        remove.onclick=()=>{
          if(active!==doc||doc.pdf!==pdf||doc.notes.some(note=>note.removeRef===comment.id))return;
          doc.notes.push({page:comment.page,text:comment.text,removeRef:comment.id,
            removeSubtype:comment.subtype,removeRect:comment.rect});
          saveNotes(doc);notes();void showEmbeddedNotes();
          status('已标记删除。保存 PDF 后生效，可以在待保存批注中撤销。');
        };
        row.append(remove);
        if(comment.shapeStyle){
          const properties=document.createElement('button');
          properties.type='button';properties.textContent='图形属性';
          properties.dataset.noteAction='properties';
          properties.onclick=async()=>{
            const previous=doc.notes.find(note=>note.styleRef===comment.id)??comment.shapeStyle;
            const style=await askForShapeStyle(previous);
            if(!style||active!==doc||doc.pdf!==pdf||doc.saving)return;
            doc.notes=doc.notes.filter(note=>note.styleRef!==comment.id);
            if(style.color!==comment.shapeStyle.color||style.width!==comment.shapeStyle.width)doc.notes.push({
              page:comment.page,text:comment.name+'外观',styleRef:comment.id,
              removeSubtype:comment.subtype,removeRect:comment.rect,...style
            });
            saveNotes(doc);notes();void showEmbeddedNotes();
          };
          row.append(properties);
        }
        if(comment.subtype!=='FreeText'&&!comment.richText){
          const edit=document.createElement('button');
          edit.type='button';edit.textContent='编辑正文';
          edit.dataset.noteAction='edit';
          edit.onclick=async()=>{
            const value=await askForText('编辑 PDF 批注正文',comment.body??'','multiline');
            if(value===null||active!==doc||doc.pdf!==pdf||doc.saving)return;
            if(value===(comment.body??''))return;
            doc.notes=doc.notes.filter(note=>note.editRef!==comment.id);
            if(value!==(savedComment.body??''))doc.notes.push({
              page:comment.page,text:value,editRef:comment.id,
              removeSubtype:comment.subtype,removeRect:comment.rect
            });
            saveNotes(doc);notes();void showEmbeddedNotes();
          };
          row.append(edit);
        }
      }
      if(comment.body){
        if(comment.rect?.length===4&&comment.rect.every(Number.isFinite)){
          const popupButton=document.createElement('button');
          popupButton.type='button';
          popupButton.textContent='页内查看';
          popupButton.onclick=()=>locate(true,popupButton);
          row.append(popupButton);
        }
        const details=document.createElement('details');
        const summary=document.createElement('summary');
        summary.textContent=comment.name||'批注正文';
        const body=document.createElement('div');
        body.style.whiteSpace='pre-wrap';
        body.style.overflowWrap='anywhere';
        body.textContent=comment.body;
        details.append(summary,body);
        bodies.push(details);
        row.append(details);
      }else{
        row.append(document.createTextNode(comment.text));
      }
      list.append(row);
    }
    if(bodies.length>1){
      const tools=document.createElement('div');
      tools.className='actions';
      tools.setAttribute('role','group');
      tools.setAttribute('aria-label','批量查看批注正文');
      for(const [label,open] of [['展开全部正文',true],['收起全部正文',false]]){
        const button=document.createElement('button');
        button.type='button';button.textContent=label;
        button.onclick=()=>{for(const details of bodies)details.open=open;};
        tools.append(button);
      }
      title.after(tools);
    }
  }catch{if(active===doc&&!$('work-notes').hidden)list.textContent='无法读取 PDF 内嵌批注。';}
}

let ocrWorker,ocrModel;
$('ocr').onclick=async()=>{
  const doc=active;
  if(!doc){status('请先打开 PDF。');return;}
  const pageNumber=doc.page,button=$('ocr');
  button.disabled=true;
  status('正在识别本页文字…');
  try{
    const text=await recognizePage(doc,pageNumber);
    if(active!==doc||doc.page!==pageNumber)return;
    if(!text){status('本页未识别出文字。');return;}
    doc.source=text;
    $('source').value=text;
    status('识别完成，已填入英文原文。');
  }catch(error){
    if(active===doc)status('识别失败：'+error.message);
  }finally{button.disabled=false;}
};

const recognized=new WeakMap();
let ocrQueue=Promise.resolve();
function recognizePage(doc,pageNumber,signal,language=$('ocr-language').value){
  const cacheKey=language+':'+pageNumber;
  let pages=recognized.get(doc);
  if(!pages){pages=new Map();recognized.set(doc,pages);}
  const saved=pages.get(cacheKey);
  if(saved)return Promise.resolve(saved);
  const pending=ocrQueue.then(async()=>{
    signal?.throwIfAborted();
    if(pages.has(cacheKey))return pages.get(cacheKey);
    const text=await recognizeUncached(doc,pageNumber,language);
    pages.set(cacheKey,text);
    return text;
  });
  ocrQueue=pending.catch(()=>{});
  return pending;
}
async function recognizeUncached(doc,pageNumber,language){
    const page=await doc.pdf.getPage(pageNumber);
    const viewport=page.getViewport({scale:1});
    const scale=Math.min(3,2600/Math.max(viewport.width,viewport.height));
    const view=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);
    await page.render({canvas,viewport:view,background:'#ffffff'}).promise;
    return recognizeCanvas(canvas,language);
}
async function recognizeCanvas(canvas,language){
    if(ocrWorker&&ocrModel!==language){await ocrWorker.terminate();ocrWorker=null;}
    if(!ocrWorker){
      const {default:Tesseract}=await import('/ocr/tesseract.esm.min.js');
      ocrWorker=await Tesseract.createWorker(language.split('+'),1,{
        workerPath:location.origin+'/ocr/worker.min.js',
        corePath:location.origin+'/ocr/core',
        langPath:location.origin+'/ocr/data',
        cacheMethod:'none',
        workerBlobURL:false
      });
      ocrModel=language;
    }
    const {data}=await ocrWorker.recognize(canvas);
    return data.text.trim();
}

const repairText=$('repair-text');
try{repairText.checked=localStorage.getItem('dsh-repair-text')!=='off';}catch{}
repairText.onchange=()=>{try{localStorage.setItem('dsh-repair-text',repairText.checked?'on':'off');}catch{}};

$('mark-tools-toggle').addEventListener('pointerdown',event=>{if(selectionInPdf())event.preventDefault();});
for(const id of ['highlight','highlight-translation','underline','strikeout','squiggly'])$(id).addEventListener('pointerdown',event=>event.preventDefault());
$('highlight').onclick=()=>highlightSelection(false);
$('highlight-translation').onclick=()=>highlightSelection(true);
const textMarkup={underline:'Underline',strikeout:'StrikeOut',squiggly:'Squiggly'};
for(const [id,markup] of Object.entries(textMarkup))$(id).onclick=()=>highlightSelection(false,markup);
const pdfSelectionMenu=document.createElement('div');
pdfSelectionMenu.className='source-context pdf-selection-menu';
pdfSelectionMenu.setAttribute('popover','auto');
document.body.append(pdfSelectionMenu);
for(const [label,action,singlePageOnly] of [
  ['复制选区',()=>navigator.clipboard.writeText(getSelection().toString()).catch(()=>status('无法复制选区。'))],
  ['就此段提问',askAboutSelection],
  ['高亮',()=>highlightSelection(false),true],
  ['下划线',()=>highlightSelection(false,'Underline'),true],
  ['删除线',()=>highlightSelection(false,'StrikeOut'),true]
]){
  const button=document.createElement('button');
  button.type='button';
  button.textContent=label;
  button.addEventListener('pointerdown',event=>event.preventDefault());
  button.onclick=()=>{action();hidePdfSelectionMenu();};
  if(singlePageOnly)button.dataset.singlePageOnly='';
  pdfSelectionMenu.append(button);
}
function showQuestionSelection(){
  const excerpts=active?.questionSelection;
  $('qa-selection').hidden=!excerpts;
  const pages=excerpts?.map(({page})=>page).join('、');
  $('qa-selection-label').textContent=excerpts?'仅使用第 '+pages+' 页选中文字':'';
  $('qa-selection-preview').open=false;
  $('qa-selection-text').textContent=excerpts?.length===1?excerpts[0].text:
    excerpts?.map(({page,text})=>'第 '+page+' 页\n'+text).join('\n\n')??'';
  $('qa-whole-document').disabled=Boolean(excerpts);
}
function askAboutSelection(){
  const selected=selectionInPdf(),doc=active;
  if(!selected||!doc)return;
  const range=selected.getRangeAt(0),pageOf=node=>pdfTextLayer(node)?.closest('.page');
  let excerpts;
  if(doc.continuous&&pageOf(range.startContainer)!==pageOf(range.endContainer)){
    const first=Number(pageOf(range.startContainer)?.dataset.pageNumber);
    const last=Number(pageOf(range.endContainer)?.dataset.pageNumber);
    if(!first||!last||last-first>=6){status('请将问答选区缩小到 6 页以内。');return;}
    excerpts=[];
    for(let page=first;page<=last;page++){
      const layer=$('continuous-pages').querySelector('.page[data-page-number="'+page+'"] .textLayer');
      if(!layer){status('部分选中页面尚未显示文字，请缩小选区后重试。');return;}
      const part=document.createRange();
      part.selectNodeContents(layer);
      if(page===first)part.setStart(range.startContainer,range.startOffset);
      if(page===last)part.setEnd(range.endContainer,range.endOffset);
      const fragment=part.cloneContents();
      for(const lineBreak of fragment.querySelectorAll('br'))lineBreak.replaceWith('\n');
      const text=normalizePdfText(fragment.textContent);
      if(text)excerpts.push({page,text});
    }
  }else{
    const page=doc.continuous?Number(pageOf(range.startContainer)?.dataset.pageNumber):doc.page;
    const text=normalizePdfText(selected.toString());
    if(!page||!text)return;
    excerpts=[{page,text}];
  }
  if(!excerpts.length)return;
  if(excerpts.reduce((length,{text})=>length+text.length,0)>2200){
    status('选区超过 2200 字，请缩小范围后重试。');return;
  }
  doc.questionSelection=excerpts;
  $('qa-whole-document').checked=false;
  $('follow-up').checked=false;
  selectWorkspace('qa');
  showQuestionSelection();
  $('question').focus({preventScroll:true});
}
function clearQuestionSelection(){
  if(active)delete active.questionSelection;
  showQuestionSelection();
}
$('clear-qa-selection').onclick=clearQuestionSelection;
function pdfTextLayer(node){
  return (node?.nodeType===1?node:node?.parentElement)?.closest('.textLayer');
}
function selectionInPdf(){
  const selected=getSelection();
  if(!active||!selected?.rangeCount||selected.isCollapsed||!selected.toString().trim())return null;
  const start=pdfTextLayer(selected.anchorNode),end=pdfTextLayer(selected.focusNode);
  const container=active.continuous?$('continuous-pages'):$('paper');
  return start&&end&&container.contains(start)&&container.contains(end)?selected:null;
}
function positionPdfSelectionMenu(x,y,anchor){
  const selected=selectionInPdf();
  if(!selected)return;
  const spansPages=pdfTextLayer(selected.anchorNode)!==pdfTextLayer(selected.focusNode);
  for(const button of pdfSelectionMenu.querySelectorAll('[data-single-page-only]'))button.hidden=spansPages;
  const floating=Boolean(anchor);
  pdfSelectionMenu.classList.toggle('floating-selection-menu',floating);
  const mode=floating?'manual':'auto';
  if(pdfSelectionMenu.getAttribute('popover')!==mode)pdfSelectionMenu.setAttribute('popover',mode);
  pdfSelectionMenu.showPopover();
  const pane=floating?$(active?.continuous?'continuous':'scroll').getBoundingClientRect():null;
  const left=Math.max(0,pane?.left??0),right=Math.min(innerWidth,pane?.right??innerWidth);
  const top=Math.max(0,pane?.top??0),bottom=Math.min(innerHeight,pane?.bottom??innerHeight);
  const width=pdfSelectionMenu.offsetWidth,height=pdfSelectionMenu.offsetHeight;
  const desiredTop=floating&&y+height>bottom?anchor.top-height-6:y;
  pdfSelectionMenu.style.left=Math.max(left,Math.min(x,right-width))+'px';
  pdfSelectionMenu.style.top=Math.max(top,Math.min(desiredTop,bottom-height))+'px';
}
document.addEventListener('dsh-page-change',hidePdfSelectionMenu);
document.addEventListener('dsh-page-change',()=>document.querySelector('.embedded-note-popup')?.remove());
function hidePdfSelectionMenu(){
  if(pdfSelectionMenu.matches(':popover-open'))pdfSelectionMenu.hidePopover();
}
const embeddedNoteMenu=document.createElement('div');
embeddedNoteMenu.className='source-context pdf-selection-menu';
embeddedNoteMenu.setAttribute('popover','auto');
document.body.append(embeddedNoteMenu);
document.addEventListener('dsh-page-change',()=>{
  if(embeddedNoteMenu.matches(':popover-open'))embeddedNoteMenu.hidePopover();
});
async function embeddedNoteAtPoint(event,{bodyRequired=false}={}){
  if(event.target.closest('button,a,input,textarea,.embedded-note-popup'))return;
  const doc=active,pdf=doc?.pdf,id=renderId;
  if(!pdf)return;
  const state=doc.continuous?continuousPageState(event.target.closest('.page')):pageView;
  const container=state?.surface??$('paper');
  if(!state?.viewport||!container.contains(event.target))return;
  const bounds=pageContentBounds(state);
  const [x,y]=state.viewport.convertToPdfPoint(event.clientX-bounds.left,event.clientY-bounds.top);
  try{
    const annotations=await (await pdf.getPage(state.page)).getAnnotations();
    if(active!==doc||doc.pdf!==pdf||renderId!==id||!container.isConnected||selectionInPdf())return;
    const bodyFor=annotation=>doc.notes.find(note=>note.editRef===annotation.id)?.text??annotation.contentsObj?.str?.trim();
    const annotation=annotations.find(annotation=>{
      if(!embeddedNoteNames[annotation.subtype]||(bodyRequired&&!bodyFor(annotation)))return false;
      if(doc.notes.some(note=>note.removeRef===annotation.id)||annotation.rect?.length!==4)return false;
      const [left,bottom,right,top]=annotation.rect;
      return x>=left&&x<=right&&y>=bottom&&y<=top;
    });
    if(annotation)return {doc,pdf,state,container,annotation,body:bodyFor(annotation)};
  }catch{/* Annotation lookup must leave the reader usable. */}
}
function openMatchedNote({doc,container,state,annotation,body}){
  showEmbeddedPopup(doc,container,state.viewport,{
    rect:annotation.rect,body,name:embeddedNoteNames[annotation.subtype]
  },document.activeElement);
}
function openEmbeddedNoteMenu(event,hit){
  const {doc,pdf,state,annotation,body}=hit;
  const selectNote=async(action)=>{
    if(active!==doc||doc.pdf!==pdf)return;
    await selectWorkspace('notes');
    if(active!==doc||doc.pdf!==pdf||$('work-notes').hidden)return;
    const row=$('embedded-notes').querySelector('[data-annotation-id="'+CSS.escape(annotation.id)+'"][data-annotation-page="'+state.page+'"]');
    if(!row)return;
    if(action){row.querySelector('[data-note-action="'+action+'"]')?.click();return;}
    row.scrollIntoView({block:'center',behavior:'instant'});
    row.querySelector('button')?.focus({preventScroll:true});
  };
  embeddedNoteMenu.replaceChildren();
  const writable=/^\d+R\d*$/.test(annotation.id??'');
  const actions=[
    ...(body?[['打开批注正文',()=>openMatchedNote(hit)]]:[]),
    ...(writable&&annotation.subtype!=='FreeText'&&!annotation.richText?[['编辑正文',()=>selectNote('edit')]]:[]),
    ...(writable&&canStyleEmbeddedShape(annotation)?[['图形属性',()=>selectNote('properties')]]:[]),
    ['在侧栏管理批注',()=>selectNote()],
    ...(writable?[['标记删除批注',()=>selectNote('remove')]]:[])
  ];
  for(const [label,action] of actions){
    const button=document.createElement('button');
    button.type='button';button.textContent=label;
    button.onclick=()=>{embeddedNoteMenu.hidePopover();void action();};
    embeddedNoteMenu.append(button);
  }
  embeddedNoteMenu.showPopover();
  embeddedNoteMenu.style.left=Math.max(0,Math.min(event.clientX,innerWidth-embeddedNoteMenu.offsetWidth))+'px';
  embeddedNoteMenu.style.top=Math.max(0,Math.min(event.clientY,innerHeight-embeddedNoteMenu.offsetHeight))+'px';
}
for(const surface of [$('paper'),$('continuous')]){
  surface.addEventListener('click',async event=>{
    if(event.defaultPrevented||event.button!==0||pointMarkMode==='note'||selectionInPdf())return;
    if(surface===$('continuous')&&!event.target.closest('button,a,input,textarea')&&
       !surface.matches('.typewriter-active,.rectangle-active,.region-active')){
      const links=event.target.closest('.page')?.querySelectorAll('.linkAnnotation[data-internal-link] > a')??[];
      const link=[...links].find(anchor=>{
        const {left,top,right,bottom}=anchor.getBoundingClientRect();
        return event.clientX>=left&&event.clientX<=right&&event.clientY>=top&&event.clientY<=bottom;
      });
      if(link){link.click();return;}
    }
    if(surface===$('paper')&&pageView?.links?.length&&!event.target.closest('button,a,input,textarea')&&
       !surface.matches('.typewriter-active,.rectangle-active,.region-active')){
      const bounds=surface.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
      const link=pageView.links.find(area=>x>=area.left&&x<=area.right&&y>=area.top&&y<=area.bottom);
      if(link){void link.open();return;}
    }
    const hit=await embeddedNoteAtPoint(event,{bodyRequired:true});
    if(hit)openMatchedNote(hit);
  });
  surface.addEventListener('contextmenu',async event=>{
    if(selectionInPdf()){
      if(!event.target.closest('.textLayer'))return;
      event.preventDefault();
      positionPdfSelectionMenu(event.clientX,event.clientY);
      return;
    }
    if(!active||event.target.closest('button,a,input,textarea,.embedded-note-popup'))return;
    event.preventDefault();
    const hit=await embeddedNoteAtPoint(event);
    if(hit)openEmbeddedNoteMenu(event,hit);
  });
  surface.addEventListener('pointerup',event=>{
    if(event.button!==0)return;
    const selected=selectionInPdf();
    if(!selected)return;
    const pane=$(active?.continuous?'continuous':'scroll').getBoundingClientRect();
    const rect=Array.from(selected.getRangeAt(0).getClientRects())
      .findLast(item=>item.width&&item.height&&item.bottom>pane.top&&item.top<pane.bottom);
    if(!rect)return;
    positionPdfSelectionMenu(rect.left,rect.bottom+6,rect);
  });
}
document.addEventListener('pointerdown',event=>{
  if(!pdfSelectionMenu.contains(event.target))hidePdfSelectionMenu();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')hidePdfSelectionMenu();});
document.addEventListener('selectionchange',()=>{
  if(!selectionInPdf())hidePdfSelectionMenu();
});
document.addEventListener('scroll',event=>{
  if(event.target===$('scroll')||event.target===$('continuous'))hidePdfSelectionMenu();
},true);
function pageContentBounds(state){
  const surface=state.surface??$('paper');
  const content=surface.querySelector(':scope > .canvasWrapper')??surface;
  return content.getBoundingClientRect();
}
function highlightSelection(includeTranslation,markup='Highlight'){
  const range=getSelection();
  const selected=range?.anchorNode?.nodeType===1?range.anchorNode:range?.anchorNode?.parentElement;
  const state=active?.continuous?continuousPageState(selected?.closest('.page')):pageView;
  const surface=state?.surface??$('paper'),layer=surface.querySelector('.textLayer');
  if(!state||!layer||range?.rangeCount!==1||!layer.contains(range.anchorNode)||!layer.contains(range.focusNode)||!range.toString().trim()){
    status('请先选中 PDF 中要标记的文字。');return;
  }
  const bounds=pageContentBounds(state);
  const {viewport,doc,page}=state;
  const scaleX=viewport.width/bounds.width,scaleY=viewport.height/bounds.height;
  const quads=[...range.getRangeAt(0).getClientRects()].filter(rect=>rect.width&&rect.height).map(rect=>
    [[rect.left,rect.top],[rect.right,rect.top],[rect.left,rect.bottom],[rect.right,rect.bottom]]
      .map(([x,y])=>viewport.convertToPdfPoint((x-bounds.left)*scaleX,(y-bounds.top)*scaleY)))
    .map(points=>{
      const xs=points.map(([x])=>x),ys=points.map(([,y])=>y);
      const left=Math.min(...xs),right=Math.max(...xs),top=Math.max(...ys),bottom=Math.min(...ys);
      return [left,top,right,top,left,bottom,right,bottom];
    });
  if(!quads.length)return;
  const text=range.toString().trim();
  const translation=includeTranslation&&doc.translationInfo?.text===normalizePdfText(text)?doc.result:'';
  if(includeTranslation&&!translation){status('请先翻译当前选区，等译文显示后再添加。');return;}
  doc.notes.push({page,text,quads,markup,...(translation?{translation}:{})});
  saveNotes(doc);notes();range.removeAllRanges();drawHighlights(state);
  status(translation?'已添加带译文高亮。':'已添加文字标记，可随批注一起导出。');
}
function shapeMarker(note,viewport){
  const shape=document.createElement('span');
  const stroke=(note.shapeWidth??2)*viewport.scale;
  const color=note.shapeColor??'#2456ad';
  if(note.shapeLine){
    const [x1,y1]=viewport.convertToViewportPoint(...note.shapeLine.slice(0,2));
    const [x2,y2]=viewport.convertToViewportPoint(...note.shapeLine.slice(2));
    const arrow=note.shapeType==='arrow',length=Math.hypot(x2-x1,y2-y1);
    shape.className='dsh-shape-line'+(arrow?' dsh-shape-arrow':'');
    Object.assign(shape.style,{left:x1+'px',top:(y1-stroke/2)+'px',width:length+'px',
      height:stroke+'px',backgroundColor:arrow?'':color,color,transform:'rotate('+Math.atan2(y2-y1,x2-x1)+'rad)'});
    if(arrow){
      const head=Math.min(length,Math.max(7*viewport.scale,stroke*4));
      shape.style.setProperty('--arrow-head',head+'px');
      shape.style.setProperty('--arrow-wing',(head*.42)+'px');
      shape.style.setProperty('--arrow-shaft',(length-head*.65)+'px');
    }
  }else{
    const [x1,y1,x2,y2]=viewport.convertToViewportRectangle(note.shapeRect);
    shape.className='dsh-rectangle';
    Object.assign(shape.style,{left:Math.min(x1,x2)+'px',top:Math.min(y1,y2)+'px',width:Math.abs(x2-x1)+'px',
      height:Math.abs(y2-y1)+'px',borderWidth:stroke+'px',borderColor:color,borderRadius:note.shapeType==='circle'?'50%':''});
  }
  return shape;
}
function drawHighlights(state=pageView){
  if(!state){
    if(active?.continuous)for(const surface of $('continuous-pages').querySelectorAll('.page[data-loaded]'))drawHighlights(continuousPageState(surface));
    return;
  }
  const surface=state.surface??$('paper');
  surface.querySelector('.dsh-highlights:not(.dsh-shape-drag)')?.remove();
  const {doc,page,viewport,embeddedHighlights=[]}=state;
  const overlay=document.createElement('div');
  overlay.className='dsh-highlights';
  const embeddedShapes=new Set(embeddedHighlights.flatMap(note=>note.quads.map(quad=>(note.markup??'Highlight')+':'+quad.map(Math.round).join(','))));
  for(const note of [...embeddedHighlights,...doc.notes]){
    if(note.page!==page)continue;
    if(note.shapeRect||note.shapeLine){
      overlay.append(shapeMarker(note,viewport));
      continue;
    }
    if(note.pointRect){
      const [x1,y1,x2,y2]=viewport.convertToViewportRectangle(note.pointRect);
      const marker=document.createElement('span');
      marker.className='dsh-point-note';
      marker.setAttribute('aria-hidden','true');
      Object.assign(marker.style,{left:Math.min(x1,x2)+'px',top:Math.min(y1,y2)+'px',
        width:Math.abs(x2-x1)+'px',height:Math.abs(y2-y1)+'px'});
      overlay.append(marker);
      continue;
    }
    if(note.freeText){
      const [left,bottom,right,top]=viewport.convertToViewportRectangle(note.freeText);
      const typed=document.createElement('span');
      typed.className='dsh-typewriter-text';typed.textContent=note.text;
      Object.assign(typed.style,{left:Math.min(left,right)+'px',top:Math.min(top,bottom)+'px',width:Math.abs(right-left)+'px',height:Math.abs(bottom-top)+'px',fontSize:Math.max(8,12*viewport.scale)+'px'});
      overlay.append(typed);
      continue;
    }
    if(!Array.isArray(note.quads))continue;
    for(const quad of note.quads){
      if(!embeddedHighlights.includes(note)&&embeddedShapes.has((note.markup??'Highlight')+':'+quad.map(Math.round).join(',')))continue;
      const points=[];
      for(let index=0;index<quad.length;index+=2)points.push(viewport.convertToViewportPoint(quad[index],quad[index+1]));
      const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
      const mark=document.createElement('span');
      Object.assign(mark.style,{
        left:Math.min(...xs)+'px',top:Math.min(...ys)+'px',
        width:Math.max(...xs)-Math.min(...xs)+'px',height:Math.max(...ys)-Math.min(...ys)+'px'
      });
      if(note.color?.length===3)mark.style.backgroundColor='rgba('+Array.from(note.color).join(',')+',0.38)';
      if(note.markup&&note.markup!=='Highlight'){
        mark.className='dsh-mark-'+note.markup;
        mark.style.backgroundColor='transparent';
      }
      overlay.append(mark);
    }
  }
  if(overlay.childElementCount)surface.append(overlay);
}

$('rotate').onclick=()=>{
  if(!active)return;
  active.rotation=(active.rotation+90)%360;
  saveReading(active);
  void render();
};


let pendingDesktopPdf=Promise.resolve();
window.dshDesktop?.onOpenPdf(file=>{
  if(file.error){status('无法打开 '+file.name+'。');return;}
  pendingDesktopPdf=pendingDesktopPdf.then(()=>load(
    [new File([file.bytes],file.name,{type:'application/pdf'})],{fileId:file.fileId,fileScope:file.fileScope}
  )).catch(error=>status('打开 '+file.name+' 失败：'+error.message));
});

$('append-selection').onchange=()=>{
  if(active)active.appendSelection=$('append-selection').checked;
};

const readingTheme=$('reading-theme');
try{
  const saved=localStorage.getItem('dsh-reading-theme');
  if([...readingTheme.options].some(option=>option.value===saved))readingTheme.value=saved;
}catch{}
function applyReadingTheme(){document.documentElement.dataset.readingTheme=readingTheme.value;}
readingTheme.onchange=()=>{
  applyReadingTheme();
  try{localStorage.setItem('dsh-reading-theme',readingTheme.value);}catch{}
};
applyReadingTheme();

const writingOutput=$('writing-output'),writingResultModel=$('writing-result-model');
const writingStatus=$('writing-status'),writingStop=$('writing-stop'),writingUsage=$('writing-usage');
let writingRequest;
writingStop.onclick=()=>writingRequest?.abort();
const writingInput=$('writing-input');
$('writing-clear').onclick=()=>{
  writingInput.value='';
  writingInput.focus();
};
$('writing-copy-input').onclick=async()=>{
  if(!writingInput.value.trim())return;
  try{await navigator.clipboard.writeText(writingInput.value);writingStatus.textContent='原文已复制。';}
  catch{writingStatus.textContent='无法写入剪贴板。';}
};
$('writing-source').onclick=()=>{$('writing-input').value=$('source').value.slice(0,10000);};
$('writing-form').onsubmit=async event=>{
  event.preventDefault();
  if(writingRequest)return;
  const text=$('writing-input').value.trim();
  if(!text){writingStatus.textContent='请输入待处理内容。';return;}
  writingRequest=new AbortController();
  const {signal}=writingRequest;
  writingStop.hidden=false;
  $('writing-submit').disabled=true;$('writing-copy').disabled=true;
  writingOutput.textContent='';writingResultModel.hidden=writingUsage.hidden=true;writingStatus.textContent='正在生成…';
  const mode=$('writing-mode').value;
  try{
    const writingBundled=writingProfileSelect.value===bundledProfileOption;
    const writingProfile=writingBundled?'':writingProfileSelect.value;
    const selected=writingBundled||writingProfile?writingProfileSelect.selectedOptions[0]?.dataset:null;
    const capabilities=selected?null:await getCapabilities(signal);
    const aiService=selected?.aiService??capabilities?.aiService;
    const model=selected?.model??shownAiModel(capabilities?.aiModel,capabilities?.aiThinking);
    if(!aiService)throw Error('请先配置 AI 服务的接口地址和模型。');
    const response=await fetch('/write',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode,text,aiService,writingProfile,writingBundled}),signal
    });
    const data=await response.json();
    if(!response.ok)throw Error(data.error);
    writingOutput.textContent=data.result;writingStatus.textContent='';
    writingResultModel.textContent=model?'生成模型 · '+model:'';
    writingResultModel.hidden=!model;
    const usage=translationUsage();
    usage.add(data.usage);
    writingUsage.textContent=usage.text();
    writingUsage.hidden=!writingUsage.textContent;
    $('writing-copy').disabled=false;
  }catch(error){writingStatus.textContent=signal.aborted?'已停止。':error.message;}
  finally{
    writingRequest=null;
    writingStop.hidden=true;
    $('writing-submit').disabled=false;
  }
};
$('writing-copy').onclick=async()=>{
  try{await navigator.clipboard.writeText(writingOutput.textContent);writingStatus.textContent='结果已复制。';}
  catch{writingStatus.textContent='无法写入剪贴板。';}
};

if(window.dshDesktop?.newWindow){
  $('new-window').hidden=false;
  $('new-window').onclick=async()=>{
    try{await window.dshDesktop.newWindow();}
    catch(error){status('无法打开新窗口：'+error.message);}
  };
}

const paragraphControl=$('split-paragraphs');
try{paragraphControl.checked=localStorage.getItem('dsh-split-paragraphs')==='on';}catch{}
paragraphControl.onchange=()=>{
  try{localStorage.setItem('dsh-split-paragraphs',paragraphControl.checked?'on':'off');}catch{}
};

const rectangleButton=$('rectangle-mark'),shapeType=$('shape-mark-type');
const shapeLabels={square:'矩形',circle:'椭圆',line:'直线',arrow:'箭头'};
shapeType.onchange=()=>{
  rectangleButton.textContent=shapeLabels[shapeType.value]+'批注';
  if(rectangleButton.getAttribute('aria-pressed')==='true')status('在 PDF 页面拖动画出'+shapeLabels[shapeType.value]+'。');
};
function setRectangle(enabled){
  if(!enabled)cancelShapeDrag();
  rectangleButton.setAttribute('aria-pressed',String(enabled));
  for(const surface of [$('paper'),$('continuous')])surface.classList.toggle('rectangle-active',enabled);
}
rectangleButton.onclick=()=>{
  if(!active){status('请先打开 PDF。');return;}
  const enabled=rectangleButton.getAttribute('aria-pressed')!=='true';
  if(enabled)setPointMark(null);
  setRectangle(enabled);
  status(enabled?'在 PDF 页面拖动画出'+shapeLabels[shapeType.value]+'。':'');
};
let rectangleDrag;
function cancelShapeDrag(){
  rectangleDrag?.overlay.remove();
  rectangleDrag=null;
}
function shapePdfPoint(state,event){
  const {viewport}=state,bounds=pageContentBounds(state);
  return viewport.convertToPdfPoint(
    Math.max(0,Math.min(bounds.width,event.clientX-bounds.left))*viewport.width/bounds.width,
    Math.max(0,Math.min(bounds.height,event.clientY-bounds.top))*viewport.height/bounds.height
  );
}
function pointNoteRect(viewport,x,y){
  const [pointerX,pointerY]=viewport.convertToViewportPoint(x,y);
  const size=18*Math.hypot(viewport.transform[0],viewport.transform[1]);
  const width=Math.min(size,viewport.width),height=Math.min(size,viewport.height);
  const left=Math.max(0,Math.min(pointerX,viewport.width-width));
  const top=Math.max(0,Math.min(pointerY,viewport.height-height));
  const [x1,y1]=viewport.convertToPdfPoint(left,top);
  const [x2,y2]=viewport.convertToPdfPoint(left+width,top+height);
  return [Math.min(x1,x2),Math.min(y1,y2),Math.max(x1,x2),Math.max(y1,y2)];
}
function shapeAtPointer(start,event){
  const {state:{doc,page},shapeType,shapeColor,shapeWidth}=start;
  if(active!==doc||doc.rotation!==start.rotation||doc.scale!==start.scale||
     doc.continuous!==start.continuous||!start.overlay.isConnected||
     (!start.continuous&&pageView!==start.state))return null;
  const [x1,y1]=start.point,[x2,y2]=shapePdfPoint(start.state,event);
  const line=shapeType==='line'||shapeType==='arrow';
  if(line?Math.hypot(x2-x1,y2-y1)<3:Math.abs(x2-x1)<3||Math.abs(y2-y1)<3)return null;
  const geometry=line?{shapeLine:[x1,y1,x2,y2]}:
    {shapeRect:[Math.min(x1,x2),Math.min(y1,y2),Math.max(x1,x2),Math.max(y1,y2)]};
  return {page,text:shapeLabels[shapeType]+'批注',shapeType,shapeColor,shapeWidth,...geometry};
}
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&rectangleButton.getAttribute('aria-pressed')==='true'){
    setRectangle(false);status('');
  }
});
for(const container of [$('paper'),$('continuous')]){
  container.addEventListener('pointerdown',event=>{
    if(rectangleButton.getAttribute('aria-pressed')!=='true'||event.button!==0||rectangleDrag)return;
    const state=active?.continuous?continuousPageState(event.target.closest('.page')):pageView;
    if(!state)return;
    event.preventDefault();
    container.setPointerCapture(event.pointerId);
    const {doc}=state;
    const overlay=document.createElement('div');
    overlay.className='dsh-highlights dsh-shape-drag';
    overlay.setAttribute('aria-hidden','true');
    const point=shapePdfPoint(state,event);
    (state.surface??$('paper')).append(overlay);
    rectangleDrag={state,point,overlay,id:event.pointerId,rotation:doc.rotation,scale:doc.scale,
      continuous:doc.continuous,shapeType:shapeType.value,shapeColor:$('shape-mark-color').value,
      shapeWidth:Number($('shape-mark-width').value)};
  });
  container.addEventListener('pointermove',event=>{
    const start=rectangleDrag;
    if(!start||start.id!==event.pointerId)return;
    const shape=shapeAtPointer(start,event);
    if(shape)start.overlay.replaceChildren(shapeMarker(shape,start.state.viewport));
    else start.overlay.replaceChildren();
  });
  for(const type of ['pointercancel','lostpointercapture']){
    container.addEventListener(type,event=>{if(rectangleDrag?.id===event.pointerId)cancelShapeDrag();});
  }
  container.addEventListener('pointerup',event=>{
    const start=rectangleDrag;
    if(!start||start.id!==event.pointerId)return;
    const shape=shapeAtPointer(start,event);
    cancelShapeDrag();
    if(!shape)return;
    const {doc}=start.state;
    doc.notes.push(shape);
    setRectangle(false);
    saveNotes(doc);
    notes();
    drawHighlights(start.state);
    status('已添加'+shape.text+'。');
  });
}
let pointMarkMode=null;
function setPointMark(mode){
  pointMarkMode=mode;
  if(mode){setRectangle(false);setRegionMode(false);}
  $('typewriter').setAttribute('aria-pressed',String(mode==='typewriter'));
  $('place-note').setAttribute('aria-pressed',String(mode==='note'));
  for(const surface of [$('paper'),$('continuous')])surface.classList.toggle('typewriter-active',Boolean(mode));
}
for(const [id,mode,hint] of [
  ['typewriter','typewriter','点击页面上要添加文字的位置。'],
  ['place-note','note','点击页面上要放置附注的位置。']
]){
  $(id).onclick=()=>{
    if(!active){status('请先打开 PDF。');return;}
    setPointMark(pointMarkMode===mode?null:mode);
    status(pointMarkMode?hint:'');
  };
}
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&pointMarkMode){setPointMark(null);status('');}
});
for(const container of [$('paper'),$('continuous')])container.addEventListener('click',async event=>{
  const mode=pointMarkMode;
  if(!mode||event.button!==0)return;
  const state=active?.continuous?continuousPageState(event.target.closest('.page')):pageView;
  if(!state)return;
  const bounds=pageContentBounds(state);
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)return;
  setPointMark(null);
  const {doc,page,viewport}=state;
  const [x,y]=shapePdfPoint(state,event);
  const isNote=mode==='note';
  const input=(await askForText(isNote?'输入附注正文':'输入页面文字','',isNote?'multiline':'text'))?.trim();
  if(!input||!docs.includes(doc))return;
  if(isNote)doc.notes.push({page,text:input,pointRect:pointNoteRect(viewport,x,y)});
  else{
    const [x1,y1,x2,y2]=viewport.viewBox;
    const width=Math.min(250,Math.abs(x2-x1)),height=Math.min(22,Math.abs(y2-y1));
    const start=Math.max(Math.min(x1,x2),Math.min(x,Math.max(x1,x2)-width));
    const bottom=Math.max(Math.min(y1,y2),Math.min(y-height,Math.max(y1,y2)-height));
    doc.notes.push({page,text:input.slice(0,120),freeText:[start,bottom,start+width,bottom+height]});
  }
  saveNotes(doc);
  if(active===doc){notes();drawHighlights(state);status(isNote?'已添加附注。':'已在页面添加文字。');}
});

const settingsTest=$('settings-test'), testEngine=$('settings-test-engine'), testStatus=$('settings-test-status');
let serviceTest;
$('settings').addEventListener('click',()=>{
  testStatus.textContent='';
  testEngine.replaceChildren(...[...engine.options].map(option=>option.cloneNode(true)));
  testEngine.value=engine.value;
});
settingsDialog.addEventListener('close',()=>serviceTest?.abort());
settingsTest.onclick=async()=>{
  const controller=new AbortController(),label=testEngine.selectedOptions[0]?.textContent??'';
  serviceTest=controller;
  settingsTest.disabled=true;
  testStatus.textContent='正在测试 '+label+'…';
  try{
    const result=await translateText('Hello, this is a connection test.',testEngine.value,controller.signal,{useGlossary:false});
    if(!controller.signal.aborted){testStatus.textContent='连接成功。示例译文：'+result;void showLocalModelBackend();}
  }catch(error){if(!controller.signal.aborted)testStatus.textContent='连接失败：'+error.message;}
  finally{if(serviceTest===controller){serviceTest=null;settingsTest.disabled=false;}}
};


const workspaceTabs=[...document.querySelectorAll('.workspace-tabs [role=tab]')];
$('quick-question').onsubmit=event=>{
  event.preventDefault();
  const question=$('quick-question-input').value.trim();
  if(!question)return;
  $('question').value=question;
  $('quick-question-input').value='';
  clearQuestionSelection();
  $('qa-whole-document').checked=$('quick-question-scope').value==='full';
  $('follow-up').checked=false;
  selectWorkspace('qa');
  $('question').focus({preventScroll:true});
  $('ask').click();
};
function selectWorkspace(name){
  if(inputMode&&name!=='selection')setInputTranslationMode(false);
  $('quick-question').hidden=name==='qa';
  const showTranslationControls=name==='selection'||name==='full';
  $('translation-lock-control').hidden=name!=='selection'&&name!=='qa';
  $('translation-engine-control').hidden=$('translation-direction-control').hidden=!showTranslationControls;
  const chosen=$('tab-'+name);
  const changed=chosen.getAttribute('aria-selected')!=='true';
  for(const tab of workspaceTabs){
    const active=tab===chosen;
    tab.setAttribute('aria-selected',String(active));
    tab.tabIndex=active?0:-1;
    $(tab.getAttribute('aria-controls')).hidden=!active;
  }
  if(changed){
    $('translation-scroll').scrollTop=0;
    document.dispatchEvent(new CustomEvent('dsh-workspace-change',{detail:name}));
  }
  if(name==='notes')return showEmbeddedNotes();
}
for(const [index,tab] of workspaceTabs.entries()){
  tab.onclick=()=>selectWorkspace(tab.id.slice(4));
  tab.onkeydown=event=>{
    const next={ArrowLeft:(index+workspaceTabs.length-1)%workspaceTabs.length,ArrowRight:(index+1)%workspaceTabs.length,Home:0,End:workspaceTabs.length-1}[event.key];
    if(next===undefined)return;
    event.preventDefault();event.stopPropagation();
    workspaceTabs[next].click();workspaceTabs[next].focus();
  };
}

const panelDivider=$('panel-divider'),translationPanel=$('translation-panel');
let panelDrag=null;
function resizeTranslationPanel(width){
  const maximum=Math.min(650,Math.floor(innerWidth*.52));
  const clamped=Math.max(300,Math.min(maximum,Math.round(width)));
  document.documentElement.style.setProperty('--translation-width',clamped+'px');
  panelDivider.setAttribute('aria-valuemax',String(Math.max(300,maximum)));
  panelDivider.setAttribute('aria-valuenow',String(clamped));
}
function rememberTranslationWidth(){
  try{localStorage.setItem('dsh-translation-width',String(translationPanel.clientWidth));}catch{}
}
try{
  const savedWidth=Number(localStorage.getItem('dsh-translation-width'));
  if(savedWidth>0)resizeTranslationPanel(savedWidth);
}catch{}
panelDivider.onpointerdown=event=>{
  if(event.button!==0)return;
  panelDrag={id:event.pointerId,x:event.clientX,width:translationPanel.clientWidth};
  panelDivider.setPointerCapture(event.pointerId);
  event.preventDefault();
};
panelDivider.onpointermove=event=>{
  if(panelDrag?.id===event.pointerId)resizeTranslationPanel(panelDrag.width+panelDrag.x-event.clientX);
};
panelDivider.onlostpointercapture=()=>{
  if(!panelDrag)return;
  panelDrag=null;rememberTranslationWidth();
};
panelDivider.onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  resizeTranslationPanel(event.key==='Home'?innerWidth*.31:translationPanel.clientWidth+(event.key==='ArrowLeft'?24:-24));
  rememberTranslationWidth();
};
panelDivider.ondblclick=()=>{
  resizeTranslationPanel(innerWidth*.31);
  rememberTranslationWidth();
};
new ResizeObserver(()=>{
  panelDivider.setAttribute('aria-valuemax',String(Math.min(650,Math.max(300,Math.floor(innerWidth*.52)))));
  panelDivider.setAttribute('aria-valuenow',String(Math.round(translationPanel.getBoundingClientRect().width)));
}).observe(translationPanel);

function clearComparison(){
  comparisonRequest?.abort();
  comparisonRequest=null;
  $('comparison').hidden=true;
  $('comparison-result').textContent='';
  $('comparison-service').textContent='';
  $('comparison-service').hidden=true;
  $('compare').disabled=false;
}
compareEngine.onchange=()=>{
  const wasComparing=Boolean(comparisonRequest);
  clearComparison();
  if(wasComparing)status('');
};
$('compare').onclick=async()=>{
  const base=latestTranslation,chosen=compareEngine.value;
  if(selectionRequest){status('正在翻译，请等当前译文完成。');return;}
  if(!base||base.text!==$(inputMode?'input-translation-text':'source').value.trim()||base.direction!==$('translation-direction').value){status('请先翻译当前原文。');return;}
  if(chosen===base.engine){status('请选择另一种引擎做对照。');return;}
  clearComparison();
  const controller=new AbortController();
  comparisonRequest=controller;
  const label=compareEngine.selectedOptions[0].textContent;
  $('compare').disabled=true;
  status('正在获取 '+label+' 的对照译文…');
  try{
    const usage=translationUsage(),signal=controller.signal;
    const service=chosen==='ai'?await getCapabilities(signal):null;
    const translation=await translateParagraphs(base.paragraphs,chosen,signal,base.direction,service?.aiService??null,usage.add);
    if(controller.signal.aborted||base!==latestTranslation)return;
    $('comparison-title').textContent=label;
    $('comparison-result').textContent=translation;
    const detail=[shownAiModel(service?.aiModel,service?.aiThinking),usage.text()].filter(Boolean).join(' · ');
    $('comparison-service').textContent=detail;
    $('comparison-service').hidden=!detail;
    $('comparison').hidden=false;
    status('');
  }catch(error){if(!controller.signal.aborted)status(error.message);}
  finally{if(comparisonRequest===controller){comparisonRequest=null;$('compare').disabled=false;}}
};

const thumbnails=$('thumbnails'),strip=$('thumbnail-strip');
const thumbnailActions=document.createElement('div');
thumbnailActions.id='thumbnail-actions';
thumbnailActions.className='source-context';
thumbnailActions.popover='auto';
thumbnailActions.setAttribute('role','dialog');
thumbnailActions.setAttribute('aria-label','页面操作');
const thumbnailCommands=[
  ['提取页面',extractPageSelection],
  ['插入空白页并另存',exportWithInsertedPages],
  ['插入 PDF 并另存',(doc,page)=>exportWithInsertedPages(doc,page,'insert')],
  ['替换页面并另存',(doc,page)=>exportWithInsertedPages(doc,page,'replace')],
  ['删除页面并另存',exportWithoutPages],
  ['裁剪页面并另存',exportCroppedPages],
  ['顺时针旋转并另存',(doc,page)=>exportRotatedPage(doc,page,90)],
  ['逆时针旋转并另存',(doc,page)=>exportRotatedPage(doc,page,-90)],
  ['旋转页面（待保存）',(doc,page)=>editRotationRange(doc,page,false)],
  ['批量旋转并另存',(doc,page)=>editRotationRange(doc,page,true)]
];
const thumbnailButtons=thumbnailCommands.map(([label])=>{
  const button=document.createElement('button');
  button.type='button';
  button.textContent=label;
  return button;
});
thumbnailActions.append(...thumbnailButtons);
document.body.append(thumbnailActions);
strip.addEventListener('contextmenu',event=>{
  const thumbnail=event.target.closest('button[data-page]');
  const doc=active;
  if(!thumbnail||!doc)return;
  event.preventDefault();
  thumbnailActions.hidePopover();
  const rect=thumbnail.getBoundingClientRect();
  const x=event.clientX||rect.left,y=event.clientY||rect.bottom;
  for(const [index,button] of thumbnailButtons.entries()){
    button.onclick=()=>{
      thumbnailActions.hidePopover();
      thumbnail.focus({preventScroll:true});
      if(active===doc)void thumbnailCommands[index][1](doc,Number(thumbnail.dataset.page));
    };
  }
  thumbnailActions.showPopover();
  thumbnailActions.style.left=Math.max(0,Math.min(x,innerWidth-thumbnailActions.offsetWidth))+'px';
  thumbnailActions.style.top=Math.max(0,Math.min(y,innerHeight-thumbnailActions.offsetHeight))+'px';
  thumbnailButtons[0].focus({preventScroll:true});
});
let thumbnailObserver;
function resetThumbnails(){
  thumbnailActions.hidePopover();
  thumbnailObserver?.disconnect();
  thumbnailObserver=null;
  strip.replaceChildren();
  thumbnails.hidden=!active;
  if(active&&thumbnails.open)populateThumbnails();
}
function populateThumbnails(){
  const doc=active;
  if(!doc||strip.childElementCount)return;
  const fragment=document.createDocumentFragment();
  thumbnailObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      const button=entry.target;
      thumbnailObserver?.unobserve(button);
      void paintThumbnail(doc,button);
    }
  },{root:strip,rootMargin:'0px 110px'});
  for(let page=1;page<=doc.pdf.numPages;page++){
    const button=document.createElement('button');
    button.type='button';button.dataset.page=String(page);button.setAttribute('aria-label','转到第 '+page+' 页');
    const preview=document.createElement('canvas');
    preview.setAttribute('aria-hidden','true');preview.width=90;preview.height=114;
    const label=document.createElement('span');label.textContent=String(page);
    button.append(preview,label);button.onclick=()=>{if(active===doc)go(page);};
    fragment.append(button);thumbnailObserver.observe(button);
  }
  strip.append(fragment);syncThumbnail();
}
function refreshRotatedThumbnails(doc,pages){
  for(const page of new Set(pages)){
    const button=strip.querySelector('[data-page="'+page+'"]');
    if(button?.dataset.rendered)void paintThumbnail(doc,button);
  }
}
async function paintThumbnail(doc,button){
  const pdf=doc.pdf;
  const pageNumber=Number(button.dataset.page);
  const preview=document.createElement('canvas');
  preview.setAttribute('aria-hidden','true');
  const previous=button.querySelector('canvas');
  preview.width=previous.width;preview.height=previous.height;
  previous.replaceWith(preview);
  button.dataset.rendered='pending';
  try{
    const page=await pdf.getPage(pageNumber);
    if(active!==doc||pdf!==doc.pdf||!preview.isConnected)return;
    const turn=doc.notes.reduce((sum,note)=>note.page===pageNumber?sum+(note.rotateBy??0):sum,0);
    const rotation=((page.rotate+turn)%360+360)%360;
    const view=page.getViewport({scale:1,rotation}),ratio=window.devicePixelRatio||1;
    const viewport=page.getViewport({scale:ratio*Math.min(90/view.width,114/view.height),rotation});
    preview.width=Math.ceil(viewport.width);preview.height=Math.ceil(viewport.height);
    await page.render({canvas:preview,viewport,background:'#fff'}).promise;
    if(preview.isConnected)button.dataset.rendered='true';
  }catch{}
}
function syncThumbnail(){
  const old=strip.querySelector('[aria-current]');
  const next=strip.querySelector('[data-page="'+active?.page+'"]');
  if(old===next)return;
  old?.removeAttribute('aria-current');
  if(next){
    next.setAttribute('aria-current','page');
    const viewport=strip.getBoundingClientRect(),button=next.getBoundingClientRect();
    if(button.right>viewport.right||button.left<viewport.left){
      strip.scrollLeft+=button.left-viewport.left-(viewport.width-button.width)/2;
    }
  }
}
thumbnails.addEventListener('toggle',()=>{if(thumbnails.open)populateThumbnails();});
document.addEventListener('dsh-page-change',syncThumbnail);

const translationDirection=$('translation-direction');
try{if(localStorage.getItem('dsh-direction')==='zh-en')translationDirection.value='zh-en';}catch{}
translationDirection.onchange=()=>{
  updateAutomaticEngine();
  try{localStorage.setItem('dsh-direction',translationDirection.value);}catch{}
  clearComparison();
  if(!inputMode&&!$('work-selection').hidden&&$('source').value.trim())void translate();
};

let continuousViewer,continuousDoc,viewerModule,viewerReady=false,continuousRestore;
async function renderContinuous(doc,id,restorePosition){
  try{
    globalThis.pdfjsLib=pdfjsLibrary;
    viewerModule??=import('/pdf/web/pdf_viewer.mjs');
    const {PDFViewer,EventBus,PDFLinkService}=await viewerModule;
    if(id!==renderId||active!==doc||!doc.continuous)return;
    if(!continuousViewer){
      const eventBus=new EventBus();
      const linkService=new PDFLinkService({eventBus});
      linkService.goToDestination=async destination=>{
        const doc=continuousDoc;
        if(!doc||active!==doc||!doc.continuous)return;
        try{await openPdfDestination(doc,destination);}
        catch{if(active===doc)status('无法打开 PDF 内部链接。');}
      };
      continuousViewer=new PDFViewer({
        container:$('continuous'),viewer:$('continuous-pages'),eventBus,linkService,
        annotationEditorMode:-1
      });
      linkService.setViewer(continuousViewer);
      eventBus.on('pagesinit',()=>{
        if(active!==continuousDoc||!active?.continuous)return;
        const target=active.page;
        continuousViewer.pagesRotation=active.rotation;
        continuousViewer.currentScaleValue=active.fit?'page-width':String(active.scale);
        continuousViewer.currentPageNumber=target;
        restoreReadingScroll(active,continuousRestore);
        continuousRestore=undefined;
        viewerReady=true;
      });
      eventBus.on('scalechanging',({source,scale})=>{
        if(source!==continuousViewer||active!==continuousDoc||!active?.continuous||!Number.isFinite(scale)||scale<=0)return;
        active.scale=scale;
        syncZoom(scale);
      });
      eventBus.on('pagerendered',({source})=>{
        if(active===continuousDoc&&active?.continuous)drawHighlights(continuousPageState(source.div));
      });
      eventBus.on('pagechanging',({pageNumber})=>{
        if(!viewerReady||active!==continuousDoc||!active?.continuous||active.page===pageNumber)return;
        active.page=pageNumber;
        selection='';
        clearSelectionDictionary();
        clearRegionStatus();
        $('page').value=pageNumber;
        rememberReadingScroll(active,$('continuous'));
        document.dispatchEvent(new Event('dsh-page-change'));
      });
    }
    if(continuousDoc!==doc){
      continuousDoc=doc;viewerReady=false;continuousRestore=restorePosition;
      continuousViewer.linkService.setDocument(doc.pdf);
      continuousViewer.setDocument(doc.pdf);
    }else if(viewerReady){
      const target=doc.page;
      viewerReady=false;
      try{
        if(continuousViewer.pagesRotation!==doc.rotation)continuousViewer.pagesRotation=doc.rotation;
        const chosen=doc.fit?'page-width':String(doc.scale);
        if(continuousViewer.currentScaleValue!==chosen)continuousViewer.currentScaleValue=chosen;
        if(continuousViewer.currentPageNumber!==target)continuousViewer.currentPageNumber=target;
        restoreReadingScroll(doc,restorePosition);
      }finally{viewerReady=true;}
    }
  }catch(error){if(active===doc)status('连续阅读加载失败：'+error.message);}
}
$('continuous-toggle').onclick=()=>{
  if(!active)return;
  active.continuous=!active.continuous;
  saveReading(active);
  void render();
};

function continuousPageState(surface){
  const page=Number(surface?.dataset.pageNumber);
  const view=page&&continuousViewer?.getPageView(page-1);
  return view?.viewport&&active===continuousDoc?{doc:active,page,viewport:view.viewport,surface}:null;
}

$('lock').onchange=()=>{
  const checked=$('lock').checked;
  if(active)active.lockTranslation=checked;
  if(!checked){selection='';clearWordDictionary();return;}
  if(!automaticRequest||automaticRequest!==selectionRequest)return;
  automaticRequest.abort();
  clearWordDictionary();
  automaticRequest=null;selectionRequest=null;requestId++;
  $('result').removeAttribute('aria-busy');
  if(latestTranslation){
    $('source').value=latestTranslation.text;
    if(active)active.source=latestTranslation.text;
  }
  updateCopyButton();
  status('已锁定当前译文。');
};

let regionDrag,regionBusy=false;
function clearRegionStatus(){
  if(regionBusy&&$('status').textContent==='正在识别选区…')status('');
}
function setRegionMode(enabled){
  $('region-ocr').setAttribute('aria-pressed',String(enabled));
  for(const surface of [$('paper'),$('continuous')])surface.classList.toggle('region-active',enabled);
  if(!enabled&&regionDrag){regionDrag.outline.remove();regionDrag=null;}
}
$('region-ocr').onclick=()=>{
  if(!active){status('请先打开 PDF。');return;}
  if(regionBusy)return;
  const enabled=$('region-ocr').getAttribute('aria-pressed')!=='true';
  setPointMark(null);setRegionMode(enabled);
  status(enabled?'在 PDF 页面上拖动，框选文字。':'');
};
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('region-ocr').getAttribute('aria-pressed')==='true'){setRegionMode(false);status('');}
});
for(const surface of [$('paper'),$('continuous')]){
  surface.addEventListener('pointerdown',event=>{
    if(event.button!==0||$('region-ocr').getAttribute('aria-pressed')!=='true')return;
    const state=active?.continuous?continuousPageState(event.target.closest('.page')):pageView;
    if(!state)return;
    event.preventDefault();event.stopImmediatePropagation();
    const bounds=pageContentBounds(state);
    const outline=document.createElement('div');outline.className='region-outline';document.body.append(outline);
    regionDrag={state,bounds,outline,id:event.pointerId,x:event.clientX,y:event.clientY};
    surface.setPointerCapture(event.pointerId);
  },true);
  surface.addEventListener('pointermove',event=>{
    if(regionDrag?.id!==event.pointerId)return;
    const {x,y,outline}=regionDrag;
    Object.assign(outline.style,{left:Math.min(x,event.clientX)+'px',top:Math.min(y,event.clientY)+'px',width:Math.abs(event.clientX-x)+'px',height:Math.abs(event.clientY-y)+'px'});
  });
  surface.addEventListener('pointerup',event=>{
    if(regionDrag?.id!==event.pointerId)return;
    const drag=regionDrag;
    setRegionMode(false);
    void recognizeRegion(drag,event.clientX,event.clientY);
  });
  surface.addEventListener('pointercancel',()=>setRegionMode(false));
}
async function recognizeRegion({state,bounds,x,y},endX,endY){
  const {doc,page,viewport}=state;
  const readingPage=doc.page,renderAtStart=renderId;
  const stillCurrent=()=>active===doc&&doc.page===readingPage&&renderId===renderAtStart;
  const left=Math.max(0,Math.min(x,endX)-bounds.left),top=Math.max(0,Math.min(y,endY)-bounds.top);
  const width=Math.min(bounds.width,Math.max(x,endX)-bounds.left)-left;
  const height=Math.min(bounds.height,Math.max(y,endY)-bounds.top)-top;
  if(width<8||height<8){status('选区太小，请重新框选。');return;}
  const language=$('ocr-language').value;
  regionBusy=true;$('region-ocr').disabled=true;
  status('正在识别选区…');
  const pending=ocrQueue.then(async()=>{
    if(active!==doc)return '';
    const pdfPage=await doc.pdf.getPage(page);
    const sx=viewport.width/bounds.width,sy=viewport.height/bounds.height;
    const ratio=Math.min(4/viewport.scale,2200/Math.max(width*sx,height*sy));
    const view=pdfPage.getViewport({scale:viewport.scale*ratio,rotation:viewport.rotation});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(width*sx*ratio);canvas.height=Math.ceil(height*sy*ratio);
    await pdfPage.render({canvas,viewport:view,transform:[1,0,0,1,-left*sx*ratio,-top*sy*ratio],background:'#fff'}).promise;
    const rotation=(viewport.rotation-pdfPage.rotate+360)%360;
    if(!rotation)return recognizeCanvas(canvas,language);
    const upright=document.createElement('canvas');
    const swap=rotation===90||rotation===270;
    upright.width=swap?canvas.height:canvas.width;
    upright.height=swap?canvas.width:canvas.height;
    const ctx=upright.getContext('2d');
    ctx.translate(upright.width/2,upright.height/2);
    ctx.rotate(-rotation*Math.PI/180);
    ctx.drawImage(canvas,-canvas.width/2,-canvas.height/2);
    return recognizeCanvas(upright,language);
  });
  ocrQueue=pending.catch(()=>{});
  try{
    const text=await pending;
    if(!stillCurrent())return;
    if(!text){status('选区内没有识别出文字。');return;}
    doc.source=text;$('source').value=text;updateCopyButton();selectWorkspace('selection');
    if($('auto').checked)void translate({originPage:page});
    else status('已识别选区文字。');
  }catch(error){if(stillCurrent())status('选区识别失败：'+error.message);}
  finally{regionBusy=false;$('region-ocr').disabled=false;}
}

let scanningClipboard=false;
$('paste-image').onclick=async()=>{
  try{
    const items=await navigator.clipboard.read();
    for(const item of items){
      const imageType=item.types.find(type=>type.startsWith('image/'));
      if(imageType){await recognizeClipboardImage(await item.getType(imageType));return;}
    }
    status('剪贴板中没有图片。');
  }catch{status('无法读取剪贴板图片，可按 Ctrl+V 粘贴截图。');}
};
document.addEventListener('paste',event=>{
  if(event.target!==$('source')&&event.target.closest?.('input,textarea,[contenteditable],dialog'))return;
  const image=[...(event.clipboardData?.items??[])].find(item=>item.type.startsWith('image/'))?.getAsFile();
  if(!image)return;
  event.preventDefault();
  void recognizeClipboardImage(image);
});
async function recognizeClipboardImage(image){
  if(scanningClipboard)return;
  const doc=active;
  const language=$('ocr-language').value;
  scanningClipboard=true;$('paste-image').disabled=true;
  status('正在识别剪贴板图片…');
  const pending=ocrQueue.then(async()=>{
    if(active!==doc)return '';
    const bitmap=await createImageBitmap(image);
    const canvas=document.createElement('canvas');
    try{
      const scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height));
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d');
      context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      return await recognizeCanvas(canvas,language);
    }finally{bitmap.close();canvas.width=canvas.height=0;}
  });
  ocrQueue=pending.catch(()=>{});
  try{
    const text=await pending;
    if(active!==doc)return;
    if(!text){status('没有从图片中识别出文字。');return;}
    if(doc)doc.source=text;
    $('source').value=text;selectWorkspace('selection');
    if($('auto').checked)void translate();
    else status('截图文字已填入原文。');
  }catch(error){if(active===doc)status('截图识别失败：'+error.message);}
  finally{scanningClipboard=false;$('paste-image').disabled=false;}
}

const ocrLanguage=$('ocr-language');
try{if(localStorage.getItem('dsh-ocr-language')==='chi_sim+eng')ocrLanguage.value='chi_sim+eng';}catch{}
ocrLanguage.onchange=()=>{try{localStorage.setItem('dsh-ocr-language',ocrLanguage.value);}catch{}};

async function choosePdf(){
  if(!window.dshDesktop?.pickPdfs){control.click();return;}
  try{await window.dshDesktop.pickPdfs();}catch(error){status('打开文件失败：'+error.message);}
}
if(window.dshDesktop?.recentPdfs){
  $('recent-pdfs').hidden=false;
  $('recent-pdfs').onclick=async()=>{
    const list=$('recent-list'),dialog=$('recent-dialog');
    list.replaceChildren();
    try{
      const files=await window.dshDesktop.recentPdfs();
      for(const file of files){
        const button=document.createElement('button');
        button.type='button';button.textContent=file.name;
        button.onclick=async()=>{
          dialog.close();
          try{await window.dshDesktop.openRecent(file.id);}catch(error){status('无法打开最近文献：'+error.message);}
        };
        list.append(button);
      }
      if(!files.length)list.textContent='暂无最近打开的文献。';
      dialog.showModal();
    }catch(error){status('无法读取最近文献：'+error.message);}
  };
}

if(window.dshDesktop?.windowMode){
  const input=$('window-mode');
  $('window-mode-label').hidden=false;
  $('settings').addEventListener('click',()=>{
    void window.dshDesktop.windowMode().then(mode=>{if(mode)input.value=mode;}).catch(()=>{});
  });
  input.onchange=()=>{void window.dshDesktop.setWindowMode(input.value).catch(error=>status(error.message));};
}

const profileSelect=$('profile-select'),profileStatus=$('profile-status');
const quickProfileSelect=$('quick-profile-select'),quickProfileApply=$('quick-profile-apply');
const qaProfileSelect=$('qa-profile-select'),writingProfileSelect=$('writing-profile-select');
const qaProfileKey='dsh-qa-profile',writingProfileKey='dsh-writing-profile';
// Built-in value exceeds the 60-character limit on user profile names.
const bundledProfileOption='@dsh/built-in-model/available-locally-without-api-key/qwen-2.5-writing';
let qaProfileName='',writingProfileName='';
try{qaProfileName=localStorage.getItem(qaProfileKey)??'';writingProfileName=localStorage.getItem(writingProfileKey)??'';}catch{}
function rememberQuestionProfile(name){
  qaProfileName=name;
  try{
    if(name)localStorage.setItem(qaProfileKey,name);
    else localStorage.removeItem(qaProfileKey);
  }catch{}
}
function showQuickQuestionModel(){
  const label=$('quick-question-model');
  const model=qaProfileSelect.value&&qaProfileSelect.selectedOptions[0]?.dataset.model;
  label.hidden=!model;
  label.textContent=model?'问答模型 · '+model:'';
}
qaProfileSelect.addEventListener('change',()=>{
  rememberQuestionProfile(qaProfileSelect.value);
  showQuickQuestionModel();
});
function rememberWritingProfile(name){
  writingProfileName=name;
  try{
    if(name)localStorage.setItem(writingProfileKey,name);
    else localStorage.removeItem(writingProfileKey);
  }catch{}
}
writingProfileSelect.addEventListener('change',()=>rememberWritingProfile(writingProfileSelect.value));
async function refreshProfiles(){
  const [response,capabilities]=await Promise.all([
    fetch('/ai-profiles'),
    getCapabilities().catch(()=>null)
  ]);
  if(!response.ok)return;
  const profiles=await response.json();
  for(const select of [profileSelect,quickProfileSelect]){
    const selected=select.value;
    select.replaceChildren(...profiles.map(({name,model,thinking})=>new Option(name+' · '+shownAiModel(model,thinking),name)));
    if(profiles.some(item=>item.name===selected))select.value=selected;
  }
  $('quick-ai-profile').hidden=!profiles.length;

  for(const select of [qaProfileSelect,writingProfileSelect]){
    select.length=1;
    if(capabilities?.bundledAiService){
      const option=new Option('本地 Qwen 2.5',bundledProfileOption);
      option.dataset.aiService=capabilities.bundledAiService;
      option.dataset.model=option.text;
      select.add(option);
    }
    for(const {name,model,aiService,thinking} of profiles){
      const label=shownAiModel(model,thinking);
      const option=new Option(name+' · '+label,name);
      option.dataset.aiService=aiService;
      option.dataset.model=label;
      select.add(option);
    }
  }

  if([...writingProfileSelect.options].some(option=>option.value===writingProfileName))writingProfileSelect.value=writingProfileName;
  else if(writingProfileName)rememberWritingProfile('');
  $('writing-profile-control').hidden=writingProfileSelect.length===1;
  if([...qaProfileSelect.options].some(option=>option.value===qaProfileName))qaProfileSelect.value=qaProfileName;
  else if(qaProfileName)rememberQuestionProfile('');
  $('qa-profile-control').hidden=qaProfileSelect.length===1;
  showQuickQuestionModel();
  for(const id of ['profile-apply','profile-remove'])$(id).disabled=!profiles.length;
}
$('settings').addEventListener('click',()=>{
  profileStatus.textContent='';
  void refreshProfiles().catch(()=>{});
});
async function changeProfile(action,name){
  profileStatus.textContent='';
  try{
    const response=await fetch('/ai-profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,name})});
    if(!response.ok)throw Error((await response.json().catch(()=>({}))).error??'无法更新方案。');
    if(action==='apply'){
      const settings=await (await fetch('/settings')).json();
      for(const key of ['DSH_AI_URL','DSH_AI_MODEL','DSH_AI_THINKING'])settingsForm.elements.namedItem(key).value=settings[key]??'';
      aiKey.value='';
      clearAiKey.checked=false;
      aiKey.disabled=false;
      syncAiPreset();
      await refreshEngines();
    }
    await refreshProfiles();
    if(action!=='remove')profileSelect.value=quickProfileSelect.value=name;
    profileStatus.textContent=action==='apply'?'已切换 AI 服务方案。':action==='save'?'已保存方案。':'已移除方案。';
    return true;
  }catch(error){profileStatus.textContent=error.message;return false;}
}
$('profile-save').onclick=()=>changeProfile('save',$('profile-name').value.trim());
$('profile-apply').onclick=()=>changeProfile('apply',profileSelect.value);
$('profile-remove').onclick=()=>changeProfile('remove',profileSelect.value);
quickProfileApply.onclick=async()=>{
  quickProfileApply.disabled=true;
  try{
    const changed=await changeProfile('apply',quickProfileSelect.value);
    status(profileStatus.textContent);
    if(changed&&!inputMode&&!$('work-selection').hidden&&engine.value==='ai'&&$('source').value.trim())void translate();
  }finally{quickProfileApply.disabled=false;}
};
const initialProfiles=refreshProfiles().catch(()=>{});

async function getQuestionModel(signal){
  await initialProfiles;
  signal.throwIfAborted();
  const qaProfile=qaProfileName;
  if(qaProfile){
    const selected=qaProfileSelect.selectedOptions[0]?.dataset;
    if(!selected?.aiService)throw Error('无法读取保存的问答模型方案。');
    const qaBundled=qaProfile===bundledProfileOption;
    return {qaProfile:qaBundled?'':qaProfile,qaBundled,aiService:selected.aiService,model:selected.model};
  }
  const capabilities=await getCapabilities(signal);
  return {qaProfile,aiService:capabilities.aiService??null,model:shownAiModel(capabilities.aiModel,capabilities.aiThinking)};
}

async function getCapabilities(signal){
  const response=await fetch('/capabilities',{signal});
  if(!response.ok)throw Error('无法读取当前 AI 服务设置。');
  return response.json();
}

async function getAiService(signal){
  return (await getCapabilities(signal)).aiService??null;
}

let selectionHistoryDb;
const markedHistoryByDocument=new WeakMap(),markedAllHistory=new Set();
const standaloneHistoryKey='input-translation';
const historyEntryKey=({documentKey,entryId,page,engine,direction,text})=>entryId?
  JSON.stringify([documentKey,entryId]):JSON.stringify([documentKey,page,engine,direction??'en-zh',text]);
function openSelectionHistory(){
  selectionHistoryDb??=new Promise((resolve,reject)=>{
    const request=indexedDB.open('dsh-selection-history',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('documents');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>{selectionHistoryDb=null;reject(request.error);};
  });
  return selectionHistoryDb;
}
async function addSelectionHistory(doc,entry){
  try{
    const db=await openSelectionHistory(),key=doc?documentStorageKey(doc):standaloneHistoryKey;
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents'),request=store.get(key);
      tx.oncomplete=resolve;
      tx.onabort=()=>reject(tx.error);
      request.onsuccess=()=>{
        const prior=Array.isArray(request.result)?request.result:[];
        const keep=doc?prior.filter(record=>record.text!==entry.text||record.engine!==entry.engine||record.direction!==entry.direction||record.page!==entry.page):prior;
        store.put([{...entry,documentName:doc?.name??'输入翻译'},...keep].slice(0,80),key);
      };
    });
    if(active===doc||historyScope.value==='all')void refreshSelectionHistory();
  }catch{}
}
async function deleteSelectionHistory(selection){
  const db=await openSelectionHistory(),byDocument=new Map();
  for(const item of selection){
    if(!byDocument.has(item.documentKey))byDocument.set(item.documentKey,new Set());
    byDocument.get(item.documentKey).add(historyEntryKey(item));
  }
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents');
    tx.oncomplete=resolve;
    tx.onabort=()=>reject(tx.error);
    for(const [documentKey,keys] of byDocument){
      const request=store.get(documentKey);
      request.onsuccess=()=>store.put((request.result??[]).filter(item=>!keys.has(historyEntryKey({...item,documentKey}))),documentKey);
    }
  });
}
async function readSelectionHistory(doc){
  const db=await openSelectionHistory();
  return new Promise((resolve,reject)=>{
    const store=db.transaction('documents').objectStore('documents');
    if(doc){
      const keys=new Set([documentStorageKey(doc),doc.pdf.fingerprints[0]]);
      const requests=[...keys].map(documentKey=>new Promise((success,fail)=>{
        const request=store.get(documentKey);
        request.onsuccess=()=>success((request.result??[]).map(item=>({...item,documentKey})));
        request.onerror=()=>fail(request.error);
      }));
      Promise.all(requests).then(groups=>resolve(groups.flat().sort((a,b)=>(b.createdAt??0)-(a.createdAt??0))),reject);
      return;
    }
    const rows=[],request=store.openCursor();
    request.onsuccess=()=>{
      const cursor=request.result;
      if(!cursor){resolve(rows.sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)));return;}
      for(const item of cursor.value??[])rows.push({...item,documentKey:cursor.key});
      cursor.continue();
    };
    request.onerror=()=>reject(request.error);
  });
}
$('selection-history').addEventListener('toggle',()=>{void refreshSelectionHistory();});
let selectionHistoryRange,selectionHistoryRender=0;
const historyScope=$('selection-history-scope'),historyFilter=$('selection-history-filter');
const historyFrom=$('selection-history-from'),historyTo=$('selection-history-to');
historyScope.onchange=()=>{void refreshSelectionHistory();};
function setHistoryDates(from,to){
  historyFrom.value=from;
  historyTo.value=to;
  historyFilter.requestSubmit();
}
$('open-translation-history').onclick=()=>{
  if(inputMode)setInputTranslationMode(false);
  selectWorkspace('selection');
  historyScope.value='all';
  $('selection-history').open=true;
  const now=new Date(),pad=value=>String(value).padStart(2,'0');
  const today=now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate());
  setHistoryDates(today,today);
  historyScope.focus();
};
$('selection-history-clear-dates').onclick=()=>setHistoryDates('','');
historyFilter.onsubmit=event=>{
  event.preventDefault();
  const from=historyFrom.value,to=historyTo.value;
  const error=$('selection-history-filter-error');
  error.hidden=!(from&&to&&from>to);
  error.textContent=error.hidden?'':'开始日期不能晚于结束日期。';
  if(!error.hidden)return;
  selectionHistoryRange=from||to?{
    from:from?new Date(from+'T00:00:00').getTime():-Infinity,
    to:to?new Date(to+'T23:59:59.999').getTime():Infinity
  }:undefined;
  void refreshSelectionHistory();
};
async function refreshSelectionHistory(){
  const render=++selectionHistoryRender;
  const doc=active,list=$('selection-history-list'),all=historyScope.value==='all';
  list.replaceChildren();
  if(!$('selection-history').open)return;
  if(!doc&&!all){list.textContent='请先打开 PDF。';return;}
  try{
    const records=await readSelectionHistory(all?null:doc);
    if(render!==selectionHistoryRender||!$('selection-history').open)return;
    if(!records.length){list.textContent=all?'还没有划词记录。':'这份文献还没有划词记录。';return;}
    const activeKeys=new Set(records.map(historyEntryKey));
    const marked=all?markedAllHistory:markedHistoryByDocument.get(doc)??new Set();
    for(const key of marked)if(!activeKeys.has(key))marked.delete(key);
    if(!all)markedHistoryByDocument.set(doc,marked);
    const range=selectionHistoryRange;
    const visibleRecords=range?records.filter(item=>Number.isFinite(item.createdAt)&&item.createdAt>=range.from&&item.createdAt<=range.to):records;
    if(!visibleRecords.length){list.textContent='所选日期内没有划词记录。';return;}
    const selectedItems=()=>visibleRecords.filter(item=>marked.has(historyEntryKey(item)));
    const exportHistory=document.createElement('button'),deleteHistory=document.createElement('button');
    exportHistory.type='button';
    exportHistory.textContent='导出所选记录';
    exportHistory.disabled=!selectedItems().length;
    exportHistory.onclick=()=>{
      const text=selectedItems().map(item=>
        (all?(item.documentName??'未命名文献')+'\n':'')+(item.page?'第 '+item.page+' 页\n\n':'\n')+'原文\n'+item.text+'\n\n译文\n'+item.result
      ).join('\n\n');
      if(!text)return;
      const url=URL.createObjectURL(new Blob(['\uFEFF',text],{type:'text/plain;charset=utf-8'}));
      const link=document.createElement('a');
      link.href=url;link.download=all?'全部文献-划词历史.txt':doc.name.replace(/\.pdf$/i,'')+'-划词历史.txt';
      link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    };
    deleteHistory.type='button';
    deleteHistory.textContent='删除所选记录';
    deleteHistory.disabled=!selectedItems().length;
    deleteHistory.onclick=async()=>{
      const selection=selectedItems();
      if(render!==selectionHistoryRender||!selection.length||!confirm('删除所选 '+selection.length+' 条划词历史？'))return;

      deleteHistory.disabled=true;
      try{
        await deleteSelectionHistory(selection);
        for(const item of selection)marked.delete(historyEntryKey(item));
        if(active===doc||historyScope.value==='all')void refreshSelectionHistory();
      }catch{
        deleteHistory.disabled=!selectedItems().length;
        if(active===doc)status('无法删除所选记录。');
      }
    };
    const actions=document.createElement('div');
    actions.className='actions';
    const visibleCheckboxes=new Map();
    function selectionAction(label,invert){
      const control=document.createElement('button');
      control.type='button';
      control.textContent=label;
      control.onclick=()=>{
        for(const [key,checkbox] of visibleCheckboxes){
          checkbox.checked=!invert||!marked.has(key);
          if(checkbox.checked)marked.add(key);
          else marked.delete(key);
        }
        syncSelectionActions();
      };
      return control;
    }
    const copyMenu=document.createElement('details'),copySummary=document.createElement('summary');
    copySummary.textContent='复制所选';
    copyMenu.append(copySummary);
    const copyButtons=[
      ['复制原文',item=>item.text],
      ['复制译文',item=>item.result],
      ['复制原文和译文',item=>'原文\n'+item.text+'\n\n译文\n'+item.result]
    ].map(([label,format])=>{
      const control=document.createElement('button');
      control.type='button';
      control.textContent=label;
      control.onclick=async()=>{
        const text=selectedItems().map(format).join('\n\n');
        if(!text)return;
        try{await navigator.clipboard.writeText(text);status('已复制所选历史记录。');}
        catch{status('无法复制所选历史记录。');}
      };
      copyMenu.append(control);
      return control;
    });
    function syncSelectionActions(){
      const disabled=!selectedItems().length;
      for(const control of [exportHistory,deleteHistory,...copyButtons])control.disabled=disabled;
    }
    actions.append(selectionAction('全选',false),selectionAction('反选',true),exportHistory,deleteHistory);
    syncSelectionActions();
    list.append(actions,copyMenu);
    for(const item of visibleRecords){
      const row=document.createElement('div'),checkbox=document.createElement('input'),button=document.createElement('button');
      row.className='selection-history-row';
      const key=historyEntryKey(item);
      checkbox.type='checkbox';
      checkbox.checked=marked.has(key);
      visibleCheckboxes.set(key,checkbox);
      checkbox.setAttribute('aria-label','选中记录：'+item.text.slice(0,85));
      checkbox.onchange=()=>{
        if(checkbox.checked)marked.add(key);
        else marked.delete(key);
        syncSelectionActions();
      };
      const engineName=[...$('engine').options].find(option=>option.value===item.engine)?.textContent??item.engine;
      button.textContent=(all?(item.documentName??'未命名文献')+' · ':'')+(item.page?'第 '+item.page+' 页 · ':'')+engineName+' · '+item.text.slice(0,85);
      const exact=all?docs.find(entry=>documentStorageKey(entry)===item.documentKey):doc;
      const legacy=all&&!exact?docs.filter(entry=>entry.pdf.fingerprints[0]===item.documentKey):[];
      const target=exact??(legacy.length===1?legacy[0]:null);
      if(!target)button.setAttribute('aria-expanded','false');
      button.onclick=()=>{
        if(render!==selectionHistoryRender)return;
        if(!target){
          const preview=document.createElement('p');
          preview.className='history-preview';
          const detail=[item.model,translationUsage(item.usage).text()].filter(Boolean).join(' · ');
          preview.textContent='原文\n'+item.text+'\n\n译文\n'+(item.result||'未获得译文')+(detail?'\n\n'+detail:'');
          const existing=row.querySelector('.history-preview');
          if(existing){existing.remove();button.setAttribute('aria-expanded','false');}
          else{row.append(preview);button.setAttribute('aria-expanded','true');}
          return;
        }
        if(active!==target)activate(target);
        selectionRequest?.abort();selectionRequest=null;automaticRequest=null;requestId++;
        $('result').removeAttribute('aria-busy');
        clearComparison();
        $('source').value=target.source=item.text;
        $('result').textContent=target.result=item.result;
        latestTranslation=target.translationInfo=item;showSelectionService(item);updateCopyButton();
        $('translation-direction').value=item.direction??'en-zh';
        updateAutomaticEngine();
        go(item.page);status('已恢复历史译文。');
      };
      if(Number.isFinite(item.createdAt)){
        const date=new Date(item.createdAt);
        const time=document.createElement('time');
        time.dateTime=date.toISOString();
        time.textContent=date.toLocaleString('zh-CN',{hour12:false});
        button.append(time);
      }
      row.append(checkbox,button);
      list.append(row);
    }
  }catch{if(render===selectionHistoryRender)list.textContent='无法读取划词历史。';}
}
