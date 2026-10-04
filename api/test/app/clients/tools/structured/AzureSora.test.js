const createAzureSoraTools = require('~/app/clients/tools/structured/AzureSora');
const { generateSoraVideo, createSoraVideoClient } = require('@librechat/api');
const { createFile } = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  azureToolkit: {
    video_gen_azure: {
      name: 'video_gen_azure',
      description: 'Generate a video',
      schema: {},
      responseFormat: 'content_and_artifact',
    },
  },
  getStorageMetadata: jest.fn(() => ({})),
  getProxyDispatcher: jest.fn(() => undefined),
  createSoraVideoClient: jest.fn(() => ({ marker: 'client' })),
  generateSoraVideo: jest.fn(),
  SORA_JOB_TIMEOUT_MS: 900000,
  SORA_JOB_POLL_INTERVAL_MS: 5000,
  DEFAULT_SORA_API_VERSION: 'preview',
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/server/services/Files/retention', () => ({
  getRetentionExpiry: jest.fn(async () => ({})),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn(() => 'local'),
}));

jest.mock('~/models', () => ({
  createFile: jest.fn(),
}));

const ENV_KEYS = [
  'AZURE_SORA_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  'AZURE_SORA_ENDPOINT',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_BASEURL',
  'AZURE_SORA_DEPLOYMENT',
  'AZURE_SORA_MODEL',
  'AZURE_OPENAI_SORA_DEPLOYMENT',
  'AZURE_SORA_API_VERSION',
  'AZURE_SORA_POLL_INTERVAL_MS',
  'AZURE_SORA_TIMEOUT_MS',
];

const setEnv = () => {
  process.env.AZURE_SORA_API_KEY = 'test-key';
  process.env.AZURE_SORA_ENDPOINT = 'https://res.openai.azure.com';
  process.env.AZURE_SORA_DEPLOYMENT = 'sora-deployment';
};

const makeReq = () => ({
  user: { id: 'user-1', tenantId: 'tenant-1' },
  config: {},
});

const makeToolCall = (args) => ({
  id: 'call_video_1',
  name: 'video_gen_azure',
  args,
  type: 'tool_call',
});

