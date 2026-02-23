import type { RecipeDefinition } from '@patze/telemetry-core';

export const BUILT_IN_RECIPES: readonly RecipeDefinition[] = [
  {
    id: 'quick-start-agent',
    name: 'Quick Start Agent',
    description: 'Create an agent, assign a model, and bind it to a channel — all in one go.',
    difficulty: 'beginner',
    tags: ['agent', 'model', 'channel', 'setup'],
    params: [
      {
        id: 'agentId',
        label: 'Agent ID',
        description: 'Unique identifier (alphanumeric, hyphens, underscores)',
        type: 'string',
        required: true,
      },
      {
        id: 'agentName',
        label: 'Agent Display Name',
        type: 'string',
        required: true,
      },
      {
        id: 'modelId',
        label: 'Model Profile',
        type: 'model',
        required: true,
      },
      {
        id: 'channelId',
        label: 'Channel to Bind',
        type: 'channel',
        required: true,
      },
    ],
    steps: [
      {
        action: 'openclaw',
        label: 'Create agent',
        args: { 0: 'agents', 1: 'add', 2: '{{agentId}}', 3: '--non-interactive' },
      },
      {
        action: 'openclaw',
        label: 'Set agent name',
        args: { 0: 'config', 1: 'set', 2: 'agents.{{agentId}}.name', 3: '{{agentName}}' },
      },
      {
        action: 'openclaw',
        label: 'Set primary model',
        args: { 0: 'config', 1: 'set', 2: 'agents.{{agentId}}.model.primary', 3: '{{modelId}}' },
      },
      {
        action: 'openclaw',
        label: 'Bind to channel',
        args: { 0: 'config', 1: 'set', 2: 'channels.{{channelId}}.agents.+', 3: '{{agentId}}' },
      },
    ],
  },
  {
    id: 'add-discord-bot',
    name: 'Add Discord Bot',
    description: 'Set up a Discord channel binding with DM and group policies.',
    difficulty: 'beginner',
    tags: ['discord', 'channel', 'setup'],
    params: [
      {
        id: 'botToken',
        label: 'Discord Bot Token',
        type: 'string',
        required: true,
      },
      {
        id: 'dmPolicy',
        label: 'DM Policy',
        type: 'select',
        required: true,
        defaultValue: 'allow',
        options: [
          { value: 'allow', label: 'Allow DMs' },
          { value: 'deny', label: 'Deny DMs' },
          { value: 'allowlist', label: 'Allowlist Only' },
        ],
      },
      {
        id: 'groupPolicy',
        label: 'Group Policy',
        type: 'select',
        required: true,
        defaultValue: 'mention',
        options: [
          { value: 'all', label: 'Respond to all' },
          { value: 'mention', label: 'Respond on mention' },
          { value: 'none', label: 'Ignore groups' },
        ],
      },
    ],
    steps: [
      {
        action: 'openclaw',
        label: 'Set Discord token',
        args: { 0: 'config', 1: 'set', 2: 'channels.discord.token', 3: '{{botToken}}' },
      },
      {
        action: 'openclaw',
        label: 'Enable Discord channel',
        args: { 0: 'config', 1: 'set', 2: 'channels.discord.enabled', 3: 'true' },
      },
      {
        action: 'openclaw',
        label: 'Set DM policy',
        args: { 0: 'config', 1: 'set', 2: 'channels.discord.dmPolicy', 3: '{{dmPolicy}}' },
      },
      {
        action: 'openclaw',
        label: 'Set group policy',
        args: { 0: 'config', 1: 'set', 2: 'channels.discord.groupPolicy', 3: '{{groupPolicy}}' },
      },
    ],
  },
  {
    id: 'add-telegram-bot',
    name: 'Add Telegram Bot',
    description: 'Set up a Telegram channel binding.',
    difficulty: 'beginner',
    tags: ['telegram', 'channel', 'setup'],
    params: [
      {
        id: 'botToken',
        label: 'Telegram Bot Token',
        type: 'string',
        required: true,
      },
      {
        id: 'dmPolicy',
        label: 'DM Policy',
        type: 'select',
        required: true,
        defaultValue: 'allow',
        options: [
          { value: 'allow', label: 'Allow' },
          { value: 'deny', label: 'Deny' },
        ],
      },
    ],
    steps: [
      {
        action: 'openclaw',
        label: 'Set Telegram token',
        args: { 0: 'config', 1: 'set', 2: 'channels.telegram.token', 3: '{{botToken}}' },
      },
      {
        action: 'openclaw',
        label: 'Enable Telegram channel',
        args: { 0: 'config', 1: 'set', 2: 'channels.telegram.enabled', 3: 'true' },
      },
      {
        action: 'openclaw',
        label: 'Set DM policy',
        args: { 0: 'config', 1: 'set', 2: 'channels.telegram.dmPolicy', 3: '{{dmPolicy}}' },
      },
    ],
  },
  {
    id: 'switch-global-model',
    name: 'Switch Global Model',
    description: 'Change the default model for all agents at once.',
    difficulty: 'beginner',
    tags: ['model', 'global', 'config'],
    params: [
      {
        id: 'modelId',
        label: 'New Default Model',
        type: 'model',
        required: true,
      },
    ],
    steps: [
      {
        action: 'openclaw',
        label: 'Set default primary model',
        args: { 0: 'config', 1: 'set', 2: 'agents.defaults.model.primary', 3: '{{modelId}}' },
      },
    ],
  },
  {
    id: 'setup-cron-job',
    name: 'Setup Cron Job',
    description: 'Create a scheduled task for an agent.',
    difficulty: 'intermediate',
    tags: ['cron', 'agent', 'automation'],
    params: [
      {
        id: 'jobName',
        label: 'Job Name',
        type: 'string',
        required: true,
      },
      {
        id: 'cronExpr',
        label: 'Cron Expression',
        description: 'e.g. "0 9 * * *" for every day at 9am',
        type: 'string',
        required: true,
      },
      {
        id: 'agentId',
        label: 'Agent',
        type: 'agent',
        required: true,
      },
      {
        id: 'message',
        label: 'Message/Prompt',
        type: 'string',
        required: true,
      },
    ],
    steps: [
      {
        action: 'openclaw',
        label: 'Create cron job',
        args: {
          0: 'cron',
          1: 'add',
          2: '{{jobName}}',
          3: '--schedule',
          4: '{{cronExpr}}',
          5: '--agent',
          6: '{{agentId}}',
          7: '--message',
          8: '{{message}}',
        },
      },
    ],
  },
  {
    id: 'enable-multi-model',
    name: 'Enable Multi-Model',
    description: 'Set primary and fallback models for an agent for resilience.',
    difficulty: 'intermediate',
    tags: ['model', 'agent', 'resilience'],
    params: [
      {
        id: 'agentId',
        label: 'Agent',
        type: 'agent',
        required: true,
      },
      {
        id: 'primaryModel',
        label: 'Primary Model',
        type: 'model',
        required: true,
      },
      {
        id: 'fallbackModel',
        label: 'Fallback Model',
        type: 'model',
        required: true,
      },
    ],
    steps: [
      {
        action: 'openclaw',
        label: 'Set primary model',
        args: {
          0: 'config',
          1: 'set',
          2: 'agents.{{agentId}}.model.primary',
          3: '{{primaryModel}}',
        },
      },
      {
        action: 'openclaw',
        label: 'Set fallback model',
        args: {
          0: 'config',
          1: 'set',
          2: 'agents.{{agentId}}.model.fallback',
          3: '{{fallbackModel}}',
        },
      },
    ],
  },
];
