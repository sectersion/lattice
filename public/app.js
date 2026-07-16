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

function initials(name) {
  return (name ?? "?").trim().slice(0, 2).toUpperCase();
}

// ponytail: admin token is optional (server only enforces it if ADMIN_TOKEN
// is set); prompt lazily on first 401 rather than always asking for one.
async function adminFetch(url, opts = {}) {
  let token = localStorage.getItem("lattice_admin_token") ?? "";
  let res = await fetch(url, { ...opts, headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = prompt("Admin token required:") ?? "";
    localStorage.setItem("lattice_admin_token", token);
    res = await fetch(url, { ...opts, headers: { authorization: `Bearer ${token}` } });
  }
  return res;
}

// Theme: class-strategy dark mode, persisted in localStorage, defaults to
// system preference. Applied ASAP (before body paints) via inline script
// in each page's <head>, this just wires the toggle button.
function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const update = () => {
    btn.textContent = document.documentElement.classList.contains("dark") ? "☀️" : "🌙";
  };
  update();
  btn.addEventListener("click", () => {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("lattice_theme", dark ? "dark" : "light");
    update();
  });
}
document.addEventListener("DOMContentLoaded", initThemeToggle);
