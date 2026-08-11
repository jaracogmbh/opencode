import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import type { KeycloakAuthLoginInput, KeycloakIdentity, KeycloakLoginStart } from "@opencode-ai/sdk/v2/client"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"

const DEFAULT_SCOPE = "openid profile email offline_access"
const DEFAULT_ISSUER = "https://keycloak.jarakube.com/realms/jaraco"
const DEFAULT_KEYCLOAK_CLIENT_ID = "data-mesh-k8s"

function identityLabel(identity: KeycloakIdentity) {
  if (identity.status === "not_authenticated") return "Not logged in"
  return identity.username ?? identity.clientId ?? identity.issuer ?? "Keycloak"
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

function openWindow(url: string) {
  if (typeof window !== "object") return
  window.open(url, "_blank", "noopener,noreferrer")
}

export function DialogIdentity() {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const [form, setForm] = createStore({
    issuer: sync().data.identity.issuer ?? DEFAULT_ISSUER,
    clientId: sync().data.identity.clientId ?? DEFAULT_KEYCLOAK_CLIENT_ID,
    scope: sync().data.identity.scope ?? DEFAULT_SCOPE,
    clientSecret: "",
  })
  const [state, setState] = createStore({
    loading: false,
    started: undefined as KeycloakLoginStart | undefined,
  })

  const statusDescription = () => {
    const identity = sync().data.identity
    if (identity.status === "authenticated") return language.t("dialog.identity.status.active")
    if (identity.status === "expired") return language.t("dialog.identity.status.expired")
    return language.t("dialog.identity.status.loggedOut")
  }

  const loginInput = (): KeycloakAuthLoginInput => ({
    issuer: form.issuer.trim() || DEFAULT_ISSUER,
    clientId: form.clientId.trim() || DEFAULT_KEYCLOAK_CLIENT_ID,
    clientSecret: form.clientSecret.trim() || undefined,
    scope: form.scope.trim() || DEFAULT_SCOPE,
    flow: "device",
  })

  const finishLogin = async (started: KeycloakLoginStart) => {
    const result = await sdk().client.identity.keycloak.login.finish({
      keycloakLoginFinishInput: { state: started.state },
    })
    if (!result.data) {
      throw new Error(result.error ? errorMessage(result.error) : "Login failed")
    }
    sync().set("identity", result.data)
    showToast({
      variant: "success",
      title: result.data.username ? `Logged in as ${result.data.username}` : identityLabel(result.data),
    })
    dialog.close()
  }

  const login = async () => {
    if (state.loading) return
    setState("loading", true)
    try {
      const result = await sdk().client.identity.keycloak.login.start({
        keycloakAuthLoginInput: loginInput(),
      })
      if (!result.data) {
        throw new Error(result.error ? errorMessage(result.error) : "Login failed")
      }
      setState("started", result.data)
      openWindow(result.data.verificationUriComplete ?? result.data.verificationUri ?? result.data.authorizationUrl)
      await finishLogin(result.data)
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: errorMessage(error) })
    } finally {
      setState("loading", false)
    }
  }

  const refresh = async () => {
    const result = await sdk().client.identity.keycloak.status()
    if (!result.data) {
      showToast({
        title: language.t("common.requestFailed"),
        description: result.error ? errorMessage(result.error) : undefined,
      })
      return
    }
    sync().set("identity", result.data)
  }

  const logout = async () => {
    if (state.loading) return
    setState("loading", true)
    try {
      const result = await sdk().client.identity.keycloak.logout()
      if (!result.data) {
        throw new Error(result.error ? errorMessage(result.error) : "Logout failed")
      }
      sync().set("identity", result.data)
      setState("started", undefined)
      showToast({ variant: "success", title: language.t("dialog.identity.toast.loggedOut") })
      dialog.close()
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: errorMessage(error) })
    } finally {
      setState("loading", false)
    }
  }

  return (
    <Dialog title={language.t("dialog.identity.title")}>
      <div class="flex flex-col gap-4 px-3 pb-3 max-h-[70vh] overflow-y-auto">
        <div class="flex flex-col gap-1">
          <div class="text-14-medium text-text-strong">{identityLabel(sync().data.identity)}</div>
          <div class="text-13-regular text-text-weak">{statusDescription()}</div>
        </div>

        <p class="text-13-regular text-text-weak">{language.t("dialog.identity.description")}</p>

        <div class="grid gap-3">
          <TextField
            autofocus
            label={language.t("dialog.identity.field.issuer")}
            value={form.issuer}
            onChange={(value) => setForm("issuer", value)}
          />
          <TextField
            label={language.t("dialog.identity.field.clientId")}
            value={form.clientId}
            onChange={(value) => setForm("clientId", value)}
          />
          <TextField
            label={language.t("dialog.identity.field.scope")}
            value={form.scope}
            onChange={(value) => setForm("scope", value)}
          />
          <TextField
            label={language.t("dialog.identity.field.clientSecret")}
            placeholder={language.t("dialog.identity.field.clientSecret.placeholder")}
            value={form.clientSecret}
            onChange={(value) => setForm("clientSecret", value)}
          />
        </div>

        <Show when={state.started}>
          {(started) => (
            <div class="rounded-lg border border-border-subtle bg-surface-secondary p-3 flex flex-col gap-2">
              <div class="text-13-medium text-text-strong">{language.t("dialog.identity.waiting")}</div>
              <div class="text-12-regular text-text-weak">{language.t("dialog.identity.flow.device")}</div>
              <Show when={started().userCode}>
                {(userCode) => (
                  <div class="text-13-regular text-text-base">
                    {language.t("dialog.identity.code")}: <span class="font-mono">{userCode()}</span>
                  </div>
                )}
              </Show>
              <div class="text-12-regular text-text-weak break-all">
                {started().verificationUriComplete ?? started().verificationUri ?? started().authorizationUrl}
              </div>
              <div>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => openWindow(started().verificationUriComplete ?? started().verificationUri ?? started().authorizationUrl)}
                >
                  {language.t("dialog.identity.action.open")}
                </Button>
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-wrap gap-2">
          <Button variant="primary" disabled={state.loading} onClick={() => void login()}>
            {sync().data.identity.status === "not_authenticated"
              ? language.t("dialog.identity.action.login")
              : language.t("dialog.identity.action.loginAgain")}
          </Button>
          <Button variant="secondary" disabled={state.loading} onClick={() => void refresh()}>
            {language.t("dialog.identity.action.refresh")}
          </Button>
          <Show when={sync().data.identity.status !== "not_authenticated"}>
            <Button variant="ghost" disabled={state.loading} onClick={() => void logout()}>
              {language.t("dialog.identity.action.logout")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
