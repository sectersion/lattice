let agentsById = null;
let threadsById = null;

async function agentName(id) {
  if (!agentsById) {
    const res = await fetch("/agents");
    const { agents } = await res.json();
    agentsById = new Map(agents.map((a) => [a.id, a.name]));
  }
  return agentsById.get(id) ?? `agent#${id}`;
}

async function threadTitle(id) {
  if (!threadsById) {
    const res = await fetch(`/threads?limit=1000`);
    const { threads } = await res.json();
    threadsById = new Map(threads.map((t) => [t.id, t.title]));
  }
  return threadsById.get(id) ?? `thread#${id}`;
}

function formatTime(ms) {
  return new Date(ms).toLocaleString();
}
