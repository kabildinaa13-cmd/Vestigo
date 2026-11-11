import {getCase} from './vestigo-db.mjs';

const labels={
 planned:/^(?:общая (?:стоимость|сумма) (?:работ|услуг|договора)|(?:договорная|сметная) стоимость работ|стоимость работ по договору|цена договора|сумма договора)$/iu,
 actual:/^(?:(?:стоимость|сумма) (?:фактического исполнения|фактически выполненных работ|выполненных работ|оказанных услуг|принятых работ)|фактическая (?:стоимость|сумма) работ)$/iu,
 documented:/^документально подтверждённая исходная сумма для расчёта$/iu,
};
const amountWithCurrency=/^(\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[,.](\d{1,2}))?[ \t]*(KZT|EUR|USD|RUB|тенге|теңге|₸|€|₽)$/iu;
const currencyMap={ТЕНГЕ:'KZT',ТЕҢГЕ:'KZT','₸':'KZT','€':'EUR','₽':'RUB'};
const acts=new Set(['completion_act','acceptance_act','performance']);

export function readWorkCost({type,group,name,id,hash,body,pages=[]}){
 const role=group==='contract'&&['agreement','supply_agreement','work_contract','addendum','specification'].includes(type)||type==='claimed_damage'?'planned':acts.has(type)?'actual':null;
 if(!role)return null;
 const texts=pages.length?pages.filter(p=>typeof p.text==='string'&&p.text.trim()).map(p=>({page:p.page,text:p.text})): [{page:0,text:body||''}];
 const facts=[],references=new Set();
 for(const source of texts){
  for(const [i,line] of source.text.normalize('NFC').split(/\r?\n/).entries()){
   const heading=line.match(/^\s*(?:Акт(?: выполненных работ| при[её]ма[-– ]передачи| оказанных услуг)?|Номер акта)\s*(?:№|:|N\b)\s*([\p{L}\d][\p{L}\d./_-]*)/iu);
   if(heading)references.add(heading[1].normalize('NFKC').toLocaleUpperCase('ru'));
   const field=line.match(/^[ \t]*([^:：]{1,130})[:：][ \t]*(.*)$/u);
   if(!field)continue;
   const label=field[1].trim(),expected=type==='claimed_damage'?labels.documented:labels[role];
   if(!expected.test(label.replace(/подтвержденная/iu,'подтверждённая')))continue;
   const raw=field[2].trim(),money=raw.match(amountWithCurrency),unit=money?.[3]?.toUpperCase();
   const minor=money?(BigInt(money[1].replace(/\s/g,''))*100n+BigInt((money[2]||'').padEnd(2,'0'))).toString():null;
   facts.push({label,raw,line:i+1,page:source.page,currency:unit&&(currencyMap[unit]||unit),minor});
  }
 }
 const source={id,name,hash,role,reference:references.size===1?[...references][0]:'',facts};
 if(pages.some(p=>!p.text?.trim()))return {...source,problem:'Не все страницы прочитаны. Сверьте документ целиком.'};
 if(!facts.length)return {...source,problem:'Не найдена явно указанная стоимость с валютой.'};
 if(facts.some(f=>f.minor===null||BigInt(f.minor)>9000000000000000n))return {...source,problem:'Сумма или валюта указана неоднозначно.'};
 if(new Set(facts.map(f=>f.currency+':'+f.minor)).size!==1)return {...source,problem:'В документе указаны разные суммы или валюты для этой роли.'};
 if(references.size>1)return {...source,problem:'В файле несколько актов. Загрузите их отдельно.'};
 return {...source,minor:facts[0].minor,currency:facts[0].currency};
}

export function workCostSources(db,caseId,departmentId){
 if(!getCase(db,caseId,departmentId))throw Object.assign(new Error('Дело не найдено'),{status:404});
 // Saved text only; excluded files, unread files and pending reprocessing are not candidates.
 return [...db.prepare(`SELECT d.id,d.original_name name,d.sha256 hash,m.group_code AS "group",m.type_code type,e.text_content body,e.pages_json pages
  FROM case_extractions e JOIN case_documents c ON c.case_id=e.case_id AND c.document_id=e.document_id
  JOIN documents d ON d.id=e.document_id JOIN case_document_metadata m ON m.case_id=e.case_id AND m.document_id=e.document_id
  WHERE e.case_id=? AND e.status IN ('review','extracted','confirmed') AND
  (m.group_code='contract' OR m.type_code IN ('claimed_damage','completion_act','acceptance_act','performance'))
  AND NOT EXISTS (SELECT 1 FROM case_document_exclusions x WHERE x.case_id=e.case_id AND x.document_id=e.document_id)
  ORDER BY d.original_name,d.id`).iterate(caseId)].map(d=>readWorkCost({...d,pages:JSON.parse(d.pages||'[]')})).filter(Boolean);
}
