export const authProviderIds = [
  "github",
  "google",
  "microsoft-entra-id",
] as const;

export type AuthProviderId = (typeof authProviderIds)[number];

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
