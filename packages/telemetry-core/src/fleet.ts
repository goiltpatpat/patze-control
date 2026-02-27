export type FleetTransport = 'reverse_ssh' | 'direct_https' | 'hybrid';
export type FleetEnvironment = 'local' | 'vps' | 'cloud';
export type FleetRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface FleetDesiredState {
  bridgeVersion?: string;
  configHash: string;
  maxSyncLagMs: number;
  allowAutoRemediation: boolean;
}

export interface FleetReportedState {
  machineId?: string;
  bridgeVersion?: string;
  configHash?: string;
  syncLagMs?: number;
  heartbeatAt?: string;
}

export type FleetDriftCategory = 'version' | 'config' | 'sync' | 'runtime';
export type FleetDriftSeverity = 'minor' | 'major' | 'critical';

export interface FleetDriftRecord {
  targetId: string;
  category: FleetDriftCategory;
  severity: FleetDriftSeverity;
  expected: string;
  actual: string;
  detectedAt: string;
}

export type FleetViolationSeverity = 'warning' | 'high' | 'critical';

export interface FleetPolicyViolation {
  id: string;
  targetId: string;
  code: string;
  severity: FleetViolationSeverity;
  message: string;
  createdAt: string;
}

export interface FleetTargetStatus {
  targetId: string;
  targetLabel: string;
  targetType: 'local' | 'remote';
  policyProfileId: string;
  policyProfileName: string;
  transport: FleetTransport;
  environment: FleetEnvironment;
  healthScore: number;
  riskLevel: FleetRiskLevel;
  desired: FleetDesiredState;
  reported: FleetReportedState;
  drifts: readonly FleetDriftRecord[];
  violations: readonly FleetPolicyViolation[];
  updatedAt: string;
}

export type FleetSseEventKind =
  | 'fleet-health-changed'
  | 'drift-detected'
  | 'policy-violation'
  | 'remediation-status'
  | 'target-offline';
