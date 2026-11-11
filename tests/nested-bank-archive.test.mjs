import test from 'node:test';import assert from 'node:assert/strict';import {zipSync,strToU8} from 'fflate';
import {readDocumentArchive} from '../app/lib/document-archives.mjs';
const zip=entries=>Buffer.from(zipSync(entries,{level:0})),text=strToU8;
test('nested ZIP preserves leaf originals and distinct provenance; corrupt inner archives still fail',async()=>{
 const inner=zip({'statement.csv':text('Дата;Сумма\n2026-10-01;10')});
 const r=await readDocumentArchive(zip({'A.zip':inner,'B.zip':inner,'letter.txt':text('Synthetic letter')}));
 assert.equal(r.files.length,3);assert.deepEqual(r.files.map(x=>x.path),['A.zip!/statement.csv','B.zip!/statement.csv','letter.txt']);assert.equal(r.files[0].bytes.toString(),'Дата;Сумма\n2026-10-01;10');
 await assert.rejects(readDocumentArchive(zip({'inner.zip':text('invalid')})));
 let deep=zip({'leaf.txt':text('control')});for(let n=0;n<4;n++)deep=zip({'nested.zip':deep});await assert.rejects(readDocumentArchive(deep),/трёх уровней/);
 const many=zip(Object.fromEntries(Array.from({length:251},(_,n)=>[n+'.txt',text('x')])));await assert.rejects(readDocumentArchive(zip({'A.zip':many,'B.zip':many})),/500/);
 await assert.rejects(readDocumentArchive(zip({'inner.zip':zip({'../escape.txt':text('x')})})),/путь|relative/);
});
