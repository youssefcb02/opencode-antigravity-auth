import type { Plugin } from "@opencode/plugin/tui"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { AntigravityAccountsRpc, type AccountQuota, type AccountSummary } from "./plugin/account-rpc.ts"
import { lowestCachedQuota } from "./plugin/account-management.ts"
import { loadAccounts, updateAccounts, type AccountMetadataV3, type AccountStorageV4 } from "./plugin/storage.ts"

/** Formats cached quota for the account list, e.g. "81% · resets in 2h 54m". */
export function formatAccountQuota(quota: AccountQuota | undefined, now = Date.now()) {
  if (!quota) return "no quota data"
  const percent = `${Math.round(quota.remainingFraction * 100)}%`
  const reset = quota.resetTime ? Date.parse(quota.resetTime) : Number.NaN
  // A full quota has nothing to reset, and an elapsed reset has no countdown left.
  if (quota.remainingFraction >= 1 || Number.isNaN(reset) || reset <= now) return percent
  const minutes = Math.max(1, Math.round((reset - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const until = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return `${percent} · resets in ${until}`
}

const accountTitle = (account: Pick<AccountSummary, "email" | "current" | "enabled" | "verificationRequired">) =>
  `${account.email}${account.current ? " [current]" : ""}${account.enabled ? "" : " [disabled]"}${account.verificationRequired ? " [needs verification]" : ""}`

// This plugin uses host dialogs and renders no JSX. Keep its public declarations
// independent of the SDK's optional Solid/OpenTUI rendering dependencies.
interface AccountMenuContext {
  readonly client: OpenCodeClient
  readonly location: LocationRef | undefined
  readonly data: { readonly location: { default(): LocationRef } }
  readonly ui: {
    readonly dialog: {
      prompt(options: { title: string; description?: string }): Promise<string | undefined>
      alert(options: { title: string; message: string }): Promise<void>
      confirm(options: { title: string; message: string }): Promise<boolean | undefined>
      select<Value>(options: { title: string; options: ReadonlyArray<{ title: string; value: Value; description?: string; category?: string; disabled?: boolean }> }): Promise<Value | undefined>
    }
    readonly toast: { show(options: { message: string; variant: "info" | "success" }): void }
  }
  readonly keymap: {
    layer(factory: () => { mode: "global"; commands: ReadonlyArray<{
      id: string; title: string; group: string; palette: true
      slash: { name: string; aliases: string[] }; run: () => Promise<void>
    }> }): void
  }
}

export const AntigravityTuiPlugin = {
  id: "opencode-antigravity-auth",
  setup(ctx: AccountMenuContext) {
    const rpc = ctx.client.rpc(AntigravityAccountsRpc)
    const location = () => ({ location: ctx.location ?? ctx.data.location.default() })

    async function login() {
      const { data: attempt } = await ctx.client.integration.oauth.connect({
        integrationID: "google", methodID: "antigravity", answer: { manual: true }, ...location(),
      })
      let completed = false
      try {
        const code = await ctx.ui.dialog.prompt({ title: "Connect Google (Antigravity)", description: `${attempt.instructions}\n\n${attempt.url}` })
        if (!code?.trim()) return
        await ctx.client.integration.oauth.complete({ integrationID: "google", attemptID: attempt.attemptID, code: code.trim(), ...location() })
        completed = true
        await rpc.models({}, location())
        ctx.ui.toast.show({ message: "Google account connected", variant: "success" })
      } finally {
        if (!completed) await ctx.client.integration.oauth.cancel({ integrationID: "google", attemptID: attempt.attemptID, ...location() })
      }
    }

    async function quotas(id?: string) {
      ctx.ui.toast.show({ message: "Checking account access and quotas…", variant: "info" })
      const result = await rpc.quotas(id ? { id } : {}, location())
      const reports = result.accounts.filter(account => id || !account.disabled)
      if (reports.length <= 1) {
        await ctx.ui.dialog.alert({ title: "Antigravity quotas", message: reports[0]?.report ?? result.report })
        return
      }
      while (true) {
        const selected = await ctx.ui.dialog.select({
          title: "Antigravity quotas",
          options: reports.map(account => ({ title: account.email, value: account.id, description: account.report.split("\n").slice(1, 4).join("; ") })),
        })
        const report = reports.find(account => account.id === selected)
        if (!report) return
        await ctx.ui.dialog.alert({ title: report.email, message: report.report })
      }
    }

    async function accountMenu(account: AccountSummary) {
      const action = await ctx.ui.dialog.select({
        title: account.email,
        options: [
          { title: "Check quotas / verify access", value: "verify" },
          { title: "Use this account", value: "select", disabled: !account.enabled },
          { title: account.enabled ? "Disable account" : "Enable account", value: account.enabled ? "disable" : "enable" },
          { title: "Re-authenticate / refresh token", value: "login" },
          { title: "Delete this account", value: "delete" },
          { title: "Back", value: "back" },
        ],
      })
      if (!action || action === "back") return
      if (action === "verify") return quotas(account.id)
      if (action === "login") return login()
      if (action === "delete") {
        if (!await ctx.ui.dialog.confirm({ title: "Delete account?", message: `Remove ${account.email} from OpenCode and the Antigravity account pool?` })) return
        const { ids } = await rpc.connections({ id: account.id }, location())
        for (const credentialID of ids) await ctx.client.credential.remove({ credentialID })
      }
      if (action !== "enable" && action !== "disable" && action !== "select" && action !== "delete") return
      const result = await rpc.update({ id: account.id, action }, location())
      ctx.ui.toast.show({ message: result.message, variant: "success" })
    }

    async function manage(accounts: ReadonlyArray<AccountSummary>) {
      const selected = await ctx.ui.dialog.select({
        title: "Manage account",
        options: accounts.map(account => ({ title: accountTitle(account), value: account.id })),
      })
      const account = accounts.find(item => item.id === selected)
      if (account) await accountMenu(account)
    }

    async function menu() {
      try {
        while (true) {
          const accounts = await rpc.list({}, location())
          const action = await ctx.ui.dialog.select({
            title: "Google accounts (Antigravity)",
            options: [
              { title: "Add account", value: "add", category: "Actions" },
              { title: "Check quotas / verify enabled accounts", value: "quotas", category: "Actions" },
              { title: "Refresh available models", value: "models", category: "Actions" },
              { title: "Manage an account…", value: "manage", category: "Actions" },
              ...accounts.map(account => ({
                title: accountTitle(account),
                value: account.id,
                description: formatAccountQuota(account.quota),
                category: "Accounts",
                disabled: !account.enabled,
              })),
              { title: "Close", value: "close", category: "Actions" },
            ],
          })
          if (!action || action === "close") return
          if (action === "add") await login()
          else if (action === "quotas") await quotas()
          else if (action === "models") {
            const { count } = await rpc.models({}, location())
            ctx.ui.toast.show({ message: `${count} available models loaded`, variant: "success" })
          } else if (action === "manage") await manage(accounts)
          else {
            // Picking an account switches to it, like the model picker.
            const account = accounts.find(item => item.id === action)
            if (!account?.enabled) continue
            if (!account.current) {
              const result = await rpc.update({ id: account.id, action: "select" }, location())
              ctx.ui.toast.show({ message: `${result.message}: ${account.email}`, variant: "success" })
            }
            return
          }
        }
      } catch (error) {
        await ctx.ui.dialog.alert({ title: "Antigravity", message: error instanceof Error ? error.message : String(error) })
      }
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "antigravity.accounts", title: "Antigravity accounts and quotas", group: "Antigravity",
        palette: true, slash: { name: "antigravity", aliases: ["ag"] }, run: menu,
      }],
    }))
  },
} satisfies Plugin.Definition

