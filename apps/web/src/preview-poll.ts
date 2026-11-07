import type { ContentPreview } from "@shazhou/pinboard-contracts";

export function previewPollDelay(
  preview: ContentPreview,
  attempts: number,
): number | undefined {
  if (attempts >= 24) return undefined;
  if (preview.status === "pending") return 2000;
  if (
    preview.status === "failed" &&
    preview.reason === "Preview generation failed; retry scheduled"
  )
    return 30000;
  return undefined;
}
