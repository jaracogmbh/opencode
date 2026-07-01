import { describe, expect, test } from "bun:test"
import { KeycloakAuth } from "../../src/auth/keycloak"

function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

describe("KeycloakAuth", () => {
  test("identityFromEntry returns redacted authenticated identity with username", () => {
    const identity = KeycloakAuth.identityFromEntry({
      type: "keycloak",
      issuer: "https://sso.example.com/realms/dev",
      clientId: "opencode-cli",
      access: jwt({ preferred_username: "ada" }),
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      scope: "openid profile",
      clientSecret: "secret",
    })

    expect(identity).toEqual({
      provider: "keycloak",
      status: "authenticated",
      username: "ada",
      issuer: "https://sso.example.com/realms/dev",
      clientId: "opencode-cli",
      expires: expect.any(Number),
      scope: "openid profile",
    })
    expect(identity).not.toHaveProperty("access")
    expect(identity).not.toHaveProperty("refresh")
    expect(identity).not.toHaveProperty("clientSecret")
  })

  test("identityFromEntry reports expired and unauthenticated states", () => {
    expect(
      KeycloakAuth.identityFromEntry({
        type: "keycloak",
        issuer: "https://sso.example.com/realms/dev",
        clientId: "opencode-cli",
        access: jwt({ email: "ada@example.com" }),
        expires: Date.now() - 1,
      }),
    ).toMatchObject({
      provider: "keycloak",
      status: "expired",
      username: "ada@example.com",
    })

    expect(KeycloakAuth.identityFromEntry(undefined)).toEqual({
      provider: "keycloak",
      status: "not_authenticated",
    })
  })
})
