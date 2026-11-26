import {createHash,randomUUID} from 'node:crypto';

export async function translateWithYoudao(text,signal,reverse){
  const {DSH_YOUDAO_APP_ID:appKey,DSH_YOUDAO_KEY:key}=process.env;
  if(!appKey||!key)throw Error('请在服务设置中填写有道翻译应用 ID 和密钥。');
  const salt=randomUUID(),curtime=String(Math.floor(Date.now()/1000));
  const input=text.length>20?text.slice(0,10)+text.length+text.slice(-10):text;
  const sign=createHash('sha256').update(appKey+input+salt+curtime+key).digest('hex');
  const response=await fetch('https://openapi.youdao.com/api',{
    method:'POST',
    body:new URLSearchParams({q:text,from:reverse?'zh-CHS':'en',to:reverse?'en':'zh-CHS',appKey,salt,sign,signType:'v3',curtime,strict:'true'}),
    signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])
  });
  if(!response.ok)throw Error('有道翻译返回 HTTP '+response.status);
  const data=await response.json();
  if(String(data.errorCode)!=='0')throw Error('有道翻译返回错误 '+String(data.errorCode??'未知')+'。');
  if(!Array.isArray(data.translation)||!data.translation.length||data.translation.some(item=>typeof item!=='string'))throw Error('有道翻译未返回译文。');
  return data.translation.join('\n');
}
