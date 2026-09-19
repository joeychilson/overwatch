<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { goto, snapshot } from "$app/navigation";
  import { page } from "$app/state";
  import Sidebar from "#lib/components/sidebar/Sidebar.svelte";
  import { onCommand, onOpen } from "#lib/api/backend.ts";
  import { Engine, setEngine } from "#lib/state/engine.svelte.ts";
  import { Clock, setClock } from "#lib/state/clock.svelte.ts";
  import { ModeWatcher } from "mode-watcher";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  // Bound only in the app's window, which is the only one that navigates.
  let content = $state() as HTMLElement;

  // The window owns one engine state for its whole lifetime: indexing runs in
  // the background and announces itself, and a per-page subscription would drop
  // those notices while navigating.
  const engine = setEngine(new Engine());
  const clock = setClock(new Clock());

  onMount(() => {
    const stopEngine = engine.start();
    const stopClock = clock.start();
    // The app's menu and the menu bar panel open the window at a destination,
    // and may name an element there to focus, as `/sessions#search` does. A
    // destination already on screen keeps what it is narrowed to.
    const opening = onOpen(async (path) => {
      const [route = "/", focus] = path.split("#");
      if (route !== page.url.pathname) await goto(route);
      if (focus) document.getElementById(focus)?.focus();
    });
    // The menu's Back and Forward move through the window's own history, as
    // the buttons of a browser would.
    const commanding = onCommand((command) => {
      if (command === "back") history.back();
      else history.forward();
    });
    return () => {
      stopEngine();
      stopClock();
      void opening.then((stop) => stop());
      void commanding.then((stop) => stop());
    };
  });

  snapshot({
    id: "main-scroll",
    capture: () => ({ top: content.scrollTop, left: content.scrollLeft }),
    restore: (position) => content.scrollTo(position),
    reset: () => {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (!target) content.scrollTo(0, 0);
    },
  });
</script>

<ModeWatcher disableHeadScriptInjection />

{#if page.route.id === "/tray"}
  <!-- The menu bar item's panel is a window of its own, without the app's frame. -->
  {@render children()}
{:else}
  <a
    class="fixed top-2 left-24 z-50 translate-y-[-150%] rounded-control bg-menu px-3.5 py-2.5 focus:translate-y-0"
    href="#main-content">Skip to content</a
  >

  <div
    class="grid h-dvh grid-cols-[216px_minmax(0,1fr)] grid-rows-[2rem_minmax(0,1fr)] overflow-hidden"
  >
    <div
      class="border-r border-border bg-sidebar select-none"
      data-tauri-drag-region
      aria-hidden="true"
    ></div>
    <div class="bg-content select-none" data-tauri-drag-region aria-hidden="true"></div>
    <Sidebar />
    <main
      class="min-h-0 min-w-0 overflow-auto bg-content px-8 pt-3 pb-8 scrollbar-gutter-stable focus:outline-none [@media(max-width:760px)]:px-6"
      id="main-content"
      bind:this={content}
      tabindex="-1"
    >
      {@render children()}
    </main>
  </div>
{/if}
