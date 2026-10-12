# Vanilla TypeScript primitives
No UI framework. Custom DOM templates, native form and dialog.

## web/frontend.ts
```ts
const badge = (state: string) =>
  `<span class="badge ${escape(state)}">${escape(
    state.replace(/_/g, " ")
  )}</span>`;
const button = (action: string, text: string, job = "", cls = "") =>
  `<button class="button ${cls}" data-action="${action}" data-job="${escape(
    job
  )}">${text}</button>`;
const routeLink = (path: string, text: string, cls = "button") =>
  `<a class="${cls}" href="${escape(path)}" data-route>${text}</a>`;
const pCurrent = () => context.projects.find((p: any) => p.id === projectId);
const manager = (p: any) =>
  p &&
  (key === p.owner || (key === p.manager && p.expires > Date.now() / 1000));

```
