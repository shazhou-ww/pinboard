import { CarWriter } from "@ipld/car";
import type { Pin } from "@shazhou/pinboard-contracts";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export interface PreviewAsset {
  readonly pin: Pin;
  readonly car: Uint8Array<ArrayBuffer>;
}

async function asset(name: string, bytes: Uint8Array): Promise<PreviewAsset> {
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  const { writer, out } = CarWriter.create([cid]);
  const collecting = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    const car = new Uint8Array(
      chunks.reduce((size, chunk) => size + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      car.set(chunk, offset);
      offset += chunk.length;
    }
    return car;
  })();
  await writer.put({ cid, bytes });
  await writer.close();
  return {
    pin: {
      cid: cid.toString(),
      name,
      size: bytes.length,
      blocks: 1,
      createdAt: "2026-01-01T00:00:00Z",
    },
    car: await collecting,
  };
}

export async function createPreviewAssets(): Promise<readonly PreviewAsset[]> {
  const images = [
    { name: "Coast study.png", colors: ["#b9dbe0", "#3d6478", "#4b7764"] },
    { name: "Mountain light.png", colors: ["#e4d7bd", "#9588ae", "#506f75"] },
    {
      name: "Evening landscape.png",
      colors: ["#f1d7b6", "#b67563", "#405f59"],
    },
  ] as const;
  const result: PreviewAsset[] = [];
  for (const [index, image] of images.entries()) {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 600;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Canvas is unavailable for local preview images.");
    const sky = context.createLinearGradient(0, 0, 900, 600);
    sky.addColorStop(0, image.colors[0]);
    sky.addColorStop(1, image.colors[1]);
    context.fillStyle = sky;
    context.fillRect(0, 0, 900, 600);
    context.fillStyle = "rgba(255,255,255,.55)";
    context.beginPath();
    context.arc(680 - index * 160, 140, 75, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = image.colors[1];
    context.beginPath();
    context.moveTo(0, 480);
    context.lineTo(180, 160 + index * 40);
    context.lineTo(490, 510);
    context.lineTo(730, 210);
    context.lineTo(900, 450);
    context.lineTo(900, 600);
    context.lineTo(0, 600);
    context.closePath();
    context.fill();
    context.fillStyle = image.colors[2];
    context.beginPath();
    context.moveTo(0, 420);
    context.bezierCurveTo(180, 320, 350, 610, 900, 390);
    context.lineTo(900, 600);
    context.lineTo(0, 600);
    context.closePath();
    context.fill();
    for (let line = 0; line < 12; line++) {
      context.strokeStyle = "rgba(255,255,255,.13)";
      context.beginPath();
      context.moveTo(0, 450 + line * 13);
      context.bezierCurveTo(
        230,
        390 + line * 13,
        580,
        570 + line * 8,
        900,
        430 + line * 13,
      );
      context.stroke();
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("Could not encode the local preview image."));
      }, "image/png");
    });
    result.push(
      await asset(image.name, new Uint8Array(await blob.arrayBuffer())),
    );
  }
  result.push(
    await asset(
      "Read me.txt",
      new TextEncoder().encode(
        "Read-only UI preview. These are synthetic files, not your account data.",
      ),
    ),
  );
  return result;
}
