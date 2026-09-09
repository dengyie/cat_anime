const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ipcPath = require.resolve('../../src/main/ipc')
const { IPC } = require('../../src/shared/ipc-channels')
const { createEventBus } = require('../../src/main/services/event-bus')
const { createPetService } = require('../../src/main/services/pet-service')
const { createAiTalkStore } = require('../../src/main/services/ai-talk-store')
const { createAiTalkService } = require('../../src/main/services/ai-talk-service')

const loadIpcWithElectron = (electronStub) => {
  delete require.cache[ipcPath]
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(ipcPath)
  } finally {
    Module._load = originalLoad
  }
}

const createIpcMainStub = () => {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    on(channel, handler) {
      listeners.set(channel, handler)
    }
  }
}

const createRequiredServices = (overrides = {}) => ({
  getPetWindow: () => null,
  petService: {
    onSay: () => {},
    onAction: () => {},
    onEvent: () => {},
    getAnimations: () => ({ actions: [] }),
    getPreviewAnimations: () => ({ actions: [] }),
    reloadAnimations: () => ({ actions: [] }),
    getSettings: () => ({ localHttp: {}, menuPosition: 'auto' }),
    saveSettings: (settings) => settings,
    say: (payload) => payload,
    playAction: (payload) => payload,
    setEvent: (payload) => payload
  },
  petPackService: {},
  aiService: {
    getConfig: () => ({ enabled: false, hasApiKey: false }),
    getConversation: () => [],
    chat: async () => ({ reply: 'ok' })
  },
  behaviorOrchestratorService: {
    getConfig: () => ({ enabled: false }),
    saveConfig: (config) => config,
    dryRun: () => ({ matched: false }),
    replayDecision: () => ({ matched: false }),
    exportDiagnostics: () => ({}),
    clearDecisions: () => ({ ok: true })
  },
  localHttpService: {
    getStatus: () => ({ enabled: false, host: '127.0.0.1', port: 0, mcp: { activeSessions: 0, sessionTtlMs: 0 } })
  },
  createSettingsWindow: () => {},
  appLogService: { record: () => {} },
  ...overrides
})

const registerPetChatHandlers = (services) => {
  const ipcMain = createIpcMainStub()
  const { registerIpcHandlers } = loadIpcWithElectron({
    ipcMain,
    BrowserWindow: { fromWebContents: () => null },
    app: { quit: () => {} },
    dialog: {},
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 900, height: 700 } })
    }
  })

  ipcMain.runtime = registerIpcHandlers({
    ...createRequiredServices(services),
    ipcMainService: ipcMain
  })
  return ipcMain
}

test('pet chat state exposes provider readiness and current pet-pack main conversation', async () => {
  const conversationRequests = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({
        enabled: false,
        hasApiKey: false,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: (conversationId) => {
        conversationRequests.push(conversationId)
        return [{ id: 'm1', role: 'assistant', content: 'hello', createdAt: '2026-06-24T00:00:00.000Z' }]
      }
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true })
    },
    petBubbleChatWindowService: {
      getState: () => ({ visible: true, hasWindow: true, pinned: false, placement: 'above' })
    }
  })

  const state = await ipcMain.handlers.get(IPC.PET_CHAT_GET_STATE)()

  assert.equal(state.available, true)
  assert.equal(state.ai.ready, false)
  assert.equal(state.ai.reason, '请先在 Control Center 启用 AI Provider')
  assert.equal(state.ai.baseUrl, 'http://127.0.0.1:8317/v1')
  assert.deepEqual(state.petPack, { id: 'legacy-cat', displayName: 'Legacy Cat' })
  assert.deepEqual(state.bubble, { text: '', source: '', ttlMs: 0, updatedAt: '' })
  assert.deepEqual(state.bubbleChat, { visible: true, hasWindow: true, pinned: false, placement: 'above' })
  assert.deepEqual(state.messages, [{ id: 'm1', role: 'assistant', content: 'hello', createdAt: '2026-06-24T00:00:00.000Z' }])
  assert.deepEqual(conversationRequests, [''])
})

