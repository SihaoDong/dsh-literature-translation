import {chunks,joinSoftLines,joinTranslationParts} from './text-chunks.mjs';
export {chunks} from './text-chunks.mjs';
export function documentStorageKey(doc){
  const fingerprint=doc.pdf.fingerprints[0];
  return doc.fileScope?doc.fileScope+':'+fingerprint:fingerprint;
}
import {exportAnnotatedPdf} from './pdf-notes.mjs';
function usageText({input,output,reasoning}){
  return '输入 '+input+' / 输出 '+output+' token'+
    (Number.isSafeInteger(reasoning)&&reasoning>0&&reasoning<=output?'（其中已报告思考 '+reasoning+'）':'');
}
export function translationUsage(seed){
  let input=0,output=0,reasoning,reported=false;
  function add(counts){
    const {input:incoming,output:outgoing}=counts??{};
    if(!Number.isSafeInteger(incoming)||incoming<0||!Number.isSafeInteger(outgoing)||outgoing<0)return;
    input+=incoming;output+=outgoing;reported=true;
    const value=counts.reasoning;
    if(Number.isSafeInteger(value)&&value>=0&&value<=outgoing)reasoning=(reasoning??0)+value;
  }
  add(seed);
  return {
    add,
    snapshot(){return reported?{input,output,...(reasoning===undefined?{}:{reasoning})}:undefined;},
    text(){return reported?'服务报告用量：'+usageText({input,output,reasoning}):'';}
  };
}
export function addDocumentTools({getActive, go, translateText, status, recognizePage, getCapabilities, getQuestionModel}) {
  const $ = id => document.getElementById(id);
  const output = $('document-output');
  const fullOutput = $('full-output');
  const jumpToCurrentTranslation=$('show-current-translation');
  function syncCurrentTranslation(){
    const page=getActive()?.page;
    const section=fullOutput.querySelector('[data-source-page="'+page+'"]');
    jumpToCurrentTranslation.hidden=!section;
    jumpToCurrentTranslation.textContent=section?'查看第 '+page+' 页译文':'';
    return section;
  }
  jumpToCurrentTranslation.onclick=()=>{
    const section=syncCurrentTranslation();
    if(!section)return;
    section.scrollIntoView({block:'start',behavior:'instant'});
    section.querySelector('button')?.focus({preventScroll:true});
  };
  document.addEventListener('dsh-page-change',syncCurrentTranslation);
  const fullUsage=$('full-usage'),usageByDocument=new WeakMap();
  function showFullUsage(){
    const total=usageByDocument.get(getActive())?.text();
    fullUsage.hidden=!total;
    fullUsage.textContent=total?'本次 · '+total:'';
  }
  const cache = new WeakMap();
  const completedTranslations=new WeakMap(),partialTranslations=new WeakMap();
  const resumeButton=$('resume-translation'),resumeEngine=$('resume-engine');
  const restored=new WeakSet();
  const exportButton=$('export-translation');
  const pdfExport=$('export-bilingual');
  pdfExport.hidden=!window.dshDesktop?.printBilingual;
  $('keep-layout-option').hidden=pdfExport.hidden;
  const exportingBilingual=new WeakSet();
  function syncExportButtons(){
    const doc=getActive();
    const complete=completedTranslations.has(doc);
    const partial=partialTranslations.get(doc)?.nodes.length>0;
    exportButton.disabled=!complete&&!partial;
    exportButton.textContent=partial?'导出已译页面':'导出全文译文';
    pdfExport.disabled=(!complete&&!partial)||exportingBilingual.has(doc);
    syncCurrentTranslation();
    pdfExport.textContent=partial?'导出已译页对照 PDF':'导出对照 PDF';
  }
  pdfExport.onclick=async()=>{
    const doc=getActive(),completed=completedTranslations.get(doc),partial=partialTranslations.get(doc);
    const job=completed??partial;
    if(!job?.nodes.length||exportingBilingual.has(doc))return;
    const pdf=doc.pdf;
    const source=completed?.rows??partial.pages.slice(0,partial.nodes.length)
      .map(({page,text},index)=>({page,source:text,translation:partial.byPage.get(page),engineLabel:partial.sources[index]}));
    exportingBilingual.add(doc);
    syncExportButtons();
    try{
      let rows=source;
      if($('keep-layout').checked){
        rows=[];
        const byPage=new Map(source.map(row=>[row.page,row]));
        const selectedPages=completed?Array.from({length:pdf.numPages},(_,index)=>index+1):source.map(row=>row.page);
        for(const [index,number] of selectedPages.entries()){
          if(getActive()===doc)status('正在准备原页 · '+(index+1)+' / '+selectedPages.length);
          const row=byPage.get(number)??{page:number,source:'',translation:'此页没有可供翻译的文字。'};
          const page=await pdf.getPage(number),unit=page.getViewport({scale:1});
          const view=page.getViewport({scale:Math.min(2.5,1400/Math.max(unit.width,unit.height))});
          const canvas=document.createElement('canvas');
          canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);
          await page.render({canvas,viewport:view,background:'#ffffff'}).promise;
          rows.push({...row,image:canvas.toDataURL('image/jpeg',.9)});
          canvas.width=canvas.height=0;
        }
      }
      const bytes=await window.dshDesktop.printBilingual(rows);
      const current=completedTranslations.get(doc)??partialTranslations.get(doc);
      if(current?.nodes!==job.nodes)return;
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const link=document.createElement('a');link.href=url;
      link.download=doc.name.replace(/\.pdf$/i,'')+(completed?'-中英对照.pdf':'-部分中英对照.pdf');
      link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(getActive()===doc)status(completed?'已导出中英对照 PDF。':'已导出已译页对照 PDF。');
    }catch(error){if(getActive()===doc)status('导出对照 PDF 失败：'+error.message);}
    finally{exportingBilingual.delete(doc);syncExportButtons();}
  };
  const pageTranslation=$('page-translation'), pairButton=$('pair');
  function updatePair(){
    const doc=getActive();
    const show=Boolean(doc?.paired);
    $('reading-layout').classList.toggle('paired',show);
    pageTranslation.hidden=!show;
    pairButton.setAttribute('aria-pressed',String(show));
    if(!show)return;
    const completed=completedTranslations.get(doc),partial=partialTranslations.get(doc);
    const entry=completed?.pages.get(doc.page)??partial?.byPage.get(doc.page);
    const heading=document.createElement('h2');
    heading.textContent='第 '+doc.page+' 页译文';
    const body=document.createElement('p');
    body.textContent=entry??(completed?'此页没有可供翻译的文字。':partial
      ?'当前页尚未译出。':'开始全文翻译后，这里会显示当前页译文。');
    pageTranslation.replaceChildren(heading,body);
    pageTranslation.scrollTop=0;
  }
  document.addEventListener('dsh-page-change',updatePair);
  pairButton.onclick=()=>{
    const doc=getActive();
    if(!doc){status('请先打开 PDF。');return;}
    doc.paired=!doc.paired;
    updatePair();
  };
  exportButton.onclick=()=>{
    const doc=getActive(),complete=completedTranslations.get(doc),partial=partialTranslations.get(doc);
    const confirmedPages=partial?.sections.length??0;
    const translation=complete?.text??(confirmedPages?
      '部分译文 · 已译 '+confirmedPages+' / '+partial.pages.length+' 页\n\n'+partial.sections.join('\n\n'):'');
    if(!translation)return;
    const url=URL.createObjectURL(new Blob(['\uFEFF',translation],{type:'text/plain;charset=utf-8'}));
    const link=document.createElement('a');
    link.href=url;link.download=doc.name.replace(/\.pdf$/i,'')+(complete?'-全文翻译.txt':'-部分译文.txt');link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  };
  const operations={full:null,qa:null};
  const operationMessages={full:'',qa:''};
  const statusNode=$('status'),statusHome=statusNode.parentElement,qaStatusSlot=$('qa-status-slot');
  document.addEventListener('dsh-workspace-change',({detail:name})=>{
    (name==='qa'?qaStatusSlot:statusHome).append(statusNode);
    if(Object.hasOwn(operationMessages,name))status(operationMessages[name]);
    else if(Object.values(operationMessages).includes($('status').textContent))status('');
  });
  function showFullProgress(){
    const doc=getActive();
    const running=operations.full?.doc===doc&&Boolean(doc);
    const partial=partialTranslations.get(doc),complete=completedTranslations.get(doc);
    const state=$('full-progress'),label=$('full-progress-label'),bar=$('full-progress-bar');
    const job=partial??complete;
    const warning=$('full-save-warning');
    warning.hidden=!job?.saveFailed;
    warning.textContent=job?.saveFailed
      ?(job.lastSavedPage?'未能保存最新进度。最近一次成功保存到第 '+job.lastSavedPage+' 页。':'未能保存此次翻译进度。退出后可能无法恢复。'):'';
    state.hidden=!running&&!partial&&!complete;
    if(state.hidden)return;
    if(running&&operations.full.reading){
      bar.removeAttribute('value');
      label.textContent='正在准备全文翻译';
      return;
    }
    const count=(partial??complete)?.nodes.length??0;
    const total=partial?.pages.length??complete?.rows.length??doc.pdf.numPages;
    bar.max=Math.max(1,total);
    bar.value=count;
    const skipped=doc.pdf.numPages-total;
    label.textContent='已译 '+count+' / '+total+' 页'+
      (skipped?'，'+skipped+' 页无可译文字':'')+
      (!running&&partial?' · 可以继续':'');
  }
  const startFull=$('full-translate');
  const cancelFull=$('cancel-document'),cancelQa=$('cancel-qa');
  function setOperation(kind,next){
    operations[kind]=next;
    showFullProgress();
    startFull.disabled=resumeButton.disabled=Boolean(operations.full);
    cancelFull.disabled=!operations.full;
    cancelQa.disabled=!operations.qa;
    $('ask').disabled=$('summarize').disabled=Boolean(operations.qa);
  }
  async function extract(doc,signal,progress){
    if(!cache.has(doc))cache.set(doc,new Map());
    const pageCache=cache.get(doc),pages=[],total=doc.pdf.numPages;
    for(let page=1;page<=total;page++){
      signal?.throwIfAborted();
      if(!pageCache.has(page)){
        progress('正在读取 PDF 文字 · 第 '+page+' / '+total+' 页');
        const extraction=doc.pdf.getPage(page).then(source=>source.getTextContent()).then(content=>{
          const text=content.items.map(item=>item.str===undefined?'':item.str+(item.hasEOL?'\n':' ')).join('').trim();
          return {page,text};
        });
        extraction.catch(()=>pageCache.delete(page));
        pageCache.set(page,extraction);
      }
      pages.push(await pageCache.get(page));
    }
    signal?.throwIfAborted();
    if(!$('include-ocr').checked)return pages.filter(item=>item.text).map(item=>({...item,text:normalizePdfText(item.text)}));
    const readable=[],language=$('ocr-language').value;
    for(const item of pages){
      signal?.throwIfAborted();
      if(item.text){readable.push({...item,text:normalizePdfText(item.text)});continue;}
      progress('正在识别扫描页 · '+item.page+' / '+pages.length);
      const text=await recognizePage(doc,item.page,signal,language);
      signal?.throwIfAborted();
      if(text)readable.push({page:item.page,text:normalizePdfText(text)});
    }
    return readable;
  }
  async function run(kind,work) {
    const doc=getActive();
    if (!doc) {status('请先打开 PDF。');return;}
    operations[kind]?.controller.abort();
    const controller=new AbortController();
    const current={controller,doc,reading:kind==='full'};
    const report=message=>{
      if(operations[kind]!==current||getActive()!==doc)return;
      operationMessages[kind]=message;
      if(!$('work-'+kind).hidden)status(message);
    };
    current.report=report;
    setOperation(kind,current);
    if(kind==='qa')output.replaceChildren();
    report(kind==='qa'?'正在准备问答…':'');
    try {await work(doc,controller.signal,report,current);}
    catch(error){if(!controller.signal.aborted)report(error.message);}
    finally {if(operations[kind]===current)setOperation(kind,null);}
  }

  function updateResume(){
    showFullProgress();
    const job=partialTranslations.get(getActive());
    resumeButton.hidden=$('resume-engine-option').hidden=!job;
    if(job){
      resumeEngine.replaceChildren(...Array.from($('engine').options,item=>item.cloneNode(true)));
      resumeEngine.value=job.engine;
    }
  }
  async function saveFullProgress(doc,job){
    try{
      job.saveFailed=!await persistTranslation(doc,job);
      if(!job.saveFailed)job.lastSavedPage=job.pages[(job.persistedCount??0)-1]?.page;
    }catch{
      job.saveFailed=true;
    }
    if(getActive()===doc)showFullProgress();
  }
  const translateDocument=(resume=false)=>run('full',async (doc,signal,report,operation)=>{
    const usage=translationUsage();
    usageByDocument.set(doc,usage);
    showFullUsage();
    let job=resume?partialTranslations.get(doc):null;
    let previousComplete,previousPartial;
    const selectedEngine=job?(resumeEngine.value||job.engine):$('engine').value;
    const selectedDirection=job?.direction??$('translation-direction').value;
    if(selectedEngine==='local'&&selectedDirection!=='en-zh')throw Error('本地轻量模型仅支持英译中，请切换翻译方向或更换引擎。');
    const service=selectedEngine==='ai'?await getCapabilities(signal):null;
    signal.throwIfAborted();
    if(selectedEngine==='ai'&&!service?.aiService)throw Error('请先配置 AI 服务的接口地址和模型。');
    const engineLabel=service?.localAIActive?'本地 Qwen 2.5':
      service?.aiThinking&&service.aiModel?service.aiModel+'（思考模式）':service?.aiModel??
      [...$('engine').options].find(option=>option.value===selectedEngine)?.textContent??selectedEngine;
    if(!job){
      restored.add(doc);
      const engine=selectedEngine,direction=selectedDirection;
      report('正在读取 PDF 文字…');
      const aiService=service?.aiService;
      signal.throwIfAborted();
      const pages=await extract(doc,signal,report);
      if(!pages.length)throw Error('PDF 没有可选文字，扫描件需要先做 OCR。');
      signal.throwIfAborted();
      job={engine,direction,aiService,pages,sections:[],sources:[],byPage:new Map(),nodes:[]};
      previousPartial=partialTranslations.get(doc);
      partialTranslations.set(doc,job);
      previousComplete=completedTranslations.get(doc);
      completedTranslations.delete(doc);
      syncExportButtons();
      updatePair();
    }
    if(resume&&resumeEngine.value){
      const nextEngine=selectedEngine;
      const nextService=service?.aiService;
      if(nextEngine!==job.engine||nextService!==job.aiService){
        job.engine=nextEngine;
        job.aiService=nextService;
        job.checkpoint=undefined;
        await saveFullProgress(doc,job);
      }
    }
    signal.throwIfAborted();
    const {engine,direction,aiService,pages,nodes}=job;
    operation.reading=false;
    showFullProgress();
    fullOutput.replaceChildren(...nodes);
    syncCurrentTranslation();
    resumeButton.hidden=$('resume-engine-option').hidden=true;
    try{
      for(let index=nodes.length;index<pages.length;index++){
        signal.throwIfAborted();
        const {page,text}=pages[index];
        const pageProgress='正在翻译全文 · 第 '+page+' / '+doc.pdf.numPages+' 页 · '+engineLabel;
        const parts=chunks(text,engine==='mymemory'?490:engine==='baidu'?950:5000);
        const saved=job.checkpoint;
        const translatedParts=saved?.page===page&&saved.inputs.length<=parts.length&&
          saved.inputs.every((input,index)=>input===parts[index])?saved.outputs.slice():[];
        if(parts.length===1||translatedParts.length===parts.length)report(pageProgress);
        for(let part=translatedParts.length;part<parts.length;part++){
          signal.throwIfAborted();
          if(parts.length>1)report(pageProgress+' · 已完成 '+part+' / '+parts.length+' 段');
          const translated=await translateText(parts[part],engine,signal,{direction,aiService,onUsage:counts=>{
            if(signal.aborted)return;
            usage.add(counts);
            if(getActive()===doc)showFullUsage();
          }});
          signal.throwIfAborted();
          translatedParts.push(translated);
          job.checkpoint={page,inputs:parts.slice(0,part+1),outputs:translatedParts.slice()};
          if(!previousComplete&&!previousPartial||nodes.length){
            await saveFullProgress(doc,job);
          }
        }
        signal.throwIfAborted();
        const translatedText=joinTranslationParts(translatedParts);
        job.checkpoint=undefined;
        addTranslatedPage(doc,job,{page,text},translatedText,engineLabel);
        fullOutput.append(nodes[nodes.length-1]);
        syncExportButtons();
        showFullProgress();
        if(getActive()===doc&&doc.page===page)updatePair();
        await saveFullProgress(doc,job);
        signal.throwIfAborted();
      }
      completeTranslation(doc,job);
      partialTranslations.delete(doc);
      syncExportButtons();
      updatePair();
      const skipped=doc.pdf.numPages-pages.length;
      report(skipped?'全文翻译完成。'+skipped+' 页未提取到文字。':'全文翻译完成。');
    }finally{
      if((previousComplete||previousPartial)&&!nodes.length&&partialTranslations.get(doc)===job){
        if(previousPartial)partialTranslations.set(doc,previousPartial);
        else partialTranslations.delete(doc);
        if(previousComplete)completedTranslations.set(doc,previousComplete);
        if(getActive()===doc){
          fullOutput.replaceChildren(...(previousPartial??previousComplete).nodes);
          syncExportButtons();
          updatePair();
          updateResume();
        }
      }else if(getActive()===doc&&operations.full===operation)updateResume();
    }
  });
  startFull.onclick=()=>translateDocument();
  resumeButton.onclick=()=>translateDocument(true);

  function addTranslatedPage(doc,job,{page,text},translatedText,engineLabel){
    const section=document.createElement('section'),link=document.createElement('button');
    section.dataset.sourcePage=page;
    link.textContent='第 '+page+' 页';link.onclick=()=>{if(getActive()===doc)go(page);};
    const original=document.createElement('p'),translated=document.createElement('p');
    original.textContent=text;translated.className='full-result';translated.textContent=translatedText;
    const source=document.createElement('details'),summary=document.createElement('summary');
    summary.textContent='查看原文';
    source.className='full-source';
    source.append(summary,original);
    section.append(link);
    if(engineLabel){
      const engine=document.createElement('span');
      engine.className='excerpt-label full-page-engine';
      engine.textContent=engineLabel;
      section.append(' ',engine);
    }
    section.append(translated,source);
    job.nodes.push(section);
    job.byPage.set(page,translatedText);
    job.sources.push(engineLabel);
    const sourceLabel=engineLabel?'\n翻译引擎：'+engineLabel:'';
    job.sections.push('第 '+page+' 页'+sourceLabel+'\n\n原文\n'+text+'\n\n译文\n'+translatedText);
  }
  function completeTranslation(doc,job){
    completedTranslations.set(doc,{text:job.sections.join('\n\n'),nodes:job.nodes,pages:job.byPage,saveFailed:job.saveFailed,lastSavedPage:job.lastSavedPage,rows:job.pages.map(({page,text},index)=>({page,source:text,translation:job.byPage.get(page),engineLabel:job.sources[index]}))});
  }
  async function restoreTranslation(doc){
    if(!doc||restored.has(doc))return;
    restored.add(doc);
    try{
      const saved=await loadTranslation(doc);
      if(!saved||(!saved.translated?.length&&!saved.checkpoint)||partialTranslations.has(doc)||completedTranslations.has(doc))return;
      const job={engine:saved.engine,direction:saved.direction??'en-zh',aiService:saved.aiService,pages:saved.pages,sections:[],sources:[],byPage:new Map(),nodes:[],storageId:saved.id,persistedCount:saved.translated.length,lastSavedPage:saved.pages[saved.translated.length-1]?.page,checkpoint:saved.checkpoint};
      for(const [index,record] of saved.translated.entries()){
        const {text,engineLabel}=typeof record==='string'?{text:record}:record;
        addTranslatedPage(doc,job,job.pages[index],text,engineLabel);
      }
      const complete=job.nodes.length===job.pages.length;
      if(complete)completeTranslation(doc,job);
      else partialTranslations.set(doc,job);
      if(getActive()!==doc)return;
      fullOutput.replaceChildren(...job.nodes);
      syncExportButtons();
      updateResume();updatePair();
    }catch{}
  }
  function historyKey(doc){return 'dsh-qa:'+documentStorageKey(doc);}
  function history(doc){
    try{
      const records=JSON.parse(localStorage.getItem(historyKey(doc))??localStorage.getItem('dsh-qa:'+doc.pdf.fingerprints[0]));
      return Array.isArray(records)?records:[];
    }catch{return [];}
  }
  function showAnswer(doc,answer){
    output.replaceChildren();
    const paragraph=document.createElement('p');
    const returnButton=document.createElement('button');
    returnButton.type='button';
    returnButton.hidden=true;
    let returnPosition;
    function jumpToCitation(page){
      if(getActive()!==doc||doc.page===page)return;
      const view=$(doc.continuous?'continuous':'scroll');
      returnPosition??={page:doc.page,top:view.scrollTop,left:view.scrollLeft,
        continuous:doc.continuous,rotation:doc.rotation,scale:doc.scale};
      returnButton.textContent='返回第 '+returnPosition.page+' 页';
      returnButton.hidden=false;
      void go(page);
    }
    returnButton.onclick=async()=>{
      if(getActive()!==doc||!returnPosition)return;
      const position=returnPosition;
      returnPosition=null;
      returnButton.hidden=true;
      await go(position.page);
      if(getActive()!==doc||doc.page!==position.page||doc.continuous!==position.continuous||
         doc.rotation!==position.rotation||Math.abs(doc.scale-position.scale)>.001)return;
      const view=$(position.continuous?'continuous':'scroll');
      view.scrollTo({top:position.top,left:position.left,behavior:'instant'});
    };
    let offset=0;
    for(const match of answer.text.matchAll(/\[PDF[ \t]*[:：][ \t]*(\d+)[ \t]*\]|第\s*(\d+)\s*页|\b(?:page[ \t]+|p\.[ \t]*)(\d+)\b(?!\.\d)/gi)){
      const page=Number(match[1]??match[2]??match[3]);
      if(!answer.pages.includes(page))continue;
      paragraph.append(document.createTextNode(answer.text.slice(offset,match.index)));
      const citation=document.createElement('button');
      citation.type='button';citation.className='answer-citation';citation.textContent=match[0];
      citation.onclick=()=>jumpToCitation(page);
      paragraph.append(citation);
      offset=match.index+match[0].length;
    }
    paragraph.append(document.createTextNode(answer.text.slice(offset)));
    const label=document.createElement('p');label.className='excerpt-label';label.textContent='供模型参考的页面';
    if(answer.scope){
      const details=document.createElement('p');
      details.className='excerpt-label';
      const scope=answer.scope==='full'?'全文':answer.scope==='selection'?'选中文字':'相关摘录';
      const usage=answer.usage?usageText(answer.usage):null;
      details.textContent=[scope,answer.model,usage].filter(Boolean).join(' · ');
      output.append(details);
    }
    output.append(paragraph);
    if(answer.truncated){
      const warning=document.createElement('p');
      warning.className='excerpt-label';
      warning.textContent='回答达到模型输出上限，内容可能不完整。';
      output.append(warning);
    }
    output.append(label);
    const links=document.createElement('div');
    links.className='actions';
    for(const page of answer.pages){
      const link=document.createElement('button');
      link.textContent='第 '+page+' 页';link.onclick=()=>jumpToCitation(page);
      links.append(link);
    }
    links.append(returnButton);
    output.append(links);
    if(Array.isArray(answer.sourceExcerpts)&&answer.sourceExcerpts.length){
      const sources=document.createElement('details'),summary=document.createElement('summary');
      sources.className='qa-answer-sources';
      summary.textContent='核对当次发送的原文';
      sources.append(summary);
      for(const {page,text} of answer.sourceExcerpts){
        const source=document.createElement('div'),label=document.createElement('p'),body=document.createElement('p');
        label.className='excerpt-label';
        label.textContent='第 '+page+' 页';
        body.textContent=text;
        source.append(label,body);
        sources.append(source);
      }
      output.append(sources);
    }
  }
  let selectedHistoryIndex=0;
  function renderHistory(doc){
    const container=$('qa-history');
    container.replaceChildren();
    const records=doc?history(doc):[];
    $('follow-up').disabled=!records.length;
    if(!records.length)$('follow-up').checked=false;
    if(!records.length){container.textContent='尚无问答记录。';return;}
    for(const [index,answer] of records.entries()){
      const entry=document.createElement('button');
      entry.className='qa-entry';entry.textContent=answer.question;
      entry.onclick=()=>{
        selectedHistoryIndex=index;
        $('question').value=answer.question;
        showAnswer(doc,answer);status('');
      };
      container.append(entry);
    }
  }
  const answerDocument=(summary=false)=>run('qa',async (doc,signal,report)=>{
    const selected=!summary?doc.questionSelection:null;
    const scope=selected?'selection':$('qa-whole-document').checked?'full':'excerpts';
    if(scope==='full'&&doc.pdf.numPages>50)throw Error('全文问答最多支持 50 页。请改用相关摘录。');
    const question=summary?'请根据提供的文献内容概括研究问题、方法、结果和局限，标注相关页码。材料中没提到的内容请明确指出。':$('question').value.trim();
    if(!question)throw Error('请输入你想询问的问题。');
    const requestedPages=summary||scope!=='excerpts'?new Set():pdfPagesInQuestion(question);
    if([...requestedPages].some(page=>page<1||page>doc.pdf.numPages)){
      throw Error('指定的 PDF 页码超出范围。请输入第 1–'+doc.pdf.numPages+' 页。');
    }
    if(requestedPages.size>6)throw Error('相关摘录最多可指定 6 个 PDF 页。请减少页数，或选择「使用全文」。');
    const records=!summary&&$('follow-up').checked?history(doc).slice(selectedHistoryIndex):[];
    const questionModel=await getQuestionModel(signal);
    const {qaProfile,qaBundled,aiService,model}=questionModel;
    if(!aiService)throw Error('请先配置 AI 服务的接口地址和模型。');
    const pages=selected??(await extract(doc,signal,report)).filter(item=>
      item.text.trim()&&(!requestedPages.size||requestedPages.has(item.page)));
    if(requestedPages.size&&pages.length!==requestedPages.size){
      const available=new Set(pages.map(item=>item.page));
      const missing=[...requestedPages].filter(page=>!available.has(page));
      throw Error('未提取到指定 PDF 页的文字：'+missing.join('、')+'。请检查页面或启用「识别扫描页」。');
    }
    signal.throwIfAborted();
    if(scope==='full'&&pages.length!==doc.pdf.numPages){
      const readable=new Set(pages.map(item=>item.page));
      const missing=Array.from({length:doc.pdf.numPages},(_,index)=>index+1).filter(page=>!readable.has(page));
      const suggestion=$('include-ocr').checked?'请检查这些页面或关闭「使用全文」。':'请启用「识别扫描页」，或关闭「使用全文」。';
      throw Error('以下页面没有提取到文字：'+missing.join('、')+'。'+suggestion);
    }
    if(!pages.length)throw Error('PDF 没有可供问答使用的文字。');
    const previous=records[0];
    const threadId=previous?.threadId??crypto.randomUUID();
    const turns=Array.isArray(previous?.context)
      ?[previous,...previous.context.slice().reverse()].slice(0,5)
      :previous?.threadId?records.filter(record=>record.threadId===threadId).slice(0,5):records.slice(0,1);
    const context=turns.length?turns.map(({question,text,answer},index)=>({
      question:question.slice(0,index===0?2000:400),
      answer:(text??answer).slice(0,index===0?2500:600)
    })).reverse():null;
    let excerpts=pages;
    if(scope==='excerpts'){
      const candidates=pages.flatMap(({page,text})=>chunks(text,2200).map(part=>({page,text:part})));
      excerpts=summary?sampleExcerpts(candidates):await rankExcerpts(candidates,question+' '+(context?.at(-1)?.question??''),signal,questionModel,report,requestedPages);
    }
    signal.throwIfAborted();
    report(summary?'正在生成文献摘要…':scope==='full'?'正在阅读全文，等待模型开始回答…':'正在等待模型开始回答…');
    const response=await fetch('/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,excerpts,context,aiService,scope:scope==='selection'?'excerpts':scope,qaProfile,qaBundled}),signal});
    const {text,truncated,usage}=await readAnswer(response,signal,()=>report('正在输出回答…'));
    signal.throwIfAborted();
    const answer={threadId,scope,model,usage,context:context??[],question:summary?'文献摘要':question,text,truncated,pages:[...new Set(excerpts.map(excerpt=>excerpt.page))]};
    if(selected)answer.sourceExcerpts=excerpts;
    showAnswer(doc,answer);
    try{
      localStorage.setItem(historyKey(doc),JSON.stringify([answer,...history(doc)].slice(0,50)));
      selectedHistoryIndex=0;
      renderHistory(doc);
      report('回答完成。');
    }catch{report('回答已生成，无法保存问答历史。');}
  });
  async function readAnswer(response,signal,onFirstText){
    if(!response.ok||!response.headers.get('content-type')?.includes('application/x-ndjson')){
      const data=await response.json();
      if(!response.ok)throw Error(data.error);
      return {text:data.result,truncated:false};
    }
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let pending='',text='',finished=false,truncated=false,usage;
    output.textContent='';
    try{
      while(true){
        const {done,value}=await reader.read();
        signal.throwIfAborted();
        if(done)break;
        pending+=decoder.decode(value,{stream:true});
        let newline;
        while((newline=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,newline);
          pending=pending.slice(newline+1);
          if(!line)continue;
          const event=JSON.parse(line);
          if(event.error)throw Error(event.error);
          if(event.delta){
            if(!text)onFirstText();
            text+=event.delta;
            output.append(document.createTextNode(event.delta));
          }
          if(event.truncated===true)truncated=true;
          if(event.usage)usage=event.usage;
          if(event.done)finished=true;
        }
      }
      if(!finished)throw Error('AI 回复连接提前结束。');
      return {text,truncated,usage};
    }finally{reader.releaseLock();}
  }
  $('ask').onclick=()=>answerDocument();
  $('summarize').onclick=()=>answerDocument(true);
  function tokens(text){
    return new Set((text.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]/g)??[]).filter(word=>!stopwords.has(word)));
  }
  const stopwords=new Set('the a an and of from by on at is are was were in to as does do how what when why which used this that for into with paper study'.split(' '));
  function pdfPagesInQuestion(question){
    const pages=new Set();
    for(const match of question.matchAll(/\[PDF\s*[:：]\s*(\d+)\s*\]|\bPDF\s*(?:第\s*(\d+)\s*页|page\s+(\d+)\b(?!\.\d))/giu)){
      pages.add(Number(match[1]??match[2]??match[3]));
    }
    return pages;
  }
  function figureReferences(text,captionOnly=false){
    const pattern=captionOnly
      ?/(?:^|\n)\s*(figure|fig\.?|table|图|表)\s*([0-9]+(?:[.-][0-9]+)*)(?=\s*[.:：、．])/giu
      :/\b(figure|fig\.?|table)\s*([0-9]+(?:[.-][0-9]+)*)(?![0-9])|([图表])\s*([0-9]+(?:[.-][0-9]+)*)/giu;
    return new Set([...text.matchAll(pattern)].map(([,english,number,chinese,chineseNumber])=>{
      const label=(english??chinese).toLowerCase();
      return (label==='table'||label==='表'?'table':'figure')+':'+(number??chineseNumber);
    }));
  }
  async function rankExcerpts(candidates,query,signal,{aiService,qaProfile,qaBundled},report,requestedPages){
    if(candidates.length<=6)return candidates;
    const references=figureReferences(query);
    const probe=sampleExcerpts(candidates).map(item=>item.text.slice(0,350)).join(' ');
    if(/[\u3400-\u9fff]/u.test(query)&&(probe.match(/[a-z]/gi)?.length??0)>(probe.match(/[\u3400-\u9fff]/g)?.length??0)*3){
      report('正在匹配英文文献片段…');
      try{
        const response=await fetch('/search-terms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:query.trim().slice(0,4000),aiService,qaProfile,qaBundled}),signal});
        if(response.ok){
          const {terms}=await response.json();
          if(typeof terms==='string')query+=' '+terms;
        }
      }catch{signal.throwIfAborted();}
    }
    const terms=[...tokens(query)],frequency=new Map(terms.map(term=>[term,0]));
    const matches=candidates.map(candidate=>{
      const words=tokens(candidate.text),found=terms.filter(term=>words.has(term));
      for(const term of found)frequency.set(term,frequency.get(term)+1);
      const captions=references.size?[...figureReferences(candidate.text,true)].filter(id=>references.has(id)).length:0;
      return {candidate,found,captions};
    });
    const score=({found})=>found.reduce((sum,term)=>sum+Math.log((candidates.length+1)/frequency.get(term)),0);
    const relevanceOrder=matches.sort((a,b)=>b.captions-a.captions||score(b)-score(a));
    const ranked=[];
    for(const page of requestedPages){
      const match=relevanceOrder.find(item=>item.candidate.page===page);
      if(match)ranked.push(match.candidate);
    }
    for(const {candidate,found,captions} of relevanceOrder){
      if(ranked.length===6)break;
      if((found.length||captions)&&!ranked.includes(candidate))ranked.push(candidate);
    }
    if(ranked.length<6){
      const remaining=candidates.filter(item=>!ranked.includes(item));
      ranked.push(...sampleExcerpts(remaining,6-ranked.length));
    }
    return ranked.sort((a,b)=>a.page-b.page);
  }
  function sampleExcerpts(candidates,limit=6){
    if(candidates.length<=limit)return candidates;
    if(limit===1)return [candidates[Math.floor(candidates.length/2)]];
    return Array.from({length:limit},(_,index)=>candidates[Math.round(index*(candidates.length-1)/(limit-1))]);
  }
  $('save-notes').onclick=async()=>{
    const doc=getActive();
    if(!doc){status('请先打开 PDF。');return;}
    try {
      const data=doc.notes.length?await exportAnnotatedPdf(doc.bytes,doc.notes):doc.bytes;
      const url=URL.createObjectURL(new Blob([data],{type:'application/pdf'}));
      const anchor=document.createElement('a');anchor.href=url;
      anchor.download=doc.name.replace(/\.pdf$/i,'')+(doc.notes.length?'-批注.pdf':'-副本.pdf');anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      status('已另存 PDF 副本。');
    } catch(error){status('无法导出批注：'+error.message);}
  };
  const stop=kind=>{
    const operation=operations[kind];
    if(!operation)return;
    operation.controller.abort();
    operation.report('已停止。');
  };
  cancelFull.onclick=()=>stop('full');
  cancelQa.onclick=()=>stop('qa');
  let searchId=0,searchRequest;
  const search=$('find-input'), results=$('find-results'), findStatus=$('find-status');
  $('find-form').onsubmit=async event=>{
    event.preventDefault();
    searchRequest?.abort();
    searchRequest=new AbortController();
    const id=++searchId,doc=getActive(),query=search.value.trim().toLowerCase();
    results.replaceChildren();
    if(!doc||!query){findStatus.textContent=doc?'请输入关键词。':'请先打开 PDF。';return;}
    findStatus.textContent='正在查找…';
    try{
      const pages=await extract(doc,searchRequest.signal,message=>{if(id===searchId)findStatus.textContent=message;});
      if(id!==searchId)return;
      let count=0;
      for(const {page,text} of pages){
        const offset=text.toLowerCase().indexOf(query);
        if(offset<0)continue;
        count++;
        const li=document.createElement('li'),button=document.createElement('button');
        button.type='button';
        button.textContent='第 '+page+' 页 · '+text.slice(Math.max(0,offset-30),offset+query.length+45).replace(/\s+/g,' ');
        button.onclick=()=>{if(getActive()===doc)go(page);};
        li.append(button);results.append(li);
      }
      findStatus.textContent=count?'在 '+count+' 页找到关键词。':'没有找到关键词。';
    }catch{
      if(id===searchId)findStatus.textContent='无法读取文献文字。';
    }
  };
  return ()=>{
    for(const kind of Object.keys(operations)){
      operations[kind]?.controller.abort();
      operationMessages[kind]='';
      setOperation(kind,null);
    }
    output.replaceChildren();selectedHistoryIndex=0;
    fullOutput.replaceChildren(...(partialTranslations.get(getActive())?.nodes??completedTranslations.get(getActive())?.nodes??[]));
    updateResume();
    showFullUsage();
    void restoreTranslation(getActive());
    searchRequest?.abort();searchId++;results.replaceChildren();findStatus.textContent='';search.value='';syncExportButtons();$('question').value='';$('follow-up').checked=false;$('qa-whole-document').checked=false;renderHistory(getActive());
  };
}

