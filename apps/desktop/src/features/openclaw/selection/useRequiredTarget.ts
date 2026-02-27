export type RequiredTargetState = 'notReady' | 'noTarget' | 'ready';

export interface UseRequiredTargetInput {
  readonly connected: boolean;
  readonly selectedTargetId: string | null;
}

export interface RequiredTargetContext {
  readonly targetId: string | null;
  readonly targetKey: string | null;
  readonly state: RequiredTargetState;
  readonly isConnected: boolean;
  readonly hasTarget: boolean;
}

export function useRequiredTarget(input: UseRequiredTargetInput): RequiredTargetContext {
  if (!input.connected) {
    return {
      targetId: null,
      targetKey: null,
      state: 'notReady',
      isConnected: false,
      hasTarget: false,
    };
  }

  if (!input.selectedTargetId) {
    return {
      targetId: null,
      targetKey: null,
      state: 'noTarget',
      isConnected: true,
      hasTarget: false,
    };
  }

  return {
    targetId: input.selectedTargetId,
    targetKey: input.selectedTargetId,
    state: 'ready',
    isConnected: true,
    hasTarget: true,
  };
}