// OpenCode 1.x loads TUI plugins through `tui(api)` and has no account RPC, so this
// menu reads and writes the account file directly with the host's 1.x dialogs.
interface LegacyTuiApi {
  readonly client: { readonly instance: { dispose(): Promise<unknown> } }
  readonly keymap: {
    registerLayer(layer: { commands: ReadonlyArray<{
      name: string; title: string; desc: string; category: string; namespace: "palette"
      slashName: string; slashAliases: string[]; run: () => void
    }> }): unknown
  }
  readonly ui: {
    DialogSelect<Value>(props: {
      title: string; current?: Value
      options: Array<{ title: string; value: Value; description?: string; category?: string; disabled?: boolean }>
      onSelect?: (option: { value: Value }) => void
    }): unknown
    DialogAlert(props: { title: string; message: string; onConfirm?: () => void }): unknown
    readonly dialog: { replace(render: () => unknown): void; clear(): void }
    toast(input: { message: string; variant?: "info" | "success" | "error" }): void
  }
}

const LEGACY_LOGIN_HINT = "Run `opencode auth login google` in a terminal and choose \"OAuth with Google (Antigravity)\", then restart OpenCode."

const activeAccountIndex = (storage: AccountStorageV4) => storage.activeIndexByFamily?.claude ?? storage.activeIndex
const sameAccount = (a: AccountMetadataV3, b: AccountMetadataV3) => a.id && b.id ? a.id === b.id : a.refreshToken === b.refreshToken

function selectAccount(storage: AccountStorageV4, index: number) {
  storage.activeIndex = index
  storage.activeIndexByFamily = { ...storage.activeIndexByFamily, claude: index, gemini: index }
}

const legacyTitle = (account: AccountMetadataV3, current: boolean) => accountTitle({
  email: account.email ?? "(no email)", current, enabled: account.enabled !== false, verificationRequired: account.verificationRequired === true,
})

