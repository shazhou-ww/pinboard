import { HTTPException } from "hono/http-exception";
import { MAX_UPLOAD } from "./content.js";

export interface EntityRange {
  from: bigint;
  to: bigint | null;
}

export function entityRange(value: string | null): EntityRange | undefined {
  if (value === null) return undefined;
  if (!/^-?\d+:(?:-?\d+|\*)$/.test(value))
    throw new HTTPException(400, { message: "Invalid entity-bytes" });
  const [from, to] = value.split(":");
  return { from: BigInt(from!), to: to === "*" ? null : BigInt(to!) };
}

export function rangeKey(range: EntityRange | undefined): string | null {
  return range ? `${range.from}:${range.to ?? "*"}` : null;
}

export function selectRange(
  range: EntityRange,
  size: bigint,
): { start: bigint; end: bigint } {
  const from = range.from < 0n ? size + range.from : range.from;
  const to =
    range.to === null ? size - 1n : range.to < 0n ? size + range.to : range.to;
  if (size === 0n || (range.to !== null && from > to))
    return { start: 0n, end: 0n };
  if (from >= size || to < 0n)
    throw new HTTPException(400, { message: "entity-bytes outside entity" });
  return {
    start: from < 0n ? 0n : from,
    end: to >= size ? size : to + 1n,
  };
}

function invalid(): never {
  throw new HTTPException(503, {
    message: "Inconsistent UnixFS file metadata",
  });
}

// Read the original protobuf, not UnixFS.fileSize(): that accessor recomputes
// sizes and discards a dishonest on-wire filesize. Never round uint64 to Number.
export function fileMetadata(data: Uint8Array, links: number) {
  let offset = 0;
  function uint(end = data.length): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= end) invalid();
      const byte = data[offset++]!;
      if (shift === 63n && byte > 1) invalid();
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    return invalid();
  }
  let type: bigint | undefined;
  let inline = 0n;
  let declared: bigint | undefined;
  const sizes: bigint[] = [];
  const seen = new Set<number>();
  while (offset < data.length) {
    const tag = uint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field) invalid();
    if ([1, 2, 3].includes(field)) {
      if (seen.has(field)) invalid();
      seen.add(field);
    }
    if (wire === 0) {
      const value = uint();
      if (field === 1) type = value;
      else if (field === 3) declared = value;
      else if (field === 4) sizes.push(value);
      else if (field === 2) invalid();
    } else if (wire === 2) {
      const length = uint();
      if (length > BigInt(data.length - offset)) invalid();
      const end = offset + Number(length);
      if (field === 2) inline = length;
      else if (field === 4) {
        while (offset < end) sizes.push(uint(end));
      } else if (field === 1 || field === 3) invalid();
      offset = end;
    } else if (wire === 1 || wire === 5) {
      if (field <= 4) invalid();
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) invalid();
    } else invalid();
  }
  if (type !== 0n && type !== 2n) return undefined;
  if (sizes.length !== links || (type === 0n && links !== 0)) invalid();
  const size = sizes.reduce((sum, value) => sum + value, inline);
  if (declared !== undefined && declared !== size) invalid();
  if (size > BigInt(MAX_UPLOAD))
    throw new HTTPException(413, { message: "UnixFS file exceeds 32 MiB" });
  return { size, inline, sizes };
}
