import { act, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerAgentSettings from './PartnerAgentSettings';

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), update: vi.fn() }, toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({user:{id:'fixture-user'}}) }));
vi.mock('@/lib/partner', () => ({getPartnerConfig:api.get,updatePartnerConfig:api.update,
  uploadSignature:vi.fn(),TONES:[{value:'fixture',label:'Fictif'}],NICHES:[]}));
vi.mock('sonner', () => ({toast}));
vi.mock('framer-motion',async()=>{
  const React=await import('react');
  return {motion:{div:React.forwardRef<HTMLDivElement,HTMLAttributes<HTMLDivElement>&{initial?:unknown;animate?:unknown}>((props,ref)=>{
    const attributes={...props}; delete attributes.initial; delete attributes.animate;
    return React.createElement('div',{...attributes,ref});
  })}};
});
let root:Root;
let host:HTMLDivElement;
const fixture={user_id:'fixture-user',sender_name:'Test',sender_email:'test@example.invalid',sender_title:'Test',company_name:'Fictive',
  signature_image_url:null,signature_name:null,signature_title:null,
  daily_outreach_limit:2,outreach_hours_start:'09:00',outreach_hours_end:'18:00',outreach_days:['MO'],outreach_timezone:'UTC',
  relance_1_delay_days:3,relance_2_delay_days:7,relance_3_delay_days:14,max_relances:3,
  commission_first_payment:3,commission_recurring:2,target_niches:[],target_min_followers:0,target_countries:['FR'],target_languages:['fr'],
  outreach_tone:'fixture',custom_tone_prompt:null,require_approval_new_prospect:true,require_approval_outreach:true,
  // Deliberately preserve old flags; they must not appear as controls or be
  // written again when editing the new schedule.
  require_approval_contract:false,auto_send_contract:true};
async function render(){ await act(async()=>{root.render(<MemoryRouter><PartnerAgentSettings/></MemoryRouter>);}); }
async function timezone(value:string){
  const input=document.querySelector<HTMLInputElement>('#partner-outreach-timezone')!;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
}
async function save(){
  const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='Enregistrer')!;
  await act(async()=>button.click());
}
beforeEach(()=>{
  vi.clearAllMocks();api.get.mockResolvedValue({...fixture});api.update.mockResolvedValue({});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Unexpected network call');}));
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

describe('partner schedule settings',()=>{
  it('shows the explicit timezone and exact contract review instead of false automatic-send controls',async()=>{
    await render();
    expect(document.querySelector<HTMLInputElement>('#partner-outreach-timezone')?.value).toBe('UTC');
    expect(host.textContent).toContain('Une plage qui traverse minuit commence le jour sélectionné');
    expect(host.textContent).toContain('Chaque contrat est préparé puis approuvé');
    expect(host.textContent).not.toContain('Auto-envoyer le contrat');
    expect([...host.querySelectorAll('a')].find(a=>a.textContent==='Prospects')?.getAttribute('href'))
      .toBe('/dashboard/partner-agent/prospects');
  });
  it('saves a chosen IANA timezone without rewriting historical contract flags',async()=>{
    await render();await timezone('America/New_York');await save();
    expect(api.update).toHaveBeenCalledExactlyOnceWith('fixture-user',expect.objectContaining({outreach_timezone:'America/New_York'}));
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('auto_send_contract');
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('require_approval_contract');
    expect(toast.success).toHaveBeenCalled();
  });
  it('keeps invalid timezone data out of saved settings and explains the correction',async()=>{
    await render();await timezone('Mars/Unknown');await save();
    expect(api.update).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Fuseau horaire invalide',expect.objectContaining({description:expect.stringContaining('Europe/Paris')}));
  });
  it('normalizes a case-insensitive browser timezone to the name accepted by SQL',async()=>{
    await render();await timezone(' europe/paris ');await save();
    expect(api.update).toHaveBeenCalledExactlyOnceWith('fixture-user',expect.objectContaining({outreach_timezone:'Europe/Paris'}));
    expect(document.querySelector<HTMLInputElement>('#partner-outreach-timezone')?.value).toBe('Europe/Paris');
  });
  it('rejects numeric offsets instead of accepting an Intl value absent from the named SQL zones',async()=>{
    await render();await timezone('+01:00');await save();
    expect(api.update).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Fuseau horaire invalide',expect.any(Object));
  });
});
