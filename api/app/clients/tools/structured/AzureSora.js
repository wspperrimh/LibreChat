const { v4 } = require('uuid');
const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { ContentTypes, FileContext } = require('librechat-data-provider');
const {
  azureToolkit,
  getStorageMetadata,
  getProxyDispatcher,
  createSoraVideoClient,
  generateSoraVideo,
  SORA_JOB_TIMEOUT_MS,
  SORA_JOB_POLL_INTERVAL_MS,
  DEFAULT_SORA_API_VERSION,
} = require('@librechat/api');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createFile } = require('~/models');

const displayMessage =
  "The tool displayed a video. The generated video is already plainly visible, so don't repeat the description in detail. Do not list download links as they are available in the UI already. The user may download the video by clicking on it, but do not mention anything about downloading to the user.";

function returnValue(value) {
  if (typeof value === 'string') {
    return [value, {}];
  }
  return [displayMessage, value];
}

/**
 * Resolves the first non-empty value from user-provided auth fields then env vars.
 * @param {Object} fields
 * @param {string[]} keys
 * @returns {string}
 */
function resolveConfigValue(fields, keys) {
  for (const key of keys) {
    const value = fields[key] ?? process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parses a `WIDTHxHEIGHT` tool argument into video dimensions, or null for `auto`.
 * @param {string} size
 * @returns {{ width: number, height: number } | null | { error: string }}
 */
function parseVideoSize(size) {
  if (size == null || size === 'auto') {
    return null;
  }
  const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(size);
  if (!match) {
    return { error: `\`size\` must be \`auto\` or WIDTHxHEIGHT, got "${size}".` };
  }
  return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
}

/**
 * Creates the Azure OpenAI Sora video generation tool.
 * @param {Object} fields - Configuration fields
 * @param {ServerRequest} fields.req - The Express request object
 * @param {boolean} fields.isAgent - Whether the tool is being used in an agent context
 * @param {string} [fields.AZURE_SORA_API_KEY] - Azure OpenAI API key
 * @param {string} [fields.AZURE_SORA_ENDPOINT] - Azure OpenAI resource endpoint
 * @param {string} [fields.AZURE_SORA_DEPLOYMENT] - Sora model deployment name
 * @param {string} [fields.fileStrategy] - The app file storage strategy
 * @param {boolean} [fields.override] - Skip env checks, used at app initialization
 * @returns {Array<ReturnType<tool>>} - Array containing the video generation tool
 */
function createAzureSoraTools(fields = {}) {
  /** @type {boolean} Used to initialize the Tool without necessary variables. */
  const override = fields.override ?? false;
  if (!override && !fields.isAgent) {
    throw new Error('This tool is only available for agents.');
  }
  const { req } = fields;

  const apiKey = resolveConfigValue(fields, [
    'AZURE_SORA_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AZURE_API_KEY',
  ]);
  const endpoint = resolveConfigValue(fields, [
    'AZURE_SORA_ENDPOINT',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_BASEURL',
  ]);
  const deployment = resolveConfigValue(fields, [
    'AZURE_SORA_DEPLOYMENT',
    'AZURE_SORA_MODEL',
    'AZURE_OPENAI_SORA_DEPLOYMENT',
  ]);
  const apiVersion = resolveConfigValue(fields, [
    'AZURE_SORA_API_VERSION',
    'AZURE_OPENAI_API_VERSION',
  ]);
  const pollIntervalMs = resolvePositiveInt(
    fields.AZURE_SORA_POLL_INTERVAL_MS ?? process.env.AZURE_SORA_POLL_INTERVAL_MS,
    SORA_JOB_POLL_INTERVAL_MS,
  );
  const timeoutMs = resolvePositiveInt(
    fields.AZURE_SORA_TIMEOUT_MS ?? process.env.AZURE_SORA_TIMEOUT_MS,
    SORA_JOB_TIMEOUT_MS,
  );

  if (!override) {
    if (!apiKey) {
      throw new Error('Missing AZURE_SORA_API_KEY (or AZURE_OPENAI_API_KEY) credential.');
    }
    if (!endpoint) {
      throw new Error('Missing AZURE_SORA_ENDPOINT (or AZURE_OPENAI_ENDPOINT) configuration.');
    }
    if (!deployment) {
      throw new Error('Missing AZURE_SORA_DEPLOYMENT (Sora model deployment name) configuration.');
    }
  }

  const videoGenTool = tool(async ({ prompt, size = 'auto', n_seconds }, runnableConfig) => {
    if (!prompt) {
      throw new Error('Missing required field: prompt');
    }

    const dimensions = parseVideoSize(size);
    if (dimensions?.error) {
      return returnValue(dimensions.error);
    }

    /** @type {AbortSignal} */
    const derivedSignal = runnableConfig?.signal
      ? AbortSignal.any([runnableConfig.signal])
      : undefined;

    const client = createSoraVideoClient({
      apiKey,
      endpoint,
      apiVersion: apiVersion || DEFAULT_SORA_API_VERSION,
      dispatcher: getProxyDispatcher(),
    });

    const result = await generateSoraVideo({
      client,
      signal: derivedSignal,
      pollIntervalMs,
      timeoutMs,
      request: {
        prompt,
        model: deployment,
        n_seconds,
        ...dimensions,
      },
    });

    if (!result.ok) {
      logger.debug(`[video_gen_azure] Video generation failed: ${result.error.code}`);
      return returnValue(
        `Something went wrong when trying to generate the video. The Azure OpenAI deployment may be unavailable:\nError Message: ${result.error.message}`,
      );
    }

    const { bytes, contentType } = result.value;
    const file_id = v4();
    const filename = `${file_id}-sora-video.mp4`;
    const buffer = Buffer.from(bytes);
    const source =
      fields.fileStrategy ?? getFileStrategy(req.config, { context: FileContext.video_generation });
    const { saveBuffer } = getStrategyFunctions(source);

    let file;
    try {
      const filepath = await saveBuffer({
        userId: req.user.id,
        fileName: filename,
        buffer,
        tenantId: req.user.tenantId,
      });
      const storageMetadata = getStorageMetadata({ filepath, source });
      file = await createFile(
        {
          user: req.user.id,
          file_id,
          filename,
          filepath,
          bytes: buffer.byteLength,
          ...storageMetadata,
          source,
          type: contentType ?? 'video/mp4',
          context: FileContext.video_generation,
          tenantId: req.user.tenantId,
          ...(await getRetentionExpiry(req)),
        },
        true,
      );
    } catch (error) {
      logger.error('[video_gen_azure] Failed to save generated video:', error);
      return returnValue(
        'The video was generated but could not be saved to the configured file storage.',
      );
    }

    const response = [
      {
        type: ContentTypes.TEXT,
        text: displayMessage + `\n\ngenerated_video_id: "${file_id}"`,
      },
    ];
    const content = [
      {
        type: ContentTypes.VIDEO_URL,
        video_url: {
          url: file.filepath,
          file_id: file.file_id,
          filename: path.basename(file.filename),
          mime_type: file.type ?? 'video/mp4',
          source: file.source,
          bytes: file.bytes,
        },
      },
    ];
    return [response, { content, file_ids: [file_id] }];
  }, azureToolkit.video_gen_azure);

  return [videoGenTool];
}

module.exports = createAzureSoraTools;
