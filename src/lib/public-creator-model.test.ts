import { describe, expect, it } from 'vitest';
import { isCreatorModelId, parsePublicCreatorModel } from './public-creator-model';

const publicRecord = {
  id: '81000000-0000-4000-8000-000000000001',
  name: 'Préparer ma semaine',
  description: 'Un plan clair et personnalisable.',
  emoji: '🗓️', color: '#8B5CF6', category: 'productivity',
  is_public: true, is_template: false, is_active: true,
};

describe('contrat public du modèle', () => {
  it('projette seulement les métadonnées publiques, même avec un serveur trop bavard', () => {
    const result = parsePublicCreatorModel({
      ...publicRecord,
      user_id: 'private-owner', system_prompt: 'private-prompt',
      schedule_input: { email: 'private@example.test' },
      history: ['private-history'], credentials: 'private-credential',
    });
    expect(result).toEqual(publicRecord);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it.each([
    null, [], {}, { ...publicRecord, id: '../../dashboard' },
    { ...publicRecord, name: '   ' }, { ...publicRecord, is_public: false },
    { ...publicRecord, is_active: false }, { ...publicRecord, is_active: 'true' },
    { ...publicRecord, is_template: 'true' },
  ].map(record => ({ record })))('refuse une fiche privée, inactive ou malformée ($record)', ({ record }) => {
    expect(parsePublicCreatorModel(record)).toBeNull();
  });

  it('accepte un modèle officiel actif sans le marquer publié par la communauté', () => {
    expect(parsePublicCreatorModel({ ...publicRecord, is_public: false, is_template: true }))
      .toMatchObject({ is_public: false, is_template: true });
  });

  it('borne les textes et refuse une couleur active ou une catégorie inconnue', () => {
    const result = parsePublicCreatorModel({
      ...publicRecord, name: '🌍'.repeat(300), description: 'a'.repeat(5000),
      emoji: 'a'.repeat(100), color: 'url(https://tracking.invalid)', category: 'unknown',
    });
    expect(Array.from(result!.name)).toHaveLength(161);
    expect(result!.description).toHaveLength(1601);
    expect(result).toMatchObject({ emoji: '🤖', color: '#8B5CF6', category: null });
  });

  it.each(['', '/', '%2F', 'https://example.test', '81000000-0000-4000-8000-000000000001?token=secret'])('refuse un identifiant ambigu (%s)', value => {
    expect(isCreatorModelId(value)).toBe(false);
  });
});
