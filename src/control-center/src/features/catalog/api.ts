import * as v from '../../../../shared/browser-validation.ts';
import type { Job } from '@openpet/contracts';
import { backendClient } from '../../api/backend-client.ts';
import { controlCenterAPI } from '../../api/control-center-api.ts';
import type { ApiClient } from '../../api/client.ts';
import type { CatalogBlocklistEntry, CatalogBlocklistResult, CatalogDemoApi, CatalogInstallRequest, CatalogInstallResult, CatalogInstallSelection, CatalogState, } from '../../../../shared/openpet-contracts.ts';
const blocklistSchema = v.object({
    pluginIds: v.array(v.string()),
    packIds: v.array(v.string()),
    sha256: v.array(v.string()),
});
const reviewStateSchema = v.object({ blocked: v.boolean(), reasons: v.array(v.string()) });
const pluginEntrySchema = v.looseObject({
    id: v.string(),
    name: v.string(),
    version: v.string(),
    author: v.optional(v.string()),
    description: v.optional(v.string()),
    openpetApiVersion: v.optional(v.string()),
    permissions: v.optional(v.array(v.string())),
    downloadable: v.optional(v.boolean()),
    installed: v.optional(v.boolean()),
    installedVersion: v.optional(v.string()),
    updateAvailable: v.optional(v.boolean()),
    sha256: v.optional(v.string()),
    reportUrl: v.optional(v.string()),
    blockStatus: v.optional(reviewStateSchema),
});
const petPackEntrySchema = v.looseObject({
    id: v.string(),
    displayName: v.string(),
    version: v.string(),
    author: v.optional(v.string()),
    description: v.optional(v.string()),
    previewImage: v.optional(v.string()),
    actionCount: v.optional(v.number()),
    downloadable: v.optional(v.boolean()),
    installed: v.optional(v.boolean()),
    installedVersion: v.optional(v.string()),
    updateAvailable: v.optional(v.boolean()),
    sha256: v.optional(v.string()),
    reportUrl: v.optional(v.string()),
    blockStatus: v.optional(reviewStateSchema),
});
const catalogStateSchema = v.object({
    schemaVersion: v.number(),
    updatedAt: v.string(),
    feedbackUrl: v.string(),
    localBlocklist: blocklistSchema,
    catalogBlocklist: blocklistSchema,
    blocklist: blocklistSchema,
    plugins: v.array(pluginEntrySchema),
    petPacks: v.array(petPackEntrySchema),
});
const prepareRequestSchema = v.strictObject({
    kind: v.picklist(['plugin', 'pet-pack']),
    itemId: v.pipe(v.string(), v.minLength(1)),
});
const selectionRequestSchema = v.strictObject({ selectionId: v.pipe(v.string(), v.minLength(1)) });
const blocklistEntrySchema = v.strictObject({
    type: v.picklist(['pluginId', 'packId', 'sha256']),
    value: v.pipe(v.string(), v.minLength(1)),
});
const installSelectionSchema = v.union([
    v.looseObject({
        kind: v.literal('plugin'),
        itemId: v.string(),
        selectionId: v.pipe(v.string(), v.minLength(1)),
        sourcePackageHash: v.string(),
        pluginReview: v.unknown(),
    }),
    v.looseObject({
        kind: v.literal('pet-pack'),
        itemId: v.string(),
        selectionId: v.pipe(v.string(), v.minLength(1)),
        sourcePackageHash: v.string(),
        petPackReview: v.unknown(),
    }),
]);
const okSchema = v.looseObject({ ok: v.boolean() });
const blocklistResultSchema = v.object({ catalog: catalogStateSchema, blocklist: blocklistSchema });
const installJobSchema = v.object({ jobId: v.pipe(v.string(), v.minLength(1)) });
const installResultSchema = v.looseObject({
    ok: v.boolean(),
    kind: v.optional(v.picklist(['plugin', 'pet-pack'])),
    itemId: v.optional(v.string()),
    catalog: catalogStateSchema,
});
export type CatalogInstallStart = {
    jobId: string;
} | {
    result: CatalogInstallResult;
};
export type CatalogInstallJobResolution = {
    kind: 'pending';
} | {
    kind: 'succeeded';
    result: CatalogInstallResult;
} | {
    kind: 'failed';
    message: string;
};
export function createCatalogHttpApi(client: ApiClient = backendClient) {
    return {
        list(): Promise<CatalogState> {
            return client.request({ method: 'GET', path: '/catalog', responseSchema: catalogStateSchema }) as Promise<CatalogState>;
        },
        prepare(body: CatalogInstallRequest): Promise<CatalogInstallSelection> {
            return client.request({
                method: 'POST',
                path: '/catalog/prepare',
                requestSchema: prepareRequestSchema,
                body,
                responseSchema: installSelectionSchema,
                timeoutMs: 60000,
                retry: false,
            }) as Promise<CatalogInstallSelection>;
        },
        install(selectionId: string): Promise<{
            jobId: string;
        }> {
            return client.request({
                method: 'POST',
                path: '/catalog/install',
                requestSchema: selectionRequestSchema,
                body: { selectionId },
                responseSchema: installJobSchema,
                job: true,
                retry: false,
            });
        },
        clearSelection(selectionId: string): Promise<{
            ok: boolean;
        }> {
            return client.request({
                method: 'POST',
                path: '/catalog/clear-selection',
                requestSchema: selectionRequestSchema,
                body: { selectionId },
                responseSchema: okSchema,
                retry: false,
            });
        },
        addBlocklistEntry(body: CatalogBlocklistEntry): Promise<CatalogBlocklistResult> {
            return client.request({
                method: 'POST',
                path: '/catalog/blocklist',
                requestSchema: blocklistEntrySchema,
                body,
                responseSchema: blocklistResultSchema,
                retry: false,
            }) as Promise<CatalogBlocklistResult>;
        },
        removeBlocklistEntry(entry: CatalogBlocklistEntry): Promise<CatalogBlocklistResult> {
            const path = `/catalog/blocklist/${encodeURIComponent(entry.value)}?type=${encodeURIComponent(entry.type)}`;
            return client.request({ method: 'DELETE', path, responseSchema: blocklistResultSchema, retry: false }) as Promise<CatalogBlocklistResult>;
        },
    };
}
export function resolveCatalogInstallJob(job: Job | null): CatalogInstallJobResolution {
    if (!job || job.status === 'queued' || job.status === 'running')
        return { kind: 'pending' };
    if (job.status === 'succeeded') {
        const parsed = v.safeParse(installResultSchema, job.result);
        return parsed.success
            ? { kind: 'succeeded', result: parsed.output as CatalogInstallResult }
            : { kind: 'failed', message: 'Catalog install returned an invalid result.' };
    }
    if (job.status === 'failed')
        return { kind: 'failed', message: job.error?.message || 'Catalog install failed.' };
    if (job.status === 'canceled')
        return { kind: 'failed', message: 'Catalog install was canceled.' };
    return { kind: 'failed', message: job.error?.message || 'Catalog install was interrupted.' };
}
export function shouldUseCatalogDemoApi(isDevelopment: boolean, hasBackendBridge: boolean): boolean {
    return isDevelopment && !hasBackendBridge;
}
const httpApi = createCatalogHttpApi();
const demoApi = controlCenterAPI as unknown as CatalogDemoApi;
const useDemoApi = () => shouldUseCatalogDemoApi(import.meta.env?.DEV === true, Boolean((globalThis as {
    openpetBackend?: unknown;
}).openpetBackend));
export const catalogApi = {
    list: (): Promise<CatalogState> => useDemoApi() ? demoApi.getCatalog() : httpApi.list(),
    prepare: (request: CatalogInstallRequest): Promise<CatalogInstallSelection> => useDemoApi()
        ? demoApi.prepareCatalogInstall(request)
        : httpApi.prepare(request),
    install: async (selectionId: string): Promise<CatalogInstallStart> => useDemoApi()
        ? { result: await demoApi.installCatalogSelection(selectionId) }
        : httpApi.install(selectionId),
    clearSelection: (selectionId: string) => useDemoApi()
        ? demoApi.clearCatalogSelection(selectionId)
        : httpApi.clearSelection(selectionId),
    addBlocklistEntry: (entry: CatalogBlocklistEntry) => useDemoApi()
        ? demoApi.addCatalogBlocklistEntry(entry)
        : httpApi.addBlocklistEntry(entry),
    removeBlocklistEntry: (entry: CatalogBlocklistEntry) => useDemoApi()
        ? demoApi.removeCatalogBlocklistEntry(entry)
        : httpApi.removeBlocklistEntry(entry),
};
