import { normalizeItemFilter } from "@shazhou/pinboard-contracts";

export function matchesItemFilter(
  query: string,
  name: string,
  description: string | null,
): boolean {
  const needle = normalizeItemFilter(query);
  return (
    !needle ||
    name.toLowerCase().includes(needle) ||
    (description ?? "").toLowerCase().includes(needle)
  );
}
