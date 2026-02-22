import type { ControlClient } from '@patze/control-client';

export type FrontendUnifiedSnapshot = NonNullable<ReturnType<ControlClient['getSnapshot']>>;

export type FrontendRunDetailSnapshot =
  FrontendUnifiedSnapshot['runDetails'] extends Readonly<Record<string, infer D>> ? D : never;

export type FrontendToolCallSnapshot = FrontendRunDetailSnapshot['toolCalls'][number];

export type FrontendLogSnapshot = FrontendUnifiedSnapshot['logs'][number];

export type FrontendRecentEvent = FrontendUnifiedSnapshot['recentEvents'][number];

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'degraded' | 'error';
