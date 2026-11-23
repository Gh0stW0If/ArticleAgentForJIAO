import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeepSeekLlm} from '../packages/skills/dist/index.js';
test('timeout also covers a provider that sends headers before its delayed body',async()=>{
 const llm=createDeepSeekLlm({apiKey:'unit',retries:0,timeoutMs:25,fetchImpl:async(_url,init)=>({
   ok:true,status:200,json:()=>new Promise((_,reject)=>{
     init.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));
   }),
 })});
 await assert.rejects(llm.invoke({system:'s',user:'u',tag:'body-timeout'}),error=>error.kind==='timeout');
});
