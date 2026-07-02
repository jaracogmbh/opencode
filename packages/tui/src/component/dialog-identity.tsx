import { TextAttributes } from "@opentui/core"
import type { KeycloakAuthLoginInput, KeycloakIdentity } from "@opencode-ai/sdk/v2"
import { createMemo, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import open from "open"

const DEFAULT_SCOPE = "openid profile email offline_access"
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:19877"

function identityLabel(identity: KeycloakIdentity) {
  if (identity.status === "not_authenticated") return "Not logged in"
  return identity.username ?? identity.clientId ?? identity.issuer ?? "Keycloak"
}

function identityDescription(identity: KeycloakIdentity) {
  if (identity.status === "authenticated") return "Keycloak SSO active"
  if (identity.status === "expired") return "Keycloak SSO expired"
  return "Keycloak SSO not configured"
}

function identityMessage(identity: KeycloakIdentity) {
  const name = identityLabel(identity)
  if (identity.status === "authenticated") return `Logged in as ${name}`
  if (identity.status === "expired") return `Identity expired for ${name}`
  return "Not logged in"
}

function errorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return error instanceof Error ? error.message : String(error)
}

function Status(props: { identity: KeycloakIdentity }) {
  const { theme } = useTheme()
  if (props.identity.status === "authenticated") {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Active</span>
  }
  if (props.identity.status === "expired") {
    return <span style={{ fg: theme.warning, attributes: TextAttributes.BOLD }}>△ Expired</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Logged out</span>
}

async function promptRequired(input: {
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
  title: string
  placeholder: string
  value?: string
  validate?: (value: string) => boolean
}): Promise<string | undefined> {
  const value = await DialogPrompt.show(input.dialog, input.title, {
    placeholder: input.placeholder,
    value: input.value,
  })
  if (value === null) return
  const trimmed = value.trim()
  if (trimmed.length > 0 && (input.validate?.(trimmed) ?? true)) return trimmed
  input.toast.show({ variant: "warning", message: "Enter a valid value" })
  return promptRequired(input)
}

async function promptLogin(input: {
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
  identity: KeycloakIdentity
}): Promise<KeycloakAuthLoginInput | undefined> {
  const issuer = await promptRequired({
    ...input,
    title: "Keycloak issuer URL",
    placeholder: input.identity.issuer ?? "Configured on server or env",
    value: input.identity.issuer,
    validate: URL.canParse,
  })
  if (!issuer) return

  const clientId = await promptRequired({
    ...input,
    title: "Keycloak client ID",
    placeholder: input.identity.clientId ?? "Configured on server or env",
    value: input.identity.clientId,
  })
  if (!clientId) return

  const scopeInput = await DialogPrompt.show(input.dialog, "Scopes", {
    placeholder: input.identity.scope ?? DEFAULT_SCOPE,
    value: input.identity.scope ?? DEFAULT_SCOPE,
  })
  if (scopeInput === null) return

  const clientSecretInput = await DialogPrompt.show(input.dialog, "Client secret", {
    placeholder: "optional",
  })
  if (clientSecretInput === null) return

  const redirectUriInput = await DialogPrompt.show(input.dialog, "Redirect URI", {
    placeholder: DEFAULT_REDIRECT_URI,
    value: DEFAULT_REDIRECT_URI,
  })
  if (redirectUriInput === null) return

  const redirectUri = redirectUriInput.trim() || DEFAULT_REDIRECT_URI
  if (!URL.canParse(redirectUri)) {
    input.toast.show({ variant: "warning", message: "Enter a valid redirect URI" })
    return promptLogin(input)
  }

  return {
    issuer,
    clientId,
    scope: scopeInput.trim() || DEFAULT_SCOPE,
    clientSecret: clientSecretInput.trim() || undefined,
    redirectUri,
  }
}

function WaitingLogin(props: { state: string; authorizationUrl: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  onMount(() => {
    void sdk.client.identity.keycloak.login
      .finish({
        keycloakLoginFinishInput: {
          state: props.state,
        },
      })
      .then((result) => {
        if (result.data) {
          sync.set("identity", result.data)
          toast.show({ variant: "success", message: identityMessage(result.data) })
          dialog.clear()
          return
        }
        toast.show({ variant: "error", message: result.error ? errorMessage(result.error) : "Login failed" })
        dialog.clear()
      })
      .catch((error) => {
        toast.show({ variant: "error", message: errorMessage(error) })
        dialog.clear()
      })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Identity
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.text}>Waiting for Keycloak authorization</text>
      <text fg={theme.textMuted} wrapMode="word">
        {props.authorizationUrl}
      </text>
    </box>
  )
}

export function DialogIdentity() {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()

  async function refresh() {
    const result = await sdk.client.identity.keycloak.status()
    if (result.data) {
      sync.set("identity", result.data)
      toast.show({ variant: "info", message: identityMessage(result.data) })
      return
    }

    toast.show({ variant: "error", message: result.error ? errorMessage(result.error) : "Failed to refresh identity" })
  }

  async function logout() {
    const result = await sdk.client.identity.keycloak.logout()
    if (result.data) {
      sync.set("identity", result.data)
      toast.show({ variant: "success", message: "Logged out" })
      dialog.clear()
      return
    }
    toast.show({ variant: "error", message: result.error ? errorMessage(result.error) : "Logout failed" })
  }

  async function login() {
    const input = await promptLogin({ dialog, toast, identity: sync.data.identity })
    if (!input) return
    const result = await sdk.client.identity.keycloak.login.start({
      keycloakAuthLoginInput: input,
    })
    if (!result.data) {
      toast.show({ variant: "error", message: result.error ? errorMessage(result.error) : "Login failed" })
      dialog.clear()
      return
    }

    const started = result.data
    void open(started.authorizationUrl).catch(() => undefined)
    dialog.replace(() => <WaitingLogin state={started.state} authorizationUrl={started.authorizationUrl} />)
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const identity = sync.data.identity
    const loggedIn = identity.status !== "not_authenticated"
    return [
        {
          title: identityLabel(identity),
          value: "status",
          description: identityDescription(identity),
          footer: <Status identity={identity} />,
          category: "Status",
          onSelect: () => {
            if (identity.status === "expired") {
              void refresh()
            }
          },
        },
      {
        title: loggedIn ? "Log in again" : "Log in",
        value: "login",
        description: "Keycloak SSO",
        category: "Actions",
        onSelect: () => void login(),
      },
      ...(loggedIn
        ? [
            {
              title: "Log out",
              value: "logout",
              description: identityLabel(identity),
              category: "Actions",
              onSelect: () => void logout(),
            },
          ]
        : []),
    ]
  })

  return <DialogSelect title="Identity" options={options()} />
}
