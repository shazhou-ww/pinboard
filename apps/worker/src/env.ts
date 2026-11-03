export interface Bindings extends Omit<
  CloudflareBindings,
  | "APP_NAME"
  | "PUBLIC_ORIGIN"
  | "PROVIDER_MULTIADDR"
  | "PROVIDER_ID"
  | "AUTH_URL"
  | "AUTH_GOOGLE_ID"
  | "AUTH_GOOGLE_SECRET"
> {
  readonly APP_NAME: string;
  readonly PUBLIC_ORIGIN: string;
  readonly PROVIDER_MULTIADDR: string;
  readonly PROVIDER_ID: string;
  readonly AUTH_GITHUB_ID?: string;
  readonly AUTH_GITHUB_SECRET?: string;
  readonly AUTH_GOOGLE_ID?: string;
  readonly AUTH_GOOGLE_SECRET?: string;
  readonly AUTH_MICROSOFT_ENTRA_ID_ID?: string;
  readonly AUTH_MICROSOFT_ENTRA_ID_ISSUER?: string;
  readonly AUTH_MICROSOFT_ENTRA_ID_SECRET?: string;
  readonly AUTH_SECRET: string;
  readonly AUTH_URL?: string;
}
