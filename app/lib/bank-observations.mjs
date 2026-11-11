import {isPartyKey,validIban,bankPaymentClass} from './bank-identities.mjs';
// Source observations are not complete transfers, allocations or temporal facts.
// Do not guess a century or merge unidentified parties by their displayed names.
export function incompleteBankObservations(entries,q={}){
 if(q.from||q.to)return [];
 return entries.filter(e=>!e.conflict&&['transfer','refund'].includes(e.kind)&&bankPaymentClass(e)!=='conversion'&&e.direction&&isPartyKey(e.ownerId)&&e.currency&&e.currency!=='UNKNOWN'&&/^\d+$/.test(String(e.amountMinor??''))&&BigInt(e.amountMinor)>0n&&e.sources?.length&&(!e.dateValid||!(validIban(e.senderAccount)||isPartyKey(e.senderId))||!(validIban(e.recipientAccount)||isPartyKey(e.recipientId))));
}
