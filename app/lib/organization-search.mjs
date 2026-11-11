const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function searchOrganizations(items,query=''){
    const terms=normalize(query).split(' ').filter(Boolean);
    return items.filter(item=>{const text=normalize(`${item.name||''} ${item.identifier||''}`);return terms.every(term=>text.includes(term));});
}
