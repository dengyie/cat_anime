import * as v from '../../../../shared/browser-validation.ts';
import { EVENT_PET_PACK_ACTIVATED, type Job } from '../../../../shared/browser-contracts.ts';
import { backendClient } from '../../api/backend-client.ts';
import type { ApiClient } from '../../api/client.ts';
import { controlCenterAPI } from '../../api/control-center-api.ts';
import type { PetPackExportResult, PetPackMutationResult, PetPacksViewState } from '../../../../shared/openpet-contracts.ts';
const blockStatusSchema = v.object({
    blocked: v.boolean(),
    reasons: v.array(v.string()),
});
const petPackSummarySchema = v.looseObject({
    id: v.pipe(v.string(), v.minLength(1)),
    displayName: v.string(),
    version: v.string(),
    source: v.string(),
    rootPath: v.string(),
    active: v.optional(v.boolean()),
    installedAt: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
    packageHash: v.optional(v.string()),
    sourcePackageHash: v.optional(v.string()),
    provenance: v.optional(v.record(v.string(), v.unknown())),
    actionCount: v.optional(v.pipe(v.pipe(v.number(), v.integer()), v.minValue(0))),
    defaultAction: v.optional(v.string()),
    clickAction: v.optional(v.string()),
    previewSprite: v.optional(v.string()),
    previewAction: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
    valid: v.optional(v.boolean()),
    error: v.optional(v.string()),
    blockStatus: v.optional(blockStatusSchema),
    conflict: v.optional(v.record(v.string(), v.unknown())),
});
const petPacksSchema = v.object({
    activePackId: v.string(),
    packs: v.array(petPackSummarySchema),
});
const actionsSchema = v.looseObject({
    defaultAction: v.string(),
    clickAction: v.string(),
    actions: v.array(v.record(v.string(), v.unknown())),
    triggerRules: v.optional(v.array(v.unknown())),
    triggerProposalInbox: v.optional(v.array(v.unknown())),
});
const mutationSchema = v.looseObject({
    pack: v.optional(petPackSummarySchema),
    activePackId: v.optional(v.string()),
    petPacks: petPacksSchema,
    animations: v.optional(actionsSchema),
});
const exportResultSchema = v.union([
    v.object({ canceled: v.literal(true) }),
    v.looseObject({
        canceled: v.optional(v.literal(false)),
        packId: v.pipe(v.string(), v.minLength(1)),
        fileName: v.pipe(v.string(), v.minLength(1)),
        outputPath: v.optional(v.string()),
        sha256: v.optional(v.string()),
        byteSize: v.optional(v.pipe(v.pipe(v.number(), v.integer()), v.minValue(0))),
    }),
]);
const jobStartSchema = v.object({ jobId: v.pipe(v.string(), v.minLength(1)) });
const emptyRequestSchema = v.strictObject({});
const importRequestSchema = v.strictObject({ selectionId: v.pipe(v.string(), v.minLength(1)) });
const clearRequestSchema = v.strictObject({
    operation: v.literal('clear-selection'),
    selectionId: v.pipe(v.string(), v.minLength(1)),
});
export type PetPackJobKind = 'import' | 'export';
export type PetPackJobStart<T> = {
    jobId: string;
} | {
    result: T;
};
export type PetPackJobResolution = {
    kind: 'pending';
} | {
    kind: 'succeeded';
    result: PetPackMutationResult | PetPackExportResult;
} | {
    kind: 'failed';
    message: string;
};
export function nextPetPackActivationEventId(event: {
    lastEventId: string | null;
    lastEventName: string | null;
}, lastHandledEventId: string | null): string | null {
    if (event.lastEventName !== EVENT_PET_PACK_ACTIVATED)
        return null;
    if (!event.lastEventId || event.lastEventId === lastHandledEventId)
        return null;
    return event.lastEventId;
}
export function createPetPackHttpApi(client: ApiClient = backendClient) {
    return {
        list(): Promise<PetPacksViewState> {
            return client.request({ method: 'GET', path: '/pet-packs', responseSchema: petPacksSchema }) as Promise<PetPacksViewState>;
        },
        clearSelection(selectionId: string): Promise<{
            ok: boolean;
        }> {
            return client.request({
                method: 'POST',
                path: '/pet-packs/validate',
                requestSchema: clearRequestSchema,
                body: { operation: 'clear-selection', selectionId },
                responseSchema: v.object({ ok: v.boolean() }),
                retry: false,
            });
        },
        import(selectionId: string): Promise<{
            jobId: string;
        }> {
            return client.request({
                method: 'POST',
                path: '/pet-packs/import',
                requestSchema: importRequestSchema,
                body: { selectionId },
                responseSchema: jobStartSchema,
                job: true,
                retry: false,
            });
        },
        export(packId: string): Promise<{
            jobId: string;
        }> {
            return client.request({
                method: 'POST',
                path: `/pet-packs/${encodeURIComponent(packId)}/export`,
                requestSchema: emptyRequestSchema,
                body: {},
                responseSchema: jobStartSchema,
                job: true,
                retry: false,
            });
        },
        activate(packId: string): Promise<PetPackMutationResult> {
            return client.request({
                method: 'POST',
                path: `/pet-packs/${encodeURIComponent(packId)}/activate`,
                requestSchema: emptyRequestSchema,
                body: {},
                responseSchema: mutationSchema,
                retry: false,
            }) as Promise<PetPackMutationResult>;
        },
        remove(packId: string): Promise<PetPackMutationResult> {
            return client.request({
                method: 'DELETE',
                path: `/pet-packs/${encodeURIComponent(packId)}`,
                responseSchema: mutationSchema,
                retry: false,
            }) as Promise<PetPackMutationResult>;
        },
    };
}
export function resolvePetPackJob(job: Job | null, expectedKind: PetPackJobKind): PetPackJobResolution {
    if (!job || job.status === 'queued' || job.status === 'running')
        return { kind: 'pending' };
    if (job.status === 'succeeded') {
        const parsed = expectedKind === 'import'
            ? v.safeParse(mutationSchema, job.result) : v.safeParse(exportResultSchema, job.result);
        return parsed.success
            ? { kind: 'succeeded', result: parsed.output as PetPackMutationResult | PetPackExportResult }
            : { kind: 'failed', message: `Pet pack ${expectedKind} returned an invalid result.` };
    }
    if (job.status === 'failed')
        return { kind: 'failed', message: job.error?.message || `Pet pack ${expectedKind} failed.` };
    if (job.status === 'canceled')
        return { kind: 'failed', message: `Pet pack ${expectedKind} was canceled.` };
    return { kind: 'failed', message: job.error?.message || `Pet pack ${expectedKind} was interrupted.` };
}
const httpApi = createPetPackHttpApi();
const useDemoApi = () => import.meta.env?.DEV === true && !Boolean((globalThis as {
    openpetBackend?: unknown;
}).openpetBackend);
export const petPackApi = {
    inspect: () => controlCenterAPI.inspectPetPackDirectory(),
    list: (): Promise<PetPacksViewState> => useDemoApi() ? controlCenterAPI.listPetPacks() : httpApi.list(),
    clearSelection: (selectionId: string) => useDemoApi()
        ? controlCenterAPI.clearPetPackSelection(selectionId)
        : httpApi.clearSelection(selectionId),
    import: async (selectionId: string): Promise<PetPackJobStart<PetPackMutationResult>> => useDemoApi()
        ? { result: await controlCenterAPI.importPetPack(selectionId) }
        : httpApi.import(selectionId),
    export: async (packId: string): Promise<PetPackJobStart<PetPackExportResult>> => useDemoApi()
        ? { result: await controlCenterAPI.exportPetPack(packId) }
        : httpApi.export(packId),
    activate: (packId: string): Promise<PetPackMutationResult> => useDemoApi()
        ? controlCenterAPI.setActivePetPack(packId)
        : httpApi.activate(packId),
    remove: (packId: string): Promise<PetPackMutationResult> => useDemoApi()
        ? controlCenterAPI.removePetPack(packId)
        : httpApi.remove(packId),
};
