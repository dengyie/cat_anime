import * as v from '../../../../shared/browser-validation.ts';
import { backendClient } from '../../api/backend-client.ts';
import { controlCenterAPI } from '../../api/control-center-api.ts';
import type { ApiClient } from '../../api/client.ts';
import type { JsonObject } from '../../../../shared/openpet-contracts';
export type PluginJobCreated = {
    jobId: string;
};
export type PluginHttpApi = ReturnType<typeof createPluginHttpApi>;
const jsonObject = v.record(v.string(), v.unknown());
const pluginJob = v.object({ jobId: v.pipe(v.string(), v.minLength(1)) });
export function isBackendUnavailableBeforeDispatch(error: unknown): boolean {
    const failure = error as {
        code?: unknown;
        dispatched?: unknown;
    } | null;
    return failure?.code === 'BACKEND_UNAVAILABLE' && failure.dispatched === false;
}
export function shouldUseImmediatePluginCommandFallback(isDevelopment: boolean, hasBackendBridge: boolean): boolean {
    return isDevelopment && !hasBackendBridge;
}
export function shouldUsePluginDemoApi(isDevelopment: boolean, hasBackendBridge: boolean): boolean {
    return isDevelopment && !hasBackendBridge;
}
export function createPluginHttpApi(client: ApiClient = backendClient) {
    const anyResponse = v.unknown();
    const request = (method: string, path: string, body?: JsonObject): Promise<any> => body === undefined
        ? client.request({ method, path, responseSchema: anyResponse, retry: method === 'GET' })
        : client.request({ method, path, requestSchema: jsonObject, body, responseSchema: anyResponse, retry: method === 'GET' });
    return {
        list: async () => {
            const result = await request('GET', '/plugins');
            return Array.isArray(result) ? result : (result?.items || []);
        },
        detail: (pluginId: string) => request('GET', `/plugins/${encodeURIComponent(pluginId)}`),
        enable: (pluginId: string, enabled: boolean) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/enable`, { enabled }),
        nativeApproval: (pluginId: string, approved: boolean) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/native-approval`, { approved }),
        start: (pluginId: string) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/start`, {}),
        stop: (pluginId: string) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/stop`, {}),
        restart: (pluginId: string) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/restart`, {}),
        status: (pluginId: string) => request('GET', `/plugins/${encodeURIComponent(pluginId)}/status`),
        logs: (pluginId: string, query: Record<string, unknown> = {}) => {
            const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
            return request('GET', `/plugins/${encodeURIComponent(pluginId)}/logs${params.size ? `?${params}` : ''}`);
        },
        clearLogsFor: (pluginId: string) => request('DELETE', `/plugins/${encodeURIComponent(pluginId)}/logs`),
        clearSelection: (selectionId: string) => request('POST', '/plugins/install?operation=clear-selection', { selectionId }),
        exportLogsHttp: (query: Record<string, unknown> = {}) => {
            const params = new URLSearchParams({ operation: 'export', ...Object.fromEntries(Object.entries(query).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])) });
            return request('GET', `/plugins/${encodeURIComponent(String(query.pluginId || ''))}/logs?${params}`);
        },
        permissions: (pluginId: string) => request('GET', `/plugins/${encodeURIComponent(pluginId)}/permissions`),
        setPermissions: (pluginId: string, permissions: string[]) => request('PUT', `/plugins/${encodeURIComponent(pluginId)}/permissions`, { permissions }),
        config: (pluginId: string) => request('GET', `/plugins/${encodeURIComponent(pluginId)}/config`),
        setConfig: (pluginId: string, config: JsonObject) => request('PUT', `/plugins/${encodeURIComponent(pluginId)}/config`, config),
        install: (selectionId: string) => request('POST', '/plugins/install', { selectionId }),
        installGithub: (repositoryUrl: string) => request('POST', '/plugins/install/github', { repositoryUrl }),
        inspectGithub: (repositoryUrl: string) => request('POST', '/plugins/validate', { repositoryUrl }),
        uninstall: (pluginId: string, removeStorage = false) => request('DELETE', `/plugins/${encodeURIComponent(pluginId)}?removeStorage=${removeStorage}`),
        validate: (path: string) => request('POST', '/plugins/validate', { path }),
        syncBundled: () => request('POST', '/plugins/sync-bundled', {}),
        setup: (pluginId: string, setupId: string) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(setupId)}?operation=setup`, {}),
        service: (pluginId: string, serviceId: string, operation: 'start' | 'stop' | 'health') => operation === 'health'
            ? request('POST', `/plugins/${encodeURIComponent(pluginId)}/start?operation=health`, { serviceId })
            : request('POST', `/plugins/${encodeURIComponent(pluginId)}/${operation}`, { serviceId }),
        servicePolicy: (pluginId: string, serviceId: string, policy: JsonObject) => request('PUT', `/plugins/${encodeURIComponent(pluginId)}/config?operation=health-policy`, { serviceId, policy }),
        storage: (pluginId: string) => request('POST', `/plugins/${encodeURIComponent(pluginId)}/enable?operation=storage-clear`, {}),
        creatorFlow: (prompt: string) => request('POST', '/plugins/openpet.creator-studio/commands/default-flow?operation=creator-default-flow', { prompt }),
        imSecret: (operation: 'state' | 'save' | 'clear' | 'save-wecom' | 'clear-wecom', token?: string, credentials?: {
            corpSecret: string;
            token: string;
            encodingAesKey: string;
        }) => operation === 'state'
            ? request('GET', '/plugins/openpet.im-gateway/config?operation=secret-state')
            : operation === 'save-wecom'
                ? request('PUT', '/plugins/openpet.im-gateway/config?operation=secret-save-wecom', credentials || {})
                : operation === 'clear-wecom'
                    ? request('PUT', '/plugins/openpet.im-gateway/config?operation=secret-clear-wecom', {})
                    : request('PUT', `/plugins/openpet.im-gateway/config?operation=secret-${operation}`, token ? { token } : {}),
        imQqCredentials: (operation: 'state' | 'save' | 'clear', credentials?: {
            appId: string;
            clientSecret: string;
        }) => operation === 'state'
            ? request('GET', '/plugins/openpet.im-gateway/config?operation=secret-state')
            : request('PUT', `/plugins/openpet.im-gateway/config?operation=secret-qq-${operation}`, credentials || {}),
        update: (selectionId: string) => request('POST', '/plugins/install', { selectionId, update: true }),
        exportLogs: async (query: Record<string, unknown> = {}) => {
            const plugins = await (async () => {
                const result = await request('GET', '/plugins');
                return Array.isArray(result) ? result : (result?.items || []);
            })();
            const entries = (await Promise.all(plugins.map((plugin: {
                id?: string;
            }) => plugin.id ?
                request('GET', `/plugins/${encodeURIComponent(plugin.id)}/logs`) : []))).flatMap((result: any) => result?.items || result?.entries || []);
            if (String(query.format || 'json').toLowerCase() === 'csv') {
                return ['id,pluginId,level,message,at', ...entries.map((entry: any) => [entry.id, entry.pluginId, entry.level, entry.message, entry.at].map((value) => JSON.stringify(value ?? '')).join(','))].join('\n');
            }
            return JSON.stringify(entries);
        },
        clearLogs: async () => {
            const result = await request('GET', '/plugins');
            const plugins = Array.isArray(result) ? result : (result?.items || []);
            return Promise.all(plugins.filter((plugin: {
                id?: string;
            }) => plugin.id).map((plugin: {
                id: string;
            }) => request('DELETE', `/plugins/${encodeURIComponent(plugin.id)}/logs`)));
        },
        async command(pluginId: string, command: string, args: JsonObject = {}): Promise<PluginJobCreated> {
            return client.request({ method: 'POST', path: `/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(command)}`, requestSchema: jsonObject, body: args, responseSchema: pluginJob, job: true, retry: false });
        },
    };
}
const pluginHttpApiTransport = createPluginHttpApi();
type PluginApi = typeof pluginHttpApiTransport;
const usePluginDemoApi = () => shouldUsePluginDemoApi(import.meta.env?.DEV === true, Boolean((globalThis as any).openpetBackend));
// The Control Center also runs in a plain browser under Vite, where no
// Electron backend bridge is present. Keep the public API stable while
// routing plugin pane operations to the in-memory demo API in that mode.
export const pluginHttpApi: PluginApi = {
    ...pluginHttpApiTransport,
    list: () => usePluginDemoApi() ? controlCenterAPI.getPlugins() : pluginHttpApiTransport.list(),
    enable: (pluginId, enabled) => usePluginDemoApi()
        ? controlCenterAPI.setPluginEnabled(pluginId, enabled)
        : pluginHttpApiTransport.enable(pluginId, enabled),
    nativeApproval: (pluginId, approved) => usePluginDemoApi()
        ? controlCenterAPI.setPluginNativeExecutionApproved(pluginId, approved)
        : pluginHttpApiTransport.nativeApproval(pluginId, approved),
    logs: (pluginId, query = {}) => usePluginDemoApi()
        ? controlCenterAPI.getPluginLogs({ ...query, pluginId } as any)
        : pluginHttpApiTransport.logs(pluginId, query),
    setConfig: (pluginId, config) => usePluginDemoApi()
        ? controlCenterAPI.savePluginConfig(pluginId, config)
        : pluginHttpApiTransport.setConfig(pluginId, config),
    inspectGithub: (repositoryUrl) => usePluginDemoApi()
        ? controlCenterAPI.inspectPluginGithubRepository(repositoryUrl)
        : pluginHttpApiTransport.inspectGithub(repositoryUrl),
    install: (selectionId) => usePluginDemoApi()
        ? controlCenterAPI.installPlugin(selectionId)
        : pluginHttpApiTransport.install(selectionId),
    update: (selectionId) => usePluginDemoApi()
        ? controlCenterAPI.updatePlugin(selectionId)
        : pluginHttpApiTransport.update(selectionId),
    uninstall: (pluginId, removeStorage = false) => usePluginDemoApi()
        ? controlCenterAPI.uninstallPlugin(pluginId, { removeStorage })
        : pluginHttpApiTransport.uninstall(pluginId, removeStorage),
    setup: (pluginId, setupId) => usePluginDemoApi()
        ? controlCenterAPI.runPluginSetup(pluginId, setupId)
        : pluginHttpApiTransport.setup(pluginId, setupId),
    service: (pluginId, serviceId, operation) => {
        if (!usePluginDemoApi())
            return pluginHttpApiTransport.service(pluginId, serviceId, operation);
        if (operation === 'start')
            return controlCenterAPI.startPluginService(pluginId, serviceId);
        if (operation === 'stop')
            return controlCenterAPI.stopPluginService(pluginId, serviceId);
        return controlCenterAPI.checkPluginServiceHealth(pluginId, serviceId);
    },
    servicePolicy: (pluginId, serviceId, policy) => usePluginDemoApi()
        ? controlCenterAPI.savePluginServiceHealthPolicy(pluginId, serviceId, policy as any)
        : pluginHttpApiTransport.servicePolicy(pluginId, serviceId, policy),
    storage: (pluginId) => usePluginDemoApi()
        ? controlCenterAPI.clearPluginStorage(pluginId)
        : pluginHttpApiTransport.storage(pluginId),
    creatorFlow: (prompt) => usePluginDemoApi()
        ? controlCenterAPI.runCreatorStudioDefaultFlow(prompt)
        : pluginHttpApiTransport.creatorFlow(prompt),
    imSecret: (operation, token, credentials) => {
        if (operation === 'state')
            return controlCenterAPI.getImGatewaySecretState();
        if (operation === 'save')
            return controlCenterAPI.saveImGatewayTelegramBotToken(token || '');
        if (operation === 'save-wecom')
            return controlCenterAPI.saveImGatewayWecomCredentials(credentials || { corpSecret: '', token: '', encodingAesKey: '' });
        if (operation === 'clear-wecom')
            return controlCenterAPI.clearImGatewayWecomCredentials();
        return controlCenterAPI.clearImGatewayTelegramBotToken();
    },
    imQqCredentials: (operation, credentials) => {
        if (operation === 'state')
            return controlCenterAPI.getImGatewaySecretState();
        if (operation === 'save')
            return controlCenterAPI.saveImGatewayQqOfficialCredentials(credentials || { appId: '', clientSecret: '' });
        return controlCenterAPI.clearImGatewayQqOfficialCredentials();
    },
    exportLogs: (query = {}) => usePluginDemoApi()
        ? controlCenterAPI.exportPluginLogs(query as any)
        : pluginHttpApiTransport.exportLogs(query),
    clearLogs: () => usePluginDemoApi()
        ? controlCenterAPI.clearPluginLogs()
        : pluginHttpApiTransport.clearLogs(),
};
