import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = join(directory, '../..');
const profileColumns = 'user_id,skills_offered,skills_needed,availability_days,radius_km,location_lat,location_lng,created_at,updated_at';
const profileTypes = {
  skills_offered: 'text[]', skills_needed: 'text[]', availability_days: 'text[]',
  radius_km: 'integer', location_lat: 'double precision', location_lng: 'double precision',
};

/**
 * Fixture locale uniquement : vraie page, vrai HTTP métier et vrais RPC/migrations PostgreSQL.
 * L'identité Alice/Bob et le transport des ports de profil remplacent Supabase Auth/PostgREST.
 * L'import est léger ; le moteur DB choisi par db-harness, esbuild et le serveur démarrent ici.
 */
export async function createBrowserHarness() {
  if (!process.execArgv.includes('--wasm-num-compilation-tasks=1') || !process.execArgv.includes('--max-old-space-size=384')) {
    throw new Error('Utiliser node tests/entraide/fixtures/run-browser.mjs : le banc exige un worker Node limité à 384 Mo et une seule tâche de compilation WASM.');
  }
  const { build, stop } = await import('esbuild');
  const { createDb, seedUsers, asRole, callRpc, USERS } = await import('./db-harness.mjs');
  const { computeMatchScore } = await import('../../supabase/functions/_shared/vendor/entraide-matching.js');
  const actors = Object.freeze({ alice: USERS.a, bob: USERS.b });
  const tokens = new Map(Object.entries(actors).map(([alias, id]) => [`Bearer fixture-${alias}-${id}`, { id, alias }]));
  const history = [];
  const serverErrors = [];
  const faults = [];
  const gates = new Set();
  let db;
  let server;
  let baseURL;
  let javascript;
  let stylesheet;
  let bundleDirectory;
  let closed = false;

  const closeResources = async () => {
    if (closed) return;
    closed = true;
    for (const gate of gates) gate.release();
    try {
      if (server?.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    } finally {
      try { await db?.close(); }
      finally {
        stop();
        if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
      }
    }
  };

  try {
    bundleDirectory = await mkdtemp(join(tmpdir(), 'entraide-browser-node-'));
    // Compile exactement le handler de production ; aucune copie de ses validations/transitions.
    const backend = await build({
      absWorkingDir: repository,
      entryPoints: [join(repository, 'supabase/functions/_shared/entraide-http.ts')],
      bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false,
      logLevel: 'silent',
    });
    const backendPath = join(bundleDirectory, 'entraide-handler.mjs');
    await writeFile(backendPath, backend.outputFiles[0].text, 'utf8');
    const { createEntraideHandler } = await import(pathToFileURL(backendPath).href);
    db = await createDb();
    await seedUsers(db, Object.values(actors));

    const getProfile = async (actor) => {
      const result = await asRole(db, 'service_role', actor,
        `SELECT ${profileColumns} FROM purama_ai.entraide_profils WHERE user_id = $1::uuid`, [actor]);
      return result.rows[0] ?? null;
    };
    const matchingProfile = (profile, blocked = []) => ({
      userId: profile.user_id,
      skillsOffered: profile.skills_offered,
      skillsNeeded: profile.skills_needed,
      availabilityDays: profile.availability_days,
      radiusKm: profile.radius_km,
      location: profile.location_lat == null || profile.location_lng == null ? null : { lat: profile.location_lat, lng: profile.location_lng },
      blockedUserIds: blocked,
    });
    const ports = {
      // Seuls les deux jetons fictifs de ce processus sont reconnus. Aucun JWT Supabase testé.
      authenticate: async (header) => tokens.has(header) ? { id: tokens.get(header).id } : null,
      getProfile,
      async saveProfile(actor, payload) {
        const keys = Object.keys(payload);
        if (keys.some((key) => !(key in profileTypes))) throw new Error('unexpected_fixture_profile_column');
        const columns = keys.join(',');
        const values = keys.map((key, index) => `$${index + 2}::${profileTypes[key]}`).join(',');
        const assignments = keys.map((key) => `${key} = EXCLUDED.${key}`).join(',');
        await asRole(db, 'service_role', actor,
          `INSERT INTO purama_ai.entraide_profils (user_id,${columns},updated_at)
           VALUES ($1::uuid,${values},now())
           ON CONFLICT (user_id) DO UPDATE SET ${assignments},updated_at = now()`,
          [actor, ...keys.map((key) => payload[key])]);
      },
      async getMatches(actor) {
        const mine = await getProfile(actor);
        if (!mine) return { matches: [], scanned_profiles: 0, truncated: false };
        const profiles = await asRole(db, 'service_role', actor,
          `SELECT ${profileColumns} FROM purama_ai.entraide_profils WHERE user_id <> $1::uuid ORDER BY user_id LIMIT 501`, [actor]);
        const blocks = await asRole(db, 'service_role', actor,
          'SELECT blocker_id,blocked_id FROM purama_ai.entraide_blocages WHERE blocker_id = $1::uuid OR blocked_id = $1::uuid', [actor]);
        const blocked = blocks.rows.map((row) => row.blocker_id === actor ? row.blocked_id : row.blocker_id);
        const own = matchingProfile(mine, blocked);
        const matches = profiles.rows.slice(0, 500).map((profile) => ({
          userId: profile.user_id, ...computeMatchScore(own, matchingProfile(profile)),
        })).filter((match) => match.score > 0).sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
        return { matches, scanned_profiles: Math.min(profiles.rows.length, 500), truncated: profiles.rows.length > 500 };
      },
      command: (kind, actor, action, payload) => callRpc(db, `entraide_${kind}_command`, actor, action, payload),
    };
    const handlers = new Map(['entraide-profil', 'entraide-matches', 'entraide-missions', 'entraide-contact']
      .map((route) => [route, createEntraideHandler(route, ports)]));

    const matchesRequest = (filter, route, method, actor) => filter.route === route &&
      (filter.method ?? 'GET') === method && (!filter.actor || actors[filter.actor] === actor);
    server = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url ?? '/', baseURL);
        if (url.pathname === '/favicon.ico') { outgoing.writeHead(204).end(); return; }
        if (url.pathname === '/app.js') {
          outgoing.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }).end(javascript);
          return;
        }
        if (url.pathname === '/app.css') {
          outgoing.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }).end(stylesheet);
          return;
        }
        if (url.pathname === '/') {
          const alias = url.searchParams.get('actor') ?? 'alice';
          if (!Object.hasOwn(actors, alias)) { outgoing.writeHead(400).end('Unknown fixture actor'); return; }
          const auth = { id: actors[alias], token: `fixture-${alias}-${actors[alias]}`, alias, database: db.engine };
          outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html>
<html lang="fr" class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entraide — fixture locale</title><link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script>window.__ENTRAIDE_FIXTURE_AUTH__=${JSON.stringify(auth)};</script><script src="/app.js" defer></script></body></html>`);
          return;
        }
        const route = url.pathname.replace(/^\/functions\/v1\//, '');
        const handler = handlers.get(route.split('/')[0]);
        if (!url.pathname.startsWith('/functions/v1/') || !handler) { outgoing.writeHead(404).end(); return; }
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const actor = tokens.get(headers.get('authorization'));
        const request = new Request(url, {
          method: incoming.method, headers,
          ...(body.length ? { body } : {}),
        });
        const result = await handler(request);
        const bytes = Buffer.from(await result.arrayBuffer());
        let payload = null;
        let response = null;
        try { if (body.length) payload = JSON.parse(body.toString('utf8')); } catch { payload = '[invalid JSON]'; }
        try { if (bytes.length) response = JSON.parse(bytes.toString('utf8')); } catch { response = '[invalid JSON]'; }
        const entry = {
          sequence: history.length + 1,
          actor: actor?.alias ?? 'unrecognized', route, method: incoming.method,
          payload, response, handlerStatus: result.status, deliveredStatus: result.status,
        };
        history.push(entry);
        const gate = [...gates].find((item) => !item.used && matchesRequest(item.filter, route, incoming.method, actor?.id));
        if (gate) {
          gate.used = true;
          gate.arrive(entry);
          await gate.promise;
          gates.delete(gate);
        }
        const faultIndex = faults.findIndex((filter) => matchesRequest(filter, route, incoming.method, actor?.id));
        if (faultIndex !== -1) {
          faults.splice(faultIndex, 1);
          // La mutation réelle a été exécutée : seule sa confirmation réseau est perdue.
          if (result.status === 200) {
            entry.injectedFault = 'confirmation_lost_after_real_commit';
            entry.deliveredStatus = 503;
            outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
              .end(JSON.stringify({ error: 'service_unavailable' }));
            return;
          }
        }
        outgoing.writeHead(result.status, Object.fromEntries(result.headers));
        outgoing.end(bytes);
      } catch (error) {
        serverErrors.push({ name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) });
        if (!outgoing.headersSent) outgoing.writeHead(503, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'fixture_failed' }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseURL = `http://127.0.0.1:${server.address().port}`;

    const frontend = await build({
      absWorkingDir: repository,
      entryPoints: [join(directory, 'fixtures/browser-entry.tsx')],
      bundle: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
      tsconfig: join(repository, 'tsconfig.app.json'), write: false, logLevel: 'silent',
      define: {
        'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(baseURL),
        'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('fixture-public-key-no-provider-access'),
        'import.meta.env.VITE_SUPABASE_ANON_KEY': 'undefined',
        'process.env.NODE_ENV': JSON.stringify('development'),
      },
      plugins: [{
        name: 'explicit-local-auth-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^@\/hooks\/useAuth$/ }, () => ({ path: join(directory, 'fixtures/browser-auth.ts') }));
        },
      }],
    });
    javascript = frontend.outputFiles[0].text;
    const [{ default: postcss }, { default: tailwind }, { default: loadConfig }, { default: autoprefixer }] = await Promise.all([
      import('postcss'), import('tailwindcss'), import('tailwindcss/loadConfig.js'), import('autoprefixer'),
    ]);
    const tailwindConfig = loadConfig(join(repository, 'tailwind.config.ts'));
    const cssPath = join(repository, 'src/index.css');
    // Les polices distantes sont exclues : toutes les autres règles et tokens sont ceux du produit.
    const css = (await readFile(cssPath, 'utf8')).replace(/^@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^\r\n]+\);\s*/m, '');
    stylesheet = (await postcss([tailwind({
      ...tailwindConfig,
      content: [
        join(repository, 'src/pages/Entraide.tsx'),
        join(repository, 'src/components/ui/{card,button,input,textarea,badge,tabs}.tsx'),
        join(directory, 'fixtures/browser-entry.tsx'),
      ],
    }), autoprefixer()]).process(css, { from: cssPath })).css;

    return {
      baseURL, actors, history, serverErrors, engine: db.engine,
      failNextAfterCommit(filter) { faults.push({ method: 'POST', ...filter }); },
      holdNextResponse(filter) {
        let arrive;
        let release;
        const arrived = new Promise((resolve) => { arrive = resolve; });
        const promise = new Promise((resolve) => { release = resolve; });
        const gate = { filter, promise, arrive, release, used: false };
        gates.add(gate);
        return { arrived, release };
      },
      async snapshot() {
        const tables = {
          profiles: 'SELECT user_id,skills_offered,skills_needed,availability_days,radius_km FROM purama_ai.entraide_profils ORDER BY user_id',
          missions: 'SELECT id,organizer_id,title,description,status,visibility,revision,min_participants,max_participants FROM purama_ai.missions_collectives ORDER BY created_at,id',
          participants: 'SELECT mission_id,user_id FROM purama_ai.missions_collectives_participants ORDER BY mission_id,user_id',
          contacts: 'SELECT id,requester_id,recipient_id,status,message FROM purama_ai.entraide_contact_requests ORDER BY created_at,id',
          blocks: 'SELECT blocker_id,blocked_id FROM purama_ai.entraide_blocages ORDER BY blocker_id,blocked_id',
        };
        const state = {};
        for (const [name, sql] of Object.entries(tables)) state[name] = (await db.query(sql)).rows;
        return state;
      },
      close: closeResources,
    };
  } catch (error) {
    try { await closeResources(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup failed'); }
    throw error;
  }
}