describe('createAzureSoraTools', () => {
  let savedEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    setEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    savedEnv = {};
  });

  it('throws when not used in an agent context', () => {
    expect(() => createAzureSoraTools({ isAgent: false })).toThrow(
      'This tool is only available for agents.',
    );
  });

  it('throws when no API key is configured', () => {
    delete process.env.AZURE_SORA_API_KEY;
    expect(() => createAzureSoraTools({ isAgent: true, req: makeReq() })).toThrow(
      'Missing AZURE_SORA_API_KEY',
    );
  });

  it('throws when no endpoint is configured', () => {
    delete process.env.AZURE_SORA_ENDPOINT;
    expect(() => createAzureSoraTools({ isAgent: true, req: makeReq() })).toThrow(
      'Missing AZURE_SORA_ENDPOINT',
    );
  });

  it('throws when no deployment is configured', () => {
    delete process.env.AZURE_SORA_DEPLOYMENT;
    expect(() => createAzureSoraTools({ isAgent: true, req: makeReq() })).toThrow(
      'Missing AZURE_SORA_DEPLOYMENT',
    );
  });

  it('falls back to generic AZURE_OPENAI_* variables', async () => {
    delete process.env.AZURE_SORA_API_KEY;
    delete process.env.AZURE_SORA_ENDPOINT;
    process.env.AZURE_OPENAI_API_KEY = 'generic-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://generic.openai.azure.com';

    generateSoraVideo.mockResolvedValue({
      ok: false,
      error: { code: 'job_failed', message: 'stop here' },
    });

    const [videoTool] = createAzureSoraTools({ isAgent: true, req: makeReq() });
    await videoTool.invoke(makeToolCall({ prompt: 'a cat' }));

    expect(createSoraVideoClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'generic-key',
        endpoint: 'https://generic.openai.azure.com',
        apiVersion: 'preview',
      }),
    );
  });

  it('accepts user-provided auth fields over env vars', async () => {
    generateSoraVideo.mockResolvedValue({
      ok: false,
      error: { code: 'submit_failed', message: 'stop here' },
    });

    const [videoTool] = createAzureSoraTools({
      isAgent: true,
      req: makeReq(),
      AZURE_SORA_API_KEY: 'user-key',
      AZURE_SORA_ENDPOINT: 'https://user.openai.azure.com',
      AZURE_SORA_DEPLOYMENT: 'user-deployment',
    });
    await videoTool.invoke(makeToolCall({ prompt: 'a cat' }));

    expect(createSoraVideoClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'user-key',
        endpoint: 'https://user.openai.azure.com',
      }),
    );
    expect(generateSoraVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ model: 'user-deployment', prompt: 'a cat' }),
      }),
    );
  });

  it('returns an error message when generation fails', async () => {
    generateSoraVideo.mockResolvedValue({
      ok: false,
      error: { code: 'job_failed', message: 'provider said no' },
    });
    const [videoTool] = createAzureSoraTools({ isAgent: true, req: makeReq() });
    const result = await videoTool.invoke(makeToolCall({ prompt: 'a cat' }));
    const contentStr =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    expect(contentStr).toContain('provider said no');
    expect(result.artifact).toEqual({});
  });

  it('rejects a malformed size argument without calling the API', async () => {
    const [videoTool] = createAzureSoraTools({ isAgent: true, req: makeReq() });
    const result = await videoTool.invoke(makeToolCall({ prompt: 'a cat', size: 'huge' }));
    const contentStr =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    expect(contentStr).toContain('auto');
    expect(generateSoraVideo).not.toHaveBeenCalled();
  });

  it('saves the generated video and returns a video_url artifact', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    generateSoraVideo.mockResolvedValue({
      ok: true,
      value: {
        bytes,
        contentType: 'video/mp4',
        jobId: 'job-9',
        generationId: 'gen-9',
      },
    });
    const saveBuffer = jest.fn(async () => '/images/user-1/file.mp4');
    getStrategyFunctions.mockReturnValue({ saveBuffer });
    createFile.mockResolvedValue({
      file_id: 'file-1',
      filename: 'file-1-sora-video.mp4',
      filepath: '/images/user-1/file.mp4',
      type: 'video/mp4',
      source: 'local',
      bytes: 3,
    });

    const [videoTool] = createAzureSoraTools({
      isAgent: true,
      req: makeReq(),
      fileStrategy: 'local',
    });
    const result = await videoTool.invoke(
      makeToolCall({ prompt: 'a cat', size: '1280x720', n_seconds: 5 }),
    );

    expect(generateSoraVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: 'a cat',
          model: 'sora-deployment',
          width: 1280,
          height: 720,
          n_seconds: 5,
        }),
      }),
    );
    expect(saveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1' }),
    );
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-1',
        context: 'video_generation',
        type: 'video/mp4',
        source: 'local',
      }),
      true,
    );
    expect(result.artifact).toBeDefined();
    const [part] = result.artifact.content;
    expect(part.type).toBe('video_url');
    expect(part.video_url.url).toBe('/images/user-1/file.mp4');
    expect(part.video_url.mime_type).toBe('video/mp4');
  });

  it('maps a save failure to a readable error', async () => {
    generateSoraVideo.mockResolvedValue({
      ok: true,
      value: {
        bytes: new Uint8Array([1]).buffer,
        contentType: 'video/mp4',
        jobId: 'j',
        generationId: 'g',
      },
    });
    getStrategyFunctions.mockReturnValue({
      saveBuffer: jest.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const [videoTool] = createAzureSoraTools({
      isAgent: true,
      req: makeReq(),
      fileStrategy: 'local',
    });
    const result = await videoTool.invoke(makeToolCall({ prompt: 'a cat' }));
    const contentStr =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    expect(contentStr).toContain('could not be saved');
  });
});
