/**
 * The shape every sidebar row shares.
 *
 * The navigation links are anchors this application renders; the appearance
 * and skipped-sources rows are buttons Bits UI renders as its own triggers.
 * They cannot be one component, so they share the utilities instead and each
 * adds its own state variants.
 */
export const sidebarItem =
  "relative flex min-h-9.5 w-full items-center gap-3 rounded-control border-0" +
  " bg-transparent px-2.75 text-left whitespace-nowrap text-muted" +
  " hover:bg-hover hover:text-text";

/** Size and weight shared by every sidebar icon. */
export const sidebarIcon = { size: 18, strokeWidth: 1.65 } as const;
