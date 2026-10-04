import type { SoraVideoJobRequest } from './sora';
import {
  createSoraVideoClient,
  generateSoraVideo,
  normalizeAzureEndpoint,
  soraVideoUrl,
  validateSoraVideoRequest,
  DEFAULT_SORA_API_VERSION,
  SORA_JOB_TIMEOUT_MS,
  SORA_MAX_DIMENSION,
  SORA_MAX_PROMPT_LENGTH,
  SORA_MAX_SECONDS,
  SORA_MIN_DIMENSION,
} from './sora';

const ENDPOINT = 'https://example.openai.azure.com';
const API_KEY = 'test-api-key';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const videoResponse = (bytes: Uint8Array<ArrayBuffer>, status = 200): Response =>
  new Response(new Blob([bytes]), { status, headers: { 'Content-Type': 'video/mp4' } });

const textResponse = (body: string, status: number): Response => new Response(body, { status });

const baseRequest: SoraVideoJobRequest = {
  prompt: 'a hummingbird over a pond',
  model: 'sora-deployment',
};

const makeClient = (fetchFn: typeof fetch) =>
  createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });

const noSleep = async (): Promise<void> => {};

describe('normalizeAzureEndpoint / soraVideoUrl', () => {
  it('strips trailing slashes from the endpoint', () => {
    expect(normalizeAzureEndpoint('https://res.openai.azure.com/')).toBe(
      'https://res.openai.azure.com',
    );
    expect(normalizeAzureEndpoint('https://res.openai.azure.com///')).toBe(
      'https://res.openai.azure.com',
    );
  });

  it('builds the jobs URL under /openai/v1/video/generations with api-version', () => {
    expect(soraVideoUrl(`${ENDPOINT}/`, DEFAULT_SORA_API_VERSION, '/jobs')).toBe(
      `${ENDPOINT}/openai/v1/video/generations/jobs?api-version=${DEFAULT_SORA_API_VERSION}`,
    );
    expect(soraVideoUrl(ENDPOINT, '2025-05-01-preview', '/jobs/job-1')).toBe(
      `${ENDPOINT}/openai/v1/video/generations/jobs/job-1?api-version=2025-05-01-preview`,
    );
  });

  it('encodes the api-version value', () => {
    expect(soraVideoUrl(ENDPOINT, 'a b', '/jobs')).toContain('api-version=a%20b');
  });
});

describe('validateSoraVideoRequest', () => {
  it('accepts a minimal request and trims the prompt', () => {
    const result = validateSoraVideoRequest({ ...baseRequest, prompt: '  hi  ' });
    expect(result).toEqual({ ok: true, value: { ...baseRequest, prompt: 'hi' } });
  });

  it.each([
    ['empty prompt', { ...baseRequest, prompt: '   ' }],
    ['prompt over the limit', { ...baseRequest, prompt: 'x'.repeat(SORA_MAX_PROMPT_LENGTH + 1) }],
    ['missing model', { ...baseRequest, model: '' }],
    ['width without height', { ...baseRequest, width: 1280 }],
    ['height without width', { ...baseRequest, height: 720 }],
    ['non-integer width', { ...baseRequest, width: 1280.5, height: 720 }],
    ['width below bounds', { ...baseRequest, width: SORA_MIN_DIMENSION - 1, height: 720 }],
    ['height above bounds', { ...baseRequest, width: 1280, height: SORA_MAX_DIMENSION + 1 }],
    ['zero seconds', { ...baseRequest, n_seconds: 0 }],
    ['seconds over limit', { ...baseRequest, n_seconds: SORA_MAX_SECONDS + 1 }],
    ['fractional seconds', { ...baseRequest, n_seconds: 2.5 }],
  ])('rejects %s as invalid_request', (_label, request) => {
    const result = validateSoraVideoRequest(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_request');
    }
  });
});

describe('createSoraVideoClient', () => {
  it('submits a job to /jobs with the api-key header and JSON body', async () => {
    const fetchFn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe(`${ENDPOINT}/openai/v1/video/generations/jobs?api-version=preview`);
      const headers = init?.headers as Record<string, string>;
      expect(headers['api-key']).toBe(API_KEY);
      expect(JSON.parse(init?.body as string)).toEqual({
        prompt: 'a hummingbird over a pond',
        model: 'sora-deployment',
        width: 1280,
        height: 720,
        n_seconds: 5,
      });
      return jsonResponse({ id: 'job-1', status: 'preprocessing' });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchFn);
    const result = await client.submitJob({
      ...baseRequest,
      width: 1280,
      height: 720,
      n_seconds: 5,
    });
    expect(result).toEqual({ ok: true, value: { id: 'job-1', status: 'preprocessing' } });
  });

  it('returns submit_failed on HTTP errors without leaking the response body', async () => {
    const fetchFn = jest.fn(async () =>
      textResponse('{"error":{"message":"model not deployed","key":"secret-key-value"}}', 400),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const result = await client.submitJob(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('submit_failed');
      expect(result.error.status).toBe(400);
      expect(result.error.message).toContain('400');
      expect(result.error.message).not.toContain('model not deployed');
      expect(result.error.message).not.toContain('secret-key-value');
    }
  });

  it('returns submit_failed when the response has no job id', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ status: 'preprocessing' }));
    const client = makeClient(fetchFn as unknown as typeof fetch);
    const result = await client.submitJob(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('submit_failed');
    }
  });

  it('returns submit_failed on network errors', async () => {
    const fetchFn = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = makeClient(fetchFn as unknown as typeof fetch);
    const result = await client.submitJob(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('submit_failed');
    }
  });

  it('gets job status and downloads video bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchFn = jest.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/jobs/job-1?')) {
        return jsonResponse({ id: 'job-1', status: 'succeeded' });
      }
      if (u.includes('/gen-7/content/video?')) {
        return videoResponse(bytes);
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const client = makeClient(fetchFn);
    const job = await client.getJob('job-1');
    expect(job).toEqual({ ok: true, value: { id: 'job-1', status: 'succeeded' } });

    const video = await client.downloadVideo('gen-7');
    expect(video.ok).toBe(true);
    if (video.ok) {
      expect(new Uint8Array(video.value.bytes)).toEqual(bytes);
      expect(video.value.contentType).toBe('video/mp4');
    }
  });

  it('maps abort errors to the aborted code', async () => {
    const fetchFn = jest.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const client = makeClient(fetchFn as unknown as typeof fetch);
    const result = await client.submitJob(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('aborted');
    }
  });
});

