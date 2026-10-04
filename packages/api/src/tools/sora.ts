import { logger } from '@librechat/data-schemas';
import type { Dispatcher } from 'undici';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Azure OpenAI Sora video generation (preview).
 *
 * Job lifecycle against the v1 surface (`api-version=preview`):
 *   POST {endpoint}/openai/v1/video/generations/jobs
 *   GET  {endpoint}/openai/v1/video/generations/jobs/{jobId}
 *   GET  {endpoint}/openai/v1/video/generations/{generationId}/content/video
 *
 * The client is a plain injected-fetch wrapper so tests drive the whole
 * lifecycle without network access, and callers own request settings
 * (proxy dispatcher, abort signal) instead of the module reading globals.
 */

export const SORA_VIDEO_API_PREFIX = 'openai/v1/video/generations';
export const DEFAULT_SORA_API_VERSION = 'preview';
export const SORA_JOB_POLL_INTERVAL_MS = 5000;
/** Video jobs can run for minutes; the default ceiling matches common preview latency. */
export const SORA_JOB_TIMEOUT_MS: number = 15 * 60 * 1000;
export const SORA_MAX_POLL_ERRORS = 3;

export const SORA_MIN_DIMENSION = 128;
export const SORA_MAX_DIMENSION = 1920;
export const SORA_MAX_SECONDS = 60;
export const SORA_MAX_PROMPT_LENGTH = 32000;

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export type SoraErrorCode =
  | 'invalid_request'
  | 'submit_failed'
  | 'status_failed'
  | 'job_failed'
  | 'job_cancelled'
  | 'job_timeout'
  | 'aborted'
  | 'no_generations'
  | 'download_failed';

export interface SoraError {
  code: SoraErrorCode;
  /** User-safe summary; never carries raw provider payloads, headers, or credentials. */
  message: string;
  status?: number;
}

export type SoraResult<T> = { ok: true; value: T } | { ok: false; error: SoraError };

const ok = <T>(value: T): SoraResult<T> => ({ ok: true, value });
const err = <T>(error: SoraError): SoraResult<T> => ({ ok: false, error });

export interface SoraVideoClientConfig {
  /** Azure OpenAI resource endpoint, e.g. `https://<resource>.openai.azure.com`. */
  endpoint: string;
  apiKey: string;
  /** `preview` while the video API is in preview. */
  apiVersion?: string;
  /** Undici dispatcher for proxy support (see `getProxyDispatcher`). */
  dispatcher?: Dispatcher;
  /** Fetch implementation; injectable for tests. */
  fetchFn?: typeof fetch;
}

export interface SoraVideoJobRequest {
  prompt: string;
  /** Model/deployment name sent in the job body. */
  model: string;
  width?: number;
  height?: number;
  n_seconds?: number;
}

export interface SoraVideoJob {
  id: string;
  status: string;
  generations?: Array<{ id: string; [key: string]: unknown }>;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

export interface SoraVideoContent {
  bytes: ArrayBuffer;
  contentType: string;
}

export interface SoraGeneratedVideo extends SoraVideoContent {
  jobId: string;
  generationId: string;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError';
}

/** Strips trailing slashes so path joins behave on `https://host/` and `https://host` alike. */
export function normalizeAzureEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

export function soraVideoUrl(endpoint: string, apiVersion: string, suffix: string): string {
  const base = `${normalizeAzureEndpoint(endpoint)}/${SORA_VIDEO_API_PREFIX}${suffix}`;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}api-version=${encodeURIComponent(apiVersion)}`;
}

/** A request argument the API would reject on sight; checked before any network call. */
export function validateSoraVideoRequest(
  request: SoraVideoJobRequest,
): SoraResult<SoraVideoJobRequest> {
  const prompt = request.prompt?.trim();
  if (!prompt) {
    return err({ code: 'invalid_request', message: 'A non-empty `prompt` is required.' });
  }
  if (prompt.length > SORA_MAX_PROMPT_LENGTH) {
    return err({
      code: 'invalid_request',
      message: `\`prompt\` exceeds ${SORA_MAX_PROMPT_LENGTH} characters.`,
    });
  }
  if (!request.model?.trim()) {
    return err({
      code: 'invalid_request',
      message: 'A Sora `model` (Azure deployment name) is required.',
    });
  }
  const { width, height, n_seconds } = request;
  if ((width == null) !== (height == null)) {
    return err({
      code: 'invalid_request',
      message: '`width` and `height` must be provided together, or neither.',
    });
  }
  for (const [name, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (
      value != null &&
      (!Number.isInteger(value) || value < SORA_MIN_DIMENSION || value > SORA_MAX_DIMENSION)
    ) {
      return err({
        code: 'invalid_request',
        message: `\`${name}\` must be an integer between ${SORA_MIN_DIMENSION} and ${SORA_MAX_DIMENSION}.`,
      });
    }
  }
  if (
    n_seconds != null &&
    (!Number.isInteger(n_seconds) || n_seconds < 1 || n_seconds > SORA_MAX_SECONDS)
  ) {
    return err({
      code: 'invalid_request',
      message: `\`n_seconds\` must be an integer between 1 and ${SORA_MAX_SECONDS}.`,
    });
  }
  return ok({ ...request, prompt });
}