test('pet chat send uses shared control-center entrypoint and compact pet bubble', async () => {
  const prompt = 'secret phrase should not be logged'
  const longReply = 'This is a very long desktop pet reply that should remain complete in the chat panel but short inside the speech bubble.'
  const bubbleSegments = ['This is a very long desktop pet reply.', 'It should remain complete in the chat panel.']
  const talkCalls = []
  const sayCalls = []
  const logs = []
  let conversationMessages = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => conversationMessages,
      chat: async (payload) => {
        talkCalls.push(payload)
        conversationMessages = [
          { id: 'u1', role: 'user', content: prompt, createdAt: '2026-06-24T00:00:00.000Z' },
          { id: 'a1', role: 'assistant', content: longReply, createdAt: '2026-06-24T00:00:01.000Z' }
        ]
        return {
          conversationId: 'control-center:legacy-cat:main',
          reply: longReply,
          bubbleSegments,
          messages: conversationMessages
        }
      }
    },
    petService: {
      ...createRequiredServices().petService,
      say: (payload) => {
        sayCalls.push(payload)
        return payload
      }
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true })
    },
    appLogService: {
      record: (entry) => logs.push(entry)
    }
  })

  const result = await ipcMain.handlers.get(IPC.PET_CHAT_SEND_MESSAGE)(null, { message: prompt })

  assert.equal(talkCalls.length, 1)
  assert.equal(talkCalls[0].message, prompt)
  assert.equal(talkCalls[0].entrypoint, 'control-center')
  assert.match(talkCalls[0].requestId, /^chat-/)
  assert.equal(result.conversationId, 'control-center:legacy-cat:main')
  assert.equal(result.reply, longReply)
  assert.deepEqual(result.bubbleSegments, bubbleSegments)
  assert.deepEqual(result.state.messages, conversationMessages)
  assert.equal(result.state.bubble.text, bubbleSegments[0])
  assert.equal(result.state.bubble.source, 'ai')
  assert.equal(sayCalls.length, 1)
  assert.equal(sayCalls[0].source, 'ai')
  assert.equal(sayCalls[0].sourceSurface, 'pet-chat')
  assert.equal(sayCalls[0].text, bubbleSegments[0])
  assert.equal(JSON.stringify(logs).includes(prompt), false)
  assert.deepEqual(logs.map((entry) => entry.event), [
    'pet-chat.message.started',
    'ai-chat.ipc.received',
    'ai-chat.bubble.dispatching',
    'ai-chat.bubble.dispatched',
    'ai-chat.ipc.completed',
    'pet-chat.message.completed'
  ])
})

test('pet chat send emits through PetService so the floating bubble window is displayed', async () => {
  const prompt = 'hello'
  const reply = 'Floating bubble reply should be visible above the desktop pet.'
  const bubbleChatMessages = []
  const sentToPetWindow = []
  const eventBus = createEventBus()
  const settingsService = {
    get: () => ({ localHttp: {}, menuPosition: 'auto', petBubbleChat: { enabled: true, autoPopup: true, autoHide: true } }),
    save: (settings) => settings,
    preview: (settings) => settings
  }
  const actionService = {
    getConfig: () => ({ actions: [] }),
    getPreviewConfig: () => ({ actions: [] }),
    getAction: () => null,
    reload: () => ({ actions: [] })
  }
  const petService = createPetService({ eventBus, settingsService, actionService })
  const ipcMain = registerPetChatHandlers({
    getPetWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sentToPetWindow.push({ channel, payload })
      }
    }),
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => [],
      chat: async () => ({
        conversationId: 'control-center:legacy-cat:main',
        reply,
        messages: [{ id: 'a1', role: 'assistant', content: reply, createdAt: '2026-06-24T00:00:01.000Z' }]
      })
    },
    petService,
    petPackService: {
      getActivePack: () => ({ id: 'legacy-cat', displayName: 'Legacy Cat' })
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true })
    },
    petBubbleChatWindowService: {
      showMessage: (payload) => {
        bubbleChatMessages.push(payload)
        return { visible: true, hasWindow: true, message: payload }
      },
      syncToPetWindow: () => ({ visible: true, hasWindow: true })
    }
  })

  const result = await ipcMain.handlers.get(IPC.PET_CHAT_SEND_MESSAGE)(null, { message: prompt })

  assert.equal(result.bubble.text, reply)
  assert.equal(bubbleChatMessages.length, 1)
  assert.equal(bubbleChatMessages[0].text, reply)
  assert.equal(bubbleChatMessages[0].source, 'ai')
  assert.equal(bubbleChatMessages[0].petPackId, 'legacy-cat')
  assert.equal(sentToPetWindow.length, 0)
})

