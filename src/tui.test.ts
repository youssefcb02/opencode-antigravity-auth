import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import TuiModule, { AntigravityTuiPlugin, antigravityLegacyTui, formatAccountQuota } from "./tui.ts"
import { loadAccounts, updateAccounts, type AccountStorageV4 } from "./plugin/storage.ts"

vi.mock("./plugin/storage.ts", async (original) => ({
  ...await original<typeof import("./plugin/storage.ts")>(),
  loadAccounts: vi.fn(),
  updateAccounts: vi.fn(),
}))

async function host(actions: Array<string | undefined>, confirmed = false, overrides: Record<string, unknown> = {}) {
  let layer: KeymapLayer | undefined
  const account = { id: "account-id", email: "saved@example.test", enabled: true, current: true, verificationRequired: false, lastUsed: 1, connectionIDs: ["native-credential"], ...overrides }
  const rpc = {
    list: vi.fn(async () => [account]), connections: vi.fn(async () => ({ ids: ["native-credential"] })), quotas: vi.fn(async () => ({ report: "Antigravity claude: 84% remaining; resets tomorrow", accounts: [{ id: account.id, email: account.email, disabled: false, report: "Antigravity claude: 84% remaining; resets tomorrow" }] })),
    update: vi.fn(async () => ({ message: "Account updated" })), models: vi.fn(async () => ({ count: 12 })),
  }
  const select = vi.fn(async (_options: { title: string; options: Array<{ title: string; value: string }> }) => actions.shift())
  const alert = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const ctx = {
    client: { rpc: () => rpc, credential: { remove }, integration: { oauth: {
      connect: vi.fn(async () => ({ data: { attemptID: "attempt", url: "https://accounts.google.com", instructions: "Sign in" } })),
      complete: vi.fn(async () => undefined), cancel,
    } } },
    location: { directory: "/tmp/menu-test" },
    ui: { dialog: { select, alert, confirm: async () => confirmed, prompt: async () => undefined }, toast: { show: vi.fn() } },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
  } as unknown as Plugin.Context
  await AntigravityTuiPlugin.setup(ctx)
  const command = layer?.commands?.[0]
  if (!command) throw new Error("Account menu command was not registered")
  await command.run()
  return { command, rpc, select, alert, remove, cancel }
}

describe("Antigravity native menu", () => {
  it("opens from /antigravity, lists saved accounts, and displays quotas", async () => {
    const result = await host(["quotas", undefined])
    expect(result.command.slash).toEqual({ name: "antigravity", aliases: ["ag"] })
    expect(result.select.mock.calls[0]?.[0].options).toContainEqual(expect.objectContaining({ title: "saved@example.test [current]" }))
    expect(result.rpc.list).toHaveBeenCalledTimes(2)
    expect(result.rpc.quotas).toHaveBeenCalledOnce()
    expect(result.alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("84% remaining") }))
  })

  it("requires confirmation before deleting an account or its native connection", async () => {
    const cancelled = await host(["manage", "account-id", "delete", undefined])
    expect(cancelled.remove).not.toHaveBeenCalled()
    expect(cancelled.rpc.update).not.toHaveBeenCalled()
    const confirmed = await host(["manage", "account-id", "delete", undefined], true)
    expect(confirmed.remove).toHaveBeenCalledWith({ credentialID: "native-credential" })
    expect(confirmed.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "delete" }, expect.any(Object))
    expect(confirmed.remove.mock.invocationCallOrder[0]).toBeLessThan(confirmed.rpc.update.mock.invocationCallOrder[0]!)
  })

  it("cancels the OAuth attempt when the account dialog is dismissed", async () => {
    const result = await host(["add", undefined])
    expect(result.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: "attempt" }))
  })

  it("shows cached quota beside each account", async () => {
    const result = await host([undefined], false, { quota: { remainingFraction: 1 } })
    expect(result.select.mock.calls[0]?.[0].options).toContainEqual(expect.objectContaining({ value: "account-id", description: "100%" }))
    expect(result.rpc.quotas).not.toHaveBeenCalled()
  })

  it("switches to a picked account in one step and closes the menu", async () => {
    const result = await host(["account-id"], false, { current: false })
    expect(result.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "select" }, expect.any(Object))
    expect(result.select).toHaveBeenCalledOnce()
  })

  it("closes without switching when the current account is picked", async () => {
    const result = await host(["account-id"])
    expect(result.rpc.update).not.toHaveBeenCalled()
    expect(result.select).toHaveBeenCalledOnce()
  })
})

type Shown = { kind: "select" | "alert"; props: { title: string; message?: string; options?: Array<{ title: string; value: unknown; description?: string; disabled?: boolean }>; onSelect?: (option: { value: unknown }) => void } }

