import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins/username";
import { getConfig } from "./config";
import { getDb } from "./db";
export function authOptions(database = getDb()) {
  const config = getConfig();
  const fixture =
    process.env.NODE_ENV !== "production" &&
    process.env.WEBCARDS_E2E_FIXTURE === "1";
  return {
    database,
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(config.BETTER_AUTH_URL).origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    plugins: [username({ immutableUsername: true })] satisfies [
      ReturnType<typeof username>,
    ],
    rateLimit: {
      enabled: true,
      window: 60,
      max: fixture ? 100 : 20,
      customRules: {
        "/sign-in/username": {
          window: 60,
          max: fixture ? 100 : 5,
        },
      },
    },
    // Local-only deployment: do not trust a caller-supplied forwarded IP.
    advanced: {
      ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
    },
  };
}
function createAuth() {
  return betterAuth(authOptions());
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (instance ??= createAuth());
}
export async function ownerSession(headers: Headers) {
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;
  // Only locally provisioned accounts have an application workspace.
  const provisioned = await getDb().query(
    "SELECT 1 FROM owner_preferences WHERE owner_id=$1",
    [session.user.id],
  );
  return provisioned.rowCount ? session : null;
}