test('pet chat state tracks latest pet bubble from say events', async () => {
  let onSayHandler = null
  const sentToPetWindow = []
  const utterances = []
  const bubbleChatMessages = []
  const refreshCalls = []
  const conversationMessages = [
    { id: 'u1', role: 'user', content: '你好', createdAt: '2026-06-24T00:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: '在呢', createdAt: '2026-06-24T00:00:01.000Z' }
  ]
  const ipcMain = registerPetChatHandlers({
    getPetWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => sentToPetWindow.push({ channel, payload })
      }
    }),
    petService: {
      ...createRequiredServices().petService,
      onSay: (handler) => { onSayHandler = handler }
    },
    aiTalkService: {
      getConversation: () => conversationMessages,
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' })
    },
    petPackService: {
      getActivePetPack: () => ({ manifest: { id: 'legacy-cat' } })
    },
    petUtteranceLogService: {
      record: (payload) => {
        utterances.push(payload)
        return payload
      }
    },
    petBubbleChatWindowService: {
      showMessage: (payload) => {
        bubbleChatMessages.push(payload)
        return { visible: true }
      },
      refreshItems: (payload) => {
        refreshCalls.push(payload)
        return { visible: true, items: payload.conversationMessages }
      }
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: false, hasWindow: true }),
      sendStateChanged: () => {}
    }
  })

  onSayHandler({ text: '刚刚打了个招呼', ttlMs: 1800, source: 'pet:event' })
  const state = await ipcMain.handlers.get(IPC.PET_CHAT_GET_STATE)()

  assert.equal(state.bubble.text, '刚刚打了个招呼')
  assert.equal(state.bubble.source, 'pet:event')
  assert.equal(state.bubble.ttlMs, 1800)
  assert.equal(sentToPetWindow.length, 0)
  assert.deepEqual(bubbleChatMessages, [{
    text: '刚刚打了个招呼',
    ttlMs: 1800,
    source: 'pet:event',
    kind: 'dialogue',
    role: 'pet',
    petPackId: 'legacy-cat'
  }])
  assert.deepEqual(utterances, [{
    petPackId: 'legacy-cat',
    text: '刚刚打了个招呼',
    source: 'pet:event',
    ttlMs: 1800
  }])
  assert.deepEqual(refreshCalls, [])
})

test('pet chat does not record ai say events as pet utterances while still showing bubble chat', async () => {
  let onSayHandler = null
  const utterances = []
  const bubbleChatMessages = []
  const ipcMain = registerPetChatHandlers({
    petService: {
      ...createRequiredServices().petService,
      onSay: (handler) => { onSayHandler = handler }
    },
    petPackService: {
      getActivePetPack: () => ({ manifest: { id: 'legacy-cat' } })
    },
    petUtteranceLogService: {
      record: (payload) => {
        utterances.push(payload)
        return payload
      }
    },
    petBubbleChatWindowService: {
      showMessage: (payload) => {
        bubbleChatMessages.push(payload)
        return { visible: true }
      },
      refreshItems: () => ({ visible: true })
    }
  })

  onSayHandler({ text: '正式回复', ttlMs: 2000, source: 'ai' })

  assert.deepEqual(utterances, [])
  assert.deepEqual(bubbleChatMessages, [{
    text: '正式回复',
    ttlMs: 2000,
    source: 'ai',
    kind: 'dialogue',
    role: 'pet',
    petPackId: 'legacy-cat'
  }])
  const state = await ipcMain.handlers.get(IPC.PET_CHAT_GET_STATE)()
  assert.equal(state.bubble.text, '正式回复')
})

test('pet chat and bubble chat cancel handlers cancel the shared ai talk request', async () => {
  const cancelCalls = []
  const ipcMain = registerPetChatHandlers({
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => [],
      cancelRequest: (payload) => {
        cancelCalls.push(payload)
        return { canceled: true }
      }
    }
  })

  assert.equal(ipcMain.handlers.has(IPC.PET_CHAT_CANCEL_MESSAGE), true)
  assert.equal(ipcMain.handlers.has(IPC.PET_BUBBLE_CHAT_CANCEL_MESSAGE), true)
  assert.equal(await ipcMain.handlers.get(IPC.PET_CHAT_CANCEL_MESSAGE)({}, { requestId: 'chat-1' }), true)
  assert.equal(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_CANCEL_MESSAGE)({}, { requestId: 'chat-2' }), true)
  assert.deepEqual(cancelCalls, [
    { requestId: 'chat-1', reason: 'user-cancel', sourceSurface: 'pet-chat' },
    { requestId: 'chat-2', reason: 'user-cancel', sourceSurface: 'bubble-chat' }
  ])
})

