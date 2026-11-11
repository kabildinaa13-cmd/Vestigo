export function compareWorkCosts(planned,acts){
 if(!planned||!acts.length)return {error:'Выберите документ с общей стоимостью и хотя бы один акт исполнения.'};
 if([planned,...acts].some(d=>d.problem||!/^\d+$/.test(d.minor||'')||!d.currency))return {error:'Не удалось однозначно определить суммы по выбранным документам.'};
 if(acts.some(d=>d.currency!==planned.currency))return {error:'Суммы в разных валютах не сравниваются.'};
 if(acts.length>1&&acts.some(d=>!d.reference))return {error:'Для сложения нескольких актов нужны распознанные номера каждого акта.'};
 for(const key of ['id','hash','reference']){
  const values=acts.map(d=>d[key]).filter(Boolean);
  if(new Set(values).size!==values.length)return {error:'Среди выбранных актов есть повтор. Один акт учитывается только один раз.'};
 }
 const total=BigInt(planned.minor),actual=acts.reduce((sum,d)=>sum+BigInt(d.minor),0n);
 return {currency:planned.currency,plannedMinor:String(total),actualMinor:String(actual),differenceMinor:String(total-actual),exceedsPlan:actual>total};
}
