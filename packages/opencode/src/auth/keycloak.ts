export * as KeycloakAuth from "./keycloak"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Auth } from "@/auth"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { createServer } from "node:http"

const PROVIDER_ID = "keycloak"
const DEFAULT_SCOPE = "openid profile email offline_access"
const REDIRECT_HOST = "127.0.0.1"
const REDIRECT_PORT = 19877
const REDIRECT_PATH = "/"
const REFRESH_SKEW_MS = 60_000
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

const DEFAULT_REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`

export class LoginInput extends Schema.Class<LoginInput>("KeycloakAuth.LoginInput")({
  issuer: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  redirectUri: Schema.optional(Schema.String),
}) {}

export class KeycloakAuthError extends Schema.TaggedErrorClass<KeycloakAuthError>()("KeycloakAuthError", {
  message: Schema.String,
}) {}

export const Status = Schema.Union([
  Schema.Literal("authenticated"),
  Schema.Literal("expired"),
  Schema.Literal("not_authenticated"),
]).annotate({ identifier: "KeycloakIdentityStatus" })
export type Status = typeof Status.Type

export class Identity extends Schema.Class<Identity>("KeycloakIdentity")({
  provider: Schema.Literal("keycloak"),
  status: Status,
  username: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  expires: Schema.optional(NonNegativeInt),
  scope: Schema.optional(Schema.String),
}) {}

export class LoginStart extends Schema.Class<LoginStart>("KeycloakLoginStart")({
  authorizationUrl: Schema.String,
  state: Schema.String,
}) {}

export class LoginFinishInput extends Schema.Class<LoginFinishInput>("KeycloakLoginFinishInput")({
  state: Schema.String,
}) {}

export interface Interface {
  readonly login: (input: LoginInput, onAuthorization?: (url: string) => void) => Effect.Effect<void, KeycloakAuthError>
  readonly startLogin: (input: LoginInput) => Effect.Effect<LoginStart, KeycloakAuthError>
  readonly finishLogin: (input: LoginFinishInput) => Effect.Effect<Identity, KeycloakAuthError>
  readonly logout: () => Effect.Effect<void>
  readonly token: () => Effect.Effect<string | undefined, KeycloakAuthError>
  readonly status: () => Effect.Effect<Status>
  readonly identity: () => Effect.Effect<Identity>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KeycloakAuth") {}

export const use = serviceUse(Service)

interface WellKnown {
  authorization_endpoint: string
  token_endpoint: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

interface PendingLogin {
  input: LoginInput
  wellKnown: WellKnown
  redirectUri: string
  verifier: string
  code: Promise<string>
}

const JwtClaims = Schema.Record(Schema.String, Schema.Unknown)
const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const pending = new Map<string, PendingLogin>()

    const identity = Effect.fn("KeycloakAuth.identity")(function* () {
      const entry = yield* auth.get(PROVIDER_ID).pipe(Effect.orDie)
      return identityFromEntry(entry?.type === "keycloak" ? entry : undefined)
    })

    const status = Effect.fn("KeycloakAuth.status")(function* () {
      return (yield* identity()).status
    })

    const logout = Effect.fn("KeycloakAuth.logout")(() => auth.remove(PROVIDER_ID).pipe(Effect.orDie))

    const token = Effect.fn("KeycloakAuth.token")(function* () {
      const entry = yield* auth.get(PROVIDER_ID).pipe(Effect.mapError(mapAuthError))
      if (!entry || entry.type !== "keycloak") return undefined
      if (entry.expires > Date.now() + REFRESH_SKEW_MS) return entry.access
      if (!entry.refresh) return undefined

      const wellKnown = yield* discoverWellKnown(entry.issuer)
      const refreshed = yield* refreshTokens(wellKnown, entry)
      yield* auth
        .set(PROVIDER_ID, {
          type: "keycloak",
          issuer: entry.issuer,
          clientId: entry.clientId,
          clientSecret: entry.clientSecret,
          access: refreshed.access,
          refresh: refreshed.refresh,
          expires: refreshed.expires,
          scope: refreshed.scope,
        })
        .pipe(Effect.mapError(mapAuthError))
      return refreshed.access
    })

    const startLogin = Effect.fn("KeycloakAuth.startLogin")(function* (input: LoginInput) {
      const wellKnown = yield* discoverWellKnown(input.issuer)
      const state = randomState()
      const pkce = yield* Effect.promise(generatePKCE).pipe(Effect.mapError(toKeycloakError("Failed to generate PKCE")))
      const resolvedRedirectUri = input.redirectUri || DEFAULT_REDIRECT_URI
      const codePromise = waitForAuthorizationCode(state, resolvedRedirectUri)
      const url = buildAuthorizeUrl(wellKnown.authorization_endpoint, input, resolvedRedirectUri, state, pkce.challenge)
      void codePromise.catch(() => undefined)
      pending.set(state, {
        input,
        wellKnown,
        redirectUri: resolvedRedirectUri,
        verifier: pkce.verifier,
        code: codePromise,
      })
      return new LoginStart({ authorizationUrl: url, state })
    })

    const finishLogin = Effect.fn("KeycloakAuth.finishLogin")(function* (input: LoginFinishInput) {
      const current = pending.get(input.state)
      if (!current) {
        return yield* new KeycloakAuthError({ message: "No pending Keycloak login found" })
      }

      return yield* Effect.gen(function* () {
        const code = yield* Effect.promise(() => current.code).pipe(
          Effect.mapError((error) => new KeycloakAuthError({ message: errorMessage(error) })),
        )
        const exchanged = yield* exchangeCode(
          current.wellKnown,
          current.input,
          current.redirectUri,
          code,
          current.verifier,
        )
        yield* auth
          .set(PROVIDER_ID, {
            type: "keycloak",
            issuer: normalizeIssuer(current.input.issuer),
            clientId: current.input.clientId,
            clientSecret: current.input.clientSecret,
            access: exchanged.access,
            refresh: exchanged.refresh,
            expires: exchanged.expires,
            scope: exchanged.scope,
          })
          .pipe(Effect.mapError(mapAuthError))
        return yield* identity()
      }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(input.state))))
    })

    const login = Effect.fn("KeycloakAuth.login")(function* (input: LoginInput, onAuthorization?: (url: string) => void) {
      const started = yield* startLogin(input)
      onAuthorization?.(started.authorizationUrl)
      yield* finishLogin(new LoginFinishInput({ state: started.state }))
    })

    return Service.of({ login, startLogin, finishLogin, logout, token, status, identity })
  }),
)

export function identityFromEntry(entry: Auth.Keycloak | undefined): Identity {
  if (!entry) {
    return new Identity({
      provider: "keycloak",
      status: "not_authenticated",
    })
  }

  return new Identity({
    provider: "keycloak",
    status: entry.expires <= Date.now() ? "expired" : "authenticated",
    username: username(entry),
    issuer: entry.issuer,
    clientId: entry.clientId,
    expires: entry.expires,
    scope: entry.scope,
  })
}

export function username(entry: Auth.Keycloak | undefined) {
  if (!entry) return
  const claims = parseJwtClaims(entry.access)
  if (!claims) return
  for (const key of ["preferred_username", "email", "name", "sub"]) {
    const value = claims[key]
    if (typeof value === "string" && value.length > 0) return value
  }
}

function parseJwtClaims(token: string) {
  const payload = token.split(".")[1]
  if (!payload) return
  return Option.getOrUndefined(decodeJwtClaims(Buffer.from(payload, "base64url").toString("utf8")))
}

function discoverWellKnown(issuer: string) {
  const normalized = normalizeIssuer(issuer)
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${normalized}/.well-known/openid-configuration`)
      if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`)
      const json = (await response.json()) as Partial<WellKnown>
      if (!json.authorization_endpoint || !json.token_endpoint) {
        throw new Error("OIDC discovery response is missing endpoints")
      }
      return {
        authorization_endpoint: json.authorization_endpoint,
        token_endpoint: json.token_endpoint,
      } satisfies WellKnown
    },
    catch: toKeycloakError("Failed to load OIDC discovery"),
  })
}

function exchangeCode(wellKnown: WellKnown, input: LoginInput, redirectUri: string, code: string, verifier: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(wellKnown.token_endpoint, {
        method: "POST",
        headers: tokenHeaders(),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: input.clientId,
          code_verifier: verifier,
          ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        }).toString(),
      })
      if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`)
      const tokens = (await response.json()) as TokenResponse
      if (!tokens.access_token) throw new Error("Token exchange response is missing access_token")
      return normalizeTokens(tokens)
    },
    catch: toKeycloakError("Failed to exchange authorization code"),
  })
}