test('pet chat IPC broadcasts streaming state to both chat surfaces', async () => {
  const bubbleStates = []
  const chatStates = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => [],
      streamChat: async ({ onState }) => {
        onState({
          requestId: 'chat-stream-1',
          conversationId: 'control-center:legacy-cat:main',
          petPackId: 'legacy-cat',
          status: 'streaming',
          partialReply: 'Hel',
          partialReplyChars: 3,
          canCancel: true
        })
        return {
          requestId: 'chat-stream-1',
          conversationId: 'control-center:legacy-cat:main',
          reply: 'Hello',
          bubbleSegments: ['Hello'],
          messages: [{ id: 'a1', role: 'assistant', content: 'Hello', createdAt: '2026-06-24T00:00:01.000Z' }]
        }
      }
    },
    petBubbleChatWindowService: {
      applyStreamState: (state) => {
        bubbleStates.push(state)
        return { streaming: state }
      },
      refreshItems: () => ({ visible: true })
    },
    petChatWindowService: {
      applyStreamState: (state) => {
        chatStates.push(state)
        return { streaming: state }
      },
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true })
    }
  })

  await ipcMain.handlers.get(IPC.PET_CHAT_SEND_MESSAGE)(null, { message: 'hello' })

  assert.equal(bubbleStates.length, 1)
  assert.equal(chatStates.length, 1)
  assert.equal(bubbleStates[0].partialReply, 'Hel')
  assert.equal(chatStates[0].requestId, 'chat-stream-1')
})

test('pet chat send clears completed transient stream before returning final state', async () => {
  const clearCalls = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => [{ id: 'a1', role: 'assistant', content: 'Hello', createdAt: '2026-06-24T00:00:01.000Z' }],
      streamChat: async ({ onState }) => {
        onState({
          requestId: 'chat-stream-1',
          conversationId: 'control-center:legacy-cat:main',
          petPackId: 'legacy-cat',
          status: 'completed',
          partialReply: 'Hello',
          partialReplyChars: 5,
          canCancel: false
        })
        return {
          requestId: 'chat-stream-1',
          conversationId: 'control-center:legacy-cat:main',
          reply: 'Hello',
          bubbleSegments: ['Hello'],
          messages: [{ id: 'a1', role: 'assistant', content: 'Hello', createdAt: '2026-06-24T00:00:01.000Z' }]
        }
      }
    },
    petBubbleChatWindowService: {
      applyStreamState: () => ({}),
      refreshItems: () => ({ visible: true })
    },
    petChatWindowService: {
      applyStreamState: () => ({ streaming: { requestId: 'chat-stream-1', status: 'completed' } }),
      clearStreamState: (requestId) => {
        clearCalls.push(requestId)
        return { alwaysOnTop: true, visible: true, hasWindow: true, streaming: null }
      },
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true, streaming: null })
    }
  })

  const result = await ipcMain.handlers.get(IPC.PET_CHAT_SEND_MESSAGE)(null, { message: 'hello' })

  assert.deepEqual(clearCalls, ['chat-stream-1'])
  assert.equal(result.state.streaming, null)
  assert.deepEqual(result.state.messages, [{ id: 'a1', role: 'assistant', content: 'Hello', createdAt: '2026-06-24T00:00:01.000Z' }])
})

