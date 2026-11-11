const parse=s=>{try{return JSON.parse(s||'{}');}catch{return {};}};
const key=o=>o?.externalKey||o?.external_key||o?.key;
export function containsDocumentReference(text,number){
  if(!number||String(number).trim().length<2)return false;
  const needle=String(number).normalize('NFKC').toLocaleLowerCase('ru'),haystack=String(text||'').normalize('NFKC').toLocaleLowerCase('ru');
  // Literal search with Unicode boundaries. Avoid compiling a distinct Unicode
  // regexp for each invoice in a large statement; numbers are not code.
  for(let at=haystack.indexOf(needle);at>=0;at=haystack.indexOf(needle,at+1)){const end=at+needle.length;if(!/[\p{L}\p{N}]$/u.test(haystack.slice(Math.max(0,at-2),at))&&!/^[\p{L}\p{N}]/u.test(haystack.slice(end,end+2)))return true;}
  return false;
}
export function thirdPartySupport(i,p,e){
  if(!i||!p||!e||i.type!=='invoice'||p.type!=='payment'||!['contract','primary'].includes(e.type))return false;
  if(e.conflict||e.reviewStatus==='rejected'||e.review==='rejected'||!e.sources?.length||e.currency!==i.currency)return false;
  if(p.senderId===i.recipientId||p.recipientId!==i.senderId||p.currency!==i.currency)return false;
  const parties=[e.senderId,e.recipientId];
  return parties.includes(p.senderId)&&parties.includes(i.recipientId)&&containsDocumentReference(`${e.number||''} ${e.reference||''} ${e.purpose||''}`,i.number);
}
export function verifiedPartyEvidence(db,caseId,i,p){
  if(!i||!p||i.recipientId===p.senderId||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_payment_party_evidence'").get())return null;
  const resolve=o=>key(o)||db.prepare('SELECT external_key FROM operations WHERE case_id=? AND id=?').get(caseId,o.id)?.external_key;
  const ik=resolve(i),pk=resolve(p);if(!ik||!pk)return null;
  const r=db.prepare("SELECT * FROM case_payment_party_evidence WHERE case_id=? AND invoice_key=? AND payment_key=? AND status='confirmed'").get(caseId,ik,pk);
  if(!r||r.invoice_fingerprint!==i.fingerprint||r.payment_fingerprint!==p.fingerprint)return null;
  const raw=db.prepare('SELECT o.id,o.operation_type type,o.currency,o.external_key,x.details_json,x.fingerprint,x.review_status FROM operations o JOIN case_operation_details x ON x.operation_id=o.id WHERE o.case_id=? AND o.external_key=?').get(caseId,r.evidence_key);
  if(!raw||raw.fingerprint!==r.evidence_fingerprint)return null;
  const evidence={...parse(raw.details_json),...raw,reviewStatus:raw.review_status};
  if(!thirdPartySupport(i,p,evidence))return null;
  return {valid:true,payerId:p.senderId,debtorId:i.recipientId,supplierId:i.senderId,evidenceId:raw.id,evidenceFingerprint:raw.fingerprint,sources:evidence.sources,note:r.note};
}