describe('generateSoraVideo', () => {
  const request: SoraVideoJobRequest = baseRequest;

  /** fetchFn routing on the URL suffix; submit returns the given job body. */
  const scriptFetch = (handlers: {
    submit?: () => Promise<Response>;
    poll?: () => Promise<Response>;
    download?: () => Promise<Response>;
  }) =>
    jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/jobs?') && init?.method === 'POST') {
        return handlers.submit
          ? handlers.submit()
          : jsonResponse({ id: 'job-1', status: 'running' });
      }
      if (u.includes('/jobs/')) {
        return handlers.poll
          ? handlers.poll()
          : jsonResponse({ id: 'job-1', status: 'succeeded', generations: [{ id: 'gen-1' }] });
      }
      if (u.includes('/content/video')) {
        return handlers.download
          ? handlers.download()
          : videoResponse(new Uint8Array([0x76, 0x69, 0x64]));
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

  it('validates before hitting the network', async () => {
    const fetchFn = jest.fn();
    const client = createSoraVideoClient({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await generateSoraVideo({
      client,
      request: { ...request, prompt: ' ' },
    });
    expect(result.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('submits, polls until succeeded, then downloads the generation', async () => {
    let polls = 0;
    const fetchFn = scriptFetch({
      poll: async () => {
        polls += 1;
        return jsonResponse({
          id: 'job-1',
          status: polls < 2 ? 'running' : 'succeeded',
          generations: polls < 2 ? [] : [{ id: 'gen-1' }],
        });
      },
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({
      client,
      request,
      sleep: noSleep,
      pollIntervalMs: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.jobId).toBe('job-1');
      expect(result.value.generationId).toBe('gen-1');
      expect(new Uint8Array(result.value.bytes)).toEqual(new Uint8Array([0x76, 0x69, 0x64]));
    }
    expect(polls).toBe(2);
  });

  it('returns job_failed with the provider reason', async () => {
    const fetchFn = scriptFetch({
      poll: async () =>
        jsonResponse({
          id: 'job-1',
          status: 'failed',
          error: { code: 'content_filter', message: 'prompt blocked' },
        }),
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({ client, request, sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('job_failed');
      expect(result.error.message).toContain('prompt blocked');
    }
  });

  it('returns job_cancelled when the job is cancelled', async () => {
    const fetchFn = scriptFetch({
      poll: async () => jsonResponse({ id: 'job-1', status: 'cancelled' }),
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({ client, request, sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('job_cancelled');
    }
  });

  it('returns job_timeout when the deadline elapses', async () => {
    const fetchFn = scriptFetch({
      poll: async () => jsonResponse({ id: 'job-1', status: 'running' }),
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({
      client,
      request,
      sleep: noSleep,
      timeoutMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('job_timeout');
    }
  });

  it('tolerates transient poll failures and fails after SORA_MAX_POLL_ERRORS', async () => {
    let polls = 0;
    const fetchFn = scriptFetch({
      poll: async () => {
        polls += 1;
        return textResponse('gateway timeout', 502);
      },
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({ client, request, sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('status_failed');
    }
    expect(polls).toBe(3);
  });

  it('returns no_generations when a succeeded job has no generations', async () => {
    const fetchFn = scriptFetch({
      poll: async () => jsonResponse({ id: 'job-1', status: 'succeeded', generations: [] }),
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({ client, request, sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no_generations');
    }
  });

  it('returns download_failed when the video download fails', async () => {
    const fetchFn = scriptFetch({
      download: async () => textResponse('gone', 404),
    });
    const client = createSoraVideoClient({ endpoint: ENDPOINT, apiKey: API_KEY, fetchFn });
    const result = await generateSoraVideo({ client, request, sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('download_failed');
      expect(result.error.status).toBe(404);
    }
  });

  it('honours a pre-aborted signal without calling the API', async () => {
    const fetchFn = jest.fn();
    const client = createSoraVideoClient({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await generateSoraVideo({
      client,
      request,
      signal: AbortSignal.abort(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('aborted');
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the default timeout when none is given', () => {
    expect(SORA_JOB_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
