import { test, expect, type Page, type Route } from '@playwright/test';

// UI-only contract tests: every backend request is intercepted. These fixtures do
// not validate authentication, database permissions, transactions or deployment.
test.use({ serviceWorkers: 'block' });

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MissionStatus = 'ouverte' | 'prete' | 'en_cours' | 'terminee' | 'annulee';
interface MissionFixture {
  id: string;
  organizer_id: string;
  version: number;
  title: string;
  description: string;
  status: MissionStatus;
  min_participants: number;
  max_participants: number | null;
  missions_collectives_participants: Array<{ user_id: string; joined_at: string }>;
}
interface MutationRequest {
  missionId?: string;
  action?: string;
  body: Record<string, unknown>;
}
interface FixtureState {
  missions: MissionFixture[];
  posts: MutationRequest[];
  listReads: number;
  profileWrites: Record<string, unknown>[];
  onMutation?: (route: Route, request: MutationRequest) => Promise<void>;
}

function mission(overrides: Partial<MissionFixture> = {}): MissionFixture {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    organizer_id: OTHER_ID,
    version: 4,
    title: 'Préparer les colis',
    description: 'Une mission de test locale.',
    status: 'ouverte',
    min_participants: 2,
    max_participants: 4,
    missions_collectives_participants: [{ user_id: OTHER_ID, joined_at: '2026-01-01T10:00:00Z' }],
    ...overrides,
  };
}

function stateFor(missions: MissionFixture[]): FixtureState {
  return { missions, posts: [], listReads: 0, profileWrites: [] };
}

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

async function setup(page: Page, state: FixtureState) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('Les tests UI nécessitent un baseURL loopback explicite.');
  const frontend = new URL(baseURL);
  if (!['http:', 'https:'].includes(frontend.protocol) || !['localhost', '127.0.0.1'].includes(frontend.hostname)) {
    throw new Error('Les tests UI sont limités à un serveur local contrôlé.');
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', exp: expiresAt })).toString('base64url'),
    'local-ui-fixture',
  ].join('.');
  const user = {
    id: USER_ID, aud: 'authenticated', role: 'authenticated',
    email: 'ui-fixture@example.invalid', app_metadata: {}, user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  await page.addInitScript(({ session }) => {
    // Seed the test session under the storage key requested by this build. No
    // real session or credential is read, and all backend traffic is mocked.
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      if (this === localStorage && /^sb-.+-auth-token$/.test(key) && !originalGetItem.call(this, key)) {
        this.setItem(key, JSON.stringify(session));
      }
      return originalGetItem.call(this, key);
    };
    localStorage.setItem('purama_ai_intro_seen', '1');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    sessionStorage.setItem('purama_affirmation_shown', 'true');
  }, { session: { access_token: token, refresh_token: 'local-ui-fixture', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user } });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/auth/v1/')) return json(route, user);
    if (url.pathname.startsWith('/rest/v1/')) return json(route, []);
    if (url.pathname.endsWith('/functions/v1/entraide-profil')) {
      if (request.method() === 'PUT') {
        state.profileWrites.push(request.postDataJSON());
        return json(route, { profil: request.postDataJSON() });
      }
      return json(route, { profil: state.profileWrites.at(-1) ?? null });
    }
    if (url.pathname.endsWith('/functions/v1/entraide-matches')) return json(route, { matches: [] });
    if (url.pathname.endsWith('/functions/v1/entraide-contact')) return json(route, { requests: [] });
    const match = url.pathname.match(/\/functions\/v1\/entraide-missions(?:\/([^/]+)\/([^/]+))?$/);
    if (match) {
      if (request.method() === 'GET') {
        state.listReads += 1;
        return json(route, { missions: state.missions });
      }
      const mutation = { missionId: match[1], action: match[2], body: request.postDataJSON() };
      state.posts.push(mutation);
      if (state.onMutation) return state.onMutation(route, mutation);
      const current = state.missions.find((item) => item.id === mutation.missionId);
      if (!current) return json(route, { error: 'mission_not_found', message: 'Mission introuvable.' }, 404);
      if (mutation.action === 'join') {
        current.missions_collectives_participants.push({ user_id: USER_ID, joined_at: '2026-01-02T10:00:00Z' });
      } else if (mutation.action === 'leave') {
        current.missions_collectives_participants = current.missions_collectives_participants.filter((item) => item.user_id !== USER_ID);
      } else if (mutation.action === 'start') current.status = 'en_cours';
      else if (mutation.action === 'complete') current.status = 'terminee';
      else if (mutation.action === 'cancel') current.status = 'annulee';
      current.version += 1;
      return json(route, { mission: current, replayed: false });
    }
    if (url.pathname.startsWith('/functions/v1/')) return json(route, {});
    if (url.origin === frontend.origin) return route.continue();
    // Never let this UI fixture use a live account, third-party service or API.
    return route.abort('blockedbyclient');
  });
  await page.goto('/dashboard/entraide');
  await expect(page.getByRole('heading', { name: "Réseau d'Entraide" })).toBeVisible();
}

async function openMissions(page: Page) {
  await page.getByRole('button', { name: 'Missions Collectives', exact: true }).click();
}

