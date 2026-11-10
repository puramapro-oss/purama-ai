const params=new URLSearchParams(location.search);
window.__calls=[];window.__scenario=params.get('scenario')||'success';window.__pending=[];
window.__release=()=>{const pending=window.__pending.splice(0);pending.forEach((resolve)=>resolve());};
function fixture(scenario){
 return {version:1,scope:'purama_ai',observedAt:'2026-11-10T08:00:00.000Z',metrics:{profiles:{status:'available',value:42},activeSubscriptions:{status:'available',value:0},enabledAgents:scenario==='partial'?{status:'unavailable',value:null}:{status:'available',value:7}},recentProfiles:{status:'available',items:[{id:'739a3eaf-8fc6-42c7-9ac1-c322cc063ba4',full_name:scenario==='xss'?'<img src=x onerror="window.__injected=true">':scenario==='hold'?'PRIVATE_PREVIOUS_OWNER':'Profil de recette',created_at:'2026-11-09T12:00:00.000Z'}]}};
}
export const supabase={functions:{async invoke(name,options){
 window.__calls.push({name,method:options.method,timeout:options.timeout});
 const scenario=window.__scenario;
 if(scenario==='hold') await new Promise((resolve)=>window.__pending.push(resolve));
 if(scenario==='error') return {data:null,error:{context:{status:503},message:'INTERNAL_SECRET_DO_NOT_RENDER'}};
 return {data:fixture(scenario),error:null};
}}};
