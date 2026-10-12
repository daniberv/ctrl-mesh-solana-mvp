/** Shared by the browser and HTTP server so direct links serve the same app. */
export const sectionPaths = {
  workspace: "/",
  projects: "/projects",
  market: "/market",
  agents: "/agents",
  activity: "/activity",
  network: "/network",
  login: "/login",
  account: "/account",
} as const;
export type View = keyof typeof sectionPaths;
export type Route = {
  view: View | "not-found";
  project?: string;
  job?: string;
  agent?: string;
};
// A prefix only for dot-only IDs avoids the browser's URL dot-segment removal.
// Escape a literal leading ~ too, keeping this mapping unambiguous.
const segment = (id: string) =>
  encodeURIComponent(
    id === "." || id === ".." || id.startsWith("~") ? "~" + id : id
  );
const identifier = (raw: string) => {
  const value = decodeURIComponent(raw);
  return value.startsWith("~") ? value.slice(1) : value;
};
export const projectPath = (project: string) => "/projects/" + segment(project);
export const agentPath = (agent: string) => "/agents/" + segment(agent);
export function safeReturnPath(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\\\r\n]/.test(value)
  )
    return "/projects";
  const url = new URL(value, "http://mesh.local");
  const route = parseRoute(url.pathname);
  return url.origin === "http://mesh.local" &&
    route.view !== "login" &&
    route.view !== "not-found"
    ? url.pathname + url.search
    : "/projects";
}
export const taskPath = (project: string, job: string) =>
  projectPath(project) + "/tasks/" + segment(job);
export function parseRoute(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  for (const [view, value] of Object.entries(sectionPaths))
    if (path === value) return { view: view as View };
  const agent = /^\/agents\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (agent) return { view: "agents", agent: agent[1] };
  const match = /^\/projects\/([^/]+)(?:\/tasks\/([^/]+))?$/.exec(path);
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
      /* Malformed percent escapes must render a missing page, not crash startup. */
    }
  }
  return { view: "not-found" };
}
