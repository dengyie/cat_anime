import * as v from '../../../../shared/browser-validation.ts';
import { createParser } from 'eventsource-parser';
import { backendClient, backendTransport } from '../../api/backend-client.ts';
import { controlCenterAPI } from '../../api/control-center-api.ts';
import type { ApiClient } from '../../api/client.ts';
import type { HatchPetAgentConfigView } from '../../../../shared/openpet-contracts.ts';
import type { ControlCenterApi, AiChatRequest, AiChatResponse, AiConfigViewState, AiPersonaProfileViewState, AiMemoryProfileViewState, AiBehaviorConfig, AiTalkTraceSummaryViewState, AiPersonaDraftViewState, AiBehaviorResult, AiConnectionTestResult, ProviderModelDiscoveryResult } from '../../../../shared/openpet-contracts.ts';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const config = v.custom<AiConfigViewState>((value) => object(value) && typeof value.enabled === 'boolean' && typeof value.provider === 'string' && typeof value.hasApiKey === 'boolean' && object(value.vision) && object(value.memory));
const persona = v.custom<AiPersonaProfileViewState>((value) => object(value) && typeof value.petPackId === 'string' && object(value.effectivePersona) && object(value.overridePersona));
const memory = v.custom<AiMemoryProfileViewState>((value) => object(value) && typeof value.petPackId === 'string' && Array.isArray(value.globalMemories) && Array.isArray(value.petPackMemories) && Array.isArray(value.recentJobs));
const behavior = v.custom<AiBehaviorConfig>((value) => object(value) && typeof value.enabled === 'boolean' && Array.isArray(value.rules) && Array.isArray(value.decisions));
const trace = v.custom<AiTalkTraceSummaryViewState>((value) => object(value) && typeof value.traceId === 'string' && object(value.result));
const draft = v.custom<AiPersonaDraftViewState>((value) => object(value) && object(value.draftPersona));
const behaviorResult = v.custom<AiBehaviorResult>((value) => object(value) && typeof value.matched === 'boolean');
const connection = v.custom<AiConnectionTestResult>((value) => object(value) && typeof value.ok === 'boolean' && typeof value.hasApiKey === 'boolean');
const models = v.custom<ProviderModelDiscoveryResult>((value) => object(value) && typeof value.ok === 'boolean' && Array.isArray(value.models) && value.models.every((item) => typeof item === 'string'));
const secret = v.object({ configured: v.boolean(), maskedTail: v.nullable(v.string()) });
const messages = v.array(v.object({ role: v.picklist(['user', 'assistant']), content: v.string() }));
const chatResult = v.custom<AiChatResponse>((value) => object(value) && typeof value.reply === 'string');
const hatchConfig = v.custom<HatchPetAgentConfigView>((value) => object(value) && typeof value.enabled === 'boolean' && typeof value.hasApiKey === 'boolean' && object(value.budgets));
export function createAiHttpApi(client: ApiClient = backendClient) {
    const send = <T>(method: string, path: string, responseSchema: v.GenericSchema<unknown, T>, body?: unknown) => body === undefined
        ? client.request({ method, path, responseSchema, retry: false, timeoutMs: 120000 })
        : client.request({ method, path, responseSchema, requestSchema: v.unknown(), body, retry: false, timeoutMs: 120000 });
    const key = async (id: string, value: string | null) => {
        const result = await send(value === null ? 'DELETE' : 'PUT', `/ai/providers/${id}/key`, secret, value === null ? undefined : { apiKey: value });
        return { apiKeyRef: id, hasApiKey: result.configured, updatedAt: new Date().toISOString() };
    };
    return {
        getAiConfig: () => send('GET', '/ai/config', config),
        saveAiConfig: (input: Parameters<ControlCenterApi['saveAiConfig']>[0]) => send('PATCH', '/ai/config', config, input),
        saveAiApiKey: (value: string) => key('ai.default', value),
        saveAiVisionApiKey: (value: string) => key('ai.vision', value),
        clearAiVisionApiKey: () => key('ai.vision', null),
        getHatchPetAgentConfig: () => send('GET', '/ai/hatch/config', hatchConfig),
        saveHatchPetAgentConfig: (input: Parameters<ControlCenterApi['saveHatchPetAgentConfig']>[0]) => send('PATCH', '/ai/hatch/config', hatchConfig, input),
        saveHatchPetAgentApiKey: (value: string) => key('ai.hatch-pet', value),
        clearHatchPetAgentApiKey: () => key('ai.hatch-pet', null),
        testAiConnection: () => send('POST', '/ai/providers/chat/test', connection),
        discoverAiModels: () => send('GET', '/ai/providers/chat/models', models),
        discoverAiVisionModels: () => send('GET', '/ai/providers/vision/models', models),
        getAiPersonaProfile: () => send('GET', '/ai/persona', persona),
        saveAiPersonaOverride: (input: Parameters<ControlCenterApi['saveAiPersonaOverride']>[0]) => send('PUT', '/ai/persona', persona, input),
        generateAiPersonaDraft: (input: Parameters<ControlCenterApi['generateAiPersonaDraft']>[0]) => send('POST', '/ai/persona/draft', draft, input),
        getAiMemoryProfile: () => send('GET', '/ai/memories', memory),
        deleteAiMemory: (id: string) => send('DELETE', `/ai/memories/${encodeURIComponent(id)}`, memory),
        clearAiPetPackMemories: () => send('DELETE', '/ai/memories', memory),
        getAiTalkTraceSummary: (input: Parameters<ControlCenterApi['getAiTalkTraceSummary']>[0] = {}) => send('GET', `/ai/traces?${new URLSearchParams(input as Record<string, string>)}`, v.nullable(trace)),
        exportAiTalkTrace: (input: Parameters<ControlCenterApi['exportAiTalkTrace']>[0] = {}) => send('POST', '/ai/traces/export', v.string(), input),
        exportAiTalkTraceDiagnostics: (input: Parameters<ControlCenterApi['exportAiTalkTraceDiagnostics']>[0] = {}) => send('POST', '/ai/traces/diagnostics', v.string(), input),
        getAiConversation: (id: string) => send('GET', `/ai/conversations?conversationId=${encodeURIComponent(id)}`, messages),
        getAiBehavior: () => send('GET', '/ai/behavior', behavior),
        saveAiBehavior: (input: Parameters<ControlCenterApi['saveAiBehavior']>[0]) => send('PATCH', '/ai/behavior', behavior, input),
        dryRunAiBehavior: (input: Parameters<ControlCenterApi['dryRunAiBehavior']>[0]) => send('POST', '/ai/behavior/dry-run', behaviorResult, input),
        replayAiBehaviorDecision: (decisionId: number) => send('POST', '/ai/behavior/replay', behaviorResult, { decisionId }),
        exportAiBehaviorDiagnostics: () => send('POST', '/ai/behavior/diagnostics', v.string()),
        clearAiBehaviorDecisions: async () => { await send('DELETE', '/ai/behavior/decisions', v.array(v.unknown())); return []; },
    };
}
export async function streamAiChat(input: AiChatRequest): Promise<AiChatResponse> {
    const requestId = crypto.randomUUID();
    const response = await backendTransport.request<Response>({ path: '/ai/chat', method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, requestId }), signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('AI chat stream unavailable');
    let terminal: {
        ok: boolean;
        requestId: string;
        data?: unknown;
        error?: {
            message: string;
        };
    } | undefined;
    const parser = createParser({ onEvent: ({ event, data }) => { if (event === 'ai.chat-done')
            terminal = JSON.parse(data); } });
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('AI chat stream unavailable');
    const decoder = new TextDecoder();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            parser.feed(decoder.decode(chunk.value, { stream: true }));
        }
        parser.feed(decoder.decode());
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    if (!terminal || terminal.requestId !== requestId)
        throw new Error('AI chat ended without a result');
    if (!terminal.ok)
        throw new Error(terminal.error?.message || 'AI chat failed');
    return v.parse(chatResult, terminal.data);
}
const http = { ...createAiHttpApi(), chat: streamAiChat, sendPetChatMessage: streamAiChat };
export const aiHttpApi = new Proxy(http, {
    get(target, property: keyof typeof http) {
        return import.meta.env?.DEV === true && !(globalThis as {
            openpetBackend?: unknown;
        }).openpetBackend
            ? controlCenterAPI[property] : target[property];
    },
});
