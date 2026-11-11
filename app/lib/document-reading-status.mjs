const names={senderId:'БИН/ИИН исполнителя или отправителя',recipientId:'БИН/ИИН заказчика или получателя',date:'дата документа',amount:'сумма',amountMinor:'сумма',currency:'валюта',number:'номер документа',lineAmount:'сумма позиции'};
const label=k=>names[k]||'реквизит из исходного документа';
const unique=xs=>[...new Set(xs)];

export function readingDiagnostic(document={}){
 const summary=document.summary||{},automatic=summary.automaticFacts||{};
 const source={documentId:document.id,name:document.name};
 if(['failed','processing_error'].includes(document.status)||document.error)return {title:'Ошибка чтения файла',rule:document.error||'Обработка остановилась с ошибкой.',nextAction:'Откройте сведения об ошибке и повторите чтение.',evidence:[source]};
 if(document.status==='uploaded'||document.status==='running')return {title:document.status==='running'?'Документ читается':'Чтение ещё не началось',rule:'Результата чтения пока нет.',nextAction:'Дождитесь завершения обработки.',evidence:[source]};
 if(document.status==='needs_ocr')return {title:'На скане не распознан текст',rule:'Оригинал сохранён, извлекаемого текста нет.',nextAction:'Проверьте страницы и настройки OCR.',evidence:[source]};
 if(document.status==='needs_mapping')return {title:'Таблица открыта. Нужно указать столбцы',rule:'Значения не сопоставлены с обязательными полями.',nextAction:'Откройте таблицу и укажите соответствия столбцов.',evidence:[source]};
 if(document.status!=='review'&&!summary.unparsedRows)return null;
 const rows=new Map();
 const quality=(summary.quality?.examples||[]).filter(x=>x.row&&x.sheet&&!String(x.code||'').startsWith('IGNORED_'));
 for(const x of quality){
  const key=JSON.stringify([x.sheet,x.row]),entry=rows.get(key)||{...source,sheet:x.sheet,row:x.row,messages:[]};
  if(x.message&&!entry.messages.includes(x.message))entry.messages.push(x.message);
  rows.set(key,entry);
 }
 if(rows.size){
  const examples=[...rows.values()].slice(0,8).map(({messages,...s})=>({...s,excerpt:messages.join(' ')}));
  const reviewCount=summary.quality?.reviewRows;
  return {title:reviewCount>0?`Таблица прочитана. Строк на проверку: ${reviewCount}`:'Таблица прочитана. Есть строки на проверку',
   rule:'В указанных строках не удалось однозначно прочитать обязательные поля. Остальные строки обработаны отдельно.',
   nextAction:'Проверьте указанные строки и поля по оригиналу.',evidence:examples};
 }
 const missing=unique((automatic.missing||[]).map(label)),conflicts=unique((automatic.conflicts||[]).map(label));
 if(missing.length||conflicts.length){
  const evidence=(automatic.fieldLocations||[]).map(f=>({...source,row:f.line,textLine:true,excerpt:f.text}));
  return {title:'Текст прочитан. Проверьте реквизиты',
   rule:[missing.length?`Не распознаны: ${missing.join(', ')}.`:'',conflicts.length?`Найдены противоречивые значения: ${conflicts.join(', ')}.`:''].filter(Boolean).join(' '),
   nextAction:'Сверьте перечисленные поля по оригиналу. Если поле не указано, его нужно уточнить отдельно.',evidence:evidence.length?evidence:[source]};
 }
 if(summary.textCharacters>0)return {title:'Текст прочитан. Операция не выделена',rule:'Текст доступен, но по нему не сформирована структурированная операция.',nextAction:'Откройте документ и проверьте, содержит ли он данные для операции.',evidence:[source]};
 return {title:'Документ требует проверки',rule:'Смотрите результаты чтения и диагностику документа.',nextAction:'Откройте документ и проверьте указанные поля.',evidence:[source]};
}
