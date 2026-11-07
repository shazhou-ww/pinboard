import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

// Original deterministic fixtures: no external PDF or operating-system fonts.
export function pdfObjects(objects: (string | Uint8Array)[], trailer = "") {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      Buffer.from(object),
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(bytes);
    length += bytes.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
export function pdfStream(bytes: Uint8Array | string, attributes = "") {
  const buffer = Buffer.from(bytes);
  return Buffer.concat([
    Buffer.from(`<< /Length ${buffer.length} ${attributes} >>\nstream\n`),
    buffer,
    Buffer.from("\nendstream"),
  ]);
}
export function simplePdf(
  options: {
    rotate?: number;
    crop?: string;
    width?: number;
    height?: number;
    content?: string;
    form?: boolean;
    annotation?: boolean;
    bomb?: boolean;
    script?: boolean;
  } = {},
) {
  const content =
    options.content ?? "1 0 0 rg 0 0 100 200 re f\n0 0 1 rg 100 0 100 200 re f";
  return pdfObjects([
    `<< /Type /Catalog /Pages 2 0 R ${options.form ? "/AcroForm << /Fields [5 0 R] >>" : ""}
      ${options.script ? "/OpenAction 6 0 R /Names << /JavaScript << /Names [(action) 6 0 R] >> >>" : ""} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.width ?? 200} ${options.height ?? 200}]
     /Rotate ${options.rotate ?? 0} ${options.crop ? `/CropBox [${options.crop}]` : ""}
     ${options.annotation ? "/Annots [5 0 R]" : ""} /Resources << >> /Contents 4 0 R >>`,
    options.bomb
      ? pdfStream(
          deflateSync(Buffer.alloc(80 * 1024 * 1024, 32)),
          "/Filter /FlateDecode",
        )
      : pdfStream(content),
    "<< /Type /Annot /Subtype /Widget /Rect [20 20 100 100] /FT /Tx /T (name) /V (required value) >>",
    '<< /S /JavaScript /JS (app.launchURL\\(\\"https://pdf-example.invalid/\\"\\);) >>',
  ]);
}
export function largeSecondPagePdf() {
  const noise = Buffer.alloc(2400 * 2400);
  let seed = 42;
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[i] = seed >>> 24;
  }
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    pdfStream("1 0 0 rg 0 0 100 200 re f\n0 0 1 rg 100 0 100 200 re f"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im 7 0 R >> >> /Contents 6 0 R >>",
    pdfStream("q 200 0 0 200 0 0 cm /Im Do Q"),
    pdfStream(
      noise,
      "/Type /XObject /Subtype /Image /Width 2400 /Height 2400 /ColorSpace /DeviceGray /BitsPerComponent 8",
    ),
  ]);
}
export function cjkPdf(text: string, traditional = false, korean = false) {
  const hex = [...text]
    .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  const [face, encoding, ordering] = korean
    ? ["HYSMyeongJo-Medium", "UniKS-UCS2-H", "Korea1"]
    : traditional
      ? ["MSung-Light", "UniCNS-UCS2-H", "CNS1"]
      : ["STSong-Light", "UniGB-UCS2-H", "GB1"];
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    pdfStream(`BT /F1 60 Tf 20 20 Td <${hex}> Tj ET`),
    `<< /Type /Font /Subtype /Type0 /BaseFont /${face} /Encoding /${encoding} /DescendantFonts [6 0 R] >>`,
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${face} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>`,
    `<< /Type /FontDescriptor /FontName /${face} /Flags 6 /FontBBox [-100 -200 1100 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 900 /StemV 80 >>`,
  ]);
}

export function embeddedCjkPdf(text: string, font: Uint8Array) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  let cmap = 0;
  for (let i = 0; i < view.getUint16(4); i++) {
    const offset = 12 + i * 16;
    if (new TextDecoder().decode(font.subarray(offset, offset + 4)) === "cmap")
      cmap = view.getUint32(offset + 8);
  }
  let format4 = 0;
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const offset = cmap + view.getUint32(cmap + 8 + i * 8);
    if (view.getUint16(offset) === 4) format4 = offset;
  }
  if (!format4) throw new Error("Expected bundled font format-4 cmap");
  const count = view.getUint16(format4 + 6) / 2;
  const ends = format4 + 14,
    starts = ends + count * 2 + 2;
  const deltas = starts + count * 2,
    ranges = deltas + count * 2;
  const map = new Uint8Array(
    (Math.max(...[...text].map((c) => c.charCodeAt(0))) + 1) * 2,
  );
  const mapped = new DataView(map.buffer);
  for (const char of text) {
    const code = char.charCodeAt(0);
    for (let i = 0; i < count; i++) {
      if (
        code > view.getUint16(ends + i * 2) ||
        code < view.getUint16(starts + i * 2)
      )
        continue;
      const range = view.getUint16(ranges + i * 2);
      let glyph = range
        ? view.getUint16(
            ranges +
              i * 2 +
              range +
              (code - view.getUint16(starts + i * 2)) * 2,
          )
        : code;
      if (glyph) glyph = (glyph + view.getInt16(deltas + i * 2)) & 65535;
      if (!glyph)
        throw new Error("Fixture character missing from bundled font");
      mapped.setUint16(code * 2, glyph);
      break;
    }
  }
  const hex = [...text].map((char) =>
    char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const unicode = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
    /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
    /CMapName /PinboardUCS def /CMapType 2 def
    1 begincodespacerange <0000> <FFFF> endcodespacerange
    ${hex.length} beginbfchar ${hex.map((code) => `<${code}> <${code}>`).join("\n")} endbfchar
    endcmap CMapName currentdict /CMap defineresource pop end end`;
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    pdfStream(`BT /F1 60 Tf 20 20 Td <${hex.join("")}> Tj ET`),
    "<< /Type /Font /Subtype /Type0 /BaseFont /DroidSansFallback /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 10 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DroidSansFallback /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap 9 0 R >>",
    "<< /Type /FontDescriptor /FontName /DroidSansFallback /Flags 4 /FontBBox [-100 -200 1100 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 900 /StemV 80 /FontFile2 8 0 R >>",
    pdfStream(
      deflateSync(font),
      `/Filter /FlateDecode /Length1 ${font.length}`,
    ),
    pdfStream(deflateSync(map), "/Filter /FlateDecode"),
    pdfStream(unicode),
  ]);
}