export async function antigravityLegacyTui(api: LegacyTuiApi) {
  const alert = (title: string, message: string) =>
    api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message, onConfirm: () => api.ui.dialog.clear() }))
  const fail = (error: unknown) => alert("Antigravity", error instanceof Error ? error.message : String(error))

  // The 1.x server plugin keeps the active account in memory and writes it back on
  // save. The first reload flushes that manager; writing again after the second
  // reload makes sure the file holds this change when the provider reloads from it.
  async function commit(target: AccountMetadataV3, change: (storage: AccountStorageV4, index: number) => void) {
    const apply = (storage: AccountStorageV4) => {
      const index = storage.accounts.findIndex(account => sameAccount(account, target))
      if (index < 0) throw new Error(`${target.email ?? "Account"} is no longer saved`)
      change(storage, index)
    }
    await api.client.instance.dispose()
    await updateAccounts(apply)
    await api.client.instance.dispose()
    await updateAccounts(apply)
  }

  async function use(account: AccountMetadataV3) {
    await commit(account, selectAccount)
    api.ui.toast({ message: `Switched to ${account.email ?? "account"}`, variant: "success" })
  }

  async function setEnabled(account: AccountMetadataV3, enabled: boolean) {
    await commit(account, (storage, index) => {
      storage.accounts[index]!.enabled = enabled
      if (enabled || activeAccountIndex(storage) !== index) return
      // A disabled account can't stay active; move to the next enabled one.
      const next = storage.accounts.findIndex((item, i) => i !== index && item.enabled !== false)
      if (next >= 0) selectAccount(storage, next)
    })
    api.ui.toast({ message: `${enabled ? "Enabled" : "Disabled"} ${account.email ?? "account"}`, variant: "success" })
  }

  function accountMenu(account: AccountMetadataV3, current: boolean) {
    const enabled = account.enabled !== false
    api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
      title: account.email ?? "Account",
      options: [
        { title: "Use this account", value: "select", disabled: !enabled || current },
        { title: enabled ? "Disable account" : "Enable account", value: enabled ? "disable" : "enable" },
        { title: "Re-authenticate / refresh token", value: "login" },
        { title: "Back", value: "back" },
      ],
      onSelect: ({ value }) => {
        if (value === "back") return void menu()
        if (value === "login") return alert("Re-authenticate", LEGACY_LOGIN_HINT)
        api.ui.dialog.clear()
        const done = value === "select" ? use(account) : setEnabled(account, value === "enable")
        done.catch(fail)
      },
    }))
  }

  function manage(storage: AccountStorageV4) {
    const current = activeAccountIndex(storage)
    api.ui.dialog.replace(() => api.ui.DialogSelect<number>({
      title: "Manage account",
      options: storage.accounts.map((account, index) => ({ title: legacyTitle(account, index === current), value: index })),
      onSelect: ({ value }) => accountMenu(storage.accounts[value]!, value === current),
    }))
  }

  async function menu() {
    let storage: AccountStorageV4 | null
    try {
      storage = await loadAccounts()
    } catch (error) {
      return fail(error)
    }
    const accounts = storage?.accounts ?? []
    const current = storage ? activeAccountIndex(storage) : -1
    api.ui.dialog.replace(() => api.ui.DialogSelect<string | number>({
      title: "Google accounts (Antigravity)",
      current,
      options: [
        { title: "Add account", value: "add", category: "Actions" },
        { title: "Manage an account…", value: "manage", category: "Actions", disabled: accounts.length === 0 },
        ...accounts.map((account, index) => ({
          title: legacyTitle(account, index === current),
          value: index,
          description: formatAccountQuota(lowestCachedQuota(account)),
          category: "Accounts",
          disabled: account.enabled === false,
        })),
        { title: "Close", value: "close", category: "Actions" },
      ],
      onSelect: ({ value }) => {
        if (value === "add") return alert("Add account", LEGACY_LOGIN_HINT)
        if (value === "manage") return storage && manage(storage)
        api.ui.dialog.clear()
        // Picking an account switches to it, like the model picker.
        const account = typeof value === "number" ? accounts[value] : undefined
        if (account && account.enabled !== false && value !== current) use(account).catch(fail)
      },
    }))
  }

  api.keymap.registerLayer({
    commands: [{
      name: "antigravity.accounts", title: "Antigravity accounts and quotas", desc: "Switch and manage Antigravity accounts",
      category: "Antigravity", namespace: "palette", slashName: "antigravity", slashAliases: ["ag"],
      run: () => void menu(),
    }],
  })
}

// One export serves both hosts: OpenCode 2 calls `setup`, OpenCode 1.x calls `tui`.
export default { ...AntigravityTuiPlugin, tui: antigravityLegacyTui }
