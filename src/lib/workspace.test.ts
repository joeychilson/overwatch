import { expect, it } from "vite-plus/test";
import { initialWorkspace, readWorkspace, type WorkspaceState } from "./workspace";

it("preserves saved navigation and filters while discarding legacy list offsets", () => {
  const workspace: WorkspaceState = {
    ...structuredClone(initialWorkspace),
    route: { view: "sessions", id: "saved-session" },
    project: "/saved/project",
    sessions: {
      ...initialWorkspace.sessions,
      search: "saved search",
      range: "30",
      sort: "tokens",
      scroll: 1200,
      focus: "saved-session",
    },
    models: {
      ...initialWorkspace.models,
      provider: "openai",
      agent: "codex",
      sort: "responses",
    },
    scroll: 800,
    readers: [{ id: "saved-session", index: 42 }],
  };
  const legacy = {
    ...workspace,
    sessions: { ...workspace.sessions, offset: 100 },
    models: { ...workspace.models, offset: 50 },
  };

  const restored = readWorkspace(legacy);
  expect(restored).toEqual(workspace);
  expect(readWorkspace(JSON.parse(JSON.stringify(restored)))).toEqual(workspace);
});
