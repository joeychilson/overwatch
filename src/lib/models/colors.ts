// App palette, not official brand colors. Unknown providers remain stable across filters.
const providerColors: Record<string, number> = {
  openai: 1,
  anthropic: 3,
  google: 4,
  xai: 6,
  deepseek: 2,
  mistral: 5,
};

export function providerColor(provider: string) {
  const key = provider.toLowerCase();
  if (!key) return "var(--chart-6)";
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return `var(--chart-${providerColors[key] ?? (hash % 6) + 1})`;
}

export function modelColor(provider: string, model: string) {
  let hash = 0;
  for (const character of model) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return `color-mix(in oklab, ${providerColor(provider)} ${100 - (hash % 3) * 15}%, var(--background))`;
}
