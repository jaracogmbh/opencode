import { afterEach, describe, expect } from "bun:test"
import { Context, Layer, Effect } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { IdentityPaths } from "../../src/server/routes/instance/httpapi/groups/identity"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(testStateLayer)
const context = Context.empty() as Context.Context<unknown>

function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.signature`
}

describe("identity HttpApi", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const request = Effect.fnUntraced(function* (route: string, directory: string, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    headers.set("x-opencode-directory", directory)
    const handler = HttpApiApp.webHandler()
    return yield* Effect.promise(() =>
      Promise.resolve(
        handler.handler(
          new Request(`http://localhost${route}`, {
            ...init,
            headers,
          }),
          context,
        ),
      ),
    )
  })

  it.instance("serves unauthenticated Keycloak identity status", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(IdentityPaths.keycloak, tmp.directory)

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        provider: "keycloak",
        status: "not_authenticated",
        issuer: null,
        clientId: null,
        scope: "openid profile email offline_access",
      })
    }),
  )

  it.instance("serves redacted authenticated Keycloak identity status", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        keycloak: {
          type: "keycloak",
          issuer: "https://sso.example.com/realms/dev",
          clientId: "opencode-cli",
          access: jwt({ preferred_username: "ada" }),
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          scope: "openid profile",
          clientSecret: "secret",
        },
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.OPENCODE_AUTH_CONTENT
            return
          }
          process.env.OPENCODE_AUTH_CONTENT = previous
        }),
      )

      const tmp = yield* TestInstance
      const response = yield* request(IdentityPaths.keycloak, tmp.directory)
      const body = yield* Effect.promise(() => response.json())

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        provider: "keycloak",
        status: "authenticated",
        username: "ada",
        issuer: "https://sso.example.com/realms/dev",
        clientId: "opencode-cli",
        scope: "openid profile",
      })
      expect(body).not.toHaveProperty("access")
      expect(body).not.toHaveProperty("refresh")
      expect(body).not.toHaveProperty("clientSecret")
    }),
  )

  it.instance("starts Keycloak device login", () =>
    Effect.gen(function* () {
      globalThis.fetch = (async (request, init) => {
        const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url
        if (url.endsWith("/.well-known/openid-configuration")) {
          return new Response(
            JSON.stringify({
              authorization_endpoint: "https://sso.example.com/auth",
              token_endpoint: "https://sso.example.com/token",
              device_authorization_endpoint: "https://sso.example.com/device",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }

        if (url === "https://sso.example.com/device") {
          const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body)
          expect(body).toContain("client_id=opencode-cli")
          return new Response(
            JSON.stringify({
              device_code: "device-code",
              user_code: "ABCD-EFGH",
              verification_uri: "https://sso.example.com/verify",
              verification_uri_complete: "https://sso.example.com/verify?user_code=ABCD-EFGH",
              expires_in: 600,
              interval: 1,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }

        throw new Error(`unexpected fetch ${url}`)
      }) as typeof fetch

      const tmp = yield* TestInstance
      const response = yield* request(IdentityPaths.keycloakLoginStart, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuer: "https://sso.example.com/realms/dev",
          clientId: "opencode-cli",
          flow: "device",
        }),
      })
      const body = yield* Effect.promise(() => response.json())

      expect(response.status).toBe(200)
      expect(body).toEqual({
        flow: "device",
        authorizationUrl: "https://sso.example.com/verify?user_code=ABCD-EFGH",
        state: expect.any(String),
        verificationUri: "https://sso.example.com/verify",
        verificationUriComplete: "https://sso.example.com/verify?user_code=ABCD-EFGH",
        userCode: "ABCD-EFGH",
        expiresInSeconds: 600,
        intervalSeconds: 1,
      })
    }),
  )
})
