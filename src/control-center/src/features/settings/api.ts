import {
  settingsEnvelopeSchema,
  settingsPatchRequestSchema,
  settingsPatchResponseSchema,
} from '../../../../shared/browser-contracts.ts'
import type * as v from 'valibot'

import type { ApiClient } from '../../api/client.ts'
import { cloneSettings, defaultSettings } from '../../lib/defaults.ts'
import type { ControlCenterSettings } from '../../../../shared/openpet-contracts.ts'

export type SettingsSnapshot = v.InferOutput<typeof settingsEnvelopeSchema>
export type SettingsPatch = v.InferOutput<typeof settingsPatchRequestSchema>

export function shouldAcceptSettingsSnapshot({ requestSequence, latestRequestSequence, snapshotVersion, acceptedVersion }: {
  requestSequence: number
  latestRequestSequence: number
  snapshotVersion: number
  acceptedVersion: number
}) {
  return requestSequence === latestRequestSequence
    && Number.isInteger(snapshotVersion)
    && snapshotVersion >= acceptedVersion
}

type SettingsApi = {
  get: () => Promise<SettingsSnapshot>
  patch: (body: SettingsPatch) => Promise<v.InferOutput<typeof settingsPatchResponseSchema>>
}

const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const equal = (left: unknown, right: unknown) => {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return Object.is(left, right) }
}

/** Convert the backend's host-shaped values into the pre-existing pane model. */
export function settingsEnvelopeToViewModel(envelope: SettingsSnapshot, runtimeStatus?: Partial<ControlCenterSettings['systemCursorStatus']>): ControlCenterSettings {
  const values = envelope.values as Record<string, any>
  const behavior = values.petBehavior && typeof values.petBehavior === 'object' ? values.petBehavior : {}
  const home = behavior.home && typeof behavior.home === 'object' ? behavior.home : {}
  const next = cloneSettings({
    ...defaultSettings,
    ...values,
    grounded: Boolean(behavior.grounded),
    home: {
      ...defaultSettings.home,
      enabled: Boolean(home.enabled),
      radius: home.radius || defaultSettings.home.radius,
      hasAnchor: Boolean(home.anchor),
    },
    petBubbleChat: { ...defaultSettings.petBubbleChat, ...(values.petBubbleChat || {}) },
    systemCursorStatus: { ...defaultSettings.systemCursorStatus, ...(runtimeStatus || {}) },
  })
  return next
}

const canonicalValues = (settings: Partial<ControlCenterSettings>) => {
  const result: Record<string, unknown> = {}
  const direct = ['scale', 'walkSpeed', 'walkDuration', 'bubbleDuration', 'menuPosition', 'autoStart',
    'selectedCursorId', 'customCursor', 'customCursors', 'hiddenCursorIds', 'customCursorScope'] as const
  for (const key of direct) if (has(settings, key)) result[key] = settings[key]
  if (has(settings, 'grounded')) result['petBehavior.grounded'] = settings.grounded
  if (settings.home && has(settings.home, 'enabled')) result['petBehavior.home.enabled'] = settings.home.enabled
  if (settings.home && has(settings.home, 'radius')) result['petBehavior.home.radius'] = settings.home.radius
  if (settings.petBubbleChat) {
    for (const key of ['enabled', 'autoPopup', 'autoHide', 'pinOnInteraction'] as const) {
      if (has(settings.petBubbleChat, key)) result[`petBubbleChat.${key}`] = settings.petBubbleChat[key]
    }
  }
  return result
}

/** Return only canonical persisted paths; derived home.hasAnchor and runtime status are excluded. */
export function createCanonicalSettingsPatch(previous: Partial<ControlCenterSettings>, next: Partial<ControlCenterSettings>) {
  const before = canonicalValues(previous)
  const after = canonicalValues(next)
  return Object.fromEntries(Object.entries(after).filter(([path, value]) => !equal(before[path], value)))
}

export function applyCanonicalSettingsPatch(values: Record<string, unknown>, patch: Record<string, unknown>) {
  const next = structuredClone(values)
  for (const [path, value] of Object.entries(patch)) {
    const segments = path.split('.')
    let target = next as Record<string, any>
    for (const segment of segments.slice(0, -1)) {
      if (!target[segment] || typeof target[segment] !== 'object' || Array.isArray(target[segment])) target[segment] = {}
      target = target[segment]
    }
    target[segments.at(-1) as string] = structuredClone(value)
  }
  return next
}

