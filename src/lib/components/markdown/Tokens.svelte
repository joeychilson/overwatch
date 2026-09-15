<script lang="ts">
  /**
   * One level of a markdown token tree.
   *
   * Recurses into itself for nested inline and block content. Two token types
   * are handled deliberately rather than rendered:
   *
   * - `html` becomes visible text. A transcript is a record of what was said,
   *   and markup inside it is content, not instructions to this window.
   * - `image` becomes a labelled placeholder. Loading a remote image would
   *   disclose that a transcript was opened, and the content security policy
   *   would block it anyway, so the reference is shown instead of fetched.
   */
  import type { Token, Tokens as MarkedTokens } from "marked";
  import Tokens from "./Tokens.svelte";
  import ImageOff from "@lucide/svelte/icons/image-off";

  let { tokens }: { tokens: Token[] } = $props();

  const HEADINGS = ["text-section", "text-section", "font-semibold", "font-semibold"];
</script>

{#each tokens as token, index (index)}
  {#if token.type === "space"}
    <!-- Blank lines carry no content; spacing is the parent's business. -->
  {:else if token.type === "paragraph"}
    {@const paragraph = token as MarkedTokens.Paragraph}
    <p><Tokens tokens={paragraph.tokens} /></p>
  {:else if token.type === "heading"}
    {@const heading = token as MarkedTokens.Heading}
    {@const level = Math.min(Math.max(heading.depth, 1), 6)}
    <!-- A transcript's own headings are content, not page structure, so they
         are styled rather than mapped onto the page's heading levels. -->
    <p class="mt-4 {HEADINGS[level - 1] ?? 'font-medium'}" role="heading" aria-level={level + 1}>
      <Tokens tokens={heading.tokens} />
    </p>
  {:else if token.type === "text"}
    {@const text = token as MarkedTokens.Text}
    {#if text.tokens}
      <Tokens tokens={text.tokens} />
    {:else}
      {text.text}
    {/if}
  {:else if token.type === "strong"}
    {@const strong = token as MarkedTokens.Strong}
    <strong class="font-semibold"><Tokens tokens={strong.tokens} /></strong>
  {:else if token.type === "em"}
    {@const em = token as MarkedTokens.Em}
    <em><Tokens tokens={em.tokens} /></em>
  {:else if token.type === "del"}
    {@const del = token as MarkedTokens.Del}
    <del class="text-muted line-through"><Tokens tokens={del.tokens} /></del>
  {:else if token.type === "codespan"}
    {@const code = token as MarkedTokens.Codespan}
    <code class="rounded-item bg-hover px-1 py-0.5 font-mono text-meta">{code.text}</code>
  {:else if token.type === "code"}
    {@const code = token as MarkedTokens.Code}
    <pre class="overflow-x-auto rounded-menu bg-hover p-4 font-mono text-meta"><code
        >{code.text}</code
      ></pre>
  {:else if token.type === "blockquote"}
    {@const quote = token as MarkedTokens.Blockquote}
    <blockquote class="border-l-2 border-border pl-3 text-muted">
      <Tokens tokens={quote.tokens} />
    </blockquote>
  {:else if token.type === "list"}
    {@const list = token as MarkedTokens.List}
    {#if list.ordered}
      <ol class="ml-5 list-decimal space-y-1" start={Number(list.start) || 1}>
        {#each list.items as item, itemIndex (itemIndex)}
          <li><Tokens tokens={item.tokens} /></li>
        {/each}
      </ol>
    {:else}
      <ul class="ml-5 list-disc space-y-1">
        {#each list.items as item, itemIndex (itemIndex)}
          <li class={item.task ? "list-none -ml-5" : ""}>
            {#if item.task}
              <input class="mr-1.5 align-middle" type="checkbox" checked={item.checked} disabled />
            {/if}
            <Tokens tokens={item.tokens} />
          </li>
        {/each}
      </ul>
    {/if}
  {:else if token.type === "table"}
    {@const table = token as MarkedTokens.Table}
    <div class="overflow-x-auto">
      <table class="border-collapse text-left">
        <thead>
          <tr class="border-b border-border">
            {#each table.header as cell, cellIndex (cellIndex)}
              <th class="px-2 py-1 font-medium" style:text-align={table.align[cellIndex] ?? "left"}>
                <Tokens tokens={cell.tokens} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each table.rows as row, rowIndex (rowIndex)}
            <tr>
              {#each row as cell, cellIndex (cellIndex)}
                <td class="px-2 py-1" style:text-align={table.align[cellIndex] ?? "left"}>
                  <Tokens tokens={cell.tokens} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if token.type === "link"}
    {@const link = token as MarkedTokens.Link}
    <!-- Not an anchor: following it would navigate this window away from the
         app. The destination stays visible so nothing is hidden from the
         reader. -->
    <span class="underline decoration-dotted underline-offset-2" title={link.href}>
      <Tokens tokens={link.tokens} />
    </span>
  {:else if token.type === "image"}
    {@const image = token as MarkedTokens.Image}
    <span
      class="inline-flex items-center gap-1.5 rounded-item bg-hover px-1.5 py-0.5 text-meta text-muted"
      title={image.href}
    >
      <ImageOff class="shrink-0" size={13} aria-hidden="true" />
      <span>{image.text || "image"}</span>
    </span>
  {:else if token.type === "br"}
    <br />
  {:else if token.type === "hr"}
    <hr class="border-t border-border" />
  {:else if token.type === "escape"}
    {@const escaped = token as MarkedTokens.Escape}
    {escaped.text}
  {:else}
    <!-- Anything unhandled, html included, shows as the text it is. -->
    {token.raw}
  {/if}
{/each}
