import { isTauri } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  loadWorkspace,
  readWorkspace,
  workspaceKey,
  type WorkspaceState,
} from "@/lib/workspace-state";

type Change = (update: (previous: WorkspaceState) => WorkspaceState, push?: boolean) => void;
export type Workspace = {
  state: WorkspaceState;
  change: Change;
  restore: { revision: number; scroll: number };
  saveReader: (id: string, index: number) => void;
};
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Workspace navigation is unavailable");
  return workspace;
}
export function useWorkspaceField<K extends keyof WorkspaceState>(field: K) {
  const { state, change } = useWorkspace();
  return [
    state[field],
    (next: SetStateAction<WorkspaceState[K]>) =>
      change((previous) => ({
        ...previous,
        [field]:
          typeof next === "function"
            ? (next as (value: WorkspaceState[K]) => WorkspaceState[K])(previous[field])
            : next,
      })),
  ] as const;
}
function persist(state: WorkspaceState) {
  try {
    localStorage.setItem(workspaceKey, JSON.stringify(state));
  } catch {
    /* Storage may be unavailable; navigation still works in memory. */
  }
}

export function useWorkspaceOwner(scrollRef: RefObject<HTMLDivElement | null>): Workspace {
  const [state, setState] = useState(loadWorkspace);
  const current = useRef(state);
  const [restore, setRestore] = useState({ revision: 0, scroll: state.scroll });
  const restoring = useRef(state.scroll > 0);
  const saveTimer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    history.replaceState({ overwatch: current.current }, "");
    persist(current.current);
  }, []);
  const scheduleSave = useCallback(() => {
    // WebKit limits history writes. Share one bounded timer across scrolling,
    // reader jumps and filter edits, while keeping the latest position in memory.
    if (saveTimer.current === undefined) saveTimer.current = window.setTimeout(flush, 250);
  }, [flush]);
  const change = useCallback<Change>(
    (update, push = false) => {
      const before = {
        ...current.current,
        scroll: Math.round(scrollRef.current?.scrollTop ?? current.current.scroll),
      };
      const after = update(before);
      if (push) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
        history.replaceState({ overwatch: before }, "");
        after.scroll = 0;
        history.pushState({ overwatch: after }, "");
        restoring.current = false;
        setRestore((value) => ({ revision: value.revision + 1, scroll: -1 }));
      }
      current.current = after;
      setState(after);
      if (push) persist(after);
      else scheduleSave();
    },
    [scrollRef, scheduleSave],
  );
  const saveReader = useCallback(
    (id: string, index: number) => {
      const before = current.current;
      if (before.readers.find((reader) => reader.id === id)?.index === index) return;
      const after = {
        ...before,
        readers: [...before.readers.filter((reader) => reader.id !== id), { id, index }].slice(-20),
      };
      current.current = after;
      scheduleSave();
      // No React render for every viewport movement; route changes read the latest ref.
    },
    [scheduleSave],
  );
  useEffect(() => {
    history.scrollRestoration = "manual";
    history.replaceState({ overwatch: current.current }, "");
    const pop = (event: PopStateEvent) => {
      if (!event.state?.overwatch) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      const next = readWorkspace(event.state.overwatch);
      current.current = next;
      restoring.current = true;
      setState(next);
      setRestore((value) => ({ revision: value.revision + 1, scroll: next.scroll }));
    };
    const keys = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("textarea,[contenteditable=true]")
      )
        return;
      if ((event.metaKey || event.ctrlKey) && (event.key === "[" || event.key === "]")) {
        if (isTauri()) return; // Native menu accelerators own this shortcut in the desktop app.
        event.preventDefault();
        if (event.key === "[") history.back();
        else history.forward();
      } else if (
        event.altKey &&
        /Win|Linux/.test(navigator.platform) &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        if (event.key === "ArrowLeft") history.back();
        else history.forward();
      }
    };
    const save = () => flush();
    window.addEventListener("popstate", pop);
    window.addEventListener("keydown", keys);
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [flush]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const scroll = () => {
      if (restoring.current) return;
      current.current = { ...current.current, scroll: Math.round(element.scrollTop) };
      scheduleSave();
    };
    element.addEventListener("scroll", scroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", scroll);
    };
  }, [scrollRef, scheduleSave]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const route = current.current.route;
    if ((route.view === "sessions" && route.id) || (route.view === "models" && route.reading)) {
      restoring.current = false;
      return;
    }
    if (restore.scroll < 0) {
      restoring.current = false;
      return;
    }
    // Restore after lazy pages, queries and virtual rows establish their height.
    restoring.current = true;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = restore.scroll;
        if (element.querySelector('[data-slot="skeleton"]')) return;
        element.scrollTo({ top: target });
        if (
          Math.abs(element.scrollTop - target) < 2 ||
          element.scrollHeight <= element.clientHeight
        ) {
          restoring.current = false;
          observer.disconnect();
        }
      });
    };
    const observer = new MutationObserver(apply);
    observer.observe(element, { childList: true, subtree: true });
    apply();
    const timeout = window.setTimeout(() => {
      restoring.current = false;
      observer.disconnect();
    }, 10_000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      observer.disconnect();
    };
  }, [restore, scrollRef]);
  return { state, change, restore, saveReader };
}
