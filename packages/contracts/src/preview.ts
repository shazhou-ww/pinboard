import type { ContentPreview } from "./index.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isContentPreview(
  value: unknown,
  allowObjectUrls = false,
): value is ContentPreview {
  if (
    !object(value) ||
    "content" in value ||
    "mediaType" in value ||
    !(value.contentType === null || typeof value.contentType === "string") ||
    !integer(value.version) ||
    value.version < 1 ||
    typeof value.truncated !== "boolean" ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.size !== undefined && !integer(value.size))
  )
    return false;
  if (value.status !== "ready")
    return (
      ["pending", "unsupported", "failed"].includes(String(value.status)) &&
      value.preview === null &&
      value.truncated === false
    );
  const material = value.preview;
  if (!object(material)) return false;
  switch (material.kind) {
    case "text":
    case "markdown":
      return typeof material.text === "string";
    case "image": {
      const image = material.image;
      return (
        object(image) &&
        typeof image.cid === "string" &&
        /^[a-zA-Z0-9]+$/u.test(image.cid) &&
        typeof image.url === "string" &&
        (image.url === `/ipfs/${image.cid}` ||
          (allowObjectUrls && image.url.startsWith("blob:"))) &&
        integer(image.width) &&
        image.width > 0 &&
        image.width <= 480 &&
        integer(image.height) &&
        image.height > 0 &&
        image.height <= 480
      );
    }
    case "directory":
      return (
        Array.isArray(material.entries) &&
        material.entries.length <= 24 &&
        (material.total === undefined || integer(material.total)) &&
        material.entries.every(
          (entry: unknown) =>
            object(entry) &&
            typeof entry.name === "string" &&
            ["file", "directory", "unknown"].includes(String(entry.kind)) &&
            integer(entry.depth) &&
            entry.depth <= 1,
        )
      );
    default:
      return false;
  }
}
