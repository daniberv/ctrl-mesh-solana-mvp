/** Shared by the browser and HTTP server. Every workspace page lives under /app. */
export const sectionPaths = {
  landing: "/",
  workspace: "/app",
  projects: "/app/projects",
  market: "/app/market",
  agents: "/app/agents",
  activity: "/app/activity",
  network: "/app/network",
  account: "/app/account",
  login: "/login",
  register: "/register",
  verify: "/verify-email",
  forgot: "/forgot-password",
  reset: "/reset-password",
  connect: "/app/connect-wallet",
} as const;
export type View = keyof typeof sectionPaths;
export type Route = {
  view: View | "not-found";
  project?: string;
  job?: string;
  agent?: string;
};
const segment = (id: string) =>
  encodeURIComponent(
    id === "." || id === ".." || id.startsWith("~") ? "~" + id : id
  );
const identifier = (raw: string) => {
  const value = decodeURIComponent(raw);
  return value.startsWith("~") ? value.slice(1) : value;
};
export const projectPath = (project: string) =>
  "/app/projects/" + segment(project);
export const agentPath = (agent: string) => "/app/agents/" + segment(agent);
export const taskPath = (project: string, job: string) =>
  projectPath(project) + "/tasks/" + segment(job);
export function safeReturnPath(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/app") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return "/app";
  const url = new URL(value, "http://mesh.local"),
    route = parseRoute(url.pathname);
  return url.origin === "http://mesh.local" &&
    route.view !== "not-found" &&
    route.view !== "connect" &&
    url.pathname.startsWith("/app")
    ? url.pathname + url.search
    : "/app";
}
export function legacyRoute(path: string) {
  return /^\/(projects|market|agents|activity|network|account)(\/|$)/.test(path)
    ? "/app" + path
    : null;
}
export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  for (const [view, value] of Object.entries(sectionPaths))
    if (path === value) return { view: view as View };
  const agent = /^\/app\/agents\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (agent) return { view: "agents", agent: agent[1] };
  const match = /^\/app\/projects\/([^/]+)(?:\/tasks\/([^/]+))?$/.exec(path);
  if (match) {
    try {
      const project = identifier(match[1]),
        job = match[2] ? identifier(match[2]) : undefined;
      if (
        !project.trim() ||
        project.length > 80 ||
        (job !== undefined && (!job.trim() || job.length > 80))
      )
        return { view: "not-found" };
      return {
        view: "workspace",
        project,
        ...(job === undefined ? {} : { job }),
      };
    } catch {
      /* Malformed percent escapes render a missing page. */
    }
  }
  return { view: "not-found" };
}
