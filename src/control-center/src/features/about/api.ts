import * as v from '../../../../shared/browser-validation.ts';
import type { Job } from '@openpet/contracts';
import { backendClient } from '../../api/backend-client.ts';
import type { ApiClient } from '../../api/client.ts';
import { cloneAboutInfo, cloneUpdateCheck, defaultAboutInfo, defaultUpdateCheck } from '../../lib/defaults.ts';
import type { AboutInfoViewState, UpdateCheckViewState } from '../../../../shared/openpet-contracts.ts';
const updateSourceSchema = v.object({
    configured: v.boolean(),
    provider: v.string(),
    owner: v.optional(v.string()),
    repo: v.optional(v.string()),
    channel: v.string(),
    url: v.string(),
});
const aboutInfoSchema = v.object({
    name: v.string(),
    productName: v.string(),
    version: v.string(),
    packaged: v.boolean(),
    platform: v.string(),
    arch: v.string(),
    update: updateSourceSchema,
});
const updateAssetSchema = v.object({
    name: v.string(),
    url: v.string(),
    size: v.pipe(v.number(), v.minValue(0)),
    contentType: v.string(),
});
const updateCheckSchema = v.object({
    status: v.pipe(v.string(), v.minLength(1)),
    configured: v.boolean(),
    currentVersion: v.string(),
    latestVersion: v.string(),
    updateAvailable: v.boolean(),
    prerelease: v.boolean(),
    releaseUrl: v.string(),
    assets: v.array(updateAssetSchema),
    checkedAt: v.string(),
    message: v.string(),
});
const emptyRequestSchema = v.strictObject({});
const updateJobSchema = v.object({ jobId: v.pipe(v.string(), v.minLength(1)) });
export type AboutUpdateStart = {
    jobId: string;
} | {
    result: UpdateCheckViewState;
};
export type AboutUpdateJobResolution = {
    kind: 'pending';
} | {
    kind: 'succeeded';
    result: UpdateCheckViewState;
} | {
    kind: 'failed';
    message: string;
};
export function createAboutHttpApi(client: ApiClient = backendClient) {
    return {
        info(): Promise<AboutInfoViewState> {
            return client.request({
                method: 'GET',
                path: '/about',
                responseSchema: aboutInfoSchema,
            });
        },
        checkUpdates(): Promise<{
            jobId: string;
        }> {
            return client.request({
                method: 'POST',
                path: '/about/check-updates',
                requestSchema: emptyRequestSchema,
                body: {},
                responseSchema: updateJobSchema,
                job: true,
                retry: false,
            });
        },
    };
}
export function resolveAboutUpdateJob(job: Job | null): AboutUpdateJobResolution {
    if (!job || job.status === 'queued' || job.status === 'running')
        return { kind: 'pending' };
    if (job.status === 'succeeded') {
        const parsed = v.safeParse(updateCheckSchema, job.result);
        return parsed.success
            ? { kind: 'succeeded', result: parsed.output }
            : { kind: 'failed', message: 'Update check returned an invalid result.' };
    }
    if (job.status === 'failed') {
        return { kind: 'failed', message: job.error?.message || 'Update check failed.' };
    }
    if (job.status === 'canceled') {
        return { kind: 'failed', message: 'Update check was canceled.' };
    }
    return { kind: 'failed', message: job.error?.message || 'Update check was interrupted.' };
}
export function shouldUseAboutDemoApi(isDevelopment: boolean, hasBackendBridge: boolean): boolean {
    return isDevelopment && !hasBackendBridge;
}
const httpApi = createAboutHttpApi();
const useDemoApi = () => shouldUseAboutDemoApi(import.meta.env?.DEV === true, Boolean((globalThis as {
    openpetBackend?: unknown;
}).openpetBackend));
export const aboutApi: {
    info: () => Promise<AboutInfoViewState>;
    checkUpdates: () => Promise<AboutUpdateStart>;
} = {
    info: async () => useDemoApi() ? cloneAboutInfo(defaultAboutInfo) : httpApi.info(),
    checkUpdates: async () => useDemoApi()
        ? {
            result: cloneUpdateCheck({
                ...defaultUpdateCheck,
                status: 'not-configured',
                message: 'Update feed is not configured.',
            }),
        }
        : httpApi.checkUpdates(),
};
