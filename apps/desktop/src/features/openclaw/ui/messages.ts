export type OpenClawPageStateKind = 'notReady' | 'noTarget' | 'loading' | 'empty' | 'error';

export interface OpenClawStateMessage {
  readonly title: string;
  readonly description: string;
}

export interface OpenClawStateMessageInput {
  readonly featureName: string;
}

export function getOpenClawStateMessage(
  kind: OpenClawPageStateKind,
  input: OpenClawStateMessageInput
): OpenClawStateMessage {
  switch (kind) {
    case 'notReady':
      return {
        title: `Connect to inspect ${input.featureName}.`,
        description: 'Open a control-plane connection first.',
      };
    case 'noTarget':
      return {
        title: `Select a target to inspect ${input.featureName}.`,
        description: 'Use the top target selector to choose an OpenClaw target.',
      };
    case 'loading':
      return {
        title: `Loading ${input.featureName}...`,
        description: 'Fetching latest target-scoped data.',
      };
    case 'empty':
      return {
        title: `No ${input.featureName} found for this target.`,
        description: 'Change target or configure OpenClaw data for this section.',
      };
    case 'error':
      return {
        title: `Failed to load ${input.featureName}.`,
        description: 'Retry and check target connectivity or permissions.',
      };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
