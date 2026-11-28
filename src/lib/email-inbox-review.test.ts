import { beforeEach, expect, it, vi } from 'vitest';
import { fetchInboxReviews, gmailReviewUrl, resolveInboxReview } from './email-inbox-review';

const api=vi.hoisted(() => ({getSession:vi.fn(),rpc:vi.fn(),header:vi.fn(),abort:vi.fn()}));
vi.mock('@/integrations/supabase/client',() => ({supabase:{auth:{getSession:api.getSession},rpc:api.rpc}}));
const item={item_id:'eeeeeeee-0000-4000-8000-000000000001',mailbox:'user@example.org',message_id:'1234',thread_id:'4321',reference:null,followup_tools:[]};
const signal=() => new AbortController().signal;
beforeEach(() => {
  vi.clearAllMocks();
  api.getSession.mockResolvedValue({data:{session:{access_token:'test-session',user:{id:'A'}}}});
  api.rpc.mockReturnValue({setHeader:api.header});api.header.mockReturnValue({abortSignal:api.abort});
});
it('binde la requête au propriétaire de la session et relaie le curseur',async() => {
  api.abort.mockResolvedValue({data:{status:'ok',items:[item],next_before_id:item.item_id}});
  const s=signal();
  expect(await fetchInboxReviews('A',item.item_id,s)).toEqual({items:[item],next:item.item_id});
  expect(api.rpc).toHaveBeenCalledWith('gmail_inbox_reviews',{p_before_id:item.item_id});
  expect(api.header).toHaveBeenCalledWith('Authorization','Bearer test-session'); expect(api.abort).toHaveBeenCalledWith(s);
});
it('refuse un autre propriétaire avant tout appel',async() => {
  await expect(fetchInboxReviews('B',null,signal())).rejects.toThrow(); expect(api.rpc).not.toHaveBeenCalled();
});
it('contrôle la preuve et exige le reçu exact du serveur',async() => {
  await expect(resolveInboxReview('A',item,'observed',' ',signal())).rejects.toThrow();
  expect(api.rpc).not.toHaveBeenCalled();
  api.abort.mockResolvedValueOnce({data:{status:'observed',item_id:'other'}})
    .mockResolvedValueOnce({data:{status:'blocked'}})
    .mockResolvedValueOnce({data:{status:'observed',item_id:item.item_id}});
  await expect(resolveInboxReview('A',item,'observed','ligne-23',signal())).rejects.toThrow();
  await expect(resolveInboxReview('A',item,'observed','ligne-23',signal())).rejects.toThrow();
  await expect(resolveInboxReview('A',item,'observed','ligne-23',signal())).resolves.toBeUndefined();
  expect(api.rpc).toHaveBeenLastCalledWith('gmail_inbox_resolve',{p_item_id:item.item_id,p_expected_mailbox:item.mailbox,p_resolution:'observed',p_reference:'ligne-23'});
});
it('limite le lien à Gmail et encode l’adresse, même si le fil transmis est invalide',() => {
  expect(gmailReviewUrl({...item,mailbox:'foo@example.org\nX'})).toBeNull();
  const destination=new URL(gmailReviewUrl({...item,thread_id:'//example.com/#123',mailbox:'foo+team@example.org'})!);
  expect(destination.origin).toBe('https://mail.google.com'); expect(destination.hash).toBe('#all');
  expect(destination.searchParams.get('authuser')).toBe('foo+team@example.org');
});