// The browser-only Vite demo has no Electron preload bridge. Keep a tiny
// in-memory HTTP-shaped adapter for that development surface so the pane
// exercises the same envelope/point-path code as the packaged app without
// restoring a renderer-to-Shell settings IPC API.
const demoStorageKey = 'openpet.controlCenter.demoState'
const readDemoSettings = (): Partial<ControlCenterSettings> => {
  if (typeof window === 'undefined') return defaultSettings
  try {
    const state = JSON.parse(window.sessionStorage.getItem(demoStorageKey) || '{}')
    return state?.settings && typeof state.settings === 'object' ? state.settings : defaultSettings
  } catch {
    return defaultSettings
  }
}

const settingsViewToBackendValues = (settings: Partial<ControlCenterSettings>) => ({
  scale: settings.scale,
  walkSpeed: settings.walkSpeed,
  walkDuration: settings.walkDuration,
  bubbleDuration: settings.bubbleDuration,
  menuPosition: settings.menuPosition,
  autoStart: settings.autoStart,
  selectedCursorId: settings.selectedCursorId,
  customCursor: structuredClone(settings.customCursor),
  customCursors: structuredClone(settings.customCursors),
  hiddenCursorIds: structuredClone(settings.hiddenCursorIds),
  customCursorScope: settings.customCursorScope,
  petBehavior: {
    grounded: settings.grounded,
    home: { enabled: settings.home?.enabled, radius: settings.home?.radius, anchor: settings.home?.hasAnchor ? { x: 0, y: 0 } : null },
  },
  petBubbleChat: structuredClone(settings.petBubbleChat),
})

const persistDemoSettings = (values: Record<string, unknown>) => {
  if (typeof window === 'undefined') return
  try {
    const state = JSON.parse(window.sessionStorage.getItem(demoStorageKey) || '{}')
    state.settings = settingsEnvelopeToViewModel({ version: 0, values } as SettingsSnapshot)
    window.sessionStorage.setItem(demoStorageKey, JSON.stringify(state))
  } catch {
    // Development fixtures must remain usable even when session storage is unavailable.
  }
}

const initialDemoSettings = readDemoSettings()
let demoSettingsSnapshot: SettingsSnapshot = {
  version: 0,
  values: settingsViewToBackendValues(initialDemoSettings),
}

const demoSettingsApi: SettingsApi = {
  async get() {
    return structuredClone(demoSettingsSnapshot)
  },
  async patch(body) {
    const nextValues = applyCanonicalSettingsPatch(demoSettingsSnapshot.values, body.patch)
    const changedPaths = Object.entries(body.patch)
      .filter(([path, value]) => !equal(getPathValue(demoSettingsSnapshot.values, path), value))
      .map(([path]) => path)
    if (changedPaths.length > 0) {
      demoSettingsSnapshot = { version: demoSettingsSnapshot.version + 1, values: nextValues }
      persistDemoSettings(nextValues)
    }
    return {
      version: demoSettingsSnapshot.version,
      changedPaths,
      snapshot: structuredClone(demoSettingsSnapshot.values),
    }
  },
}

function getPathValue(value: Record<string, unknown>, path: string) {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export async function saveSettingsWithRetry({ api, base, previousView, nextView }: {
  api: { get: () => Promise<SettingsSnapshot>; patch: (body: SettingsPatch) => Promise<v.InferOutput<typeof settingsPatchResponseSchema>> }
  base: SettingsSnapshot
  previousView: Partial<ControlCenterSettings>
  nextView: Partial<ControlCenterSettings>
}) {
  const patch = createCanonicalSettingsPatch(previousView, nextView)
  let envelope = base
  try {
    const result = await api.patch({ ifVersion: envelope.version, patch })
    return { ...result, snapshot: envelope }
  } catch (error) {
    const conflict = (error as { code?: string; status?: number } | null)
    if (conflict?.code !== 'CONFLICT' && conflict?.status !== 409) throw error
    envelope = await api.get()
    const result = await api.patch({ ifVersion: envelope.version, patch })
    return { ...result, snapshot: envelope }
  }
}

export function createSettingsApi(client: ApiClient, fallback: SettingsApi = demoSettingsApi) {
  const useDemoFallback = () => Boolean(import.meta.env?.DEV && !(globalThis as { openpetBackend?: unknown }).openpetBackend)
  return {
    get(): Promise<SettingsSnapshot> {
      if (useDemoFallback()) return fallback.get()
      return client.request({
        method: 'GET',
        path: '/settings',
        responseSchema: settingsEnvelopeSchema,
      })
    },
    patch(body: SettingsPatch): Promise<v.InferOutput<typeof settingsPatchResponseSchema>> {
      if (useDemoFallback()) return fallback.patch(body)
      return client.request({
        method: 'PATCH',
        path: '/settings',
        requestSchema: settingsPatchRequestSchema,
        responseSchema: settingsPatchResponseSchema,
        body,
      })
    },
  }
}