test('pet bubble chat IPC delegates state, open, local message, hide, pin and interaction updates', async () => {
  const calls = []
  const conversationMessages = [
    { id: 'u1', role: 'user', content: '旧消息', createdAt: '2026-06-24T00:00:00.000Z' }
  ]
  const ipcMain = registerPetChatHandlers({
    petPackService: {
      getActivePetPack: () => ({ manifest: { id: 'legacy-cat' } })
    },
    aiTalkService: {
      getConversation: () => conversationMessages,
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' })
    },
    petBubbleChatWindowService: {
      getState: () => ({ visible: true, pinned: false }),
      hide: (payload) => {
        calls.push(['hide', payload])
      },
      open: (payload) => {
        calls.push(['open', payload])
        return { visible: true, opened: true }
      },
      setPinned: (pinned, meta) => {
        calls.push(['pinned', pinned, meta])
        return { visible: true, pinned }
      },
      setInteracting: (interacting, meta) => {
        calls.push(['interacting', interacting, meta])
        return { visible: true, interacting }
      },
      setHitTestMode: (payload) => {
        calls.push(['hitTest', payload])
        return { visible: true, hitTestInteractive: payload.interactive }
      },
      dragWindowTo: (payload) => {
        calls.push(['dragTo', payload])
        return { visible: true, bounds: { x: payload.x, y: payload.y } }
      },
      showMessage: (payload) => {
        calls.push(['showMessage', payload])
        return { visible: true, message: payload }
      },
      refreshItems: (payload) => {
        calls.push(['refreshItems', payload])
        return { visible: true, refreshed: true, items: payload.conversationMessages }
      }
    }
  })

  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_GET_STATE)(), { visible: true, pinned: false })
  ipcMain.listeners.get(IPC.PET_BUBBLE_CHAT_HIDE)()
  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_OPEN)(), { visible: true, opened: true })
  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SET_PINNED)(null, { pinned: true }), { visible: true, pinned: true })
  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SET_INTERACTING)(null, { interacting: true }), { visible: true, interacting: true })
  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SET_HIT_TEST_MODE)(null, { interactive: false, source: 'test-idle' }), { visible: true, hitTestInteractive: false })
  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_DRAG_TO)(null, { x: 480, y: 320, source: 'test-drag' }), { visible: true, bounds: { x: 480, y: 320 } })
  assert.deepEqual(await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SHOW_MESSAGE)(null, { text: '本地轻量消息', ttlMs: 800 }), {
    visible: true,
    refreshed: true,
    items: conversationMessages
  })
  assert.deepEqual(calls, [
    ['hide', { source: 'pet-bubble-chat-renderer' }],
    ['open', { source: 'pet-renderer', focus: true }],
    ['pinned', true, { source: 'pet-bubble-chat-renderer' }],
    ['interacting', true, { source: 'pet-bubble-chat-renderer' }],
    ['hitTest', { interactive: false, source: 'test-idle' }],
    ['dragTo', { x: 480, y: 320, source: 'test-drag' }],
    ['showMessage', {
      text: '本地轻量消息',
      ttlMs: 800,
      source: 'pet-renderer',
      kind: 'dialogue',
      role: 'pet',
      petPackId: 'legacy-cat'
    }],
    ['refreshItems', {
      conversationMessages,
      reason: 'local-show-message'
    }]
  ])
})

test('pet bubble chat re-syncs to pet window on viewport and movement updates so popup tracks pet actions', async () => {
  let viewportHandler = null
  let setPositionHandler = null
  let moveByHandler = null
  let dragEndedHandler = null
  let onActionHandler = null
  const syncCalls = []
  const savedSettings = []
  const win = {
    getBounds: () => ({ x: 320, y: 280, width: 120, height: 120 }),
    getPosition: () => [320, 280],
    setPosition: () => {},
    webContents: {},
    isDestroyed: () => false
  }
  const ipcMain = createIpcMainStub()
  const { registerIpcHandlers } = loadIpcWithElectron({
    ipcMain,
    BrowserWindow: { fromWebContents: () => win },
    app: { quit: () => {} },
    dialog: {},
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 900, height: 700 } })
    }
  })

  registerIpcHandlers({
    ...createRequiredServices({
      petService: {
        ...createRequiredServices().petService,
        onAction: (handler) => { onActionHandler = handler },
        getSettings: () => ({
          localHttp: {},
          menuPosition: 'auto',
          petBehavior: {
            grounded: false,
            home: { enabled: true, radius: 'medium', anchor: null }
          }
        }),
        saveSettings: (settings) => {
          savedSettings.push(settings)
          return settings
        }
      },
      petBubbleChatWindowService: {
        syncToPetWindow: () => {
          syncCalls.push('sync')
        }
      },
      applyPetViewport: () => {},
      clampToWorkArea: (_win, x, y) => ({ x, y }),
      getMovementState: () => ({}),
      petMovementPolicy: {
        clampDragPosition: ({ requestedTopLeft }) => requestedTopLeft,
        clampMoveBy: ({ windowBounds, delta }) => ({
          x: windowBounds.x + delta.x,
          y: windowBounds.y + delta.y
        }),
        normalizePetBehaviorSettings: (settings) => settings,
        createHomeAnchorFromWindow: () => ({ x: 0.5, y: 1 })
      }
    }),
    browserWindowService: { fromWebContents: () => win },
    ipcMainService: ipcMain
  })

  viewportHandler = ipcMain.listeners.get(IPC.PET_SET_VIEWPORT)
  setPositionHandler = ipcMain.listeners.get(IPC.PET_SET_POSITION)
  moveByHandler = ipcMain.handlers.get(IPC.PET_MOVE_BY)
  dragEndedHandler = ipcMain.listeners.get(IPC.PET_DRAG_ENDED)

  viewportHandler({ sender: {} }, { width: 180, height: 200 })
  setPositionHandler({ sender: {} }, { x: 400, y: 420 })
  await moveByHandler({ sender: {} }, { x: 6, y: -4 })
  dragEndedHandler({ sender: {} })
  onActionHandler({ actionId: 'wave', source: 'test' })

  assert.equal(syncCalls.length, 5)
  assert.equal(savedSettings.length, 1)
  assert.deepEqual(savedSettings[0].petBehavior.home.anchor, { x: 0.5, y: 1 })
})

