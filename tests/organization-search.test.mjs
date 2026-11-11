import test from 'node:test';import assert from 'node:assert/strict';
import {searchOrganizations} from '../app/lib/organization-search.mjs';
const items=[{identifier:'221240023787',name:'ТОО Шым Спец Торг'},{identifier:'220640051586',name:'Товарищество с ограниченной ответственностью «Vermogen Company»'},{identifier:'000000000001',name:'ИП Ёлка'}];
test('organization picker: partial names, case, punctuation, ё, BIN and combined terms',()=>{
    for(const q of ['шым','ШЫМ СПЕЦ','спец тор','ТОО «Шым»','221240023787','023787','шым 2212'])assert.deepEqual(searchOrganizations(items,q),[items[0]]);
    assert.deepEqual(searchOrganizations(items,'VERMOGEN'),[items[1]]);assert.deepEqual(searchOrganizations(items,'елка'),[items[2]]);assert.deepEqual(searchOrganizations(items,'нет такой организации'),[]);assert.deepEqual(searchOrganizations(items,''),items);
});
test('organization picker: search never changes the organization list',()=>{const before=JSON.stringify(items);searchOrganizations(items,'торг');assert.equal(JSON.stringify(items),before);assert.deepEqual(searchOrganizations([],'шым'),[]);});
