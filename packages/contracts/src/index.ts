export const authProviderIds = [
  "github",
  "google",
  "microsoft-entra-id",
] as const;

export const itemFilterMaxLength = 200;
export function normalizeItemFilter(value: string): string {
  return value.trim().toLowerCase();
}

export const uploadLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxBlockBytes: 2 * 1024 * 1024,
  maxBlocks: 256,
} as const;

export type AuthProviderId = (typeof authProviderIds)[number];

export const oauthLifetimes = ["1d", "7d", "30d", "never"] as const;
export type OAuthLifetime = (typeof oauthLifetimes)[number];
export const defaultOAuthLifetime: OAuthLifetime = "1d";
export const oauthLifetimeOptions = {
  "1d": { label: "After 1 day", seconds: 86400 },
  "7d": { label: "After 7 days", seconds: 604800 },
  "30d": { label: "After 30 days", seconds: 2592000 },
  never: { label: "Never", seconds: null },
} as const satisfies Record<
  OAuthLifetime,
  { readonly label: string; readonly seconds: number | null }
>;

export interface OAuthGrant {
  readonly id: string;
  readonly clientName: string;
  readonly clientId: string;
  readonly scopes: string;
  readonly createdAt: number;
  readonly codeExpiresAt: number;
  readonly tokenIssued: boolean;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export interface AuthProviderDescriptor {
  readonly id: AuthProviderId;
  readonly label: string;
}

export interface BootstrapResponse {
  readonly appName: string;
  readonly providers: readonly AuthProviderDescriptor[];
}

export interface HealthResponse {
  readonly service: string;
  readonly status: "ok";
}

export interface SessionUser {
  readonly id?: string;
  readonly email?: string | null;
  readonly image?: string | null;
  readonly name?: string | null;
}

export interface Pin {
  readonly cid: string;
  readonly name: string;
  readonly size: number;
  readonly blocks: number;
  readonly createdAt: string;
}

export interface PublicationRevision {
  readonly revision: number;
  readonly cid: string;
  readonly size: number;
  readonly blocks: number;
  readonly createdAt: string;
  readonly descriptions?: Readonly<Record<string, string>>;
}

export interface Publication {
  readonly id: string;
  readonly title: string;
  readonly currentRevision: number;
  readonly revisionCount: number;
  readonly sequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly current: PublicationRevision;
}

export interface PublicationWrite {
  readonly expectedSequence: number;
  readonly requestId: string;
}

export interface PublicationResult {
  readonly status:
    "created" | "converted" | "published" | "rolled-back" | "nop";
  readonly publication: Publication;
}

export interface PublicationHistory {
  readonly publication: Publication;
  readonly revisions: readonly PublicationRevision[];
  readonly operations: readonly {
    sequence: number;
    revision: number;
    kind: string;
    createdAt: string;
  }[];
}

export interface DeletedItem {
  readonly kind: "pin" | "publication";
  readonly id: string;
  readonly title: string;
  readonly deletedAt: string;
  readonly expiresAt: string;
}

export type UploadPublicationResult =
  | { readonly pin: Pin; readonly publication: PublicationResult }
  | {
      readonly pin: Pin;
      readonly partialSuccess: true;
      readonly publicationError: {
        readonly status: number;
        readonly message: string;
      };
    };

export interface PreviewImage {
  readonly cid: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export type PreviewPayload =
  | { readonly contentType: "image/webp"; readonly content: PreviewImage }
  | {
      readonly contentType: "text/plain" | "text/markdown";
      readonly content: string;
    }
  | {
      readonly contentType: "application/vnd.pinboard.directory+json";
      readonly content: {
        readonly entries: readonly {
          readonly name: string;
          readonly kind: "file" | "directory" | "unknown";
          readonly depth: number;
        }[];
        readonly total?: number;
      };
    }
  | {
      readonly contentType: "application/vnd.pinboard.file+json";
      readonly content: { readonly size?: number; readonly mediaType?: string };
    };

export type ContentPreview = PreviewPayload & {
  readonly version: number;
  readonly status: "pending" | "ready" | "unsupported" | "failed";
  readonly truncated: boolean;
  readonly reason?: string;
};

export interface NodeDescription {
  readonly rootCid: string;
  readonly nodeCid: string;
  readonly description: {
    readonly user: { readonly text: string | null; readonly version: number };
    readonly preview: ContentPreview;
  };
}

export const previewBatchLimit = 32;

export type PreviewBatchItem =
  | { readonly cid: string; readonly preview: ContentPreview }
  | {
      readonly cid: string;
      readonly error: { readonly status: 404; readonly message: string };
    };

export interface PreviewBatchResponse {
  readonly previews: readonly PreviewBatchItem[];
}

export interface AgentToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface SessionResponse {
  readonly expires?: string;
  readonly user?: SessionUser;
}

export function getAuthProviderLabel(id: AuthProviderId): string {
  switch (id) {
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    case "microsoft-entra-id":
      return "Microsoft";
  }
}
