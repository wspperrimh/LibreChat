import type { ExtendedJsonSchema } from '../registry/schema';

/** Default description for the Azure OpenAI Sora video generation tool */
const DEFAULT_VIDEO_GEN_DESCRIPTION =
  `Generates a short video clip from a text description using the Azure OpenAI Sora deployment configured for this instance.

When to use \`video_gen_azure\`:
- The user asks to create, generate, or render a video, clip, or animation from a text description.

When NOT to use \`video_gen_azure\`:
- For still images → use the configured image generation tool instead.
- For editing or extending existing videos → not supported.

Video generation is asynchronous and can take several minutes; the tool call returns once the clip has rendered and been attached to the conversation.` as const;

const getVideoGenDescription = () => {
  return process.env.VIDEO_GEN_AZURE_DESCRIPTION || DEFAULT_VIDEO_GEN_DESCRIPTION;
};

const DEFAULT_VIDEO_GEN_PROMPT_DESCRIPTION = `Describe the video you want in detail.
      Be highly specific—break your idea into layers:
      (1) main subject and action,
      (2) scene composition and camera movement,
      (3) lighting and mood,
      (4) style, medium, or cinematic references,
      (5) important details (appearance, clothing, objects, etc.),
      (6) background and environment.
      Use positive, descriptive language and specify what should be included, not what to avoid.` as const;

const getVideoGenPromptDescription = () => {
  return process.env.VIDEO_GEN_AZURE_PROMPT_DESCRIPTION || DEFAULT_VIDEO_GEN_PROMPT_DESCRIPTION;
};

/** `auto` or `WIDTHxHEIGHT`; the deployment enforces which dimensions its Sora model supports. */
export const VIDEO_SIZE_PATTERN = '^(auto|[1-9][0-9]*x[1-9][0-9]*)$';

const videoGenAzureJsonSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      maxLength: 32000,
      description: getVideoGenPromptDescription(),
    },
    size: {
      type: 'string',
      pattern: VIDEO_SIZE_PATTERN,
      description:
        'The frame size of the generated video as WIDTHxHEIGHT in pixels, or auto (default). Common Sora sizes: 480x480, 480x854, 854x480, 720x720, 720x1280, 1280x720, 1080x1080, 1920x1080. The API rejects sizes the configured deployment does not support.',
    },
    n_seconds: {
      type: 'integer',
      minimum: 1,
      maximum: 60,
      description:
        'The length of the generated clip in seconds. The configured deployment limits the allowed values (commonly 5); omit to use its default.',
    },
  },
  required: ['prompt'],
};

export const azureToolkit: {
  readonly video_gen_azure: {
    readonly name: 'video_gen_azure';
    readonly description: string;
    readonly schema: ExtendedJsonSchema;
    readonly responseFormat: 'content_and_artifact';
  };
} = {
  video_gen_azure: {
    name: 'video_gen_azure' as const,
    description: getVideoGenDescription(),
    schema: videoGenAzureJsonSchema,
    responseFormat: 'content_and_artifact' as const,
  } as const,
} as const;
