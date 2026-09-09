import {
  ERROR_CODES,
  HEADER,
  apiFailureSchema,
  apiSuccessSchema,
  type ApiError as ContractApiError,
  type ErrorCode,
} from '../../../shared/browser-contracts.ts'
import * as v from 'valibot'

import type { RequestInput, Transport } from './transport.ts'

export const DEFAULT_TIMEOUT_MS = 15_000
export const JOB_TIMEOUT_MS = 30_000
export const MAX_RETRIES = 2

const RETRY_DELAYS_MS = [250, 500] as const
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

type ContractSchema = v.GenericSchema
type SchemaValue<TSchema extends ContractSchema> = v.InferOutput<TSchema>

type RequestBase<TResponseSchema extends ContractSchema> = {
  path: string
  method?: string
  responseSchema: TResponseSchema
  headers?: HeadersInit
  signal?: AbortSignal
  timeoutMs?: number
  idempotencyKey?: string
  job?: boolean
  retry?: boolean
}

export type ApiRequest<
  TResponseSchema extends ContractSchema,
  TRequestSchema extends ContractSchema | undefined = undefined,
> = RequestBase<TResponseSchema> & (TRequestSchema extends ContractSchema
  ? { requestSchema: TRequestSchema; body: SchemaValue<TRequestSchema> }
  : { requestSchema?: never; body?: never })

export type ApiClient = {
  request<
    TResponseSchema extends ContractSchema,
    TRequestSchema extends ContractSchema | undefined = undefined,
  >(input: ApiRequest<TResponseSchema, TRequestSchema>): Promise<SchemaValue<TResponseSchema>>
}

export class ApiError extends Error implements ContractApiError {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>
  readonly retryable: boolean
  readonly requestId: string
  readonly dispatched: boolean

  constructor(error: ContractApiError, options?: ErrorOptions & { dispatched?: boolean }) {
    super(error.message, options)
    this.name = 'ApiError'
    this.code = error.code
    this.details = error.details
    this.retryable = error.retryable
    this.requestId = error.requestId
    this.dispatched = options?.dispatched ?? true
  }
}

function createRequestId() {
  return `r_${crypto.randomUUID()}`
}

function createIdempotencyKey() {
  return `i_${crypto.randomUUID()}`
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

function normalizeTransportError(error: unknown, requestId: string) {
  if (error instanceof ApiError) return error
  const dispatched = (error as { dispatched?: unknown } | null)?.dispatched !== false
  const cause = (error as { cause?: unknown } | null)?.cause
  const source = cause instanceof Error ? cause : error
  const abortName = source instanceof DOMException ? source.name : ''
  if (abortName === 'TimeoutError') {
    return new ApiError({
      code: 'PROVIDER_TIMEOUT',
      message: 'Backend request timed out',
      retryable: true,
      requestId,
    }, { cause: error, dispatched })
  }
  if (abortName === 'AbortError') {
    return new ApiError({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend request was canceled',
      retryable: false,
      requestId,
    }, { cause: error, dispatched })
  }
  const code = isErrorCode((error as { code?: unknown } | null)?.code)
    ? (error as { code: ErrorCode }).code
    : 'BACKEND_UNAVAILABLE'
  return new ApiError({
    code,
    message: source instanceof Error ? source.message : 'Backend request failed',
    retryable: code === 'BACKEND_UNAVAILABLE',
    requestId,
  }, { cause: error, dispatched })
}

async function responsePayload(response: unknown): Promise<unknown> {
  if (typeof Response !== 'undefined' && response instanceof Response) {
    try {
      return await response.json()
    } catch (error) {
      throw new ApiError({
        code: 'INTERNAL',
        message: 'Backend returned a non-JSON response',
        retryable: false,
        requestId: response.headers.get(HEADER.requestId) || 'unknown',
      }, { cause: error, dispatched: true })
    }
  }
  return response
}

function unpack<TSchema extends ContractSchema>(
  payload: unknown,
  responseSchema: TSchema,
  requestId: string,
): SchemaValue<TSchema> {
  const failure = v.safeParse(apiFailureSchema, payload)
  if (failure.success) throw new ApiError(failure.output.error, { dispatched: true })

  const success = v.safeParse(apiSuccessSchema(responseSchema), payload)
  if (success.success) {
    return (success.output as { data: SchemaValue<TSchema> }).data
  }

  throw new ApiError({
    code: 'INTERNAL',
    message: 'Backend response does not match the API contract',
    details: { issues: success.issues?.map(({ message, type }) => ({ message, type })) },
    retryable: false,
    requestId,
  }, { dispatched: true })
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createApiClient(transport: Transport): ApiClient {
  return {
    async request<
      TResponseSchema extends ContractSchema,
      TRequestSchema extends ContractSchema | undefined = undefined,
    >(input: ApiRequest<TResponseSchema, TRequestSchema>) {
      const method = (input.method || 'GET').toUpperCase()
      const requestId = createRequestId()
      const headers = new Headers(input.headers)
      headers.set(HEADER.requestId, requestId)
      headers.set(HEADER.client, 'control-center')

      const isWrite = !SAFE_METHODS.has(method)
      if (isWrite) {
        headers.set(HEADER.contentType, 'application/json')
        headers.set(HEADER.idempotencyKey, input.idempotencyKey || createIdempotencyKey())
      }

      const body = input.requestSchema
        ? JSON.stringify(v.parse(input.requestSchema, input.body))
        : undefined
      const timeoutMs = input.timeoutMs ?? (input.job ? JOB_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
      const idempotent = input.retry !== false && (SAFE_METHODS.has(method) || headers.has(HEADER.idempotencyKey))

      const request: RequestInput = {
        path: input.path,
        method,
        headers,
        body,
        signal,
      }

      for (let attempt = 0; ; attempt += 1) {
        try {
          const payload = await responsePayload(await transport.request<unknown>(request))
          return unpack(payload, input.responseSchema, requestId)
        } catch (error) {
          const apiError = normalizeTransportError(error, requestId)
          if (!apiError.retryable || !idempotent || attempt >= MAX_RETRIES) throw apiError
          try {
            await delay(RETRY_DELAYS_MS[attempt], signal)
          } catch (delayError) {
            throw normalizeTransportError(delayError, requestId)
          }
        }
      }
    },
  }
}
