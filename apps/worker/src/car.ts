import { CarWriter } from "@ipld/car";
import type { Dag } from "./content.js";
import { parseCid } from "./content.js";

export async function encodeCar(dag: Dag): Promise<Uint8Array<ArrayBuffer>> {
  const { writer, out } = CarWriter.create([dag.root]);
  const writing = (async () => {
    try {
      for (const [cid, bytes] of dag.blocks)
        await writer.put({ cid: parseCid(cid), bytes });
    } finally {
      await writer.close();
    }
  })();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of out) {
    chunks.push(chunk);
    length += chunk.length;
  }
  await writing;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
