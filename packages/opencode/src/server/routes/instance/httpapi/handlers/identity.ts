import { KeycloakAuth } from "@/auth/keycloak"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { IdentityApiError } from "../groups/identity"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isKeycloakBearerRemoteMcp(value: unknown) {
  if (!isRecord(value)) return false
  if (value.type !== "remote") return false
  if (value.enabled === false) return false
  const auth = value.auth
  return isRecord(auth) && auth.type === "bearer" && auth.provider === "keycloak"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function mapIdentityError<A, R>(self: Effect.Effect<A, KeycloakAuth.KeycloakAuthError, R>) {
  return self.pipe(
    Effect.mapError(
      (error) =>
        new IdentityApiError({
          name: "KeycloakAuthError",
          data: { message: error.message },
        }),
    ),
  )
}

export const identityHandlers = HttpApiBuilder.group(InstanceHttpApi, "identity", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const keycloak = yield* KeycloakAuth.Service
    const mcp = yield* MCP.Service

    const reconnectKeycloakMcp = Effect.fn("IdentityHttpApi.reconnectKeycloakMcp")(function* () {
      const cfg = yield* config.get()
      const entries = Object.entries(cfg.mcp ?? {}).filter(([, item]) => isKeycloakBearerRemoteMcp(item))

      yield* Effect.forEach(
        entries,
        ([name]) =>
          mcp.connect(name).pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("Failed to reconnect Keycloak MCP server after login", {
                name,
                error: errorMessage(error),
              }).pipe(Effect.ignore),
            ),
          ),
        { concurrency: "unbounded" },
      )
    })

    const keycloakStatus = Effect.fn("IdentityHttpApi.keycloakStatus")(function* () {
      yield* mapIdentityError(keycloak.token()).pipe(Effect.orElseSucceed(() => undefined))
      return yield* keycloak.identity()
    })

    const keycloakLoginStart = Effect.fn("IdentityHttpApi.keycloakLoginStart")(function* (ctx: {
      payload: KeycloakAuth.LoginInput
    }) {
      return yield* mapIdentityError(keycloak.startLogin(ctx.payload))
    })

    const keycloakLoginFinish = Effect.fn("IdentityHttpApi.keycloakLoginFinish")(function* (ctx: {
      payload: KeycloakAuth.LoginFinishInput
    }) {
      const identity = yield* mapIdentityError(keycloak.finishLogin(ctx.payload))
      yield* reconnectKeycloakMcp().pipe(Effect.ignore)
      return identity
    })

    const keycloakLogout = Effect.fn("IdentityHttpApi.keycloakLogout")(function* () {
      yield* keycloak.logout()
      return yield* keycloak.identity()
    })

    return handlers
      .handle("keycloakStatus", keycloakStatus)
      .handle("keycloakLoginStart", keycloakLoginStart)
      .handle("keycloakLoginFinish", keycloakLoginFinish)
      .handle("keycloakLogout", keycloakLogout)
  }),
)
