export const previewEnabled =
  import.meta.env.DEV &&
  import.meta.env.VITE_UI_PREVIEW === "true" &&
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (import.meta.env.DEV && previewEnabled) {
    const { previewRequest } = await import("./dev-preview.js");
    const response = await previewRequest(path, init);
    if (response) return response;
  }
  return fetch(path, init);
}

export async function leavePreviewMode(): Promise<boolean> {
  if (import.meta.env.DEV && previewEnabled) {
    const { leavePreview } = await import("./dev-preview.js");
    return leavePreview();
  }
  return false;
}