test('les commandes suivent organizer_id, indépendamment de l’ordre des participants', async ({ page }) => {
  const fixture = mission({
    organizer_id: USER_ID, status: 'prete',
    missions_collectives_participants: [
      { user_id: OTHER_ID, joined_at: '2026-01-01T10:00:00Z' },
      { user_id: USER_ID, joined_at: '2026-01-01T11:00:00Z' },
    ],
  });
  const state = stateFor([fixture]);
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
  await expect(card.getByRole('button', { name: 'Démarrer', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Annuler', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Démarrer', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Terminer', exact: true })).toBeEnabled();
  expect(state.posts[0].body.expected_version).toBe(4);
  expect(state.posts[0].body.request_id).toMatch(UUID);
});

test('un participant ordinaire peut quitter en cours mais ne reçoit aucune commande organisateur', async ({ page }) => {
  const fixture = mission({ status: 'en_cours', missions_collectives_participants: [
    { user_id: USER_ID, joined_at: '2026-01-01T10:00:00Z' },
    { user_id: OTHER_ID, joined_at: '2026-01-01T11:00:00Z' },
  ] });
  const state = stateFor([fixture]);
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
  await expect(card.getByRole('button', { name: /^(Démarrer|Terminer|Annuler)$/ })).toHaveCount(0);
  await card.getByRole('button', { name: 'Quitter', exact: true }).click();
  await expect(card.getByRole('button')).toHaveCount(0);
  expect(state.posts[0].action).toBe('leave');
  expect(state.posts[0].body).not.toHaveProperty('expected_version');
});

test('l’organisateur qui quitte en cours conserve les commandes de sa mission', async ({ page }) => {
  const fixture = mission({ organizer_id: USER_ID, status: 'en_cours', missions_collectives_participants: [
    { user_id: USER_ID, joined_at: '2026-01-01T10:00:00Z' },
    { user_id: OTHER_ID, joined_at: '2026-01-01T11:00:00Z' },
  ] });
  const state = stateFor([fixture]);
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
  await card.getByRole('button', { name: 'Quitter', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Quitter', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Terminer', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Annuler', exact: true })).toBeEnabled();
});

test('les missions complètes, en cours et fermées ne proposent pas de rejoindre', async ({ page }) => {
  const fixtures = [
    mission({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', title: 'Complète', status: 'prete', max_participants: 2, missions_collectives_participants: [
      { user_id: OTHER_ID, joined_at: '2026-01-01T10:00:00Z' },
      { user_id: '33333333-3333-4333-8333-333333333333', joined_at: '2026-01-01T11:00:00Z' },
    ] }),
    mission({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', title: 'En cours', status: 'en_cours' }),
    mission({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', title: 'Terminée', organizer_id: USER_ID, status: 'terminee' }),
    mission({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', title: 'Annulée', organizer_id: USER_ID, status: 'annulee' }),
  ];
  await setup(page, stateFor(fixtures));
  await openMissions(page);
  await expect(page.getByRole('article')).toHaveCount(4);
  await expect(page.getByRole('article').getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Mission complète', { exact: true })).toBeVisible();
});

test('un double clic produit une seule requête et ne bloque pas les autres missions', async ({ page }) => {
  const first = mission();
  const second = mission({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Autre mission' });
  const state = stateFor([first, second]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.onMutation = async (route) => {
    await gate;
    first.missions_collectives_participants.push({ user_id: USER_ID, joined_at: '2026-01-02T00:00:00Z' });
    await json(route, { mission: first, replayed: false });
  };
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${first.title}` });
  try {
    await card.getByRole('button', { name: 'Rejoindre', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(card).toHaveAttribute('aria-busy', 'true');
    await expect(card.getByRole('button', { name: 'Inscription en cours…', exact: true })).toBeDisabled();
    await expect(page.getByRole('article', { name: `Mission : ${second.title}` }).getByRole('button', { name: 'Rejoindre', exact: true })).toBeEnabled();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].body.request_id).toMatch(UUID);
    expect(state.posts[0].body).not.toHaveProperty('expected_version');
  } finally { release(); }
  await expect(card.getByRole('button', { name: 'Quitter', exact: true })).toBeEnabled();
});

test('un conflit recharge l’état sans relancer et la décision suivante utilise une nouvelle clé/version', async ({ page }) => {
  const fixture = mission({ organizer_id: USER_ID, status: 'prete' });
  const state = stateFor([fixture]);
  state.onMutation = async (route) => {
    if (state.posts.length === 1) {
      fixture.version = 7;
      return json(route, { error: 'stale_mission', message: 'La mission a changé. Actualise puis réessaie.' }, 409);
    }
    fixture.status = 'en_cours';
    fixture.version = 8;
    await json(route, { mission: fixture, replayed: false });
  };
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
  await card.getByRole('button', { name: 'Démarrer', exact: true }).click();
  await expect.poll(() => state.listReads).toBeGreaterThanOrEqual(2);
  await expect(card.getByRole('button', { name: 'Démarrer', exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await expect(card.getByRole('button', { name: 'Réessayer la demande', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Démarrer', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Terminer', exact: true })).toBeEnabled();
  expect(state.posts[1].body.expected_version).toBe(7);
  expect(state.posts[1].body.request_id).not.toBe(state.posts[0].body.request_id);
});

test('une reprise conserve UUID et payload puis affiche GET plutôt que l’ancien résultat rejoué', async ({ page }) => {
  const fixture = mission({ organizer_id: USER_ID, status: 'prete' });
  const state = stateFor([fixture]);
  state.onMutation = async (route) => {
    if (state.posts.length === 1) return json(route, { error: 'internal_error', message: 'Le résultat de la demande n’a pas été confirmé.' }, 500);
    state.missions = [{ ...fixture, status: 'terminee', version: 10 }];
    await json(route, { mission: { ...fixture, status: 'en_cours', version: 5 }, replayed: true });
  };
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
  await card.getByRole('button', { name: 'Démarrer', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Réessayer la demande', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Annuler', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Réessayer la demande', exact: true }).click();
  await expect(card.getByText('Terminée', { exact: true })).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  expect(state.posts[1].body).toEqual(state.posts[0].body);
});

test('après une coupure réseau, abandonner la reprise autorise une autre action avec une nouvelle clé', async ({ page }) => {
  const fixture = mission({ organizer_id: USER_ID, status: 'prete' });
  const state = stateFor([fixture]);
  state.onMutation = async (route) => {
    if (state.posts.length === 1) return route.abort('failed');
    fixture.status = 'annulee';
    fixture.version += 1;
    await json(route, { mission: fixture, replayed: false });
  };
  await setup(page, state);
  await openMissions(page);
  const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
  await card.getByRole('button', { name: 'Démarrer', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Annuler', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Abandonner la reprise', exact: true }).click();
  expect(state.posts).toHaveLength(1);
  await card.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(card.getByText('Annulée', { exact: true })).toBeVisible();
  expect(state.posts[1].action).toBe('cancel');
  expect(state.posts[1].body.request_id).not.toBe(state.posts[0].body.request_id);
});

for (const [status, code] of [[401, 'auth_required'], [429, 'rate_limited']] as const) {
  test(`une réponse ${status} conserve la clé pour une reprise volontaire`, async ({ page }) => {
    const fixture = mission();
    const state = stateFor([fixture]);
    state.onMutation = async (route) => {
      if (state.posts.length === 1) return json(route, { error: code, message: 'Réessaie après avoir vérifié ta connexion ou attendu.' }, status);
      fixture.missions_collectives_participants.push({ user_id: USER_ID, joined_at: '2026-01-02T00:00:00Z' });
      await json(route, { mission: fixture, replayed: false });
    };
    await setup(page, state);
    await openMissions(page);
    const card = page.getByRole('article', { name: `Mission : ${fixture.title}` });
    await card.getByRole('button', { name: 'Rejoindre', exact: true }).click();
    await card.getByRole('button', { name: 'Réessayer la demande', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Quitter', exact: true })).toBeEnabled();
    expect(state.posts[1].body).toEqual(state.posts[0].body);
  });
}

test('la création réutilise sa clé à données identiques puis la change après modification', async ({ page }) => {
  const state = stateFor([]);
  state.onMutation = async (route, request) => {
    if (state.posts.length <= 2) return json(route, { error: 'internal_error', message: 'Résultat de création non confirmé.' }, 500);
    const created = mission({ organizer_id: USER_ID, title: String(request.body.title), description: String(request.body.description) });
    state.missions.push(created);
    await json(route, { mission: created, replayed: false }, 201);
  };
  await setup(page, state);
  await openMissions(page);
  await page.getByRole('textbox', { name: 'Titre de la mission', exact: true }).fill('  Première demande  ');
  await page.getByRole('textbox', { name: 'Décris le coup de main collectif', exact: true }).fill('  Description  ');
  await page.getByRole('button', { name: 'Créer à partir de 2 membres', exact: true }).click();
  await page.getByRole('button', { name: 'Réessayer la création', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Réessayer la création', exact: true })).toBeEnabled();
  expect(state.posts[1].body).toEqual(state.posts[0].body);
  expect(state.posts[0].body.title).toBe('Première demande');
  expect(state.posts[0].body.description).toBe('Description');
  await page.getByRole('textbox', { name: 'Titre de la mission', exact: true }).fill('Demande modifiée');
  await page.getByRole('button', { name: 'Créer à partir de 2 membres', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Mission : Demande modifiée' })).toBeVisible();
  expect(state.posts[2].body.request_id).not.toBe(state.posts[0].body.request_id);
  await expect(page.getByRole('textbox', { name: 'Titre de la mission', exact: true })).toHaveValue('');
});

test('la création de profil transmet explicitement radius_km nul', async ({ page }) => {
  const state = stateFor([]);
  await setup(page, state);
  await page.getByRole('button', { name: 'Créer mon profil', exact: true }).click();
  await expect.poll(() => state.profileWrites.length).toBe(1);
  expect(state.profileWrites[0]).toMatchObject({ radius_km: null, skills_offered: [], skills_needed: [], availability_days: [] });
});