export function imagePdf() {
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>",
    pdfStream("q 200 0 0 200 0 0 cm /Im Do Q"),
    pdfStream(
      new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 255]),
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8",
    ),
  ]);
}

export function passwordPdf() {
  const digest = (bytes: Uint8Array) =>
    createHash("md5").update(bytes).digest();
  const pad = Buffer.from(
    "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
    "hex",
  );
  const padded = (password: string) =>
    Buffer.concat([Buffer.from(password), pad]).subarray(0, 32);
  const rc4 = (key: Uint8Array, input: Uint8Array) => {
    const table = Uint8Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + table[i]! + key[i % key.length]!) & 255;
      [table[i], table[j]] = [table[j]!, table[i]!];
    }
    let i = 0;
    j = 0;
    return Uint8Array.from(input, (byte) => {
      i = (i + 1) & 255;
      j = (j + table[i]!) & 255;
      [table[i], table[j]] = [table[j]!, table[i]!];
      return byte ^ table[(table[i]! + table[j]!) & 255]!;
    });
  };
  const id = Buffer.alloc(16, 42);
  const owner = rc4(digest(padded("owner")).subarray(0, 5), padded("secret"));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = digest(
    Buffer.concat([padded("secret"), owner, permissions, id]),
  ).subarray(0, 5);
  const user = rc4(key, pad);
  const contentKey = digest(
    Buffer.concat([key, Buffer.from([4, 0, 0, 0, 0])]),
  ).subarray(0, 10);
  return pdfObjects(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
      pdfStream(rc4(contentKey, Buffer.from("1 0 0 rg 0 0 200 200 re f"))),
      `<< /Filter /Standard /V 1 /R 2 /O <${Buffer.from(owner).toString("hex")}> /U <${Buffer.from(user).toString("hex")}> /P -4 >>`,
    ],
    `/Encrypt 5 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`,
  );
}

export function maximumRgbaPng() {
  const width = 1414,
    height = 1414;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  let seed = 41;
  for (let y = 0; y < height; y++)
    for (let x = 1; x <= width * 4; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[y * (width * 4 + 1) + x] = seed >>> 24;
    }
  const chunk = (type: string, value: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), value]);
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(value.length);
    checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([size, data, checksum]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
