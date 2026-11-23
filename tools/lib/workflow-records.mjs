import {fingerprint} from './workflow-store.mjs';
export function mergeResultRecord(records, incoming) {
 const existing=records.find(record=>record.id===incoming.id);
 if(!existing){records.push(incoming);return;}
 const conflict=Object.keys(incoming.values).some(key=>existing.values[key]!==undefined && Number(existing.values[key])!==Number(incoming.values[key]));
 if(conflict){
  const issue='相同结局、组别和时点出现不同数值，保留各来源供核对';
  existing.status='needs_review';
  existing.issues=[...new Set([...existing.issues,issue])];
  incoming.status='needs_review';
  incoming.issues=[...new Set([...incoming.issues,issue])];
  incoming.id=fingerprint([incoming.id,incoming.values,incoming.evidence]).slice(0,24);
  if(!records.some(record=>record.id===incoming.id))records.push(incoming);
  return;
 }
 for(const [key,value] of Object.entries(incoming.values)){
  if(existing.values[key]!==undefined)continue;
  existing.values[key]=value;existing.evidence[key]=incoming.evidence[key];
 }
 existing.issues=[...new Set([...existing.issues,...incoming.issues])];
 existing.status=existing.issues.length?'needs_review':'reported';
}
