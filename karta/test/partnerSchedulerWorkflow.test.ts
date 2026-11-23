import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const user='00000000-0000-4000-8000-000000000001';
const prospect='00000000-0000-4000-8000-000000000011';
type Item = { json: unknown };
const examples=[
  {file:'partner-outreach-scheduler.json',kind:'outreach',step:'outreach'},
  {file:'partner-relances.json',kind:'followup',step:'relance_1'},
];
describe.each(examples)('versioned $file flow',({file,kind,step})=>{
  const workflow=JSON.parse(readFileSync(new URL(`../../n8n/${file}`,import.meta.url),'utf8'));
  const node=(id:string)=>workflow.nodes.find((n:{id:string})=>n.id===id);
  const select=new Function('$input',node('normalize').parameters.jsCode) as (input:{all:()=>Item[]})=>Item[];
  it('polls worldwide with explicit timezone, then selects using server-side account rules',()=>{
    expect(node('cron').parameters.rule.interval[0].expression).toBe('*/5 * * * *');
    expect(workflow.settings.timezone).toBe('UTC');
    expect(node('due').parameters.url.endsWith('/rest/v1/rpc/partner_outreach_due')).toBe(true);
    expect(JSON.parse(node('due').parameters.jsonBody)).toEqual({p_kind:kind,p_limit:100});
    const headers=node('send').parameters.headerParameters.parameters;
    expect(headers).toContainEqual({name:'X-Impersonate-User-Id',value:'={{ $json.user_id }}'});
    expect(node('send').retryOnFail).toBe(false);
  });
  it('emits zero send items on empty, skipped or malformed candidates',()=>{
    for (const items of [[],[{json:[]}],[{json:{}}],[{json:{_skip:true}}],
      [{json:{prospect_id:prospect,user_id:user,step:'not-allowed'}}],
      [{json:{prospect_id:'undefined',user_id:user,step}}]]) {
      expect(select({all:()=>items})).toEqual([]);
    }
  });
  it('keeps every valid account item in array and per-item HTTP responses',()=>{
    const candidate={prospect_id:prospect,user_id:user,step};
    const expected=[{json:{prospect_id:prospect,user_id:user,type:step}}];
    expect(select({all:()=>[{json:[candidate]}]})).toEqual(expected);
    expect(select({all:()=>[{json:candidate}]})).toEqual(expected);
    expect(select({all:()=>[{json:candidate},{json:{...candidate,user_id:prospect}}]})).toHaveLength(2);
  });
  it('connects only through candidate validation, with no broken batch loop',()=>{
    expect(workflow.nodes.some((n:{type:string})=>n.type==='n8n-nodes-base.splitInBatches')).toBe(false);
    expect(workflow.connections[node('due').name].main[0][0].node).toBe(node('normalize').name);
    expect(workflow.connections[node('normalize').name].main[0][0].node).toBe(node('send').name);
  });
});
