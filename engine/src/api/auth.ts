// Bearer-token authentication for the thin client. In production this is the user's
// single sign-on (OIDC) token, verified against the identity provider; here a fixed list of
// development tokens maps to users and roles. The client never states who the user is.
import { config } from "../shared/config.js";

export interface Principal {
  user: string;
  roles: string[];
}

const table = new Map<string, Principal>(
  config.tokens.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const [token, user, roles] = t.split(":");
    return [token, { user, roles: (roles ?? "").split("|").filter(Boolean) }];
  }),
);

export function authenticate(header: string | undefined): Principal | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? table.get(m[1].trim()) ?? null : null;
}

export const can = (p: Principal, role: string) => p.roles.includes(role) || p.roles.includes("admin");
