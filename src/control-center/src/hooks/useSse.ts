import { useEffect, useState } from 'react'
import { createParser } from 'eventsource-parser'
import { queryClient } from '../app/queryClient.ts'
import {
  EVENT_TOPIC,
  EVENT_NAMES,
  SSE_RECONNECT_AFTER_SILENCE_MS,
  SSE_RECONNECT_BACKOFF_MS,
  SSE_TOPICS,
  type EventName,
  type SseTopic,
} from '../../../shared/browser-contracts.ts'

export type SseState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unavailable'
export type SseEvent = { id: string | null; event: string; topic: SseTopic; data: unknown }
export type BackendInfo = { baseUrl: string; sessionToken: string }
export type SseRuntime = {
  getBackend: () => BackendInfo | null
  fetchImpl?: typeof fetch
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

type BackendBridge = {
  getBackend: () => BackendInfo | null
  onChanged?: (listener: (backend: BackendInfo | null) => void) => () => void
}

function backendBridge(): BackendBridge | null {
  return (globalThis as { openpetBackend?: BackendBridge }).openpetBackend || null
}

const defaultRuntime: SseRuntime = {
  getBackend: () => {
    const backend = backendBridge()?.getBackend?.() || null
    return backend?.baseUrl && backend.sessionToken ? backend : null
  },
}

function uniqueTopics(topics: string[]): SseTopic[] {
  const allowed = new Set<string>(SSE_TOPICS)
  return Array.from(new Set([...topics, 'system'])).filter((topic): topic is SseTopic => allowed.has(topic))
}

function parseData(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

function parseEvent(id: string | undefined, event: string = 'message', raw: string): SseEvent | null {
  if (!raw || event === 'message') return null
  const data = parseData(raw)
  const known = (EVENT_NAMES as readonly string[]).includes(event)
  const topic = known ? EVENT_TOPIC[event as EventName] : (data as { topic?: SseTopic })?.topic
  if (!(SSE_TOPICS as readonly string[]).includes(topic as string)) return null
  return { id: id ?? null, event, topic: topic as SseTopic, data }
}

const RECONNECT = 'subscription-or-backend-changed'

class SseManager {
  private runtime: SseRuntime = defaultRuntime
  private listeners = new Map<number, { topics: SseTopic[]; onEvent: (event: SseEvent) => void; onState: (state: SseState) => void }>()
  private nextListener = 1
  private state: SseState = 'idle'
  private lastEventId: string | null = null
  private running = false
  private enabled = false
  private controller: AbortController | null = null
  private wakeDelay: (() => void) | null = null
  private retryIndex = 0
  private topicsKey = 'system'

  constructor() {
    backendBridge()?.onChanged?.(() => {
      this.retryIndex = 0
      this.reconnect()
    })
  }

  configure(runtime: Partial<SseRuntime>) {
    this.runtime = { ...this.runtime, ...runtime }
    // A renderer can subscribe before the preload bridge has delivered the
    // backend. Wake an in-flight unavailable/backoff loop as soon as the
    // runtime becomes available instead of waiting for the next retry.
    if (this.enabled && this.listeners.size > 0) {
      this.retryIndex = 0
      this.reconnect()
    }
  }
  snapshot() { return { state: this.state, lastEventId: this.lastEventId } }

  subscribe(topics: string[], onEvent: (event: SseEvent) => void, onState: (state: SseState) => void) {
    this.enabled = true
    const id = this.nextListener++
    this.listeners.set(id, { topics: uniqueTopics(topics), onEvent, onState })
    const nextTopicsKey = this.requestedTopics().join(',')
    if (this.running && nextTopicsKey !== this.topicsKey) this.reconnect()
    this.topicsKey = nextTopicsKey
    onState(this.state)
    if (!this.running) void this.run()
    return () => {
      this.listeners.delete(id)
      if (this.listeners.size === 0) this.stop()
      else if (this.requestedTopics().join(',') !== this.topicsKey) this.reconnect()
    }
  }

  private notifyState(state: SseState) {
    this.state = state
    for (const listener of this.listeners.values()) listener.onState(state)
  }

  private requestedTopics() {
    return uniqueTopics(Array.from(this.listeners.values()).flatMap((listener) => listener.topics))
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        (this.runtime.clearTimeout ?? clearTimeout)(timer)
        if (this.wakeDelay === finish) this.wakeDelay = null
        resolve()
      }
      const timer = (this.runtime.setTimeout ?? setTimeout)(finish, ms)
      this.wakeDelay = finish
    })
  }

  private reconnect() {
    this.controller?.abort(RECONNECT)
    this.wakeDelay?.()
    if (this.enabled && this.listeners.size > 0 && !this.running) void this.run()
  }

  private async run() {
    if (this.running) return
    this.running = true
    try {
      while (this.enabled && this.listeners.size > 0) {
        const backend = this.runtime.getBackend()
        if (!backend) {
          this.notifyState('unavailable')
          await this.delay(SSE_RECONNECT_BACKOFF_MS[Math.min(this.retryIndex, SSE_RECONNECT_BACKOFF_MS.length - 1)] ?? 10_000)
          this.retryIndex = Math.min(this.retryIndex + 1, SSE_RECONNECT_BACKOFF_MS.length - 1)
          continue
        }
        this.notifyState(this.retryIndex ? 'reconnecting' : 'connecting')
        const controller = new AbortController()
        this.controller = controller
        const fetcher = this.runtime.fetchImpl ?? globalThis.fetch
        const topics = this.requestedTopics().join(',')
        this.topicsKey = topics
        const url = `${backend.baseUrl.replace(/\/$/, '')}/events?topics=${encodeURIComponent(topics)}`
        const headers = new Headers({ authorization: `Bearer ${backend.sessionToken}`, accept: 'text/event-stream' })
        if (this.lastEventId) headers.set('last-event-id', this.lastEventId)
        let silenceTimer: ReturnType<typeof setTimeout> | null = null
        const armSilence = () => {
          if (silenceTimer) (this.runtime.clearTimeout ?? clearTimeout)(silenceTimer)
          silenceTimer = (this.runtime.setTimeout ?? setTimeout)(() => controller.abort(), SSE_RECONNECT_AFTER_SILENCE_MS)
        }
        try {
          armSilence()
          const response = await fetcher(url, { headers, signal: controller.signal })
          if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
          this.retryIndex = 0
          this.notifyState('open')
          armSilence()
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          const cancelReader = () => { void reader.cancel().catch(() => {}) }
          controller.signal.addEventListener('abort', cancelReader, { once: true })
          const parser = createParser({
            maxBufferSize: 1024 * 1024,
            onError: (error) => { throw error },
            onEvent: ({ id, event, data }) => {
              const parsed = parseEvent(id, event, data)
              if (parsed && !controller.signal.aborted) this.dispatch(parsed)
            },
          })
          try {
            while (this.enabled && this.listeners.size > 0 && !controller.signal.aborted) {
              const { done, value } = await reader.read()
              if (done) throw new Error('SSE connection ended')
              armSilence()
              parser.feed(decoder.decode(value, { stream: true }))
            }
          } finally {
            controller.signal.removeEventListener('abort', cancelReader)
            await reader.cancel().catch(() => {})
            reader.releaseLock()
          }
        } catch {
          if (this.enabled && this.listeners.size > 0 && controller.signal.reason !== RECONNECT) {
            if (silenceTimer) (this.runtime.clearTimeout ?? clearTimeout)(silenceTimer)
            const delayMs = SSE_RECONNECT_BACKOFF_MS[Math.min(this.retryIndex, SSE_RECONNECT_BACKOFF_MS.length - 1)] ?? 10_000
            this.retryIndex = Math.min(this.retryIndex + 1, SSE_RECONNECT_BACKOFF_MS.length - 1)
            this.notifyState('reconnecting')
            await this.delay(delayMs)
          }
        } finally {
          if (silenceTimer) (this.runtime.clearTimeout ?? clearTimeout)(silenceTimer)
          this.controller = null
        }
      }
    } finally {
      this.running = false
      this.notifyState('idle')
      if (this.enabled && this.listeners.size > 0) void this.run()
    }
  }

  private dispatch(event: SseEvent) {
    if (event.id) this.lastEventId = event.id
    if (event.event === 'system.events-dropped') void queryClient.invalidateQueries()
    else void queryClient.invalidateQueries({ queryKey: [event.topic] })
    for (const listener of this.listeners.values()) {
      if (event.topic === 'system' || listener.topics.includes(event.topic)) listener.onEvent(event)
    }
  }

  async request(path: string, init: RequestInit = {}) {
    const backend = this.runtime.getBackend()
    if (!backend) throw Object.assign(new Error('BACKEND_UNAVAILABLE'), { code: 'BACKEND_UNAVAILABLE' })
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${backend.sessionToken}`)
    const response = await (this.runtime.fetchImpl ?? globalThis.fetch)(`${backend.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, { ...init, headers })
    if (!response.ok) {
      let payload: unknown = null
      try { payload = await response.json() } catch { /* preserve status when body is not JSON */ }
      const errorPayload = payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: { code?: string; message?: string } }).error
        : undefined
      const code = errorPayload?.code
      const message = errorPayload?.message || `Backend request failed: ${response.status}`
      const error = Object.assign(new Error(message), { code, status: response.status })
      throw error
    }
    return response.json()
  }

  stop() { this.enabled = false; this.controller?.abort(RECONNECT); this.wakeDelay?.(); this.notifyState('idle') }
}

export { SseManager }
export const sseManager = new SseManager()
export const configureSse = (runtime: Partial<SseRuntime>) => sseManager.configure(runtime)
export const requestBackend = (path: string, init?: RequestInit) => sseManager.request(path, init)

export type SseSnapshot = {
  state: SseState
  lastEventId: string | null
  lastEventName: string | null
  lastEventTopic: SseTopic | null
  lastEventData: unknown
}

export function useSse(topics: string[]): SseSnapshot {
  const [snapshot, setSnapshot] = useState<SseSnapshot>({
    ...sseManager.snapshot(),
    lastEventName: null,
    lastEventTopic: null,
    lastEventData: null,
  })
  useEffect(() => sseManager.subscribe(topics, (event) => setSnapshot((current) => {
    if (event.id && event.id === current.lastEventId && event.event === current.lastEventName) return current
    return {
      ...current,
      lastEventId: event.id ?? current.lastEventId,
      lastEventName: event.event,
      lastEventTopic: event.topic,
      lastEventData: event.data,
    }
  }), (state) => setSnapshot((current) => ({ ...current, state }))), [topics.join(',')])
  return snapshot
}