async function legacyHost() {
  const storage: AccountStorageV4 = {
    version: 4,
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
    accounts: [
      { id: "first", email: "first@example.test", refreshToken: "r1", addedAt: 1, lastUsed: 1, cachedQuota: { claude: { remainingFraction: 0.814, resetTime: "2999-01-01T00:00:00Z", modelCount: 1 } } },
      { id: "second", email: "second@example.test", refreshToken: "r2", addedAt: 2, lastUsed: 2 },
    ],
  }
  vi.mocked(loadAccounts).mockImplementation(async () => storage)
  vi.mocked(updateAccounts).mockImplementation(async (update) => { update(storage); return storage })
  let command: { slashName: string; slashAliases: string[]; run: () => void } | undefined
  let shown: Shown | undefined
  const dispose = vi.fn(async () => undefined)
  const toast = vi.fn()
  const clear = vi.fn()
  await antigravityLegacyTui({
    client: { instance: { dispose } },
    keymap: { registerLayer: (layer) => { command = layer.commands[0] } },
    ui: {
      DialogSelect: (props) => ({ kind: "select", props }),
      DialogAlert: (props) => ({ kind: "alert", props }),
      dialog: { replace: (render) => { shown = render() as Shown }, clear },
      toast,
    },
  })
  if (!command) throw new Error("Account menu command was not registered")
  const open = async () => {
    command!.run()
    await vi.waitFor(() => expect(shown?.props.title).toBe("Google accounts (Antigravity)"))
  }
  const pick = (value: unknown) => shown!.props.onSelect!({ value })
  return { command, storage, dispose, toast, clear, open, pick, shown: () => shown }
}

describe("Antigravity OpenCode 1.x menu", () => {
  it("is exported beside the OpenCode 2 setup", () => {
    expect(TuiModule.id).toBe("opencode-antigravity-auth")
    expect(TuiModule.setup).toBe(AntigravityTuiPlugin.setup)
    expect(TuiModule.tui).toBe(antigravityLegacyTui)
  })

  it("opens from /antigravity and lists accounts with cached quota", async () => {
    const host = await legacyHost()
    expect(host.command.slashName).toBe("antigravity")
    expect(host.command.slashAliases).toEqual(["ag"])
    await host.open()
    const options = host.shown()!.props.options!
    expect(options.map(option => option.title)).toEqual(expect.arrayContaining(["Add account", "Manage an account…", "first@example.test [current]", "second@example.test"]))
    expect(options).toContainEqual(expect.objectContaining({ value: 0, description: expect.stringMatching(/^81% · resets in /) }))
    expect(options).toContainEqual(expect.objectContaining({ value: 1, description: "no quota data" }))
  })

  it("switches to a picked account around two instance reloads", async () => {
    const host = await legacyHost()
    await host.open()
    host.pick(1)
    await vi.waitFor(() => expect(host.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Switched to second@example.test" })))
    expect(host.clear).toHaveBeenCalled()
    expect(host.dispose).toHaveBeenCalledTimes(2)
    expect(host.storage.activeIndex).toBe(1)
    expect(host.storage.activeIndexByFamily).toEqual({ claude: 1, gemini: 1 })
  })

  it("closes without reloading when the current account is picked", async () => {
    const host = await legacyHost()
    await host.open()
    host.pick(0)
    expect(host.clear).toHaveBeenCalled()
    expect(host.dispose).not.toHaveBeenCalled()
  })

  it("disabling the current account moves the selection to an enabled one", async () => {
    const host = await legacyHost()
    await host.open()
    host.pick("manage")
    host.pick(0)
    expect(host.shown()!.props.options).toContainEqual(expect.objectContaining({ value: "select", disabled: true }))
    host.pick("disable")
    await vi.waitFor(() => expect(host.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Disabled first@example.test" })))
    expect(host.storage.accounts[0]!.enabled).toBe(false)
    expect(host.storage.activeIndex).toBe(1)
  })

  it("explains how to add an account with the 1.x CLI", async () => {
    const host = await legacyHost()
    await host.open()
    host.pick("add")
    expect(host.shown()).toEqual(expect.objectContaining({ kind: "alert", props: expect.objectContaining({ message: expect.stringContaining("opencode auth login google") }) }))
  })
})

describe("formatAccountQuota", () => {
  const now = Date.parse("2026-10-24T00:00:00Z")

  it("shows the percentage and time until reset", () => {
    expect(formatAccountQuota({ remainingFraction: 0.814, resetTime: "2026-10-24T02:54:00Z" }, now)).toBe("81% · resets in 2h 54m")
    expect(formatAccountQuota({ remainingFraction: 0.79, resetTime: "2026-10-30T21:10:00Z" }, now)).toBe("79% · resets in 6d 21h")
    expect(formatAccountQuota({ remainingFraction: 0.5, resetTime: "2026-10-24T00:07:00Z" }, now)).toBe("50% · resets in 7m")
  })

  it("omits the reset for a full or undated quota and reports missing data", () => {
    expect(formatAccountQuota({ remainingFraction: 1, resetTime: "2026-10-30T21:10:00Z" }, now)).toBe("100%")
    expect(formatAccountQuota({ remainingFraction: 0.4 }, now)).toBe("40%")
    expect(formatAccountQuota(undefined, now)).toBe("no quota data")
  })

  it("drops the countdown once the cached reset time has passed", () => {
    expect(formatAccountQuota({ remainingFraction: 0.3, resetTime: "2026-10-23T23:00:00Z" }, now)).toBe("30%")
    expect(formatAccountQuota({ remainingFraction: 0.3, resetTime: "2026-10-24T00:00:20Z" }, now)).toBe("30% · resets in 1m")
  })
})
