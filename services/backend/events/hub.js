import {
	EVENT_NAMES,
	EVENT_SYSTEM_EVENTS_DROPPED,
	EVENT_TOPIC,
	SSE_BUFFER_MAX_FRAMES,
	SSE_HEARTBEAT_MS,
	SSE_TOPICS,
} from "@openpet/contracts"

export const HEARTBEAT_MS = SSE_HEARTBEAT_MS
export const CLIENT_STALE_MS = 45_000
export const MAX_BUFFERED_FRAMES = SSE_BUFFER_MAX_FRAMES

const EVENT_NAME_SET = new Set(EVENT_NAMES)
const TOPIC_SET = new Set(SSE_TOPICS)

function frame(id, name, payload) {
	return `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(payload ?? null)}\n\n`
}

function validateTopics(topics) {
	const values = topics === undefined ? [...SSE_TOPICS] : [...topics]
	for (const topic of values) {
		if (!TOPIC_SET.has(topic)) throw new TypeError(`未知 SSE topic: ${topic}`)
	}
	return new Set(values)
}

export function createEventHub({
	logger,
	now = () => Date.now(),
	heartbeatMs = HEARTBEAT_MS,
	setInterval: schedule = setInterval,
	clearInterval: cancel = clearInterval,
} = {}) {
	let nextId = 1
	const clients = new Set()

	function write(client, value) {
		if (client.closed) return true
		try {
			const accepted = client.sink.write(value)
			client.lastFrameAt = now()
			if (accepted !== false) return true
			client.paused = true
			if (typeof client.sink.once === "function") {
				client.onDrain = () => {
					client.onDrain = null
					client.paused = false
					flush(client)
				}
				client.sink.once("drain", client.onDrain)
			}
			return false
		} catch (error) {
			logger?.warn?.("SSE 客户端写入失败", { error: String(error) })
			close(client)
			return false
		}
	}

	function flush(client) {
		if (client.closed || client.paused) return
		while (client.queue.length > 0 && !client.paused && !client.closed) {
			const item = client.queue.shift()
			write(client, item.text)
		}
	}

	function enqueue(client, item) {
		if (client.closed) return
		client.queue.push(item)
		if (client.queue.length > MAX_BUFFERED_FRAMES) {
			const index = client.queue.findIndex((entry) => entry.name === "log.appended" || entry.name === "plugin.log")
			const [dropped] = index >= 0 ? client.queue.splice(index, 1) : client.queue.splice(0, 1)
			const topic = dropped?.topic ?? "system"
			client.dropped.set(topic, (client.dropped.get(topic) ?? 0) + 1)
			reportDrops(client)
		}
		flush(client)
	}

	function publish(name, payload) {
		if (!EVENT_NAME_SET.has(name)) throw new TypeError(`未知 SSE event: ${name}`)
		const topic = EVENT_TOPIC[name]
		const item = { id: nextId++, name, topic, text: frame(nextId - 1, name, payload) }
		for (const client of clients) {
			if (!client.topics.has(topic) && topic !== "system") continue
			enqueue(client, item)
		}
		return item.id
	}

	function reportDrops(client) {
		if (client.dropped.size === 0 || client.closed) return
		const pending = [...client.dropped]
		client.dropped.clear()
		for (const [topic, dropped] of pending) {
			const item = {
				id: nextId++,
				name: EVENT_SYSTEM_EVENTS_DROPPED,
				topic: "system",
				text: frame(nextId - 1, EVENT_SYSTEM_EVENTS_DROPPED, {
					topic,
					dropped,
					since: new Date(now()).toISOString(),
				}),
			}
			client.queue.push(item)
			if (client.queue.length > MAX_BUFFERED_FRAMES) client.queue.shift()
		}
		flush(client)
	}

	function subscribe({ topics, sink } = {}) {
		if (!sink || typeof sink.write !== "function") throw new TypeError("SSE subscribe 需要 sink.write")
		const client = {
			topics: validateTopics(topics),
			sink,
			queue: [],
			dropped: new Map(),
			paused: false,
			onDrain: null,
			closed: false,
			lastFrameAt: now(),
			heartbeat: null,
		}
		client.heartbeat = schedule(() => {
			if (client.closed) return
			if (client.paused) {
				if (now() - client.lastFrameAt >= CLIENT_STALE_MS) close(client, true)
				return
			}
			write(client, ": ping\n\n")
			reportDrops(client)
		}, heartbeatMs)
		client.heartbeat?.unref?.()
		clients.add(client)
		return {
			unsubscribe: () => close(client),
			stats: () => ({ queued: client.queue.length, dropped: Object.fromEntries(client.dropped), lastFrameAt: client.lastFrameAt }),
		}
	}

	function close(client, stalled = false) {
		if (!client || client.closed) return
		client.closed = true
		cancel(client.heartbeat)
		clients.delete(client)
		if (client.onDrain) client.sink.off?.("drain", client.onDrain)
		client.onDrain = null
		client.queue.length = 0
		client.dropped.clear()
		try {
			if (stalled && typeof client.sink.destroy === "function") client.sink.destroy()
			else client.sink.end?.()
		} catch {
			// 客户端已经断开。
		}
	}

	function closeAll() {
		for (const client of [...clients]) close(client)
	}

	return {
		subscribe,
		publish,
		stats: () => ({ clients: clients.size, nextId }),
		closeAll,
	}
}
