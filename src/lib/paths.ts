export function withBase(path: string) {
  const base = import.meta.env.BASE_URL ?? "/";
  if (!path.startsWith("/")) return `${base}${path}`;
  return `${base}${path.slice(1)}`;
}

