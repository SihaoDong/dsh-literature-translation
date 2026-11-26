import {translateWithYoudao} from './youdao.mjs';
import {translateWithBaidu} from './baidu.mjs';
import {writeFile, rename, unlink} from 'node:fs/promises';
import {aiServiceId,assistWriting,askAboutPaper,bundledTranslationService,deepSeekBalance,deepSeekModels,compatibleModels,englishSearchTerms,serviceCapabilities,translateWithAI,usesBundledAI,usesThinkingAI} from './ai.mjs';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([['/','index.html'],['/app.mjs','app.mjs'],['/style.css','style.css'],['/document-tools.mjs','document-tools.mjs'],['/text-chunks.mjs','text-chunks.mjs'],['/pdf-notes.mjs','pdf-notes.mjs'],['/pdf-lib.js','node_modules/pdf-lib/dist/pdf-lib.min.js']]);
const configKeys=['DSH_GOOGLE_KEY','DSH_YOUDAO_APP_ID','DSH_YOUDAO_KEY','DSH_BAIDU_APP_ID','DSH_BAIDU_KEY','DSH_AI_URL','DSH_AI_MODEL','DSH_AI_KEY','DSH_AI_THINKING','DSH_DEEPL_KEY','DSH_TRANSLATE_URL','DSH_TRANSLATE_KEY'];
let settingsQueue=Promise.resolve(),protectSecret,aiProfiles=[],settingsReadFailed=false;
let translateLocally;
export function setLocalTranslator(translate){translateLocally=translate;}
export function setSettingsProtection(protection,profiles=[],loadFailed=false){
  protectSecret=protection;
  aiProfiles=profiles;
  settingsReadFailed=loadFailed;
}
function writeSettings(file,change){
  const pending=settingsQueue.then(async()=>{
    const {values={},profiles=aiProfiles}=typeof change==='function'?change():{values:change};
    const config=Object.fromEntries(configKeys.map(key=>[key,values[key]??process.env[key]??'']));
    const stored=Object.fromEntries(Object.entries(config).map(([key,value])=>[
      key,key.endsWith('_KEY')&&value&&protectSecret?protectSecret(value):value
    ]));
    if(profiles.length)stored.aiProfiles=profiles.map(profile=>({...profile,key:profile.key&&protectSecret?protectSecret(profile.key):profile.key}));
    const temp=file+'.tmp';
    try{
      await writeFile(temp,JSON.stringify(stored,null,2));
      await rename(temp,file);
    }catch(error){await unlink(temp).catch(()=>{});throw error;}
    aiProfiles=profiles;
    settingsReadFailed=false;
    for(const [key,value] of Object.entries(config))process.env[key]=value;
  });
  settingsQueue=pending.catch(()=>{});
  return pending;
}
const mime = {html:'text/html',css:'text/css',mjs:'text/javascript',js:'text/javascript',wasm:'application/wasm',pfb:'application/octet-stream'};
const server = http.createServer(async (req,res) => {
  const controller=new AbortController(),{signal}=controller;
  res.once('close',()=>{if(!res.writableEnded)controller.abort();});
  try {
    if (req.headers.host !== '127.0.0.1:'+server.address().port) {res.writeHead(403).end();return;}
    const path = new URL(req.url, 'http://localhost').pathname;
    const wordMatch=/^\/dictionary\/([a-z][a-z'-]{0,49})$/i.exec(path);
    if(req.method==='GET'&&wordMatch){
      const url='https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(wordMatch[1].toLowerCase());
      const upstream=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(6000)])});
      if(!upstream.ok){res.writeHead(upstream.status===404?404:502).end();return;}
      const entries=await upstream.json();
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(entries.slice(0,3)));
      return;
    }
    const settingsFile=process.env.DSH_SETTINGS_FILE;
    if(settingsFile&&req.method==='POST'&&['/deepseek-balance','/deepseek-models'].includes(path)){
      if(req.headers.origin!=='http://'+req.headers.host){res.writeHead(403).end();return;}
      const accountData=path==='/deepseek-models'?await deepSeekModels(signal):await deepSeekBalance(signal);
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(accountData));
      return;
    }
    if (settingsFile && path === '/settings' && req.method === 'GET') {
      const fields=Object.fromEntries(configKeys.filter(key=>!key.endsWith('_KEY')).map(key=>[key,process.env[key]??'']));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(fields));
      return;
    }
    if(settingsFile&&path==='/ai-profiles'&&req.method==='GET'){
      const profiles=aiProfiles.map(profile=>({name:profile.name,model:profile.model,thinking:usesThinkingAI(profile),aiService:aiServiceId(profile)}));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(profiles));
      return;
    }
    if (req.method === 'GET' && path === '/capabilities') {
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...serviceCapabilities(),local:Boolean(translateLocally),settingsReadFailed}));
      return;
    }
    if (req.method === 'POST' && (path === '/translate' || path === '/ask' || path === '/search-terms' || path === '/write' || (settingsFile && ['/settings','/ai-profiles','/compatible-models'].includes(path)))) {
      if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
      let body = '';
      const bodyLimit=path==='/ask'?1000000:45000;
      req.setEncoding('utf8');
      for await (const part of req) {
        body += part;
        if (body.length > bodyLimit) { res.writeHead(413).end(); return; }
      }
      const payload = JSON.parse(body);
      if(path==='/compatible-models'){
        if(req.headers.origin!=='http://'+req.headers.host){res.writeHead(403).end();return;}
        const models=await compatibleModels(payload,signal);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(models));
        return;
      }
      let usage;
      function reportUsage(counts){
        usage??={input:0,output:0};
        usage.input+=counts.input;
        usage.output+=counts.output;
        if(counts.reasoning!==undefined)usage.reasoning=(usage.reasoning??0)+counts.reasoning;
      }
      const usesAI=(path==='/translate'&&payload.engine==='ai')||['/ask','/search-terms','/write'].includes(path);
      const profileName=path==='/write'?payload.writingProfile:(path==='/ask'||path==='/search-terms')&&payload.qaProfile;
      const bundled=path==='/write'&&payload.writingBundled===true||
        (path==='/ask'||path==='/search-terms')&&payload.qaBundled===true;
      const answerService=bundled?bundledTranslationService:profileName?aiProfiles.find(profile=>profile.name===profileName):undefined;
      if(usesAI&&((profileName&&!answerService)||(Object.hasOwn(payload,'aiService')&&payload.aiService!==aiServiceId(answerService)))){
        res.writeHead(409,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({code:'AI_SERVICE_CHANGED',error:'AI 服务方案已切换。请切回原方案继续，或用新方案重新开始。'}));
        return;
      }
      if(path==='/ai-profiles'){
        if(req.headers.origin!=='http://'+req.headers.host){res.writeHead(403).end();return;}
        const name=typeof payload.name==='string'?payload.name.trim():'';
        if(!name||name.length>60){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'请输入 1 到 60 个字符的方案名称。'}));return;}
        await writeSettings(settingsFile,()=>{
          const profile=aiProfiles.find(item=>item.name===name);
          if(payload.action==='save'){
            const {DSH_AI_URL:url,DSH_AI_MODEL:model,DSH_AI_KEY:key='',DSH_AI_THINKING:thinking=''}=process.env;
            if(!url||!model)throw Error('请先保存 AI 接口地址和模型。');
            if(!profile&&aiProfiles.length>=16)throw Error('最多保存 16 个 AI 方案。');
            return {profiles:[...aiProfiles.filter(item=>item.name!==name),{name,url,model,key,thinking}]};
          }
          if(!profile)throw Error('找不到该 AI 方案。');
          if(payload.action==='remove')return {profiles:aiProfiles.filter(item=>item.name!==name)};
          if(payload.action==='apply')return {values:{DSH_AI_URL:profile.url,DSH_AI_MODEL:profile.model,DSH_AI_KEY:profile.key,DSH_AI_THINKING:profile.thinking??''}};
          throw Error('无效的 AI 方案操作。');
        });
        res.writeHead(204).end();return;
      }
      if (path === '/settings') {
        if(req.headers.origin !== 'http://'+req.headers.host){res.writeHead(403).end();return;}
        const settings={};
        for(const key of configKeys){
          if(!Object.hasOwn(payload,key))continue;
          const value=payload[key];
          if(typeof value!=='string'||value.length>2048)throw Error('设置值格式无效。');
          if(key==='DSH_AI_THINKING'&&value!==''&&value!=='enabled')throw Error('无效的思考模式。');
          if(key.endsWith('_URL') && value){
            let url;
            try{url=new URL(value);}catch{throw Error('服务地址必须是完整的 HTTP 或 HTTPS 地址。');}
            if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('服务地址格式无效。');
          }
          settings[key]=value;
        }
        await writeSettings(settingsFile,()=>{
          const origin=value=>{try{return new URL(value).origin;}catch{return null;}};
          for(const [url,key] of [['DSH_AI_URL','DSH_AI_KEY'],['DSH_TRANSLATE_URL','DSH_TRANSLATE_KEY']]){
            if(Object.hasOwn(settings,url)&&!Object.hasOwn(settings,key)&&origin(settings[url])!==origin(process.env[url])){
              settings[key]='';
            }
          }
          return {values:settings};
        });
        res.writeHead(204).end();return;
      }
      if (path === '/search-terms') {
        if(typeof payload.question!=='string'||!payload.question.trim()||payload.question.length>4000){
          res.writeHead(400).end();return;
        }
        const terms=await englishSearchTerms(payload.question,signal,answerService);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({terms}));
        return;
      }
      if (path === '/write') {
        const {mode,text}=payload;
        if(typeof text!=='string'||!text.trim()||text.length>10000){
          res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:'请输入 1 到 10000 字符。'}));
          return;
        }
        const result=await assistWriting(mode,text,signal,answerService,reportUsage);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({result,usage}));
        return;
      }
      if (path === '/ask') {
        const {question,excerpts,context,scope='excerpts'} = payload;
        const whole=scope==='full';
        const turns=context==null?[]:Array.isArray(context)?context:[context];
        if (typeof question !== 'string' || !question.trim() || question.length > 2000 ||
          turns.length>5 || turns.some(turn=>!turn || typeof turn.question!=='string' || turn.question.length>2000 ||
            typeof turn.answer!=='string' || turn.answer.length>2500) ||
          !['excerpts','full'].includes(scope) || !Array.isArray(excerpts) || !excerpts.length || excerpts.length > (whole?50:6) ||
          excerpts.some(item=>!item || !Number.isInteger(item.page) || item.page < 1 ||
            typeof item.text !== 'string' || item.text.length > (whole?180000:2200))) {
          res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'问题或文献摘录格式无效。'}));
          return;
        }
        if(whole&&(new Set(excerpts.map(item=>item.page)).size!==excerpts.length||excerpts.some(item=>item.page>50))){
          res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:'全文页码格式无效。'}));
          return;
        }
        const fullTextLength=whole?excerpts.reduce((size,item)=>size+item.text.length,0):0;
        const exceedsLocalContext=whole&&usesBundledAI(answerService)&&Buffer.byteLength(body)>18000;
        if(whole&&(fullTextLength>180000||exceedsLocalContext)){
          const error=exceedsLocalContext
            ?'全文超过本地 Qwen 的问答长度上限。请取消「使用全文」，改用相关摘录。'
            :'全文文字超过当前问答模式上限。请改用相关摘录。';
          res.writeHead(413,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error}));
          return;
        }
        try{
          for await(const event of askAboutPaper(question,excerpts,context,signal,answerService)){
            signal.throwIfAborted();
            if(!res.headersSent)res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});
            res.write(JSON.stringify(event)+'\n');
          }
          res.end(JSON.stringify({done:true})+'\n');
        }catch(error){
          if(signal.aborted)return;
          if(!res.headersSent)throw error;
          res.end(JSON.stringify({error:error.message})+'\n');
        }
        return;
      }
      const {text,engine,direction='en-zh'} = payload;
      const inputError=!['en-zh','zh-en'].includes(direction)?'请选择有效的翻译方向。'
        :typeof text!=='string'||!text.trim()?'请选择或输入原文。'
        :text.length>10000?'原文超过 10000 个字符，请缩短后重试。':null;
      if(inputError){
        res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:inputError}));
        return;
      }
      const reverse=direction==='zh-en';
      const base = process.env.DSH_TRANSLATE_URL;
      let result;
      if(engine==='local'){
        if(reverse)throw Error('本地轻量模型仅支持英译中，请切换翻译方向或更换引擎。');
        if(!translateLocally)throw Error('当前包缺少本地翻译模型。');
        result=await translateLocally(text,signal);
      } else if (engine === 'ai'||engine === 'local-qwen') {
        const glossary=payload.glossary??'';
        if(typeof glossary!=='string'||glossary.length>4000)throw Error('术语表不能超过 4000 个字符。');
        const entries=glossary.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
          const match=/^([^=]+?)\s*=\s*(.+)$/.exec(line.trim());
          if(!match||!match[1].trim()||!match[2].trim())throw Error('术语表每行应为：原词 = 译法。');
          return [match[1].trim(),match[2].trim()];
        });
        const service=engine==='local-qwen'?bundledTranslationService:undefined;
        result = await translateWithAI(text,entries,signal,reverse,service,reportUsage);
      } else if (engine === 'google') {
        const key=process.env.DSH_GOOGLE_KEY;
        if(!key)throw Error('请在服务设置中填写谷歌云翻译 API 密钥。');
        const response=await fetch('https://translation.googleapis.com/language/translate/v2',{
          method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
          body:JSON.stringify({q:text,format:'text',source:reverse?'zh-CN':'en',target:reverse?'en':'zh-CN'}),
          signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])
        });
        if(!response.ok)throw Error('谷歌云翻译返回 HTTP '+response.status+'。');
        result=(await response.json()).data?.translations?.[0]?.translatedText;
      } else if (engine === 'youdao') {
        result=await translateWithYoudao(text,signal,reverse);
      } else if (engine === 'baidu') {
        result=await translateWithBaidu(text,signal,reverse);
      } else if (engine === 'deepl') {
        const key = process.env.DSH_DEEPL_KEY;
        if (!key) throw Error('请在服务设置中填写 DeepL 密钥。');
        const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
        const response=await fetch('https://'+host+'/v2/translate',{
          method:'POST',
          headers:{Authorization:'DeepL-Auth-Key '+key,'Content-Type':'application/json'},
          body:JSON.stringify({text:[text],source_lang:reverse?'ZH':'EN',target_lang:reverse?'EN':'ZH-HANS'}),
          signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])
        });
        if (!response.ok) throw Error('DeepL 返回 HTTP '+response.status);
        result=(await response.json()).translations?.[0]?.text;
      } else if (engine === 'libre' && base) {
        const response = await fetch(new URL('/translate',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:reverse?'zh':'en',target:reverse?'en':'zh',format:'text',api_key:process.env.DSH_TRANSLATE_KEY}),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
        if (!response.ok) throw Error('翻译服务返回 ' + response.status);
        result = (await response.json()).translatedText;
      } else if (engine === 'mymemory') {
        if (Buffer.byteLength(text) > 500) throw Error('MyMemory 单次最多 500 字节，请缩短选区或配置 LibreTranslate。');
        const url = new URL('https://api.mymemory.translated.net/get');
        url.search = new URLSearchParams({q:text,langpair:reverse?'zh-CN|en':'en|zh-CN'});
        const response = await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
        const data = await response.json().catch(()=>null);
        const serviceStatus=Number(data?.responseStatus);
        if(response.status===429||serviceStatus===429||data?.quotaFinished===true){
          res.writeHead(429,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:'MyMemory 翻译额度已用完，请等待额度恢复，或改用已配置的翻译引擎。'}));
          return;
        }
        if(!response.ok||serviceStatus!==200)throw Error('MyMemory 暂时无法翻译，请稍后再试。');
        result = data.responseData?.translatedText;
      } else throw Error('请在服务设置中填写 LibreTranslate 服务地址。');
      if (typeof result !== 'string') throw Error('翻译服务未返回译文。');
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({result,usage}));
      return;
    }
    if (req.method !== 'GET') {res.writeHead(405).end(); return;}
    let ocrAsset;
    if(/^\/ocr\/(worker\.min|tesseract\.esm\.min)\.js$/.test(path))ocrAsset='node_modules/tesseract.js/dist/'+path.slice(5);
    if(/^\/ocr\/core\/tesseract-core[\w.-]*\.(js|wasm)$/.test(path))ocrAsset='node_modules/tesseract.js-core/'+path.slice(10);
    const language=/^\/ocr\/data\/(eng|chi_sim)\.traineddata\.gz$/.exec(path)?.[1];
    if(language)ocrAsset='node_modules/@tesseract.js-data/'+language+'/4.0.0_best_int/'+language+'.traineddata.gz';
    const relative = assets.get(path) ?? ocrAsset ?? (/^\/pdf\/(build|web|cmaps|standard_fonts|wasm)\/[\w.-]+$/.test(path) ? 'node_modules/pdfjs-dist/' + path.slice(5) : '');
    if (!relative) {res.writeHead(404).end();return;}
    const file = resolve(root,relative);
    if (!file.startsWith(resolve(root)+sep)) {res.writeHead(404).end();return;}
    const bytes = await readFile(file);
    res.writeHead(200,{'Content-Type':(mime[file.split('.').pop()] ?? 'application/octet-stream'),'X-Content-Type-Options':'nosniff'}).end(bytes);
  } catch (error) {
    if(signal.aborted||res.destroyed)return;
    res.writeHead(error.code === 'ENOENT' ? 404 : 502,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:error.message}));
  }
});
export const ready = new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(Number(process.env.DSH_PORT ?? 8765),'127.0.0.1',()=>{
    const url='http://127.0.0.1:'+server.address().port;
    console.log('Dsh文献翻译  '+url);
    if(process.argv.includes('--open')&&process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true}).unref();
    resolve(url);
  });
});
await ready;
