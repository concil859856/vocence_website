/** Pack sizes on pricing UI: 4000 → "4K", 7000 → "7K". Under 1K stays numeric. */
export function formatCreditsCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  if (n % 1000 === 0) return `${Math.round(n / 1000)}K`;
  return n.toLocaleString();
}
