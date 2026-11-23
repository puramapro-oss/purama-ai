import { act, StrictMode, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerConfig } from '@/lib/partner';
import { configFixture } from '../../tests/ui-state/fixtures';
import PartnerAgentSettings from './PartnerAgentSettings';

const { auth, api, toast } = vi.hoisted(() => ({
  auth: { id: 'account-a' as string | undefined },
  api: { get: vi.fn(), update: vi.fn(), upload: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.id ? { id: auth.id } : null }) }));
vi.mock('@/lib/partner', () => ({
  getPartnerConfig: api.get, updatePartnerConfig: api.update, uploadSignature: api.upload,
  TONES: [{ value: 'professionnel_enthousiaste', label: 'Fictif' }], NICHES: [],
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return { motion: { div: React.forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown }>((props, ref) => {
    const attributes = { ...props }; delete attributes.initial; delete attributes.animate;
    return React.createElement('div', { ...attributes, ref });
  }) } };
});

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
const A = 'account-a';
const B = 'account-b';
const settings = (id: string, marker = `PRIVATE-${id}`): PartnerConfig => ({
  ...configFixture('partner_agent_config', id, marker), outreach_timezone: 'UTC',
} as PartnerConfig);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render(id = auth.id) {
  auth.id = id;
  await act(async () => { root.render(<MemoryRouter><PartnerAgentSettings /></MemoryRouter>); });
}
function sender() { return host.querySelector<HTMLInputElement>('input[placeholder="Tissma Dornier"]')!; }
function timezone() { return host.querySelector<HTMLInputElement>('#partner-outreach-timezone')!; }
function saveButton() { return [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Enregistrer')!; }
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function save() { await act(async () => { saveButton().click(); }); }
async function upload() {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'signature.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  auth.id = A;
  api.get.mockImplementation(async (id: string) => settings(id));
  api.update.mockResolvedValue({});
  api.upload.mockResolvedValue('https://example.invalid/signature.png');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

describe('partner settings operation ownership', () => {
  it('keeps edits made while a save is pending and canonicalizes only the submitted timezone', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await fill(timezone(), 'europe/paris'); await save();
    await fill(sender(), 'EDIT-AFTER-SAVE');
    await act(async () => pending.resolve({}));
    expect(sender().value).toBe('EDIT-AFTER-SAVE');
    expect(timezone().value).toBe('Europe/Paris');
    expect(api.update.mock.calls[0][1].sender_name).toBe(`PRIVATE-${A}`);
  });
  it('preserves a new timezone draft when an earlier save settles', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await fill(timezone(), 'Europe/Paris'); await save();
    await fill(timezone(), 'Asia/Tokyo');
    await act(async () => pending.resolve({}));
    expect(timezone().value).toBe('Asia/Tokyo');
  });
  it('never restores A settings or success after B has loaded', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await save(); await render(B);
    expect(sender().value).toBe(`PRIVATE-${B}`);
    await act(async () => pending.resolve({}));
    expect(sender().value).toBe(`PRIVATE-${B}`);
    expect(toast.success).not.toHaveBeenCalled();
    await save();
    expect(api.update.mock.calls.at(-1)?.[0]).toBe(B);
    expect(api.update.mock.calls.at(-1)?.[1].sender_name).toBe(`PRIVATE-${B}`);
  });
  it('allows B to save while A is still pending and keeps B busy when A settles', async () => {
    const first = deferred<unknown>(); const second = deferred<unknown>();
    api.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render(); await save(); await render(B);
    expect(saveButton().disabled).toBe(false);
    await save();
    expect(api.update).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve({}));
    expect(saveButton().disabled).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => second.resolve({}));
    expect(saveButton().disabled).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it('does not accept an old A save or release a newer save after an A to B to A transition', async () => {
    const obsolete = deferred<unknown>(); const current = deferred<unknown>();
    api.update.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    await render(); await save(); await render(B);
    api.get.mockResolvedValueOnce(settings(A, 'NEW-A-SESSION'));
    await render(A); await save();
    expect(api.update).toHaveBeenCalledTimes(2);
    await act(async () => obsolete.resolve({}));
    expect(sender().value).toBe('NEW-A-SESSION');
    expect(saveButton().disabled).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => current.resolve({}));
    expect(saveButton().disabled).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it('suppresses a failed A save after the active account changes', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await save(); await render(B);
    await act(async () => pending.reject(new Error('PRIVATE-A-ERROR')));
    expect(sender().value).toBe(`PRIVATE-${B}`);
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('suppresses a late save receipt after unmount', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await save();
    await act(async () => root.unmount()); mounted = false;
    await act(async () => pending.resolve({}));
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('deduplicates save clicks before React commits its busy state', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValue(pending.promise);
    await render();
    await act(async () => { const button = saveButton(); button.click(); button.click(); });
    expect(api.update).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({}));
  });
  it('keeps the same-account draft across an auth rerender while a save is pending', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render(); await fill(sender(), 'DRAFT-A'); await save(); await render(A);
    await act(async () => pending.resolve({}));
    expect(sender().value).toBe('DRAFT-A');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it('does not put an uploaded A signature or its settings into B', async () => {
    const pending = deferred<string>(); api.upload.mockReturnValueOnce(pending.promise);
    await render(); await upload(); await render(B);
    await act(async () => pending.resolve('https://example.invalid/private-A-signature.png'));
    expect(sender().value).toBe(`PRIVATE-${B}`);
    expect(host.querySelector('img[alt="Signature"]')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('preserves edits made while a signature upload is pending', async () => {
    const pending = deferred<string>(); api.upload.mockReturnValueOnce(pending.promise);
    await render(); await upload(); await fill(sender(), 'EDIT-DURING-UPLOAD');
    await act(async () => pending.resolve('https://example.invalid/accepted-signature.png'));
    expect(sender().value).toBe('EDIT-DURING-UPLOAD');
    expect(host.querySelector('img[alt="Signature"]')?.getAttribute('src')).toBe('https://example.invalid/accepted-signature.png');
  });
  it.each([B, undefined])('does not show an upload failure from A after identity becomes %s', async nextIdentity => {
    const pending = deferred<string>(); api.upload.mockReturnValueOnce(pending.promise);
    await render(); await upload(); auth.id = nextIdentity; await render();
    await act(async () => pending.reject(new Error('PRIVATE-A-UPLOAD')));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent signature selections within one account cycle', async () => {
    const pending = deferred<string>(); api.upload.mockReturnValue(pending.promise);
    await render(); await upload(); await upload();
    expect(api.upload).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve('https://example.invalid/signature.png'));
  });

  it('serializes a pending signature upload before any settings snapshot can overwrite it', async () => {
    const pending = deferred<string>(); api.upload.mockReturnValueOnce(pending.promise);
    await render();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'signature.png', { type: 'image/png' })] });
    const saveControl = saveButton();
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); saveControl.click(); });
    expect(api.upload).toHaveBeenCalledTimes(1); expect(api.update).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
    await act(async () => pending.resolve('https://fixture.invalid/current-signature.png'));
    await save();
    expect(api.update).toHaveBeenCalledExactlyOnceWith('account-a', expect.objectContaining({ signature_image_url: 'https://fixture.invalid/current-signature.png' }));
  });

  it('serializes a pending settings save before starting a signature write', async () => {
    const pending = deferred<unknown>(); api.update.mockReturnValueOnce(pending.promise);
    await render();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'signature.png', { type: 'image/png' })] });
    const saveControl = saveButton();
    await act(async () => { saveControl.click(); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(api.update).toHaveBeenCalledTimes(1); expect(api.upload).not.toHaveBeenCalled();
    expect(input.disabled).toBe(true);
    await act(async () => pending.resolve({})); await upload();
    expect(api.upload).toHaveBeenCalledTimes(1);
  });

  it('rejects a loaded configuration belonging to a different account', async () => {
    api.get.mockResolvedValueOnce({ ...settings(B, 'FOREIGN-PRIVATE') });
    await render();
    expect(host.textContent).toContain('Impossible de charger les paramètres');
    expect(host.textContent).not.toContain('FOREIGN-PRIVATE');
    expect(host.querySelector('input[placeholder="Tissma Dornier"]')).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('preserves the current load and write lease through StrictMode effect replay', async () => {
    const obsolete = deferred<unknown>(); const current = deferred<unknown>();
    api.get.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    await act(async () => { root.render(<StrictMode><MemoryRouter><PartnerAgentSettings /></MemoryRouter></StrictMode>); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ ...settings(A, 'CURRENT') }));
    await act(async () => obsolete.resolve({ ...settings(A, 'OBSOLETE') }));
    expect(sender().value).toBe('CURRENT');
    await save(); expect(api.update).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1); expect(saveButton().disabled).toBe(false);
  });
});
