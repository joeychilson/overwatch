import type { ComarkPlugin, Node } from "comark";

export function matchRanges(text: string, query: string) {
  if (!query) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return [...text.matchAll(expression)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

// Match the rendered text across syntax-color spans without changing Markdown
// structure, code whitespace, link targets or sanitization rules.
export function highlightMatches(query: string): ComarkPlugin {
  return {
    name: "search-matches",
    post({ tree }) {
      if (!query) return;
      let text = "";
      const leaves: { text: string; start: number }[] = [];
      const blocks = new Set([
        "p",
        "pre",
        "li",
        "td",
        "th",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "br",
      ]);
      function collect(nodes: Node[]) {
        for (const node of nodes) {
          if (typeof node === "string") {
            leaves.push({ text: node, start: text.length });
            text += node;
          } else if (node[0] !== null) {
            if (blocks.has(node[0])) text += "\n";
            collect(node.slice(2) as Node[]);
            if (blocks.has(node[0])) text += "\n";
          }
        }
      }
      collect(tree.nodes);
      const ranges = matchRanges(text, query);
      let leafIndex = 0,
        rangeIndex = 0;
      function render(nodes: Node[]): Node[] {
        return nodes.flatMap((node): Node[] => {
          if (typeof node !== "string")
            return node[0] === null
              ? [node]
              : [[node[0], node[1], ...render(node.slice(2) as Node[])]];
          const leaf = leaves[leafIndex++];
          const end = leaf.start + node.length;
          while (rangeIndex < ranges.length && ranges[rangeIndex].end <= leaf.start) rangeIndex++;
          const parts: Node[] = [];
          let at = 0;
          for (let i = rangeIndex; i < ranges.length && ranges[i].start < end; i++) {
            const start = Math.max(0, ranges[i].start - leaf.start);
            const finish = Math.min(node.length, ranges[i].end - leaf.start);
            if (start > at) parts.push(node.slice(at, start));
            parts.push(["mark", {}, node.slice(start, finish)]);
            at = finish;
          }
          if (at < node.length) parts.push(node.slice(at));
          return parts;
        });
      }
      tree.nodes = render(tree.nodes);
    },
  };
}
