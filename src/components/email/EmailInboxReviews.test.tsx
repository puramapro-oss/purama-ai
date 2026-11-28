import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import EmailInboxReviews from './EmailInboxReviews';
import { fetchInboxReviews, resolveInboxReview } from '@/lib/email-inbox-review';

vi.mock('@/lib/email-inbox-review', async (original) => ({
  ...await original<typeof import('@/lib/email-inbox-review')>(),
  fetchInboxReviews: vi.fn(), resolveInboxReview: vi.fn(),
}));
vi.mock('@/integrations/supabase/client',() => ({supabase:{}}));
const item = { item_id:'abababab-0000-0000-0000-000000000001',mailbox:'alice+test@example.org',message_id:'abcdef01',thread_id:'cafe123',reference:null,followup_tools:[] };
const fetch = vi.mocked(fetchInboxReviews), resolve = vi.mocked(resolveInboxReview);
const page = { items:[item], next:null };
let root:Root, host:HTMLDivElement;
function render(owner = 'alice') { return act(async() => root.render(<EmailInboxReviews key={owner} userId={owner} />)); }
function button(label:string) { return Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)!; }
async function fill() {
  await act(async() => button('Consigner la vérification').click());
  host.querySelector('select')!.value = 'closed_without_retry';
  host.querySelector<HTMLInputElement>('[name="proof"]')!.value = 'Référence vérifiée';
  host.querySelector<HTMLInputElement>('[name="checked"]')!.checked = true;
}
function submit() { host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); fetch.mockReset(); resolve.mockReset(); fetch.mockResolvedValue(page);
  host=document.createElement('div');document.body.append(host); root=createRoot(host);
});
afterEach(async() => { await act(async() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('rapprochement Gmail',() => {
  it('montre le compte originel et lie exclusivement Gmail ; la consultation ne clôt rien',async() => {
    await render();
    expect(host.querySelector('a')!.href).toBe('https://mail.google.com/mail/?authuser=alice%2Btest%40example.org#all/cafe123');
    expect(resolve).not.toHaveBeenCalled();
  });
  it('distingue le reçu du brouillon et l’action suivante à vérifier',async() => {
    fetch.mockResolvedValue({items:[{...item,reference:'draft:AA22',followup_tools:['send_notification']}],next:null});
    await render(); expect(host.textContent).toContain('Brouillon créé dans Gmail · draft:AA22');
    expect(host.textContent).toContain('Suite à vérifier manuellement : Notification'); expect(host.textContent).not.toContain('Effet initial à vérifier');
  });
  it('oriente une première approbation vers le bon écran sans donner un accord',async() => {
    fetch.mockResolvedValue({items:[{...item,reference:'approval:123',followup_tools:['gmail_send']}],next:null}); await render();
    expect(host.querySelector('a[href="/dashboard/employees"]')?.textContent).toContain('approbations');
    expect(host.textContent).toContain('encore en attente'); expect(resolve).not.toHaveBeenCalled();
  });
  it('un double clic ne produit qu’une seule clôture attestée',async() => {
    let done!:() => void;
    resolve.mockImplementation(() => new Promise<void>(r => {done=r;}));
    await render(); await fill(); await act(async() => {submit(); submit();});
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('alice',item,'closed_without_retry','Référence vérifiée',expect.any(AbortSignal));
    await act(async() => done()); expect(host.textContent).toContain('Vérification enregistrée'); expect(host.textContent).not.toContain(item.mailbox);
  });
  it('demande un rechargement après résultat inconnu et permet de constater la disparition',async() => {
    resolve.mockRejectedValue(new Error('réseau')); await render(); await fill(); await act(async() => submit());
    expect(host.textContent).toContain('Clôture non confirmée'); expect(button('Consigner la vérification').disabled).toBe(true);
    fetch.mockResolvedValue({items:[],next:null}); await act(async() => button('Actualiser les vérifications').click());
    expect(host.textContent).toContain('Aucune référence'); expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('ignore une lecture terminée après changement d’utilisateur',async() => {
    let done!:(v:typeof page) => void;
    fetch.mockImplementationOnce(() => new Promise(r => {done=r;})).mockResolvedValue({items:[],next:null});
    await render(); await render('bob'); await act(async() => done(page));
    expect(host.textContent).not.toContain(item.mailbox); expect(resolve).not.toHaveBeenCalled();
  });
  it('affiche une indisponibilité distincte de zéro résultat',async() => {
    fetch.mockRejectedValue(new Error('migration absente')); await render(); expect(host.textContent).toContain('Lecture indisponible'); expect(host.textContent).not.toContain('Aucune référence');
  });
});