function refreshTokens(
  wellKnown: WellKnown,
  entry: Auth.Keycloak,
): Effect.Effect<{ access: string; refresh?: string; expires: number; scope?: string }, KeycloakAuthError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(wellKnown.token_endpoint, {
        method: "POST",
        headers: tokenHeaders(),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: entry.refresh ?? "",
          client_id: entry.clientId,
          ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}),
        }).toString(),
      })
      if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
      const tokens = (await response.json()) as TokenResponse
      if (!tokens.access_token) throw new Error("Token refresh response is missing access_token")
      const next = normalizeTokens(tokens)
      return {
        access: next.access,
        refresh: next.refresh ?? entry.refresh,
        expires: next.expires,
        scope: next.scope ?? entry.scope,
      }
    },
    catch: toKeycloakError("Failed to refresh Keycloak token"),
  })
}

function waitForAuthorizationCode(expectedState: string, redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const callbackUrl = new URL(redirectUri)
    const callbackHost = callbackUrl.hostname
    const callbackPort = callbackUrl.port ? parseInt(callbackUrl.port, 10) : 80
    const callbackPath = callbackUrl.pathname || REDIRECT_PATH
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", redirectUri)
      if (url.pathname !== callbackPath) {
        res.writeHead(404)
        res.end("Not found")
        return
      }

      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      const finish = (status: number, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
        res.end(body)
        server.close(() => {})
      }

      if (error) {
        finish(200, OauthCallbackPage.error(errorDescription || error, { provider: "Keycloak" }))
        reject(new Error(errorDescription || error))
        return
      }

      if (!code) {
        finish(400, OauthCallbackPage.error("Missing authorization code", { provider: "Keycloak" }))
        reject(new Error("Missing authorization code"))
        return
      }

      if (state !== expectedState) {
        finish(400, OauthCallbackPage.error("Invalid state - potential CSRF attack", { provider: "Keycloak" }))
        reject(new Error("Invalid state - potential CSRF attack"))
        return
      }

      finish(200, OauthCallbackPage.success({ provider: "Keycloak" }))
      resolve(code)
    })

    const timer = setTimeout(() => {
      server.close(() => {})
      reject(new Error("OAuth callback timeout - authorization took too long"))
    }, CALLBACK_TIMEOUT_MS)

    server.listen(callbackPort, callbackHost, () => undefined)
    server.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    server.on("close", () => clearTimeout(timer))
  })
}

function buildAuthorizeUrl(endpoint: string, input: LoginInput, redirectUri: string, state: string, challenge: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: redirectUri,
    scope: input.scope || DEFAULT_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return `${endpoint}?${params.toString()}`
}

async function generatePKCE() {
  const verifier = randomString(64)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function normalizeTokens(tokens: TokenResponse) {
  return {
    access: tokens.access_token!,
    refresh: tokens.refresh_token,
    expires: Date.now() + Math.max(0, tokens.expires_in ?? 300) * 1000,
    scope: tokens.scope,
  }
}

function normalizeIssuer(issuer: string) {
  return issuer.replace(/\/+$/, "")
}

function randomState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function randomString(length: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((byte) => chars[byte % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function tokenHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function mapAuthError(error: Auth.AuthError) {
  return new KeycloakAuthError({ message: error.message })
}

function toKeycloakError(message: string) {
  return (error: unknown) => new KeycloakAuthError({ message: `${message}: ${errorMessage(error)}` })
}

export const node = LayerNode.make({ service: Service, layer, deps: [Auth.node] })