export function normalizePdfText(text){
  const trimmed=text.trim();
  if(!document.getElementById('repair-text')?.checked)return trimmed;
  return joinSoftLines(trimmed
    .replace(/\u00ad[ \t]*\r?\n[ \t]*/g,'')
    .replace(/\u00ad/g,'')
    .replace(/([A-Za-z]{2,})-[ \t]*\r?\n[ \t]*([a-z]{2,})/g,'$1$2'));
}



let translationDb;
const translationRange=key=>IDBKeyRange.bound([key,0],[key,Number.MAX_SAFE_INTEGER]);
function translationStore(){
  translationDb??=new Promise((resolve,reject)=>{
    const request=indexedDB.open('dsh-translations',2);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('documents'))db.createObjectStore('documents');
      if(!db.objectStoreNames.contains('pages'))db.createObjectStore('pages');
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>{db.close();translationDb=null;};
      resolve(db);
    };
    request.onerror=()=>{translationDb=null;reject(request.error);};
  });
  return translationDb;
}
async function persistTranslation(doc,job){
  const db=await translationStore();
  const key=documentStorageKey(doc),previousId=job.storageId;
  const id=previousId??crypto.randomUUID();
  const count=job.nodes.length,checkpoint=job.checkpoint;
  let saved=false;
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['documents','pages'],'readwrite');
    tx.oncomplete=resolve;
    tx.onabort=()=>reject(tx.error);
    const documents=tx.objectStore('documents'),pages=tx.objectStore('pages');
    const existing=documents.get(key);
    existing.onsuccess=()=>{
      if(previousId&&existing.result?.id!==previousId)return;
      if(!previousId)pages.delete(translationRange(key));
      if(!previousId||existing.result.engine!==job.engine||existing.result.aiService!==job.aiService){
        documents.put({id,engine:job.engine,direction:job.direction,aiService:job.aiService,pages:job.pages},key);
      }
      const start=previousId?(job.persistedCount??0):0;
      for(let index=start;index<count;index++){
        const text=job.byPage.get(job.pages[index].page);
        pages.put({text,engineLabel:job.sources[index]},[key,index]);
      }
      if(checkpoint)pages.put(checkpoint,[key,-1]);
      else pages.delete([key,-1]);
      saved=true;
    };
  });
  if(saved){job.storageId=id;job.persistedCount=count;}
  return saved;
}
async function loadTranslation(doc){
  const db=await translationStore(),key=documentStorageKey(doc);
  const saved=await readTranslation(db,key);
  if(saved||!doc.fileScope)return saved;
  const legacy=await readTranslation(db,doc.pdf.fingerprints[0]);
  return legacy?{...legacy,id:undefined}:legacy;
}
function readTranslation(db,key){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['documents','pages']);
    const metadata=tx.objectStore('documents').get(key),pages=tx.objectStore('pages').getAll(translationRange(key));
    const checkpoint=tx.objectStore('pages').get([key,-1]);
    tx.onabort=()=>reject(tx.error);
    tx.oncomplete=()=>{
      const saved=metadata.result;
      resolve(saved?.id?{...saved,translated:pages.result,checkpoint:checkpoint.result}:saved);
    };
  });
}