test('pet bubble chat send reuses shared AI Talk conversation and updates popup state', async () => {
  const prompt = 'bubble secret prompt'
  const reply = 'bubble reply'
  const bubbleSegments = ['bubble reply', 'follow up']
  const talkCalls = []
  const popupStates = []
  const refreshCalls = []
  const logs = []
  let conversationMessages = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => conversationMessages,
      chat: async (payload) => {
        talkCalls.push(payload)
        conversationMessages = [
          { id: 'u1', role: 'user', content: prompt, createdAt: '2026-06-24T00:00:00.000Z' },
          { id: 'a1', role: 'assistant', content: reply, createdAt: '2026-06-24T00:00:01.000Z' }
        ]
        return {
          conversationId: 'control-center:legacy-cat:main',
          reply,
          bubbleSegments,
          messages: conversationMessages,
          providerLatencyMs: 820
        }
      }
    },
    petBubbleChatWindowService: {
      setSendingState: (state) => {
        popupStates.push(state)
        return { visible: true, ...state }
      },
      showMessage: () => ({ visible: true }),
      refreshItems: (payload) => {
        refreshCalls.push(payload)
        return { visible: true, refreshed: true, items: payload.conversationMessages }
      }
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: false, hasWindow: true }),
      sendStateChanged: () => {}
    },
    appLogService: {
      record: (entry) => logs.push(entry)
    }
  })

  const result = await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SEND_MESSAGE)(null, { message: prompt })

  assert.equal(talkCalls.length, 1)
  assert.equal(talkCalls[0].message, prompt)
  assert.equal(talkCalls[0].entrypoint, 'control-center')
  assert.match(talkCalls[0].requestId, /^chat-/)
  assert.equal(result.conversationId, 'control-center:legacy-cat:main')
  assert.equal(result.reply, reply)
  assert.deepEqual(result.bubbleSegments, bubbleSegments)
  assert.deepEqual(result.state, {
    visible: true,
    refreshed: true,
    items: conversationMessages
  })
  assert.deepEqual(popupStates, [
    { sending: true, lastUserMessage: { text: prompt } },
    { sending: false, lastUserMessage: { text: prompt }, error: '' }
  ])
  assert.deepEqual(refreshCalls, [{ conversationMessages, reason: 'bubble-chat-send' }])
  assert.equal(JSON.stringify(logs).includes(prompt), false)
  assert.deepEqual(logs.map((entry) => entry.event), [
    'pet-bubble-chat.message.started',
    'ai-chat.ipc.received',
    'ai-chat.bubble.dispatching',
    'ai-chat.bubble.dispatched',
    'ai-chat.ipc.completed',
    'pet-bubble-chat.message.completed'
  ])
  const requestIds = logs.map((entry) => entry.details?.requestId).filter(Boolean)
  assert.equal(requestIds.length >= 4, true)
  assert.equal(new Set(requestIds).size, 1)
  const completionLog = logs.find((entry) => entry.event === 'pet-bubble-chat.message.completed')
  assert.equal(completionLog.details?.providerLatencyMs, 820)
})

