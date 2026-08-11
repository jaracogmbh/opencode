import { KeycloakAuth } from "@/auth/keycloak"
import { MCP } from "@/mcp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { IdentityApiError } from "../groups/identity"

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
    const keycloak = yield* KeycloakAuth.Service
    const mcp = yield* MCP.Service

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
      const result = yield* mapIdentityError(keycloak.finishLogin(ctx.payload))
      yield* mcp.connectKeycloakBearerServers().pipe(Effect.ignore)
      return result
    })

    const keycloakLoginCallback = Effect.fn("IdentityHttpApi.keycloakLoginCallback")(function* (ctx: {
      query: typeof KeycloakAuth.LoginCallbackInput.Type
    }) {
      const result = yield* mapIdentityError(
        keycloak.completeCallback(
          new KeycloakAuth.LoginCallbackInput({
            state: ctx.query.state,
            code: ctx.query.code,
            error: ctx.query.error,
            error_description: ctx.query.error_description,
          }),
        ),
      )
      yield* mcp.connectKeycloakBearerServers().pipe(Effect.ignore)
      return result
    })

    const keycloakLogout = Effect.fn("IdentityHttpApi.keycloakLogout")(function* () {
      yield* keycloak.logout()
      return yield* keycloak.identity()
    })

    return handlers
      .handle("keycloakStatus", keycloakStatus)
      .handle("keycloakLoginStart", keycloakLoginStart)
      .handle("keycloakLoginFinish", keycloakLoginFinish)
      .handle("keycloakLoginCallback", keycloakLoginCallback)
      .handle("keycloakLogout", keycloakLogout)
  }),
)
