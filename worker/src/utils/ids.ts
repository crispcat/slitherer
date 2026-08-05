// NOTE: IDs must be globally unique across Worker invocations, not just within
// a single isolate's lifetime. A previous implementation used an in-memory
// counter, but Cloudflare Workers isolates are ephemeral (a fresh isolate is
// used for every request, and definitely after a CPU-limit-exceeded crash),
// so the counter reset on every retry and produced duplicate IDs for
// different rows, causing PRIMARY KEY collisions in D1 (e.g. concepts.id).
export function nextId(prefix: string): string {
  const key = prefix.toUpperCase();
  return `${key}-${crypto.randomUUID()}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}
