<script lang="ts">
  /**
   * Markdown from a transcript, rendered as components.
   *
   * The text is lexed into a token tree and each token is rendered by a Svelte
   * component. No HTML string is ever produced, so transcript content cannot
   * introduce markup or script no matter what it contains, and there is no
   * sanitizer whose rules have to be trusted. Raw HTML in the source shows as
   * the text it is.
   *
   * This formats content the agent or the user wrote. It never executes it.
   */
  import { lexer } from "marked";
  import Tokens from "./Tokens.svelte";

  interface Props {
    text: string;
    class?: string;
  }

  let { text, class: className = "" }: Props = $props();

  // A malformed document should show as plain text rather than lose the
  // message entirely, so lexing failure falls back to the raw source.
  const tokens = $derived.by(() => {
    try {
      return lexer(text);
    } catch {
      return null;
    }
  });
</script>

<!-- `wrap-anywhere` rather than `break-words`: only the former lowers the
     element's minimum content width, which is what stops one long token from
     widening every container above it. -->
<div class="markdown min-w-0 wrap-anywhere {className}">
  {#if tokens === null}
    <p class="whitespace-pre-wrap">{text}</p>
  {:else}
    <Tokens {tokens} />
  {/if}
</div>

<style>
  /* Spacing between blocks, without reaching into every child component. */
  .markdown > :global(* + *) {
    margin-top: 0.75em;
  }
</style>
