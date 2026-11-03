import type { AuthConfig } from "@hono/auth-js";
import Google from "@auth/core/providers/google";
import type { AuthProviderDescriptor } from "@workspace/contracts";
import type { Bindings } from "./env.js";
import { accountForGoogle } from "./identity.js";

export function getConfiguredProviders(
  env: Bindings,
): readonly AuthProviderDescriptor[] {
  return env.AUTH_GOOGLE_ID?.trim() && env.AUTH_GOOGLE_SECRET?.trim()
    ? [{ id: "google", label: "Google" }]
    : [];
}

export function createAuthConfig(env: Bindings): AuthConfig {
  return {
    basePath: "/api/auth",
    providers: getConfiguredProviders(env).length
      ? [
          Google({
            clientId: env.AUTH_GOOGLE_ID!,
            clientSecret: env.AUTH_GOOGLE_SECRET!,
          }),
        ]
      : [],
    secret: env.AUTH_SECRET,
    trustHost: true,
    session: { strategy: "jwt" },
    callbacks: {
      async jwt({ token, account }) {
        if (account) {
          if (account.provider !== "google" || !account.providerAccountId)
            throw new Error("Unsupported identity provider");
          token.accountId = await accountForGoogle(
            env.DB,
            account.providerAccountId,
          );
        }
        return token;
      },
      session({ session, token }) {
        if (typeof token.accountId === "string")
          session.user.id = token.accountId;
        return session;
      },
    },
  };
}
