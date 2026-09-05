const test = require('node:test')
const assert = require('node:assert/strict')

const { IPC } = require('../../src/shared/ipc-channels')

test('shared IPC contract exports stable frozen channel names', () => {
  for (const retiredChannel of [
    'PET_PACKS_LIST',
    'PET_PACKS_CLEAR_SELECTION',
    'PET_PACKS_IMPORT',
    'PET_PACKS_EXPORT',
    'PET_PACKS_SET_ACTIVE',
    'PET_PACKS_ACTIVE_CHANGED',
    'PET_PACKS_REMOVE',
    'CONTROL_CENTER_ACTIVE_PET_PACK_CHANGED'
  ]) {
    assert.equal(IPC[retiredChannel], undefined, `${retiredChannel} must stay retired after the Pet Packs cutover`)
  }
  assert.equal(IPC.PET_PACKS_INSPECT_DIRECTORY, 'pet-packs:inspect-directory')
  assert.equal(IPC.PET_SHOW_CONTEXT_MENU, 'pet:show-context-menu')
  assert.equal(IPC.PET_MENU_COMMAND, 'pet:menu-command')
  assert.equal(IPC.PET_REQUEST_FOCUS_FOR_CURSOR, 'pet:request-focus-for-cursor')
  assert.equal(IPC.PET_CHAT_OPEN, 'pet-chat:open')
  assert.equal(IPC.PET_CHAT_GET_STATE, 'pet-chat:get-state')
  assert.equal(IPC.PET_CHAT_SET_ALWAYS_ON_TOP, 'pet-chat:set-always-on-top')
  assert.equal(IPC.PET_CHAT_SEND_MESSAGE, 'pet-chat:send-message')
  assert.equal(IPC.PET_BUBBLE_CHAT_OPEN, 'pet-bubble-chat:open')
  assert.equal(IPC.PET_BUBBLE_CHAT_SHOW_MESSAGE, 'pet-bubble-chat:show-message')
  assert.equal(IPC.PET_BUBBLE_CHAT_SET_HIT_TEST_MODE, 'pet-bubble-chat:set-hit-test-mode')
  assert.equal(IPC.AI_GENERATE_PERSONA_DRAFT, 'ai:generate-persona-draft')
  assert.equal(IPC.AI_GET_MEMORY_PROFILE, 'ai:get-memory-profile')
  assert.equal(IPC.AI_DELETE_MEMORY, 'ai:delete-memory')
  assert.equal(IPC.AI_CLEAR_PET_PACK_MEMORIES, 'ai:clear-pet-pack-memories')
  assert.deepEqual([
    IPC.HATCH_PET_AGENT_GET_CONFIG,
    IPC.HATCH_PET_AGENT_SAVE_CONFIG,
    IPC.HATCH_PET_AGENT_SAVE_API_KEY,
    IPC.HATCH_PET_AGENT_CLEAR_API_KEY,
    IPC.HATCH_PET_AGENT_CHECK_CAPABILITY,
    IPC.HATCH_PET_AGENT_GET_RUN_STATUS
  ], [
    'hatch-pet-agent:get-config',
    'hatch-pet-agent:save-config',
    'hatch-pet-agent:save-api-key',
    'hatch-pet-agent:clear-api-key',
    'hatch-pet-agent:check-capability',
    'hatch-pet-agent:get-run-status'
  ])
  for (const retiredChannel of [
    'ACTIONS_GET', 'ACTIONS_SAVE_CONFIG', 'ACTIONS_INSPECT_FRAMES', 'ACTIONS_IMPORT_FRAMES',
    'ACTIONS_CLEAR_FRAME_SELECTION', 'ACTIONS_DELETE', 'ACTIONS_PREVIEW_TRIGGER_PROPOSAL',
    'ACTIONS_SUBMIT_TRIGGER_PROPOSAL', 'ACTIONS_ACCEPT_TRIGGER_PROPOSAL',
    'ACTIONS_REJECT_TRIGGER_PROPOSAL', 'ACTIONS_UPDATE_TRIGGER_RULE', 'ACTIONS_DELETE_TRIGGER_RULE',
    'ACTIONS_CHANGED'
  ]) assert.equal(IPC[retiredChannel], undefined, `${retiredChannel} must stay retired after the Actions HTTP cutover`)
  assert.equal(IPC.PLUGINS_RUN_CREATOR_STUDIO_DEFAULT_FLOW, 'plugins:run-creator-studio-default-flow')
  assert.equal(IPC.CREATOR_GET_STATE, 'creator:get-state')
  assert.equal(IPC.CREATOR_PICK_REFERENCE_IMAGE, 'creator:pick-reference-image')
  assert.equal(IPC.CREATOR_BIND_REFERENCE, 'creator:bind-reference')
  assert.equal(IPC.CREATOR_GENERATE_NEW_CHARACTER, 'creator:generate-new-character')
  assert.equal(IPC.CREATOR_GENERATE_EXISTING_ACTION, 'creator:generate-existing-action')
  assert.equal(IPC.CREATOR_GET_LAST_RUN, 'creator:get-last-run')
  assert.equal(IPC.SETTINGS_OPEN, 'settings:open')
  assert.equal(Object.isFrozen(IPC), true)
})
