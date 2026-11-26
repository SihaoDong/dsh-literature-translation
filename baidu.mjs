import {createHash, randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

let queue=Promise.resolve(), nextRequest=0;
export function translateWithBaidu(text,signal,reverse){
  const {DSH_BAIDU_APP_ID:appid,DSH_BAIDU_KEY:key}=process.env;
  if(!appid||!key)throw Error('请在服务设置中填写百度翻译 APP ID 和密钥。');
  if(text.length>1000)throw Error('百度翻译单次最多 1000 字符。');
  const request=queue.then(async()=>{
    const wait=nextRequest-Date.now();
    signal.throwIfAborted();
    if(wait>0)await delay(wait,undefined,{signal});
    signal.throwIfAborted();
    nextRequest=Date.now()+1050;
    const salt=randomBytes(12).toString('hex');
    const sign=createHash('md5').update(appid+text+salt+key).digest('hex');
    const response=await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate',{
      method:'POST',body:new URLSearchParams({q:text,from:reverse?'zh':'en',to:reverse?'en':'zh',appid,salt,sign}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])
    });
    if(!response.ok)throw Error('百度翻译返回 HTTP '+response.status);
    const data=await response.json();
    if(data.error_code)throw Error('百度翻译返回错误 '+data.error_code+'。');
    if(!Array.isArray(data.trans_result)||!data.trans_result.length||data.trans_result.some(item=>typeof item.dst!=='string'))throw Error('百度翻译未返回译文。');
    return data.trans_result.map(item=>item.dst).join('\n');
  });
  queue=request.catch(()=>{});
  return request;
}
