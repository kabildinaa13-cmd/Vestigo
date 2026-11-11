// UI state helpers only. Source documents and normalized rows are never edited here.
export function initialTableMapping(table,settings=[]){
  const prior=settings.find(s=>s.sheet===table.sheet&&s.headerRow===table.headerRow),mapping={...table.mapping,...prior?.mapping};
  for(const field of Object.keys(table.ambiguousFields||{}))if(!Object.hasOwn(prior?.mapping||{},field))mapping[field]='';
  return mapping;
}
export function buildTableSettings(tables,selected,draft,settings=[],globalMapping={}){
  return tables.map(table=>{
    const prior=settings.find(s=>s.sheet===table.sheet&&s.headerRow===table.headerRow);
    if(table===selected)return {sheet:table.sheet,...draft};
    const mapping={...Object.fromEntries(Object.entries(globalMapping).filter(([,v])=>!v||table.columns.includes(v))),...prior?.mapping};
    return {sheet:table.sheet,headerRow:table.headerRow||1,headerDepth:table.headerDepth||1,...(table.endRow?{endRow:table.endRow}:{}),dateOrder:prior?.dateOrder||table.dateOrder||'',mapping};
  });
}