test('pet bubble chat queues user turns without persisting them ahead of provider order', async () => {
  const store = createAiTalkStore({
    storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openpet-bubble-order-')), 'ai-talk-store.json'),
    now: () => '2026-07-12T00:00:00.000Z'
  })
  const providerRequests = []
  let releaseFirst
  const firstCanFinish = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const providerService = {
    getConfig: () => ({
      enabled: true,
      hasApiKey: true,
      provider: 'openai-compatible',
      model: 'stream-model',
      behavior: { enabled: false },
      memory: { enabled: false }
    }),
    streamComplete: async ({ messages }) => {
      providerRequests.push(messages.map(({ role, content }) => ({ role, content })))
      if (providerRequests.length === 1) {
        await firstCanFinish
        return { reply: 'assistant-one', elapsedMs: 5, chunkCount: 0, finishReason: 'stop' }
      }
      return { reply: 'assistant-two', elapsedMs: 5, chunkCount: 0, finishReason: 'stop' }
    }
  }
  const petPackService = {
    getActivePetPack: () => ({
      manifest: { id: 'legacy-cat', displayName: 'Legacy Cat', persona: null, actions: [] }
    })
  }
  const aiTalkService = createAiTalkService({
    aiService: providerService,
    aiTalkStore: store,
    petPackService
  })
  let activeRequestId = ''
  let queuedMessages = []
  const bubbleWindow = {
    queueOutgoingMessage: ({ text, requestId }) => {
      if (activeRequestId) {
        queuedMessages.push(text)
        return { shouldStartRequest: false, state: { queued: true } }
      }
      activeRequestId = requestId
      return { shouldStartRequest: true, batchMessages: [text], state: { queued: false } }
    },
    completeRequest: ({ requestId }) => {
      if (requestId === activeRequestId) activeRequestId = ''
    },
    startQueuedRequest: (requestId) => {
      if (!queuedMessages.length) return []
      const batch = queuedMessages
      queuedMessages = []
      activeRequestId = requestId
      return batch
    },
    failRequest: () => {},
    applyStreamState: () => {},
    rebuildItems: ({ conversationMessages }) => ({ items: conversationMessages }),
    getState: () => ({})
  }
  const ipcMain = registerPetChatHandlers({
    aiService: providerService,
    aiTalkService,
    petPackService,
    petBubbleChatWindowService: bubbleWindow,
    petChatWindowService: { getState: () => ({}), applyStreamState: () => {} }
  })

  const first = ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SEND_MESSAGE)(null, { message: 'user-one' })
  while (providerRequests.length < 1) await new Promise((resolve) => setImmediate(resolve))
  const second = await ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SEND_MESSAGE)(null, { message: 'user-two' })
  assert.equal(second.queued, true)
  releaseFirst()
  await first
  for (let index = 0; index < 20 && providerRequests.length < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  for (let index = 0; index < 20 && store.getMessages('control-center:legacy-cat', 'main').length < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(providerRequests.length, 2)
  assert.deepEqual(providerRequests[1].map((message) => message.content), [
    providerRequests[1][0].content,
    'user-one',
    'assistant-one',
    'user-two'
  ])
  assert.deepEqual(store.getMessages('control-center:legacy-cat', 'main').map((message) => message.content), [
    'user-one',
    'assistant-one',
    'user-two',
    'assistant-two'
  ])
})

test('pet chat send refreshes bubble chat items from the shared main conversation', async () => {
  const prompt = 'hello from full chat'
  const reply = 'reply visible in mini stream'
  const refreshCalls = []
  let conversationMessages = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      getConversation: () => conversationMessages,
      chat: async () => {
        conversationMessages = [
          { id: 'u1', role: 'user', content: prompt, createdAt: '2026-06-24T00:00:00.000Z' },
          { id: 'a1', role: 'assistant', content: reply, createdAt: '2026-06-24T00:00:01.000Z' }
        ]
        return {
          conversationId: 'control-center:legacy-cat:main',
          reply,
          messages: conversationMessages
        }
      }
    },
    petBubbleChatWindowService: {
      showMessage: () => ({ visible: true }),
      refreshItems: (payload) => {
        refreshCalls.push(payload)
        return { visible: true, items: payload.conversationMessages }
      }
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true }),
      sendStateChanged: () => {}
    }
  })

  const result = await ipcMain.handlers.get(IPC.PET_CHAT_SEND_MESSAGE)(null, { message: prompt })

  assert.equal(result.reply, reply)
  assert.deepEqual(refreshCalls, [
    { conversationMessages, reason: 'pet-chat-send' }
  ])
})

test('pet bubble chat send records recoverable popup error without provider call when not ready', async () => {
  const popupStates = []
  const logs = []
  let chatCalls = 0
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({ enabled: true, hasApiKey: false })
    },
    aiTalkService: {
      getConversation: () => [],
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      chat: async () => {
        chatCalls += 1
        return { reply: 'should not happen' }
      }
    },
    petBubbleChatWindowService: {
      setSendingState: (state) => {
        popupStates.push(state)
        return { visible: true, ...state }
      }
    },
    appLogService: {
      record: (entry) => logs.push(entry)
    }
  })

  await assert.rejects(
    () => ipcMain.handlers.get(IPC.PET_BUBBLE_CHAT_SEND_MESSAGE)(null, { message: 'hi' }),
    /保存 AI API Key/
  )

  assert.equal(chatCalls, 0)
  assert.deepEqual(popupStates, [{
    sending: false,
    lastUserMessage: { text: 'hi' },
    error: '请先在 Control Center 保存 AI API Key'
  }])
  assert.deepEqual(logs.map((entry) => entry.event), [
    'pet-bubble-chat.message.started',
    'pet-bubble-chat.message.failed'
  ])
})

