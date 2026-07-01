import { describe, expect } from "bun:test"
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
})