interface SoraRequestContext {
  fetchFn: typeof fetch;
  headers: Record<string, string>;
  apiVersion: string;
  endpoint: string;
  dispatcher?: Dispatcher;
}

async function soraFetch(
  ctx: SoraRequestContext,
  suffix: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const url = soraVideoUrl(ctx.endpoint, ctx.apiVersion, suffix);
  const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
    ...init,
    headers: { ...ctx.headers, ...(init.headers ?? {}) },
  };
  if (ctx.dispatcher) {
    requestInit.dispatcher = ctx.dispatcher;
  }
  if (signal) {
    requestInit.signal = signal;
  }
  return ctx.fetchFn(url, requestInit);
}

/** Reads a bounded slice of an error body for logs; the client surface never sees it. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 512);
  } catch {
    return '';
  }
}

export interface SoraVideoClient {
  submitJob(request: SoraVideoJobRequest, signal?: AbortSignal): Promise<SoraResult<SoraVideoJob>>;
  getJob(jobId: string, signal?: AbortSignal): Promise<SoraResult<SoraVideoJob>>;
  downloadVideo(generationId: string, signal?: AbortSignal): Promise<SoraResult<SoraVideoContent>>;
}

export function createSoraVideoClient(config: SoraVideoClientConfig): SoraVideoClient {
  const apiVersion = config.apiVersion ?? DEFAULT_SORA_API_VERSION;
  const ctx: SoraRequestContext = {
    fetchFn: config.fetchFn ?? fetch,
    endpoint: config.endpoint,
    apiVersion,
    dispatcher: config.dispatcher,
    headers: {
      'api-key': config.apiKey,
      'Content-Type': 'application/json',
    },
  };

  async function submitJob(
    request: SoraVideoJobRequest,
    signal?: AbortSignal,
  ): Promise<SoraResult<SoraVideoJob>> {
    let response: Response;
    try {
      response = await soraFetch(
        ctx,
        '/jobs',
        { method: 'POST', body: JSON.stringify(request) },
        signal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        return err({ code: 'aborted', message: 'Video generation request was aborted.' });
      }
      logger.debug('[sora] Job submit failed', getSafeErrorMetadata(error));
      return err({
        code: 'submit_failed',
        message: 'Could not reach the Azure OpenAI video generation endpoint.',
      });
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      logger.debug(`[sora] Job submit HTTP ${response.status}: ${detail}`);
      return err({
        code: 'submit_failed',
        message: `Azure OpenAI rejected the video generation request (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    try {
      const job = (await response.json()) as SoraVideoJob;
      if (!job || typeof job.id !== 'string' || job.id.length === 0) {
        return err({
          code: 'submit_failed',
          message: 'The video generation response did not include a job id.',
        });
      }
      return ok(job);
    } catch {
      return err({
        code: 'submit_failed',
        message: 'The video generation response was not valid JSON.',
      });
    }
  }

  async function getJob(jobId: string, signal?: AbortSignal): Promise<SoraResult<SoraVideoJob>> {
    let response: Response;
    try {
      response = await soraFetch(
        ctx,
        `/jobs/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
        signal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        return err({ code: 'aborted', message: 'Video generation request was aborted.' });
      }
      logger.debug('[sora] Job status poll failed', getSafeErrorMetadata(error));
      return err({
        code: 'status_failed',
        message: 'Could not reach the Azure OpenAI video job status endpoint.',
      });
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      logger.debug(`[sora] Job status HTTP ${response.status}: ${detail}`);
      return err({
        code: 'status_failed',
        message: `Video job status request failed (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    try {
      return ok((await response.json()) as SoraVideoJob);
    } catch {
      return err({
        code: 'status_failed',
        message: 'The video job status response was not valid JSON.',
      });
    }
  }

  async function downloadVideo(
    generationId: string,
    signal?: AbortSignal,
  ): Promise<SoraResult<SoraVideoContent>> {
    let response: Response;
    try {
      response = await soraFetch(
        ctx,
        `/${encodeURIComponent(generationId)}/content/video`,
        { method: 'GET' },
        signal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        return err({ code: 'aborted', message: 'Video download was aborted.' });
      }
      logger.debug('[sora] Video download failed', getSafeErrorMetadata(error));
      return err({
        code: 'download_failed',
        message: 'Could not reach the Azure OpenAI video download endpoint.',
      });
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      logger.debug(`[sora] Video download HTTP ${response.status}: ${detail}`);
      return err({
        code: 'download_failed',
        message: `Video download failed (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) {
      return err({ code: 'download_failed', message: 'The generated video download was empty.' });
    }
    return ok({ bytes, contentType: response.headers.get('content-type') ?? 'video/mp4' });
  }

  return { submitJob, getJob, downloadVideo };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface GenerateSoraVideoOptions {
  client: SoraVideoClient;
  request: SoraVideoJobRequest;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable so tests run the poll loop without real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export async function generateSoraVideo({
  client,
  request,
  pollIntervalMs = SORA_JOB_POLL_INTERVAL_MS,
  timeoutMs = SORA_JOB_TIMEOUT_MS,
  signal,
  sleep = defaultSleep,
}: GenerateSoraVideoOptions): Promise<SoraResult<SoraGeneratedVideo>> {
  const validated = validateSoraVideoRequest(request);
  if (!validated.ok) {
    return validated;
  }

  if (signal?.aborted) {
    return err({ code: 'aborted', message: 'Video generation request was aborted.' });
  }

  const submitted = await client.submitJob(validated.value, signal);
  if (!submitted.ok) {
    return submitted;
  }
  const jobId = submitted.value.id;

  const deadline = Date.now() + timeoutMs;
  let consecutivePollErrors = 0;
  let job: SoraVideoJob = submitted.value;

  while (!TERMINAL_JOB_STATUSES.has(job.status)) {
    if (signal?.aborted) {
      return err({ code: 'aborted', message: 'Video generation request was aborted.' });
    }
    if (Date.now() >= deadline) {
      return err({
        code: 'job_timeout',
        message: `Video generation did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
      });
    }
    await sleep(pollIntervalMs);
    const polled = await client.getJob(jobId, signal);
    if (!polled.ok) {
      if (polled.error.code === 'aborted') {
        return polled;
      }
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= SORA_MAX_POLL_ERRORS) {
        return polled;
      }
      continue;
    }
    consecutivePollErrors = 0;
    job = polled.value;
  }

  if (job.status === 'failed') {
    const reason =
      typeof job.error?.message === 'string' && job.error.message.length > 0
        ? ` Reason: ${job.error.message.slice(0, 256)}`
        : '';
    return err({
      code: 'job_failed',
      message: `Azure OpenAI reported the video generation job as failed.${reason}`,
    });
  }
  if (job.status === 'cancelled') {
    return err({ code: 'job_cancelled', message: 'The video generation job was cancelled.' });
  }

  const generationId = job.generations?.[0]?.id;
  if (typeof generationId !== 'string' || generationId.length === 0) {
    return err({
      code: 'no_generations',
      message: 'The video generation job succeeded but returned no video.',
    });
  }

  const video = await client.downloadVideo(generationId, signal);
  if (!video.ok) {
    return video;
  }
  return ok({ ...video.value, jobId, generationId });
}
