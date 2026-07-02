// Lifecycle management for the split-footer renderer.
//
// Creates the OpenTUI CliRenderer in split-footer mode, resolves the theme
// from the terminal palette, writes the entry splash to scrollback, and
// constructs the RunFooter. Returns a Lifecycle handle whose close() writes
// the exit splash and tears everything down in the right order:
// footer.close → footer.destroy → renderer shutdown.
//
// Also wires SIGINT so Ctrl-c clears a live prompt draft first, then falls
// back to the usual two-press exit sequence through RunFooter.requestExit().
import path from "path"
import { CliRenderEvents, createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Global } from "@opencode-ai/core/global"
import { openEditor } from "@opencode-ai/tui/editor"
import { registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { Session as SessionApi } from "@/session/session"
import * as Locale from "@/util/locale"
import { resolveInteractiveStdin } from "./runtime.stdin"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { resolveRunTheme, RUN_THEME_FALLBACK } from "./theme"
import type {
  FooterApi,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunIdentity,
  RunInput,
  RunPrompt,
  RunResource,
  RunTuiConfig,
} from "./types"
import { formatModelLabel } from "./variant.shared"

const FOOTER_HEIGHT = 4

type SplashState = {
  entry: boolean
  exit: boolean
}

type CycleResult = {
  modelLabel?: string
  status?: string
  variant?: string | undefined
  variants?: string[]
}

type FooterLabels = {
  agentLabel: string
  modelLabel: string
}

export type LifecycleInput = {
  directory: string
  sdk: RunInput["sdk"]
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  resources: RunResource[]
  sessionID: string
  sessionTitle?: string
  getSessionID?: () => string | undefined
  first: boolean
  history: RunPrompt[]
  identity: RunIdentity
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  tuiConfig: RunTuiConfig
  backgroundSubagents: boolean
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onModelSelect?: (model: NonNullable<RunInput["model"]>) => CycleResult | void | Promise<CycleResult | void>
  onVariantSelect?: (variant: string | undefined) => CycleResult | void | Promise<CycleResult | void>
  onInterrupt?: () => void
  onBackground?: () => void
  onSubagentSelect?: (sessionID: string | undefined) => void
}

export type Lifecycle = {
  footer: FooterApi
  onResize(fn: () => void): () => void
  refreshTheme(): void
  resetForReplay(input: { sessionTitle?: string; sessionID?: string; history: RunPrompt[] }): Promise<void>
  close(input: { showExit: boolean; sessionTitle?: string; sessionID?: string; history?: RunPrompt[] }): Promise<void>
}

// Gracefully tears down the renderer. Order matters: switch external output
// back to passthrough before leaving split-footer mode, so pending stdout
// doesn't get captured into the now-dead scrollback pipeline.
function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashInfo(title: string | undefined, history: RunPrompt[]) {
  if (title && !SessionApi.isDefaultTitle(title)) {
    return {
      title,
      showSession: true,
    }
  }

  const next = history.find((item) => item.text.trim().length > 0)
  return {
    title: next?.text ?? title,
    showSession: !!next,
  }
}

function footerLabels(input: Pick<RunInput, "agent" | "model" | "variant">): FooterLabels {
  const agentLabel = Locale.titlecase(input.agent ?? "build")

  if (!input.model) {
    return {
      agentLabel,
      modelLabel: "Model default",
    }
  }

  return {
    agentLabel,
    modelLabel: formatModelLabel(input.model, input.variant),
  }
}

function directoryLabel(directory: string) {
  const resolved = path.resolve(directory)
  const display =
    resolved === Global.Path.home
      ? "~"
      : resolved.startsWith(`${Global.Path.home}${path.sep}`)
        ? resolved.replace(Global.Path.home, "~")
        : resolved
  return display.replaceAll("\\", "/")
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

// Boots the split-footer renderer and constructs the RunFooter.
//
// The renderer starts in split-footer mode with captured stdout so that
// scrollback commits and footer repaints happen in the same frame. After
// the entry splash, RunFooter takes over the footer region.
export function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  const source = resolveInteractiveStdin()
  let unregisterKeymap: (() => void) | undefined
  let closed = false
  let sigintRegistered = false
  let footer: RunFooter

  // Create minimal footer reference immediately for the close function
  const minimalFooter = {
    idle: () => Promise.resolve(),
    close: () => {},
    destroy: () => {},
    currentTheme: () => RUN_THEME_FALLBACK,
    refreshTheme: () => {},
  } as unknown as RunFooter

  // Create renderer with immediate fallback background
  const renderer = createCliRenderer({
    stdin: source.stdin,
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    useKittyKeyboard: { events: process.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })

  // Set fallback background immediately to prevent black screen
  renderer.setBackgroundColor(RUN_THEME_FALLBACK.background)

  // Start theme resolution in background
  const themePromise = resolveRunTheme(renderer).catch(() => RUN_THEME_FALLBACK)
  const keymap = createDefaultOpenTuiKeymap(renderer)
  unregisterKeymap = registerOpencodeKeymap(keymap, renderer, input.tuiConfig)
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  const splash = splashInfo(input.sessionTitle, input.history)
  const meta = splashMeta({
    title: splash.title,
    session_id: input.sessionID,
  })
  const labels = footerLabels({
    agent: input.agent,
    model: input.model,
    variant: input.variant,
  })
    // Start footer initialization in background
    queueMicrotask(() => {
      import("./footer").then(({ RunFooter }) => {
        // Queue splash after footer is ready
        const wrote = queueSplash(
          renderer,
          state,
          "entry",
          entrySplash({
            ...meta,
            theme: RUN_THEME_FALLBACK.splash,
            showSession: splash.showSession,
            detail: directoryLabel(input.directory),
          }),
        )
        renderer.idle().catch(() => {})

        // Create footer with fallback theme initially
        footer = new RunFooter(renderer, {
          directory: input.directory,
          sdk: input.sdk,
          findFiles: input.findFiles,
          agents: input.agents,
          resources: input.resources,
          sessionID: input.getSessionID ?? (() => input.sessionID),
          ...labels,
          identity: input.identity,
          model: input.model,
          variant: input.variant,
          first: input.first,
          history: input.history,
          theme: RUN_THEME_FALLBACK,
          wrote,
          keymap,
          tuiConfig: input.tuiConfig,
          backgroundSubagents: input.backgroundSubagents,
          diffStyle: input.tuiConfig.diff_style ?? "auto",
          onPermissionReply: input.onPermissionReply,
          onQuestionReply: input.onQuestionReply,
          onQuestionReject: input.onQuestionReject,
          onCycleVariant: input.onCycleVariant,
          onModelSelect: input.onModelSelect,
          onVariantSelect: input.onVariantSelect,
          onInterrupt: input.onInterrupt,
          onBackground: input.onBackground,
          onEditorOpen: async ({ value }) => {
            if (closed || renderer.isDestroyed) {
              return
            }

            await renderer.idle().catch(() => {})
            const ignore = () => {}
            detachSigint()
            process.on("SIGINT", ignore)
            try {
              return await openEditor({
                value,
                cwd: input.directory,
                renderer,
                stdin: source.stdin,
              })
            } finally {
              process.off("SIGINT", ignore)
              attachSigint()
            }
          },
          onSubagentSelect: input.onSubagentSelect,
          onQueuedRemove: footer.handleQueuedRemove,
        })

        // Apply actual theme to footer in background
        themePromise.then(theme => {
          if (footer) {
            footer.refreshTheme()
          }
        }).catch(() => {})
      }).catch(() => {})
    })

    // Return lifecycle promise with minimal footer reference
    return Promise.resolve({
      footer: minimalFooter,
      refreshTheme() {
        if (footer) {
          footer.refreshTheme()
        }
      },
      onResize(fn) {
        let width = renderer.terminalWidth
        let height = renderer.terminalHeight
        const resize = () => {
          if (width === renderer.terminalWidth && height === renderer.terminalHeight) {
            return
          }

          width = renderer.terminalWidth
          height = renderer.terminalHeight
          fn()
        }
        renderer.on(CliRenderEvents.RESIZE, resize)
        return () => renderer.off(CliRenderEvents.RESIZE, resize)
      },
      async resetForReplay(next) {
        if (closed || renderer.isDestroyed || minimalFooter.isClosed) {
          throw new Error("runtime closed")
        }

        await minimalFooter.idle()
        if (closed || renderer.isDestroyed || minimalFooter.isClosed) {
          throw new Error("runtime closed")
        }

        minimalFooter.resetForReplay(true)
        renderer.resetSplitFooterForReplay({ clearSavedLines: true })
        const splash = splashInfo(next.sessionTitle ?? input.sessionTitle, next.history)
        renderer.writeToScrollback(
          entrySplash({
            ...splashMeta({
              title: splash.title,
              session_id: next.sessionID ?? input.getSessionID?.() ?? input.sessionID,
            }),
            theme: minimalFooter.currentTheme().splash,
            showSession: splash.showSession,
            detail: directoryLabel(input.directory),
          }),
        )
        renderer.requestRender()
      },
      close,
    })
      
      footer = new RunFooter(renderer, {
      directory: input.directory,
      sdk: input.sdk,
      findFiles: input.findFiles,
      agents: input.agents,
      resources: input.resources,
      sessionID: input.getSessionID ?? (() => input.sessionID),
      ...labels,
      identity: input.identity,
      model: input.model,
      variant: input.variant,
      first: input.first,
      history: input.history,
      theme: RUN_THEME_FALLBACK,
      wrote,
      keymap,
      tuiConfig: input.tuiConfig,
      backgroundSubagents: input.backgroundSubagents,
      diffStyle: input.tuiConfig.diff_style ?? "auto",
      onPermissionReply: input.onPermissionReply,
      onQuestionReply: input.onQuestionReply,
      onQuestionReject: input.onQuestionReject,
      onCycleVariant: input.onCycleVariant,
      onModelSelect: input.onModelSelect,
      onVariantSelect: input.onVariantSelect,
      onInterrupt: input.onInterrupt,
      onBackground: input.onBackground,
      onEditorOpen: async ({ value }) => {
        if (closed || renderer.isDestroyed) {
          return
        }

        await renderer.idle().catch(() => {})
        const ignore = () => {}
        detachSigint()
        process.on("SIGINT", ignore)
        try {
          return await openEditor({
            value,
            cwd: input.directory,
            renderer,
            stdin: source.stdin,
          })
        } finally {
          process.off("SIGINT", ignore)
          attachSigint()
        }
      },
      onSubagentSelect: input.onSubagentSelect,
    })

    const sigint = () => {
      if (footer) {
        footer.requestExit()
      }
    }

    const attachSigint = () => {
      if (closed || sigintRegistered) {
        return
      }

      process.on("SIGINT", sigint)
      sigintRegistered = true
    }

    const detachSigint = () => {
      if (!sigintRegistered) {
        return
      }

      process.off("SIGINT", sigint)
      sigintRegistered = false
    }

    // Start sigint handling in background
    queueMicrotask(attachSigint)
  })

  // Create a minimal footer reference immediately for the close function
  const minimalFooter = {
    idle: () => Promise.resolve(),
    close: () => {},
    destroy: () => {},
    currentTheme: () => RUN_THEME_FALLBACK,
    refreshTheme: () => {},
  } as unknown as RunFooter
  
  let footer: RunFooter = minimalFooter

    const close = async (next: {
      showExit: boolean
      sessionTitle?: string
      sessionID?: string
      history?: RunPrompt[]
    }) => {
      if (closed) {
        return
      }

      closed = true
      detachSigint()
      let wroteExit = false

      try {
        await (footer || minimalFooter).idle().catch(() => {})

        const show = renderer.isDestroyed ? false : next.showExit
        if (!renderer.isDestroyed && show) {
          const sessionID = next.sessionID || input.getSessionID?.() || input.sessionID
          const splash = splashInfo(next.sessionTitle ?? input.sessionTitle, next.history ?? input.history)
          wroteExit = queueSplash(
            renderer,
            state,
            "exit",
            exitSplash({
              ...splashMeta({
                title: splash.title,
                session_id: sessionID,
              }),
              theme: (footer || minimalFooter).currentTheme().splash,
            }),
          )
          await renderer.idle().catch(() => {})
        }
      } finally {
        if (footer) {
          footer.close()
          await footer.idle().catch(() => {})
          footer.destroy()
        }
        unregisterKeymap?.()
        shutdown(renderer)
        if (!wroteExit) {
          process.stdout.write("\n")
        }
        source.cleanup?.()
      }
    }

    return {
      footer,
      refreshTheme() {
        footer.refreshTheme()
      },
      onResize(fn) {
        let width = renderer.terminalWidth
        let height = renderer.terminalHeight
        const resize = () => {
          if (width === renderer.terminalWidth && height === renderer.terminalHeight) {
            return
          }

          width = renderer.terminalWidth
          height = renderer.terminalHeight
          fn()
        }
        renderer.on(CliRenderEvents.RESIZE, resize)
        return () => renderer.off(CliRenderEvents.RESIZE, resize)
      },
      async resetForReplay(next) {
        if (closed || renderer.isDestroyed || footer.isClosed) {
          throw new Error("runtime closed")
        }

        await footer.idle()
        if (closed || renderer.isDestroyed || footer.isClosed) {
          throw new Error("runtime closed")
        }

        footer.resetForReplay(true)
        renderer.resetSplitFooterForReplay({ clearSavedLines: true })
        const splash = splashInfo(next.sessionTitle ?? input.sessionTitle, next.history)
        renderer.writeToScrollback(
          entrySplash({
            ...splashMeta({
              title: splash.title,
              session_id: next.sessionID ?? input.getSessionID?.() ?? input.sessionID,
            }),
            theme: footer.currentTheme().splash,
            showSession: splash.showSession,
            detail: directoryLabel(input.directory),
          }),
        )
        renderer.requestRender()
      },
      close,
    }
    } catch (error) {
      // Cleanup in background
      queueMicrotask(() => {
        unregisterKeymap?.()
        source.cleanup?.()
      })
      throw error
    }
  }
