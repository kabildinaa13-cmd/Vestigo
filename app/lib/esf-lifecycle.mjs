const normalized=v=>String(v||"").normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g,"");
export const cancelledEsf=status=>/^(REVOKED|CANCELLED|CANCELED|DELETED|ОТОЗВАН|АННУЛИРОВАН|ОТМЕНЕН)/u.test(String(status||"").toUpperCase());
export function esfKind(value){const text=String(value||"").toUpperCase();return /FIXED|CORRECTED|ИСПРАВЛ/u.test(text)?"corrected":/ADDITIONAL|ДОПОЛНИТ/u.test(text)?"additional":"ordinary";}
export function resolveEsfRevisions(records){
 const groups=new Map(),superseded=new Set(),conflicting=new Set(),states=new Map(),risks=[];
 for(const item of records){if(item.row.type!=="invoice"||!item.row.number)continue;if(!groups.has(item.key))groups.set(item.key,{key:item.key,rows:[],sources:[]});groups.get(item.key).rows.push(item.row);groups.get(item.key).sources.push(item.source);}
 const index=new Map();for(const g of groups.values()){const row=g.rows[0],key=normalized(row.senderId)+"|"+normalized(row.number);if(!index.has(key))index.set(key,[]);index.get(key).push(g);}
 const replacements=new Map();
 const issue=(group,others,message)=>{for(const g of [group,...others])conflicting.add(g.key);risks.push({key:"esf-revision:"+group.key,code:"AMBIGUOUS_ESF_REVISION",severity:"high",description:message,evidence:[group,...others].flatMap(g=>g.sources),rule:"Исправленная ЭСФ замещает исходную только по явной ссылке, однозначным сторонам, валюте и непротиворечивым реквизитам. Дополнительная ЭСФ не замещает исходную автоматически."});};
 for(const g of groups.values()){
  const row=g.rows[0],kind=esfKind(row.esf?.kind),baseNumber=String(row.esf?.baseNumber||"").trim();states.set(g.key,{kind,baseNumber,status:"active"});
  if(g.rows.every(r=>cancelledEsf(r.status))){states.set(g.key,{kind,baseNumber,status:"cancelled"});continue;}
  if(kind==="ordinary")continue;
  const candidates=baseNumber?(index.get(normalized(row.senderId)+"|"+normalized(baseNumber))||[]):[];
  if(kind==="additional"){states.set(g.key,{kind,baseNumber,status:"additional",basePresent:candidates.length===1,note:"Сумма дополнительной ЭСФ учитывается как подписана в выгрузке; разность с исходной не вычисляется наугад."});continue;}
  if(!baseNumber||!candidates.length){states.set(g.key,{kind,baseNumber,status:"base_missing",note:"Исходная ЭСФ не представлена: проверить ссылку и полноту редакций."});continue;}
  const parent=candidates[0],r=parent.rows[0],consistent=new Set(g.rows.map(r=>JSON.stringify([r.senderId,r.recipientId,r.currency,r.date,r.esf?.baseNumber,r.esf?.kind]))).size===1;
  const parentConsistent=parent.rows.every(p=>p.senderId===r.senderId&&p.recipientId===r.recipientId&&p.currency===r.currency)&&!(parent.rows.some(p=>cancelledEsf(p.status))&&parent.rows.some(p=>!cancelledEsf(p.status)));
  const valid=g.rows.every(r=>!cancelledEsf(r.status)&&r.senderId&&r.recipientId&&r.date&&r.currency!=="UNKNOWN"&&Number.isSafeInteger(r.amountMinor))&&consistent&&parentConsistent&&new Set(g.rows.filter(r=>r.amountBasis!=="line").map(r=>r.amountMinor)).size<=1&&!(row.esf?.baseDate&&r.esf?.issueDate&&row.esf.baseDate!==r.esf.issueDate);
  if(candidates.length!==1||parent.key===g.key||r.recipientId!==row.recipientId||r.currency!==row.currency||!valid){issue(g,candidates,"Противоречивые реквизиты исправленной и исходной ЭСФ. Обе суммы требуют проверки, автоматического выбора редакции нет.");continue;}
  if(!replacements.has(parent.key))replacements.set(parent.key,[]);replacements.get(parent.key).push(g);
 }
 for(const [parentKey,children] of replacements){if(children.length!==1){issue(groups.get(parentKey),children,"Несколько действующих исправленных ЭСФ ссылаются на одну исходную. Суммы не агрегируются до разрешения противоречия.");continue;}let cursor=children[0].key,cycle=false;const visited=new Set([parentKey]);while(replacements.get(cursor)?.length===1){if(visited.has(cursor)){cycle=true;break;}visited.add(cursor);cursor=replacements.get(cursor)[0].key;}if(cycle){issue(groups.get(parentKey),children,"Обнаружен цикл ссылок исправленных ЭСФ. Автоматический выбор редакции заблокирован.");}}
 for(const [parentKey,children] of replacements)if(children.length===1&&!conflicting.has(parentKey)&&!conflicting.has(children[0].key)){superseded.add(parentKey);states.set(parentKey,{...states.get(parentKey),status:"superseded",replacedBy:children[0].rows[0].number});}
 return {superseded,conflicting,states,risks};
}