test('pet chat send stops before provider call when chat provider is not ready', async () => {
  let chatCalls = 0
  const logs = []
  const ipcMain = registerPetChatHandlers({
    aiService: {
      getConfig: () => ({ enabled: true, hasApiKey: false }),
      chat: async () => {
        chatCalls += 1
        return { reply: 'should not happen' }
      }
    },
    aiTalkService: {
      getConversation: () => [],
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      chat: async () => {
        chatCalls += 1
        return { reply: 'should not happen' }
      }
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true })
    },
    appLogService: {
      record: (entry) => logs.push(entry)
    }
  })

  await assert.rejects(
    () => ipcMain.handlers.get(IPC.PET_CHAT_SEND_MESSAGE)(null, { message: 'hi' }),
    /保存 AI API Key/
  )

  assert.equal(chatCalls, 0)
  assert.deepEqual(logs.map((entry) => entry.event), [
    'pet-chat.message.started',
    'pet-chat.message.failed'
  ])
})

test('pet pack activation notifies control center and desktop chat with refreshed AI talk state', async () => {
  const backendNotifications = []
  const desktopStates = []
  const ipcMain = registerPetChatHandlers({
    petPackService: {
      setActivePack: (packId) => ({ activePackId: packId, pack: { id: packId, displayName: 'Mochi Cat' } }),
      listPacks: () => ({
        activePackId: 'mochi-cat',
        packs: [{ id: 'mochi-cat', displayName: 'Mochi Cat', active: true }]
      })
    },
    aiService: {
      getConfig: () => ({
        enabled: true,
        hasApiKey: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.5'
      })
    },
    aiTalkService: {
      getPersonaProfile: () => ({ petPackId: 'mochi-cat', petPackDisplayName: 'Mochi Cat' }),
      getConversation: () => [{ role: 'assistant', content: 'mochi hello' }]
    },
    petChatWindowService: {
      getState: () => ({ alwaysOnTop: true, visible: true, hasWindow: true }),
      sendStateChanged: (state) => desktopStates.push(state)
    },
    sidecarRuntimeCoordinator: {
      notifyBackend: (body) => {
        backendNotifications.push(body)
        return true
      }
    }
  })

  const result = await ipcMain.runtime.handlePetPackRequest({
    operation: 'activate',
    payload: { packId: 'mochi-cat' }
  })

  assert.equal(result.activePackId, 'mochi-cat')
  assert.equal(desktopStates.length, 1)
  assert.equal(desktopStates[0].petPack.id, 'mochi-cat')
  assert.equal(backendNotifications.length, 1)
  assert.equal(backendNotifications[0].type, 'pet.pack-activated')
  assert.equal(backendNotifications[0].payload.activePackId, 'mochi-cat')
  assert.equal(backendNotifications[0].payload.petChatState.petPack.displayName, 'Mochi Cat')
})

test('ai talk trace export HTTP includes backend behavior decisions', async (t) => {
  const { createAiHttpHarness } = require('../helpers/ai-http-harness')
  const exportCalls = []
  const http = await createAiHttpHarness(t, {
    aiTalkService: {
      getConversation: () => [],
      getPersonaProfile: () => ({ petPackId: 'legacy-cat', petPackDisplayName: 'Legacy Cat' }),
      exportTraceDiagnostics: (payload) => {
        exportCalls.push(payload)
        return JSON.stringify({ ok: true, behaviorCount: payload.behaviorDecisions.length })
      }
    },
    behaviorOrchestratorService: {
      ...createRequiredServices().behaviorOrchestratorService,
      getConfig: () => ({
        decisions: [
          { id: 7, timestamp: '2026-06-20T00:00:00.000Z', matched: true, reason: 'matched provider actionId' }
        ]
      })
    }
  })

  const exported = JSON.parse(await http('POST', '/ai/traces/diagnostics', {}))

  assert.deepEqual(exported, { ok: true, behaviorCount: 1 })
  assert.equal(exportCalls[0].behaviorDecisions[0].id, 7)
})
