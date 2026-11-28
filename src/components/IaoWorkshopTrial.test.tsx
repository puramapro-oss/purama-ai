import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IaoWorkshopTrial } from './IaoWorkshopTrial';

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<IaoWorkshopTrial />));
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function fill(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(item => item.textContent.startsWith(label))?.querySelector('input');
  if (!input) throw new Error(`Champ absent : ${label}`);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const result = () => host.querySelector('[role="status"]')!.textContent.replace(/\s+/g, ' ');

describe('Essai de couverture des coûts de l’atelier', () => {
  it('leaves confirmations unobserved and downloadable draft entirely local', () => {
    expect(result()).toContain('6 places payantes');
    expect(result()).toContain('Renseignez les confirmations');
    const draft = host.querySelector('a[download="preinscription-atelier.txt"]')!;
    expect(draft.getAttribute('href')).toMatch(/^data:text\/plain/);
    expect(decodeURIComponent(draft.getAttribute('href')!)).toContain('Nombre de places : 12.');
    expect(decodeURIComponent(draft.getAttribute('href')!)).toContain('Tarif public par personne : [à compléter]');
  });

  it('recomputes the margin, projected deficit, threshold and binding capacity', async () => {
    await fill('Confirmations', '5');
    expect(result()).toContain('encore 1 place payante');
    expect(result()).toContain('-20,00 €');
    await fill('Confirmations', '6');
    expect(result()).toContain('si chaque personne confirmée venait et payait');
    await fill('Confirmations', '');
    await fill('Places disponibles', '4');
    expect(result()).toContain('Il manque 2 places');
    expect(result()).toContain('40,00 €');
  });

  it('uses cents, rounds threshold upward and rejects out-of-range values', async () => {
    await fill('Coûts fixes', '9,99');
    await fill('Recette', '3.33');
    await fill('Coût par personne', '0');
    expect(result()).toContain('3 places payantes');
    await fill('Coûts fixes', '10');
    expect(result()).toContain('4 places payantes');
    expect(result()).toContain('0,84 €');
    await fill('Recette', '0.001');
    expect(host.querySelector('[aria-invalid="true"]')).toBeTruthy();
    expect(host.querySelector('a[download]')).toBeNull();
    await fill('Recette', '2');
    await fill('Confirmations', '13');
    expect(result()).toContain('dépassent la capacité');
  });

  it('distinguishes zero margin, a loss on every sale and a zero-capacity event', async () => {
    await fill('Recette', '10');
    expect(result()).toContain('ne couvre aucun coût fixe');
    await fill('Recette', '9');
    expect(result()).toContain('augmente le déficit');
    await fill('Coûts fixes', '0');
    await fill('Places disponibles', '0');
    await fill('Recette', '10');
    expect(result()).toContain('aucune place disponible');
    expect(result()).not.toContain('À salle pleine');
    expect(host.querySelector('a[download]')).toBeNull();
    await fill('Places disponibles', '1');
    expect(result()).toContain('0 place payante');
  });
});
