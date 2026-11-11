import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {bankFlowAnalysis,bankFlowSignals} from '../app/lib/financial-flows.mjs';
import {reconciliationProposals} from '../app/lib/reconciliation-proposals.mjs';
import {A,B,accounts} from './stage3-fixtures.mjs';

// One size per process, no access to files, SQL or the network.
const n=Number(process.argv[2]);
assert.ok([100,1000,10000,50000,100000].includes(n));
const cpu=process.cpuUsage(),rss=()=>Math.round(process.memoryUsage().rss/1048576);
const started=performance.now(),rssStart=rss(),sources=i=>[{documentId:'synthetic',sheet:'Control',row:i+2}];
const entries=Array.from({length:n},(_,i)=>({id:'entry-'+i,operationId:'payment-'+i,ownerId:A,ownerAccount:accounts[A],senderId:A,recipientId:B,senderAccount:accounts[A],recipientAccount:accounts[B],date:'2026-10-01',dateValid:true,currency:'KZT',kind:'transfer',direction:'outgoing',amountMinor:100,feeMinor:null,explicitTransactionId:'SYN-'+i,sources:sources(i)}));
const afterInput=performance.now(),flow=bankFlowAnalysis(entries),afterFlow=performance.now(),signals=bankFlowSignals(flow),afterSignals=performance.now(),rssAfterFlow=rss();
assert.equal(flow.uniqueTransfers,n);
assert.equal(flow.transferVolume.KZT,String(n*100));
const invoices=Array.from({length:n},(_,i)=>({id:'invoice-'+i,type:'invoice',number:'INV'+i,senderId:A,recipientId:B,date:'2026-10-01',currency:'KZT',amountMinor:100,sources:sources(i)}));
const payments=invoices.map((e,i)=>({...e,id:'payment-'+i,type:'payment',number:'P'+i,senderId:B,recipientId:A,purpose:'Оплата INV'+i}));
const startMatch=performance.now(),matches=reconciliationProposals({ops:[...invoices,...payments],records:[],analysis:{matches:[]}},[],[]),end=performance.now();
assert.ok(matches.candidates.every(c=>!c.confirmed&&c.status==='proposed'));
if(!matches.truncated)assert.equal(matches.candidates.length,n);
const cpuUsed=process.cpuUsage(cpu), ms=(a,b)=>Math.round(b-a);
console.log(JSON.stringify({n,inputMs:ms(started,afterInput),flowMs:ms(afterInput,afterFlow),signalMs:ms(afterFlow,afterSignals),matchMs:ms(startMatch,end),candidates:matches.candidates.length,matchTruncated:matches.truncated,signalTruncated:signals.truncated,signalCount:signals.signals.length,rssStart,rssAfterFlow,rssEnd:rss(),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),cpuMs:Math.round((cpuUsed.user+cpuUsed.system)/1000),node:process.version}));
