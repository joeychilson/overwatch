<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { setMode, userPrefersMode } from "mode-watcher";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import Check from "@lucide/svelte/icons/check";
  import { sidebarIcon, sidebarItem } from "./item.ts";

  const choices = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ] as const;

  const icons = { light: Sun, dark: Moon, system: Monitor };
  const ThemeIcon = $derived(icons[userPrefersMode.current]);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="{sidebarItem} data-[state=open]:bg-hover data-[state=open]:text-text"
    aria-label="Appearance"
  >
    <ThemeIcon class="shrink-0" {...sidebarIcon} aria-hidden="true" />
    <span class="flex-1">Appearance</span>
    <ChevronUp class="shrink-0" {...sidebarIcon} aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      class="z-30 w-48 rounded-menu border border-border bg-menu p-1.25 shadow-[0_8px_30px_#00000018,0_2px_6px_#0000000a]"
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={8}
    >
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading class="px-2.25 py-2 text-label text-muted"
          >Appearance</DropdownMenu.GroupHeading
        >
        <DropdownMenu.RadioGroup value={userPrefersMode.current}>
          {#each choices as choice (choice.value)}
            {@const ChoiceIcon = icons[choice.value]}
            <DropdownMenu.RadioItem
              class="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-item px-2.25 data-highlighted:bg-hover data-highlighted:outline-none"
              value={choice.value}
              onSelect={() => setMode(choice.value)}
            >
              {#snippet children({ checked })}
                <ChoiceIcon class="shrink-0" {...sidebarIcon} aria-hidden="true" />
                <span class="flex-1">{choice.label}</span>
                {#if checked}
                  <Check class="shrink-0" {...sidebarIcon} aria-hidden="true" />
                {/if}
              {/snippet}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
