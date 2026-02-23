export interface OpenClawAgent {
  readonly id: string;
  readonly name: string;
  readonly emoji?: string | undefined;
  readonly model?: OpenClawAgentModel | undefined;
  readonly systemPrompt?: string | undefined;
  readonly enabled: boolean;
}

export interface OpenClawAgentModel {
  readonly primary?: string | undefined;
  readonly fallback?: string | undefined;
}

export interface OpenClawModelProfile {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly enabled: boolean;
}

export interface OpenClawChannelBinding {
  readonly channelId: string;
  readonly agentId: string;
  readonly modelOverride?: string | undefined;
  readonly dmPolicy?: string | undefined;
  readonly groupPolicy?: string | undefined;
}

export interface OpenClawFullConfig {
  readonly agents: readonly OpenClawAgent[];
  readonly models: readonly OpenClawModelProfile[];
  readonly channels: Readonly<Record<string, unknown>>;
  readonly bindings: readonly OpenClawChannelBinding[];
  readonly defaults: OpenClawDefaults;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface OpenClawDefaults {
  readonly model?: OpenClawAgentModel | undefined;
}

export interface OpenClawQueuedCommand {
  readonly id: string;
  readonly targetId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly description: string;
  readonly createdAt: string;
}

export interface OpenClawCommandQueueState {
  readonly targetId: string;
  readonly commands: readonly OpenClawQueuedCommand[];
  readonly totalCount: number;
}

export interface OpenClawConfigDiffCommand {
  readonly description: string;
  readonly cli: string;
}

export interface OpenClawConfigDiff {
  readonly before: string;
  readonly after: string;
  readonly commandCount: number;
  readonly commands?: readonly OpenClawConfigDiffCommand[] | undefined;
  readonly simulated?: boolean | undefined;
  readonly simulationError?: string | undefined;
}

export interface OpenClawConfigSnapshot {
  readonly id: string;
  readonly targetId: string;
  readonly timestamp: string;
  readonly source: string;
  readonly description: string;
  readonly configContent: string;
  readonly configHash: string;
}

export interface RecipeDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly difficulty: 'beginner' | 'intermediate' | 'advanced';
  readonly tags: readonly string[];
  readonly params: readonly RecipeParam[];
  readonly steps: readonly RecipeStep[];
}

export interface RecipeParam {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly type: 'string' | 'number' | 'boolean' | 'select' | 'agent' | 'model' | 'channel';
  readonly defaultValue?: unknown;
  readonly required: boolean;
  readonly options?: readonly RecipeOption[] | undefined;
}

export interface RecipeOption {
  readonly value: string;
  readonly label: string;
}

export interface RecipeStep {
  readonly action: string;
  readonly label: string;
  readonly args: Readonly<Record<string, string>>;
}
