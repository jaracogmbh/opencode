import { KeycloakAuth } from "@/auth/keycloak"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/identity/keycloak"

export class IdentityApiError extends Schema.ErrorClass<IdentityApiError>("IdentityError")(
  {
    name: Schema.Literal("KeycloakAuthError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export const IdentityPaths = {
  keycloak: root,
  keycloakLoginStart: `${root}/login/start`,
  keycloakLoginFinish: `${root}/login/finish`,
} as const

export const IdentityApi = HttpApi.make("identity")
  .add(
    HttpApiGroup.make("identity")
      .add(
        HttpApiEndpoint.get("keycloakStatus", IdentityPaths.keycloak, {
          query: WorkspaceRoutingQuery,
          success: described(KeycloakAuth.Identity, "Keycloak identity status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "identity.keycloak.status",
            summary: "Get Keycloak identity status",
            description: "Get the current global Keycloak SSO identity status without returning tokens.",
          }),
        ),
        HttpApiEndpoint.post("keycloakLoginStart", IdentityPaths.keycloakLoginStart, {
          query: WorkspaceRoutingQuery,
          payload: KeycloakAuth.LoginInput,
          success: described(KeycloakAuth.LoginStart, "Keycloak login authorization URL"),
          error: IdentityApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "identity.keycloak.login.start",
            summary: "Start Keycloak login",
            description: "Start the Keycloak OAuth authorization flow and return the browser authorization URL.",
          }),
        ),
        HttpApiEndpoint.post("keycloakLoginFinish", IdentityPaths.keycloakLoginFinish, {
          query: WorkspaceRoutingQuery,
          payload: KeycloakAuth.LoginFinishInput,
          success: described(KeycloakAuth.Identity, "Keycloak identity status"),
          error: IdentityApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "identity.keycloak.login.finish",
            summary: "Finish Keycloak login",
            description: "Wait for the Keycloak OAuth callback, persist tokens, and return identity status.",
          }),
        ),
        HttpApiEndpoint.delete("keycloakLogout", IdentityPaths.keycloak, {
          query: WorkspaceRoutingQuery,
          success: described(KeycloakAuth.Identity, "Keycloak identity status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "identity.keycloak.logout",
            summary: "Log out Keycloak identity",
            description: "Remove the global Keycloak SSO identity.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "identity",
          description: "Identity routes for global authentication state.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
