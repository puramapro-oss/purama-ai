// Private qualification entrypoint: real API, database, Redis and CHEF runtime.
// Requires isolated QA credentials in process environment. Never starts legacy schedules.
import { startApiServer } from '../../karta/dist/api/server.js';
import { runWorkshopRuntime, checkWorkshopRuntime } from '../../karta/dist/chef/workshop-runtime.js';
import { parseWorkshopProjects, workshopProjectHash } from '../../karta/dist/chef/workshop-config.js';
import { supabase } from '../../karta/dist/db/supabase.js';
import { redisConnection } from '../../karta/dist/queue/redis.js';
import { agentCycleQueue } from '../../karta/dist/queue/queues.js';
const projects = parseWorkshopProjects();
const stop = new AbortController();
for (const name of ['SIGTERM','SIGINT']) process.once(name, () => stop.abort());
let server;
try {
  await checkWorkshopRuntime(projects, stop.signal);
  server = startApiServer(async () => {
    const rows = await supabase.from('chef_workshop_runtimes').select('project_id,config_hash,online,heartbeat_at')
      .in('project_id', projects.map(p => p.id));
    const online = !rows.error && projects.every(p => rows.data?.some(r => r.project_id === p.id &&
      r.online === true && r.config_hash === workshopProjectHash(p) && Date.parse(r.heartbeat_at) > Date.now()-20000));
    return { ready: !!online && await redisConnection.ping() === 'PONG', phase: 'running' };
  });
  console.log(JSON.stringify({event:'PRIVATE_WORKSHOP_START',projects:projects.length}));
  await runWorkshopRuntime(projects, stop.signal);
  console.log(JSON.stringify({event:'PRIVATE_WORKSHOP_STOPPED'}));
} catch (error) {
  console.error(JSON.stringify({event:'PRIVATE_WORKSHOP_ERROR',code:typeof error?.code === 'string' ? error.code : 'UNCONFIRMED'}));
  process.exitCode=1;
} finally {
  stop.abort();
  if (server) await new Promise(resolve => server.close(resolve));
  await agentCycleQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
}
