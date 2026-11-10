import {hold} from './api';
export const supabase={from(table){
 const filters={};
 const query={select(){return query;},eq(key,value){filters[key]=value;return query;},order(){return query;},limit(){return query;},maybeSingle(){return query;},
 then(resolve,reject){return hold('sql',table,filters.user_id,filters.agent_type).then(resolve,reject);},
 upsert(row){return hold('upsert',table,row.user_id,row.agent_type);}};
 return query;
},functions:{invoke(){throw new Error('Network disabled in account isolation fixture');}}};
