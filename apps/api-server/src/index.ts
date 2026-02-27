import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import os from 'node:os';
import {
  TelemetryAggregator,
  TelemetryNode,
  CronService,
  OpenClawTargetStore,
  OpenClawSyncManager,
  toFrontendUnifiedSnapshot,
  type AnyTelemetryEvent,
  type AuthConfig,
  type MachineEndpoint,
  type OpenClawCronJob,
  type OpenClawRunRecord,
  type OpenClawSyncStatus,
  type OpenClawTarget,
  type OpenClawTargetInput,
  type OpenClawTargetPatch,
  type TargetSyncStatusEntry,
  type ScheduledTask,
  type TaskCreateInput,
  type TaskPatchInput,
  type TaskEvent,
  type FleetDesiredState,
  type FleetDriftRecord,
  type FleetPolicyViolation,
  type FleetReportedState,
  type FleetRiskLevel,
  type FleetTargetStatus,
  type RecipeDefinition,
} from '@patze/telemetry-core';
import { RemoteNodeAttachmentOrchestrator } from './remote-node-attachment-orchestrator.js';
import { BridgeSetupManager, type BridgeSetupInput } from './bridge-setup-manager.js';
import { SshTunnelRuntime } from './ssh-tunnel-runtime.js';
import { createTaskExecutor } from './task-executor.js';
import { listSshConfigAliases } from './ssh-config-parser.js';
import {
  readFullConfig,
  readAgents,
  readModels,
  readBindings,
  readRawConfigString,
} from './openclaw-config-reader.js';
import { OpenClawCommandQueue, type OpenClawCommandInput } from './openclaw-command-queue.js';
import {
  BridgeCommandStore,
  type BridgeCommandIntent,
  type BridgeCommandRecord,
  type BridgeCommandResult,
  type BridgeCommandSnapshot,
} from './bridge-command-store.js';
import { SftpSessionManager, type CustomSshConnection } from './sftp-session-manager.js';
import multipart from '@fastify/multipart';
import archiver from 'archiver';
import { computeReadinessScore, deriveReadinessRootCause } from './openclaw-readiness.js';
import { shellQuote, validateInstallPayload } from './openclaw-install-security.js';

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileNode = promisify(execFileCb);

const INGEST_BODY_LIMIT_BYTES = 1024 * 1024;
const CRON_SYNC_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const APP_BODY_LIMIT_BYTES = Math.max(INGEST_BODY_LIMIT_BYTES, CRON_SYNC_BODY_LIMIT_BYTES);
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_PENDING_CHUNKS = 1_024;
const BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;
const BRIDGE_CRON_SYNC_RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.BRIDGE_CRON_SYNC_RATE_LIMIT_MAX ?? '60'
);
const SMART_FLEET_V2_ENABLED = process.env.SMART_FLEET_V2_ENABLED !== 'false';
const SMART_FLEET_MAX_SYNC_LAG_MS = Number(process.env.SMART_FLEET_MAX_SYNC_LAG_MS ?? '120000');
const SMART_FLEET_MIN_BRIDGE_VERSION =
  process.env.SMART_FLEET_MIN_BRIDGE_VERSION?.trim() || undefined;
const SMART_FLEET_ALERT_COOLDOWN_MS = Number(process.env.SMART_FLEET_ALERT_COOLDOWN_MS ?? '60000');
const SMART_FLEET_APPROVAL_CRITICAL_THRESHOLD = Number(
  process.env.SMART_FLEET_APPROVAL_CRITICAL_THRESHOLD ?? '3'
);
const SMART_FLEET_APPROVAL_TTL_MS = Number(process.env.SMART_FLEET_APPROVAL_TTL_MS ?? '300000');

// ── OpenClaw CLI detection ──

interface CliStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly checkedAt: number;
}

let cachedCliStatus: CliStatus = { available: false, version: null, checkedAt: 0 };
const CLI_CHECK_TTL_MS = 60_000;

async function checkOpenClawCli(): Promise<CliStatus> {
  if (Date.now() - cachedCliStatus.checkedAt < CLI_CHECK_TTL_MS) return cachedCliStatus;
  try {
    const { stdout } = await execFileNode('openclaw', ['--version'], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    cachedCliStatus = {
      available: true,
      version: stdout.trim() || 'unknown',
      checkedAt: Date.now(),
    };
  } catch {
    cachedCliStatus = { available: false, version: null, checkedAt: Date.now() };
  }
  return cachedCliStatus;
}

void checkOpenClawCli();

interface HealthCheckItem {
  readonly id: string;
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
  readonly details: string | undefined;
}

interface OpenClawHealthCheck {
  readonly ok: boolean;
  readonly target: string;
  readonly checks: readonly HealthCheckItem[];
  readonly syncStatus: OpenClawSyncStatus;
  readonly cliAvailable: boolean;
  readonly cliVersion: string | null;
}

interface OpenClawChannelBoundAgent {
  readonly agentId: string;
  readonly modelOverride?: string;
}

interface OpenClawChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled' | 'unknown';
  readonly groupPolicy: 'open' | 'allowlist' | 'disabled' | 'unknown';
  readonly allowFrom: readonly string[];
  readonly allowFromCount: number;
  readonly allowFromHasWildcard: boolean;
  readonly hasGroups: boolean;
  readonly connected: boolean;
  readonly runtimeState: 'connected' | 'disconnected' | 'unknown';
  readonly accountSummary: {
    readonly total: number;
    readonly enabled: number;
    readonly configured: number;
    readonly connected: number;
    readonly runtimeKnown: number;
  };
  readonly boundAgents: readonly OpenClawChannelBoundAgent[];
  readonly lastMessageAt?: string;
  readonly messageCount?: number;
}

interface RuntimeChannelProbeState {
  readonly connected: boolean;
  readonly runtimeState: 'connected' | 'disconnected' | 'unknown';
}

interface BridgeConnectionInfo {
  readonly machineId: string;
  readonly machineLabel: string | undefined;
  readonly bridgeVersion: string | undefined;
  readonly sourceIp: string;
  readonly lastSeenAt: string;
}

interface BridgeReportedState {
  readonly targetId: string;
  readonly machineId: string;
  readonly bridgeVersion: string | undefined;
  readonly configHash: string;
  readonly lastSeenAt: string;
}

interface FleetRemediationRun {
  readonly id: string;
  readonly targetId: string;
  readonly action: 'reconcile';
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly message: string;
}

type OperationType =
  | 'recipe-apply'
  | 'recipe-rollback'
  | 'readiness-fix'
  | 'queue-apply'
  | 'fleet-reconcile';

interface OperationJournalEntry {
  readonly operationId: string;
  readonly type: OperationType;
  readonly targetId?: string;
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly message: string;
  readonly error?: string;
}

type OpenClawReadinessCheckId =
  | 'bridge-connected'
  | 'targets-available'
  | 'sync-running'
  | 'recent-runs'
  | 'auth-mode';

interface OpenClawReadinessCheck {
  readonly id: OpenClawReadinessCheckId;
  readonly status: 'ok' | 'warn' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly actionHints: readonly string[];
}

interface ExtendedRecipeDefinition extends RecipeDefinition {
  readonly compatibility?: {
    readonly minOpenClawVersion?: string;
    readonly maxOpenClawVersion?: string;
  };
  readonly riskLevel?: 'low' | 'medium' | 'high';
  readonly requiresConfirm?: boolean;
}

type FleetAllowedAuthMode = 'none' | 'token' | 'any';

interface FleetPolicyProfile {
  readonly id: string;
  readonly name: string;
  readonly minBridgeVersion?: string;
  readonly maxSyncLagMs: number;
  readonly allowedAuthMode: FleetAllowedAuthMode;
  readonly maxConsecutiveFailures: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type FleetAlertSeverity = 'warning' | 'high' | 'critical';

interface FleetAlertDestination {
  readonly id: string;
  readonly name: string;
  readonly kind: 'webhook';
  readonly url: string;
  readonly minimumSeverity: FleetAlertSeverity;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FleetAlertRouteRule {
  readonly id: string;
  readonly name: string;
  readonly minimumSeverity: FleetAlertSeverity;
  readonly targetScope: 'all' | 'target_ids';
  readonly targetIds: readonly string[];
  readonly destinationIds: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PendingFleetApproval {
  readonly token: string;
  readonly signature: string;
  readonly criticalTargetIds: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface BridgeCronSyncPayload {
  readonly machineId: string;
  readonly machineLabel: string | undefined;
  readonly bridgeVersion: string | undefined;
  readonly jobsHash: string;
  readonly jobs: readonly OpenClawCronJob[] | undefined;
  readonly configHash: string;
  readonly configRaw: string | null | undefined;
  readonly newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>;
  readonly sentAt: string | undefined;
}

interface PreflightDiagnosisCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly detail: string;
}

interface PreflightDiagnosis {
  readonly code:
    | 'ssh_key_unreadable'
    | 'ssh_auth_missing'
    | 'ssh_auth_failed'
    | 'ssh_dns_failed'
    | 'ssh_network_unreachable'
    | 'ssh_timeout'
    | 'ssh_host_verification_failed'
    | 'ssh_exec_failed'
    | 'unknown';
  readonly title: string;
  readonly message: string;
  readonly hints: readonly string[];
  readonly checks: readonly PreflightDiagnosisCheck[];
}

type IngestRequest = FastifyRequest<{ Body: unknown }>;
type BatchIngestRequest = FastifyRequest<{ Body: unknown }>;
type RawResponse = FastifyReply['raw'];

const app = Fastify({
  logger: true,
  bodyLimit: APP_BODY_LIMIT_BYTES,
});

const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
  /^tauri:\/\//,
];

function classifyPreflightFailure(
  rawMessage: string,
  input: { sshHost: string; sshPort: number; sshUser: string; sshKeyPath: string }
): PreflightDiagnosis {
  const msg = rawMessage.trim();
  const normalized = msg.toLowerCase();
  const checksBase: PreflightDiagnosisCheck[] = [
    {
      id: 'host',
      label: 'SSH host',
      status: 'ok',
      detail: `${input.sshHost}:${String(input.sshPort)}`,
    },
    { id: 'user', label: 'SSH user', status: 'ok', detail: input.sshUser },
    { id: 'key', label: 'SSH key path', status: 'ok', detail: input.sshKeyPath },
  ];

  if (normalized.includes('cannot read ssh key at')) {
    return {
      code: 'ssh_key_unreadable',
      title: 'SSH key file unreadable',
      message: msg,
      hints: [
        `Verify key exists: ls -l ${input.sshKeyPath}`,
        'If key is passphrase-protected, load it into ssh-agent: ssh-add <key-path>',
        'Ensure permissions are secure: chmod 600 <key-path>',
      ],
      checks: checksBase.map((check) =>
        check.id === 'key'
          ? { ...check, status: 'error', detail: 'Key file is missing or unreadable.' }
          : check
      ),
    };
  }

  if (normalized.includes('no ssh key found and ssh agent is unavailable')) {
    return {
      code: 'ssh_auth_missing',
      title: 'No SSH authentication source available',
      message: msg,
      hints: [
        'Provide a valid key path under ~/.ssh in the dialog.',
        'Or start ssh-agent and add key: eval "$(ssh-agent -s)" && ssh-add <key-path>',
        'Retry pre-flight after key/agent is available.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'key'
          ? { ...check, status: 'error', detail: 'No key file and no ssh-agent socket found.' }
          : check
      ),
    };
  }

  if (normalized.includes('all configured authentication methods failed')) {
    return {
      code: 'ssh_auth_failed',
      title: 'SSH authentication rejected',
      message: msg,
      hints: [
        'Confirm VPS accepts this user + key pair.',
        'Test directly in same environment: ssh -p <port> <user>@<host> "echo ok"',
        'If using alias mode, verify IdentityFile/User/Port in ~/.ssh/config.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'key'
          ? {
              ...check,
              status: 'warn',
              detail: 'Key exists but authentication was rejected by host.',
            }
          : check
      ),
    };
  }

  if (normalized.includes('getaddrinfo enotfound') || normalized.includes('name not known')) {
    return {
      code: 'ssh_dns_failed',
      title: 'SSH host cannot be resolved',
      message: msg,
      hints: [
        'Check host value or SSH alias spelling.',
        'Try raw IP if DNS/alias is unavailable.',
        'If using alias mode, validate HostName in ~/.ssh/config.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'host' ? { ...check, status: 'error', detail: 'Host lookup failed.' } : check
      ),
    };
  }

  if (
    normalized.includes('econnrefused') ||
    normalized.includes('ehostunreach') ||
    normalized.includes('enetunreach')
  ) {
    return {
      code: 'ssh_network_unreachable',
      title: 'SSH network path unreachable',
      message: msg,
      hints: [
        'Verify VPS firewall / security group allows SSH port.',
        'Confirm sshd is running on target host.',
        'Test from same machine: nc -vz <host> <port> or ssh -p <port> <user>@<host>.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'host'
          ? { ...check, status: 'error', detail: 'Cannot reach SSH service from API host.' }
          : check
      ),
    };
  }

  if (normalized.includes('host key') && normalized.includes('failed')) {
    return {
      code: 'ssh_host_verification_failed',
      title: 'SSH host key verification failed',
      message: msg,
      hints: [
        'Remove stale host key entry and retry (known_hosts mismatch).',
        'Verify host fingerprint with provider console before trusting new key.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'host'
          ? { ...check, status: 'warn', detail: 'Known host fingerprint mismatch.' }
          : check
      ),
    };
  }

  if (normalized.includes('timed out')) {
    return {
      code: 'ssh_timeout',
      title: 'SSH pre-flight timed out',
      message: msg,
      hints: [
        'Check network latency, firewall, and SSHD responsiveness.',
        'Try manual SSH command from same machine to verify real latency.',
        'If unstable network, retry with a closer endpoint/VPN route.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'host'
          ? { ...check, status: 'warn', detail: 'Connection attempt exceeded timeout window.' }
          : check
      ),
    };
  }

  if (normalized.includes('echo ok mismatch') || normalized.includes('remote command timed out')) {
    return {
      code: 'ssh_exec_failed',
      title: 'SSH connected but remote command check failed',
      message: msg,
      hints: [
        'Remote shell might be blocked by profile scripts or restricted shell.',
        'Test: ssh -p <port> <user>@<host> "echo ok"',
        'Ensure login shell can execute non-interactive commands.',
      ],
      checks: checksBase.map((check) =>
        check.id === 'host'
          ? {
              ...check,
              status: 'warn',
              detail: 'Connection established but command validation failed.',
            }
          : check
      ),
    };
  }

  return {
    code: 'unknown',
    title: 'Pre-flight failed',
    message: msg || 'SSH pre-flight failed.',
    hints: [
      'Run manual SSH test from the same environment as API server.',
      'Check SSH key path, host, user, and port values.',
      'Retry pre-flight after fixing connectivity/auth.',
    ],
    checks: checksBase,
  };
}

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'), false);
    }
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
});

const telemetryNode = new TelemetryNode();
const telemetryAggregator = new TelemetryAggregator();
telemetryAggregator.attachNode('local', telemetryNode);

const sshTunnelRuntime = new SshTunnelRuntime();
const orchestrator = new RemoteNodeAttachmentOrchestrator(sshTunnelRuntime, telemetryAggregator);
const bridgeConnections = new Map<string, BridgeConnectionInfo>();
const bridgeReportedStateByTargetId = new Map<string, BridgeReportedState>();
const fleetHealthScoreByTargetId = new Map<string, number>();
const fleetDriftSignatureByTargetId = new Map<string, string>();
const fleetViolationSignatureByTargetId = new Map<string, string>();
const fleetRemediationRuns = new Map<string, FleetRemediationRun>();
const fleetPolicyProfiles = new Map<string, FleetPolicyProfile>();
const fleetTargetPolicyId = new Map<string, string>();
const fleetAlertDestinations = new Map<string, FleetAlertDestination>();
const fleetAlertRouteRules = new Map<string, FleetAlertRouteRule>();
const fleetAlertLastSentAtByDestination = new Map<string, number>();
const fleetPendingApprovals = new Map<string, PendingFleetApproval>();
const bridgeCronSyncRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
const operationJournal: OperationJournalEntry[] = [];

const OPERATION_JOURNAL_MAX = 300;

function startOperation(
  type: OperationType,
  message: string,
  targetId?: string
): { operationId: string; startedAt: string } {
  const operationId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = new Date().toISOString();
  operationJournal.unshift({
    operationId,
    type,
    status: 'started',
    startedAt,
    ...(targetId ? { targetId } : {}),
    message,
  });
  if (operationJournal.length > OPERATION_JOURNAL_MAX) {
    operationJournal.splice(OPERATION_JOURNAL_MAX);
  }
  return { operationId, startedAt };
}

function finishOperation(
  operationId: string,
  status: 'succeeded' | 'failed',
  message: string,
  error?: string
): void {
  const index = operationJournal.findIndex((entry) => entry.operationId === operationId);
  const endedAt = new Date().toISOString();
  if (index < 0) {
    operationJournal.unshift({
      operationId,
      type: 'readiness-fix',
      status,
      startedAt: endedAt,
      endedAt,
      message,
      ...(error ? { error } : {}),
    });
    return;
  }
  const previous = operationJournal[index];
  if (!previous) return;
  operationJournal[index] = {
    ...previous,
    status,
    endedAt,
    message,
    ...(error ? { error } : {}),
  };
}

function getRequestIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? request.ip;
  }
  return request.ip;
}

function upsertBridgeConnection(
  machineId: string,
  sourceIp: string,
  options?: {
    machineLabel: string | undefined;
    bridgeVersion: string | undefined;
    lastSeenAt: string | undefined;
  }
): void {
  const existing = bridgeConnections.get(machineId);
  const next: BridgeConnectionInfo = {
    machineId,
    machineLabel: options?.machineLabel ?? existing?.machineLabel,
    bridgeVersion: options?.bridgeVersion ?? existing?.bridgeVersion,
    sourceIp,
    lastSeenAt: options?.lastSeenAt ?? new Date().toISOString(),
  };
  bridgeConnections.set(machineId, next);
}

function consumeBridgeCronSyncRateLimit(
  machineId: string,
  sourceIp: string
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const key = `${machineId}:${sourceIp}`;
  const now = Date.now();
  const existing = bridgeCronSyncRateBuckets.get(key);

  if (!existing || now - existing.windowStartMs >= BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS) {
    bridgeCronSyncRateBuckets.set(key, {
      windowStartMs: now,
      count: 1,
    });
    return { ok: true };
  }

  if (existing.count >= BRIDGE_CRON_SYNC_RATE_LIMIT_MAX_REQUESTS) {
    const elapsed = now - existing.windowStartMs;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS - elapsed) / 1000)
    );
    return { ok: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { ok: true };
}

function dedupeTargetStatuses(
  statuses: readonly TargetSyncStatusEntry[],
  onlineMachineIds: ReadonlySet<string>
): readonly TargetSyncStatusEntry[] {
  const groups = new Map<string, TargetSyncStatusEntry[]>();

  for (const entry of statuses) {
    const target = entry.target;
    const key = target.type === 'remote' ? `remote::${target.id}` : `local::${target.id}`;
    const list = groups.get(key);
    if (list) {
      list.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  const result: TargetSyncStatusEntry[] = [];
  for (const entries of groups.values()) {
    let selected = entries[0];
    if (!selected) continue;
    let selectedScore = -1;
    let selectedUpdatedAt = Date.parse(selected.target.updatedAt);

    for (const entry of entries) {
      const target = entry.target;
      let score = 0;
      for (const machineId of onlineMachineIds) {
        if (target.openclawDir.includes(machineId)) {
          score = 2;
          break;
        }
      }
      if (score === 0 && entry.syncStatus.lastSuccessfulSyncAt) {
        score = 1;
      }

      const updatedAt = Date.parse(target.updatedAt);
      const newer =
        Number.isNaN(updatedAt) || Number.isNaN(selectedUpdatedAt)
          ? false
          : updatedAt > selectedUpdatedAt;

      if (score > selectedScore || (score === selectedScore && newer)) {
        selected = entry;
        selectedScore = score;
        selectedUpdatedAt = updatedAt;
      }
    }
    result.push(selected);
  }

  return result;
}

const RATE_BUCKET_CLEANUP_INTERVAL_MS = 5 * 60_000;
const rateBucketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of bridgeCronSyncRateBuckets) {
    if (now - bucket.windowStartMs >= BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS * 2) {
      bridgeCronSyncRateBuckets.delete(key);
    }
  }
}, RATE_BUCKET_CLEANUP_INTERVAL_MS);
rateBucketCleanupTimer.unref();

const BRIDGE_STALE_TTL_MS = 5 * 60_000;
const bridgeCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [machineId, info] of bridgeConnections) {
    const lastSeen = new Date(info.lastSeenAt).getTime();
    if (Number.isNaN(lastSeen) || now - lastSeen > BRIDGE_STALE_TTL_MS) {
      bridgeConnections.delete(machineId);
    }
  }
}, RATE_BUCKET_CLEANUP_INTERVAL_MS);
bridgeCleanupTimer.unref();

const fleetApprovalCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, pending] of fleetPendingApprovals) {
    if (now > pending.expiresAt) {
      fleetPendingApprovals.delete(token);
    }
  }
}, RATE_BUCKET_CLEANUP_INTERVAL_MS);
fleetApprovalCleanupTimer.unref();

const AUTH_SETTINGS_DIR =
  process.env.PATZE_SETTINGS_DIR ?? path.join(os.homedir(), '.patze-control');
const AUTH_SETTINGS_FILE = path.join(AUTH_SETTINGS_DIR, 'auth.json');
const FLEET_ALERT_SETTINGS_FILE = path.join(AUTH_SETTINGS_DIR, 'fleet-alerts.json');

interface PersistedAuthSettings {
  mode: 'none' | 'token';
  token?: string;
}

function loadPersistedAuth(): PersistedAuthSettings | null {
  try {
    if (!fs.existsSync(AUTH_SETTINGS_FILE)) return null;
    const raw = fs.readFileSync(AUTH_SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedAuthSettings;
    if (parsed.mode === 'token' || parsed.mode === 'none') return parsed;
    return null;
  } catch {
    return null;
  }
}

function savePersistedAuth(settings: PersistedAuthSettings): void {
  fs.mkdirSync(AUTH_SETTINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

interface PersistedFleetAlertSettings {
  readonly destinations: readonly FleetAlertDestination[];
  readonly rules?: readonly FleetAlertRouteRule[];
}

function isFleetAlertSeverity(value: unknown): value is FleetAlertSeverity {
  return value === 'warning' || value === 'high' || value === 'critical';
}

function loadPersistedFleetAlerts(): void {
  try {
    if (!fs.existsSync(FLEET_ALERT_SETTINGS_FILE)) return;
    const raw = fs.readFileSync(FLEET_ALERT_SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedFleetAlertSettings;
    if (Array.isArray(parsed.destinations)) {
      for (const item of parsed.destinations) {
        if (
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          item.kind !== 'webhook' ||
          typeof item.url !== 'string' ||
          !isFleetAlertSeverity(item.minimumSeverity) ||
          typeof item.enabled !== 'boolean' ||
          typeof item.createdAt !== 'string' ||
          typeof item.updatedAt !== 'string'
        ) {
          continue;
        }
        fleetAlertDestinations.set(item.id, item);
      }
    }
    if (Array.isArray(parsed.rules)) {
      for (const item of parsed.rules) {
        if (
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          !isFleetAlertSeverity(item.minimumSeverity) ||
          (item.targetScope !== 'all' && item.targetScope !== 'target_ids') ||
          !Array.isArray(item.targetIds) ||
          !item.targetIds.every(
            (targetId: unknown) => typeof targetId === 'string' && targetId.length > 0
          ) ||
          !Array.isArray(item.destinationIds) ||
          !item.destinationIds.every(
            (destinationId: unknown) =>
              typeof destinationId === 'string' && destinationId.length > 0
          ) ||
          typeof item.enabled !== 'boolean' ||
          typeof item.createdAt !== 'string' ||
          typeof item.updatedAt !== 'string'
        ) {
          continue;
        }
        fleetAlertRouteRules.set(item.id, item);
      }
    }
  } catch {
    /* ignore persisted alert settings errors */
  }
}

function savePersistedFleetAlerts(): void {
  const payload: PersistedFleetAlertSettings = {
    destinations: [...fleetAlertDestinations.values()],
    rules: [...fleetAlertRouteRules.values()],
  };
  fs.mkdirSync(AUTH_SETTINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FLEET_ALERT_SETTINGS_FILE, JSON.stringify(payload, null, 2) + '\n', {
    mode: 0o600,
  });
}

function loadAuthConfig(): AuthConfig {
  const persisted = loadPersistedAuth();
  if (persisted) {
    return {
      mode: persisted.mode,
      ...(persisted.token ? { token: persisted.token } : {}),
    };
  }

  const rawMode = process.env.TELEMETRY_AUTH_MODE;
  if (rawMode === 'token') {
    const token = process.env.TELEMETRY_AUTH_TOKEN;
    return {
      mode: 'token',
      ...(token ? { token } : {}),
    };
  }

  return { mode: 'none' };
}

let authConfig = loadAuthConfig();
loadPersistedFleetAlerts();

function getAuthToken(): string | null {
  return authConfig.mode === 'token' ? (authConfig.token ?? null) : null;
}

function authHasToken(): boolean {
  const t = getAuthToken();
  return t !== null && t.length > 0;
}

function createBridgeInstallToken(): string {
  return `pk_${randomBytes(24).toString('base64url')}`;
}

if (authConfig.mode === 'token' && !authHasToken()) {
  throw new Error('TELEMETRY_AUTH_TOKEN is required when TELEMETRY_AUTH_MODE=token.');
}

function parseBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }

  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) {
    return null;
  }

  const scheme = header.slice(0, spaceIndex);
  const token = header.slice(spaceIndex + 1);
  if (scheme !== 'Bearer' || token.length === 0) {
    return null;
  }

  return token;
}

const HMAC_KEY = randomBytes(32);

function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHmac('sha256', HMAC_KEY).update(a).digest();
  const digestB = createHmac('sha256', HMAC_KEY).update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function isAuthorized(request: FastifyRequest): boolean {
  if (authConfig.mode === 'none') {
    return true;
  }

  const requestToken = parseBearerToken(request);
  const serverToken = getAuthToken();
  if (requestToken === null || serverToken === null) {
    return false;
  }

  return constantTimeEquals(requestToken, serverToken);
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || Number.isNaN(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function isJsonContentType(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return normalized.startsWith('application/json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BLOCKED_DIR_PREFIXES = [
  '/etc',
  '/var',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/sbin',
  '/bin',
  '/usr/sbin',
  '/usr/bin',
  '/lib',
  '/tmp',
];

function isOpenClawDirSafe(resolvedDir: string): boolean {
  if (resolvedDir === '/' || resolvedDir === os.homedir()) return false;
  for (const prefix of BLOCKED_DIR_PREFIXES) {
    if (resolvedDir === prefix || resolvedDir.startsWith(prefix + path.sep)) return false;
  }
  const homeDir = os.homedir();
  const safePrefixes = [
    path.join(homeDir, '.openclaw'),
    path.join(homeDir, '.patze-control'),
    path.join(homeDir, 'openclaw'),
  ];
  const isUnderHome = resolvedDir.startsWith(homeDir + path.sep);
  if (!isUnderHome) return false;
  const isUnderSshDir =
    resolvedDir.startsWith(path.join(homeDir, '.ssh') + path.sep) ||
    resolvedDir === path.join(homeDir, '.ssh');
  if (isUnderSshDir) return false;
  const isUnderGnupg =
    resolvedDir.startsWith(path.join(homeDir, '.gnupg') + path.sep) ||
    resolvedDir === path.join(homeDir, '.gnupg');
  if (isUnderGnupg) return false;
  const isUnderConfig =
    resolvedDir.startsWith(path.join(homeDir, '.config') + path.sep) ||
    resolvedDir === path.join(homeDir, '.config');
  if (isUnderConfig) return false;
  return safePrefixes.some((p) => resolvedDir === p || resolvedDir.startsWith(p + path.sep));
}

function parseBatchBody(body: unknown): readonly unknown[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const events = body.events;
  if (!Array.isArray(events)) {
    return null;
  }
  return events;
}

function getContentLengthBytes(request: FastifyRequest): number | null {
  const raw = request.headers['content-length'];
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function isBodySizeWithinLimit(request: FastifyRequest, limitBytes: number): boolean {
  const contentLength = getContentLengthBytes(request);
  if (contentLength === null) {
    return true;
  }
  return contentLength <= limitBytes;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const SAFE_ENTITY_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isValidEntityId(id: string): boolean {
  return SAFE_ENTITY_ID_RE.test(id) && id.length > 0 && id.length <= 128;
}

function sanitizeRunFilename(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function hashTargetConfig(rawConfig: string | null): string {
  return createHash('sha256')
    .update(rawConfig ?? '{}')
    .digest('hex');
}

function buildTargetVersion(openclawDirPath: string): string {
  return hashTargetConfig(readRawConfigString(openclawDirPath));
}

function getBridgeCronProxyRootDir(): string {
  const storeDir = process.env.CRON_STORE_DIR ?? path.join(os.homedir(), '.patze-control', 'cron');
  return path.join(storeDir, 'remote-openclaw');
}

function resolveBridgeMachineIdForTarget(target: OpenClawTarget): string | null {
  if (target.type !== 'remote') return null;
  const relative = path.relative(getBridgeCronProxyRootDir(), target.openclawDir);
  if (!relative || relative.startsWith('..')) return null;
  const [machineId] = relative.split(path.sep);
  if (!machineId || machineId.trim().length === 0) return null;
  return machineId;
}

function parseSemver(version: string): readonly [number, number, number] {
  const core = version.trim().replace(/^v/i, '').split('-')[0] ?? '';
  const [majorRaw, minorRaw, patchRaw] = core.split('.');
  const major = Number(majorRaw ?? '0');
  const minor = Number(minorRaw ?? '0');
  const patch = Number(patchRaw ?? '0');
  return [
    Number.isFinite(major) ? major : 0,
    Number.isFinite(minor) ? minor : 0,
    Number.isFinite(patch) ? patch : 0,
  ];
}

function isVersionOlderThan(current: string, minimum: string): boolean {
  const c = parseSemver(current);
  const m = parseSemver(minimum);
  if (c[0] !== m[0]) return c[0] < m[0];
  if (c[1] !== m[1]) return c[1] < m[1];
  return c[2] < m[2];
}

function scoreToRiskLevel(score: number): FleetRiskLevel {
  if (score >= 85) return 'low';
  if (score >= 65) return 'medium';
  if (score >= 40) return 'high';
  return 'critical';
}

function createDefaultFleetPolicyProfile(): FleetPolicyProfile {
  const now = new Date().toISOString();
  return {
    id: 'default',
    name: 'Default Fleet Policy',
    ...(SMART_FLEET_MIN_BRIDGE_VERSION ? { minBridgeVersion: SMART_FLEET_MIN_BRIDGE_VERSION } : {}),
    maxSyncLagMs: SMART_FLEET_MAX_SYNC_LAG_MS,
    allowedAuthMode: 'any',
    maxConsecutiveFailures: 3,
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDefaultFleetPolicyProfile(): FleetPolicyProfile {
  const existing = fleetPolicyProfiles.get('default');
  if (existing) return existing;
  const created = createDefaultFleetPolicyProfile();
  fleetPolicyProfiles.set(created.id, created);
  return created;
}

function resolveFleetPolicyForTarget(targetId: string): FleetPolicyProfile {
  const defaultPolicy = ensureDefaultFleetPolicyProfile();
  const policyId = fleetTargetPolicyId.get(targetId) ?? defaultPolicy.id;
  return fleetPolicyProfiles.get(policyId) ?? defaultPolicy;
}

function computeSyncLagMs(
  syncStatus: OpenClawSyncStatus,
  reported: BridgeReportedState | undefined
): number | undefined {
  const now = Date.now();
  const lastSuccessAt = syncStatus.lastSuccessfulSyncAt
    ? Date.parse(syncStatus.lastSuccessfulSyncAt)
    : NaN;
  if (!Number.isNaN(lastSuccessAt)) {
    return Math.max(0, now - lastSuccessAt);
  }
  const lastSeenAt = reported?.lastSeenAt ? Date.parse(reported.lastSeenAt) : NaN;
  if (!Number.isNaN(lastSeenAt)) {
    return Math.max(0, now - lastSeenAt);
  }
  return undefined;
}

function buildFleetDesiredState(
  target: OpenClawTarget,
  policy: FleetPolicyProfile
): FleetDesiredState {
  return {
    ...(policy.minBridgeVersion ? { bridgeVersion: policy.minBridgeVersion } : {}),
    configHash: buildTargetVersion(target.openclawDir),
    maxSyncLagMs: policy.maxSyncLagMs,
    allowAutoRemediation: false,
  };
}

function buildFleetReportedState(
  target: OpenClawTarget,
  syncStatus: OpenClawSyncStatus
): { reported: FleetReportedState; bridgeState?: BridgeReportedState } {
  const machineId = resolveBridgeMachineIdForTarget(target);
  const bridgeState = machineId ? bridgeReportedStateByTargetId.get(target.id) : undefined;
  const syncLagMs = computeSyncLagMs(syncStatus, bridgeState);
  const reported: FleetReportedState = {
    ...(machineId ? { machineId } : {}),
    ...(bridgeState?.bridgeVersion ? { bridgeVersion: bridgeState.bridgeVersion } : {}),
    ...(bridgeState?.configHash ? { configHash: bridgeState.configHash } : {}),
    ...(syncLagMs !== undefined ? { syncLagMs } : {}),
    ...(bridgeState?.lastSeenAt ? { heartbeatAt: bridgeState.lastSeenAt } : {}),
  };
  return { reported, ...(bridgeState ? { bridgeState } : {}) };
}

function buildFleetDrifts(
  targetId: string,
  desired: FleetDesiredState,
  reported: FleetReportedState,
  syncStatus: OpenClawSyncStatus
): FleetDriftRecord[] {
  const detectedAt = new Date().toISOString();
  const drifts: FleetDriftRecord[] = [];

  if (reported.configHash && reported.configHash !== desired.configHash) {
    drifts.push({
      targetId,
      category: 'config',
      severity: 'major',
      expected: desired.configHash,
      actual: reported.configHash,
      detectedAt,
    });
  }

  if (
    desired.bridgeVersion &&
    reported.bridgeVersion &&
    isVersionOlderThan(reported.bridgeVersion, desired.bridgeVersion)
  ) {
    drifts.push({
      targetId,
      category: 'version',
      severity: 'major',
      expected: desired.bridgeVersion,
      actual: reported.bridgeVersion,
      detectedAt,
    });
  }

  if (reported.syncLagMs !== undefined && reported.syncLagMs > desired.maxSyncLagMs) {
    drifts.push({
      targetId,
      category: 'sync',
      severity: reported.syncLagMs > desired.maxSyncLagMs * 2 ? 'critical' : 'minor',
      expected: `<=${String(desired.maxSyncLagMs)}ms`,
      actual: `${String(reported.syncLagMs)}ms`,
      detectedAt,
    });
  }

  if (syncStatus.consecutiveFailures >= 3) {
    drifts.push({
      targetId,
      category: 'runtime',
      severity: 'critical',
      expected: 'consecutiveFailures<3',
      actual: `consecutiveFailures=${String(syncStatus.consecutiveFailures)}`,
      detectedAt,
    });
  }

  return drifts;
}

function buildFleetViolations(
  targetId: string,
  drifts: readonly FleetDriftRecord[],
  syncStatus: OpenClawSyncStatus,
  policy: FleetPolicyProfile
): FleetPolicyViolation[] {
  const createdAt = new Date().toISOString();
  const violations: FleetPolicyViolation[] = [];

  for (const drift of drifts) {
    const severity =
      drift.severity === 'critical' ? 'critical' : drift.severity === 'major' ? 'high' : 'warning';
    violations.push({
      id: `${targetId}:${drift.category}`,
      targetId,
      code: `drift_${drift.category}`,
      severity,
      message: `Drift detected in ${drift.category}: expected ${drift.expected}, actual ${drift.actual}`,
      createdAt,
    });
  }

  if (!syncStatus.running) {
    violations.push({
      id: `${targetId}:sync_not_running`,
      targetId,
      code: 'sync_not_running',
      severity: 'warning',
      message: 'OpenClaw sync loop is not running for target.',
      createdAt,
    });
  }

  if (syncStatus.consecutiveFailures > policy.maxConsecutiveFailures) {
    violations.push({
      id: `${targetId}:failure_burst`,
      targetId,
      code: 'failure_burst',
      severity: 'high',
      message: `Consecutive failures ${String(syncStatus.consecutiveFailures)} exceed policy max ${String(policy.maxConsecutiveFailures)}.`,
      createdAt,
    });
  }

  if (policy.allowedAuthMode !== 'any' && authConfig.mode !== policy.allowedAuthMode) {
    violations.push({
      id: `${targetId}:auth_mode`,
      targetId,
      code: 'auth_mode_mismatch',
      severity: 'warning',
      message: `Auth mode "${authConfig.mode}" does not match policy "${policy.allowedAuthMode}".`,
      createdAt,
    });
  }

  return violations;
}

function computeFleetHealthScore(
  target: OpenClawTarget,
  syncStatus: OpenClawSyncStatus,
  drifts: readonly FleetDriftRecord[],
  violations: readonly FleetPolicyViolation[],
  reported: FleetReportedState,
  maxSyncLagMs: number
): number {
  let score = 100;
  if (!syncStatus.running) score -= 15;
  if (!syncStatus.available) score -= 20;
  if (syncStatus.stale) score -= 15;
  score -= Math.min(20, syncStatus.consecutiveFailures * 5);
  if (target.type === 'remote' && !reported.heartbeatAt) score -= 20;
  if (reported.syncLagMs !== undefined && reported.syncLagMs > maxSyncLagMs) score -= 10;
  score -= drifts.length * 8;
  score -= violations.length * 5;
  return Math.max(0, Math.min(100, score));
}

function parseBridgeIntent(value: unknown): BridgeCommandIntent | null {
  switch (value) {
    case 'trigger_job':
    case 'agent_set_enabled':
    case 'approve_request':
    case 'run_command':
      return value;
    default:
      return null;
  }
}

function parseBridgeArgs(value: unknown): Readonly<Record<string, unknown>> {
  return toReadonlyRecord(value) ?? {};
}

function hasMutationArgs(
  intent: BridgeCommandIntent,
  args: Readonly<Record<string, unknown>>
): boolean {
  switch (intent) {
    case 'trigger_job':
    case 'approve_request':
      return false;
    case 'agent_set_enabled':
      return true;
    case 'run_command': {
      const command = typeof args.command === 'string' ? args.command : '';
      if (command !== 'openclaw') return true;
      const cliArgs = Array.isArray(args.args)
        ? args.args.filter((item): item is string => typeof item === 'string')
        : [];
      const joined = cliArgs.join(' ').toLowerCase();
      if (joined.includes('config set') || joined.includes('config unset')) return true;
      if (joined.includes('agents add') || joined.includes('agents remove')) return true;
      if (joined.includes('models add') || joined.includes('models remove')) return true;
      if (joined.includes('channels set') || joined.includes('channels unbind')) return true;
      return false;
    }
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

function sanitizeOutput(output: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(output, 'utf-8');
  if (buffer.byteLength <= maxBytes) {
    return { text: output, truncated: false };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString('utf-8'),
    truncated: true,
  };
}

function toReadonlyRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function readHeaderString(request: FastifyRequest, headerName: string): string | undefined {
  const value = request.headers[headerName];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function writeSseEventChunk(event: Readonly<AnyTelemetryEvent>): string {
  return writeSseNamedEventChunk('telemetry', event, event.id);
}

function writeSseNamedEventChunk(
  eventType: string,
  payload: Readonly<unknown>,
  id?: string
): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function writeSseCommentChunk(comment: string): string {
  return `: ${comment}\n\n`;
}

function createSseWriter(response: RawResponse): {
  enqueue: (chunk: string) => void;
  close: () => void;
} {
  return createBoundedSseWriter(response, {
    maxPendingChunks: SSE_MAX_PENDING_CHUNKS,
    onOverflow: () => {
      response.destroy();
    },
  });
}

function createBoundedSseWriter(
  response: RawResponse,
  options: {
    maxPendingChunks: number;
    onOverflow: () => void;
  }
): {
  enqueue: (chunk: string) => void;
  close: () => void;
} {
  let isClosed = false;
  let isBackpressured = false;
  const pending: string[] = [];

  const flushPending = (): void => {
    if (isClosed || !isBackpressured) {
      return;
    }

    isBackpressured = false;
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next) {
        continue;
      }

      const accepted = response.write(next);
      if (!accepted) {
        isBackpressured = true;
        return;
      }
    }
  };

  const onDrain = (): void => {
    flushPending();
  };

  response.on('drain', onDrain);

  const enqueue = (chunk: string): void => {
    if (isClosed) {
      return;
    }

    if (isBackpressured) {
      if (pending.length >= options.maxPendingChunks) {
        options.onOverflow();
        return;
      }
      pending.push(chunk);
      return;
    }

    const accepted = response.write(chunk);
    if (!accepted) {
      isBackpressured = true;
    }
  };

  const close = (): void => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    pending.length = 0;
    response.off('drain', onDrain);
  };

  return { enqueue, close };
}

app.post('/ingest', async (request: IngestRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isBodySizeWithinLimit(request, INGEST_BODY_LIMIT_BYTES)) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }

  const machineIdHeader = readHeaderString(request, 'x-patze-machine-id');
  if (machineIdHeader) {
    upsertBridgeConnection(machineIdHeader, getRequestIp(request), {
      machineLabel: readHeaderString(request, 'x-patze-machine-label'),
      bridgeVersion: readHeaderString(request, 'x-patze-bridge-version'),
      lastSeenAt: undefined,
    });
  }

  const result = telemetryNode.ingest(request.body);

  if (result.ok) {
    return reply.code(200).send(result);
  }

  return reply.code(400).send(result);
});

app.post('/ingest/batch', async (request: BatchIngestRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isBodySizeWithinLimit(request, INGEST_BODY_LIMIT_BYTES)) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }

  const machineIdHeader = readHeaderString(request, 'x-patze-machine-id');
  if (machineIdHeader) {
    upsertBridgeConnection(machineIdHeader, getRequestIp(request), {
      machineLabel: readHeaderString(request, 'x-patze-machine-label'),
      bridgeVersion: readHeaderString(request, 'x-patze-bridge-version'),
      lastSeenAt: undefined,
    });
  }

  const events = parseBatchBody(request.body);
  if (!events) {
    return reply.code(400).send({ error: 'invalid_batch_request' });
  }

  const accepted: Array<{ index: number; event: Readonly<AnyTelemetryEvent> }> = [];
  const rejected: Array<{ index: number; error: { code: string; message: string } }> = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const result = telemetryNode.ingest(event);
    if (result.ok) {
      accepted.push({ index, event: result.event });
      continue;
    }
    rejected.push({
      index,
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    });
  }

  return reply.code(200).send({
    accepted,
    rejected,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
  });
});

app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
  const cli = await checkOpenClawCli();
  return reply.code(200).send({
    ok: true,
    authMode: authConfig.mode,
    authRequired: authConfig.mode === 'token',
    openclawCliAvailable: cli.available,
    openclawCliVersion: cli.version,
  });
});

app.get('/snapshot', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const unified = telemetryAggregator.getUnifiedSnapshot();
  const frontendSnapshot = toFrontendUnifiedSnapshot(unified);
  // TODO: align snapshot/event resume via Last-Event-ID when server-side replay is added.
  return reply.code(200).send(frontendSnapshot);
});

app.get('/events', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  reply.hijack();

  const response = reply.raw;
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const sse = createSseWriter(response);
  sse.enqueue(writeSseCommentChunk('connected'));

  const unsubscribe = telemetryAggregator.subscribeEvents((event: Readonly<AnyTelemetryEvent>) => {
    sse.enqueue(writeSseEventChunk(event));
  });

  const heartbeat = setInterval(() => {
    sse.enqueue(writeSseCommentChunk('heartbeat'));
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    sse.close();

    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }

    request.raw.off('close', cleanup);
    response.off('close', cleanup);
    response.off('error', cleanup);
  };

  request.raw.on('close', cleanup);
  response.on('close', cleanup);
  response.on('error', cleanup);
});

type AttachRequest = FastifyRequest<{ Body: unknown }>;
type DetachRequest = FastifyRequest<{ Body: unknown }>;

interface AttachRequestBody {
  host: string;
  port: number;
  sshUser: string;
  remoteBaseUrl: string;
  label?: string;
  authToken?: string;
  sshKeyPath?: string;
}

function parseAttachBody(body: unknown): AttachRequestBody | null {
  if (!isRecord(body)) return null;
  if (typeof body.host !== 'string' || !body.host) return null;
  if (typeof body.sshUser !== 'string' || !body.sshUser) return null;
  const port = typeof body.port === 'number' ? body.port : 22;
  if (port < 1 || port > 65535) return null;
  const remoteBaseUrl =
    typeof body.remoteBaseUrl === 'string' ? body.remoteBaseUrl : 'http://127.0.0.1:9700';
  return {
    host: body.host,
    port,
    sshUser: body.sshUser,
    remoteBaseUrl,
    ...(typeof body.label === 'string' ? { label: body.label } : {}),
    ...(typeof body.authToken === 'string' ? { authToken: body.authToken } : {}),
    ...(typeof body.sshKeyPath === 'string' ? { sshKeyPath: body.sshKeyPath } : {}),
  };
}

function isPathUnderSshDir(keyPath: string): boolean {
  const homeDir = process.env.HOME ?? os.homedir();
  const resolved = path.resolve(keyPath.startsWith('~') ? keyPath.replace('~', homeDir) : keyPath);
  const allowedDir = path.resolve(homeDir, '.ssh');
  return resolved.startsWith(allowedDir + path.sep) || resolved === allowedDir;
}

function attachBodyToEndpoint(body: AttachRequestBody): MachineEndpoint {
  const endpointId = `remote_${body.host}_${body.port}_${body.sshUser}`;
  const label = body.label ?? `${body.sshUser}@${body.host}`;
  const auth: AuthConfig = body.authToken
    ? { mode: 'token', token: body.authToken }
    : { mode: 'none' };

  const homeDir = process.env.HOME ?? os.homedir();
  const defaultSshDir = path.join(homeDir, '.ssh');
  let privateKeyPath = path.join(defaultSshDir, 'id_rsa');
  let knownHostsPath = path.join(defaultSshDir, 'known_hosts');

  if (body.sshKeyPath) {
    if (!isPathUnderSshDir(body.sshKeyPath)) {
      throw new Error('SSH key path must be under ~/.ssh/');
    }
    const resolved = body.sshKeyPath.startsWith('~')
      ? body.sshKeyPath.replace('~', homeDir)
      : body.sshKeyPath;
    privateKeyPath = resolved;
    knownHostsPath = path.join(path.dirname(resolved), 'known_hosts');
  }

  return {
    id: endpointId,
    label,
    transport: 'ssh_tunnel',
    baseUrl: body.remoteBaseUrl,
    ssh: {
      host: body.host,
      port: body.port,
      user: body.sshUser,
      knownHostsPath,
      privateKeyPath,
    },
    auth,
  };
}

app.post('/remote/attach', async (request: AttachRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const body = parseAttachBody(request.body);
  if (!body) {
    return reply
      .code(400)
      .send({ error: 'invalid_attach_body', message: 'host and sshUser are required.' });
  }

  const endpoint = attachBodyToEndpoint(body);

  try {
    const info = await orchestrator.attachEndpoint(endpoint);
    return reply.code(200).send({ ...info, attachmentId: info.endpointId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    app.log.error({ err: error }, 'attach_failed');
    const safeMsg = msg.includes('/') ? 'SSH connection or tunnel setup failed.' : msg;
    return reply.code(500).send({ error: 'attach_failed', message: safeMsg });
  }
});

app.post('/remote/detach', async (request: DetachRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_detach_body' });
  }

  const rawId = request.body.attachmentId ?? request.body.endpointId;
  if (typeof rawId !== 'string' || !rawId) {
    return reply.code(400).send({ error: 'attachmentId or endpointId is required' });
  }

  try {
    await orchestrator.detachEndpoint(rawId, { closeTunnel: true });
    return reply.code(200).send({ ok: true });
  } catch (error) {
    app.log.error({ err: error }, 'detach_failed');
    return reply.code(500).send({ error: 'detach_failed', message: 'Failed to detach endpoint.' });
  }
});

app.get('/remote/attachments', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const attachments = await Promise.all(
    orchestrator.listAttachments().map(async (a) => {
      let status: 'connected' | 'degraded' = 'connected';
      try {
        const healthRes = await fetch(`${a.tunnel.localBaseUrl}/health`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(2_000),
        });
        if (!healthRes.ok) {
          status = 'degraded';
        } else {
          const payload = (await healthRes.json()) as { ok?: unknown };
          if (payload.ok !== true) {
            status = 'degraded';
          }
        }
      } catch {
        status = 'degraded';
      }
      return {
        id: a.endpointId,
        host: a.tunnel.remoteHost,
        port: a.tunnel.remotePort,
        sshUser: a.sshUser,
        status,
      };
    })
  );

  return reply.code(200).send(attachments);
});

app.get('/tunnels', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  return reply.code(200).send({ tunnels: sshTunnelRuntime.listTunnels() });
});

app.get('/bridge/connections', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const connections = [...bridgeConnections.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt)
  );
  return reply.code(200).send({ connections });
});

app.get('/operations/recent', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const query = request.query as Record<string, string | undefined>;
  const limit = parsePositiveInt(query.limit, 30, 200);
  return reply.code(200).send({ operations: operationJournal.slice(0, limit) });
});

app.get('/ssh/config-hosts', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const aliases = await listSshConfigAliases();
  return reply.code(200).send({ aliases });
});

app.post('/bridge/preflight', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const sshHost = typeof body.sshHost === 'string' ? body.sshHost.trim() : '';
  const sshPort = typeof body.sshPort === 'number' ? body.sshPort : 22;
  const sshUser = typeof body.sshUser === 'string' ? body.sshUser.trim() : 'root';
  const sshKeyPath = typeof body.sshKeyPath === 'string' ? body.sshKeyPath.trim() : '~/.ssh/id_rsa';
  const sshModeRaw = typeof body.sshMode === 'string' ? body.sshMode.trim() : '';
  const sshMode = sshModeRaw === 'alias' || sshModeRaw === 'explicit' ? sshModeRaw : undefined;

  if (!sshHost) {
    return reply.code(400).send({ error: 'missing_ssh_host' });
  }
  if (sshModeRaw && !sshMode) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_mode', message: 'sshMode must be "alias" or "explicit".' });
  }
  if (sshPort < 1 || sshPort > 65535) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_port', message: 'Port must be between 1 and 65535.' });
  }

  try {
    const result = await bridgeSetupManager.preflight({
      label: sshHost,
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
      sshMode,
      authToken: '',
      remotePort: 19700,
    });
    return reply.code(200).send(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.warn({ err }, 'bridge_preflight_failed');
    const diagnosis = classifyPreflightFailure(msg, { sshHost, sshPort, sshUser, sshKeyPath });
    const safeMsg =
      diagnosis.code === 'unknown' && msg.includes('/') && !msg.includes('~/.ssh')
        ? 'SSH pre-flight failed.'
        : diagnosis.message;
    return reply.code(422).send({
      ok: false,
      error: 'preflight_failed',
      message: safeMsg,
      diagnosis: {
        ...diagnosis,
        message: safeMsg,
      },
    });
  }
});

// ── Managed Bridge Setup (from UI) ───────────────────────────────────

app.post('/bridge/setup', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const sshHost = typeof body.sshHost === 'string' ? body.sshHost.trim() : '';
  const sshPort = typeof body.sshPort === 'number' ? body.sshPort : 22;
  const sshUser = typeof body.sshUser === 'string' ? body.sshUser.trim() : 'root';
  const sshKeyPath = typeof body.sshKeyPath === 'string' ? body.sshKeyPath.trim() : '~/.ssh/id_rsa';
  const sshModeRaw = typeof body.sshMode === 'string' ? body.sshMode.trim() : '';
  const sshMode = sshModeRaw === 'alias' || sshModeRaw === 'explicit' ? sshModeRaw : undefined;
  const authTokenInput = typeof body.authToken === 'string' ? body.authToken.trim() : '';
  const authToken =
    authTokenInput.length > 0 ? authTokenInput : (getAuthToken() ?? createBridgeInstallToken());
  const remotePort = typeof body.remotePort === 'number' ? body.remotePort : 19700;
  const expiresIn = typeof body.expiresIn === 'string' ? body.expiresIn.trim() : undefined;
  const openclawHome = typeof body.openclawHome === 'string' ? body.openclawHome.trim() : undefined;

  if (!sshHost) {
    return reply.code(400).send({ error: 'missing_ssh_host' });
  }
  if (sshModeRaw && !sshMode) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_mode', message: 'sshMode must be "alias" or "explicit".' });
  }
  if (sshPort < 1 || sshPort > 65535) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_port', message: 'Port must be between 1 and 65535.' });
  }
  if (remotePort < 1 || remotePort > 65535) {
    return reply
      .code(400)
      .send({ error: 'invalid_remote_port', message: 'Port must be between 1 and 65535.' });
  }

  const input: BridgeSetupInput = {
    label: label || sshHost,
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    sshMode,
    authToken,
    remotePort,
    expiresIn,
    openclawHome,
  };

  try {
    app.log.info(
      {
        sshHost,
        sshPort,
        sshUser,
        hasProvidedToken: authTokenInput.length > 0,
        usingServerToken: authTokenInput.length === 0 && getAuthToken() !== null,
        usingGeneratedToken: authTokenInput.length === 0 && getAuthToken() === null,
      },
      'bridge_setup_token_resolution'
    );
    const state = await bridgeSetupManager.setup(input);
    return reply.code(200).send(state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.error({ err }, 'bridge_setup_failed');
    const safeMsg = msg.includes('/') && !msg.includes('~/.ssh') ? 'Bridge setup failed.' : msg;
    return reply.code(500).send({ error: 'setup_failed', message: safeMsg });
  }
});

app.get('/bridge/managed', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send({ bridges: bridgeSetupManager.list() });
});

app.get('/bridge/managed/:id', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  const state = bridgeSetupManager.get(id);
  if (!state) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(200).send(state);
});

app.post('/bridge/managed/:id/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  const ok = bridgeSetupManager.disconnect(id);
  if (!ok) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(200).send({ ok: true });
});

app.delete('/bridge/managed/:id', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  const ok = bridgeSetupManager.remove(id);
  if (!ok) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(200).send({ ok: true });
});

app.post(
  '/bridge/managed/:id/sudo-password',
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | null;
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!password) {
      return reply.code(400).send({ error: 'password is required' });
    }
    try {
      const state = await bridgeSetupManager.retryInstallWithSudoPassword(id, password);
      if (!state) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: 'install_failed', message: msg });
    }
  }
);

app.post('/bridge/managed/:id/skip-sudo', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  try {
    const state = await bridgeSetupManager.retryInstallUserMode(id);
    if (!state) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: 'install_failed', message: msg });
  }
});

app.post('/openclaw/bridge/cron-sync', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isBodySizeWithinLimit(request, CRON_SYNC_BODY_LIMIT_BYTES)) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }

  const payload = parseBridgeCronSyncPayload(request.body);
  if (!payload) {
    return reply.code(400).send({ error: 'invalid_cron_sync_payload' });
  }

  const sourceIp = getRequestIp(request);
  const rateLimit = consumeBridgeCronSyncRateLimit(payload.machineId, sourceIp);
  if (!rateLimit.ok) {
    reply.header('Retry-After', String(rateLimit.retryAfterSeconds));
    return reply.code(429).send({
      error: 'rate_limited',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  const target = ensureBridgeProxyTarget(payload.machineId, payload.machineLabel);
  if (payload.jobs) {
    writeBridgeJobsFile(target.openclawDir, payload.jobs);
  }
  if (payload.configRaw !== undefined) {
    writeBridgeConfigFile(target.openclawDir, payload.configRaw);
  }
  if (hasRunDelta(payload.newRuns)) {
    appendBridgeRuns(target.openclawDir, payload.newRuns);
  }

  upsertBridgeConnection(payload.machineId, sourceIp, {
    machineLabel: payload.machineLabel,
    bridgeVersion: payload.bridgeVersion,
    lastSeenAt: new Date().toISOString(),
  });
  bridgeReportedStateByTargetId.set(target.id, {
    targetId: target.id,
    machineId: payload.machineId,
    bridgeVersion: payload.bridgeVersion,
    configHash: payload.configHash,
    lastSeenAt: new Date().toISOString(),
  });
  maybeBroadcastFleetTargetSignals(target.id);

  app.log.info(
    {
      machineId: payload.machineId,
      machineLabel: payload.machineLabel,
      bridgeVersion: payload.bridgeVersion,
      sourceIp,
      jobsChanged: payload.jobs !== undefined,
      configChanged: payload.configRaw !== undefined,
      runDeltaJobs: Object.keys(payload.newRuns).length,
    },
    'Bridge cron sync received'
  );

  return reply.code(200).send({
    ok: true,
    targetId: target.id,
    jobsApplied: payload.jobs !== undefined,
    configApplied: payload.configRaw !== undefined,
    runDeltaJobs: Object.keys(payload.newRuns).length,
  });
});

const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? '120000');
const HEARTBEAT_CHECK_INTERVAL_MS = 60_000;

const lastHeartbeatByMachine = new Map<string, number>();

telemetryAggregator.subscribeEvents((event: Readonly<AnyTelemetryEvent>) => {
  if (event.type === 'machine.heartbeat') {
    lastHeartbeatByMachine.set(event.machineId, Date.now());
  } else if (event.type === 'machine.registered') {
    lastHeartbeatByMachine.set(event.machineId, Date.now());
  }
});

const heartbeatChecker = setInterval(() => {
  const now = Date.now();
  for (const [machineId, lastSeen] of lastHeartbeatByMachine) {
    if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
      const offlineEvent = {
        version: 'telemetry.v1',
        id: `synth_offline_${machineId}_${now.toString(36)}`,
        ts: new Date().toISOString(),
        machineId,
        severity: 'warn',
        type: 'machine.heartbeat',
        payload: {
          machineId,
          status: 'offline',
          resource: { cpuPct: 0, memoryBytes: 0, memoryPct: 0 },
        },
        trace: { traceId: `trace_synth_${now.toString(36)}` },
      };
      telemetryNode.ingest(offlineEvent);
      lastHeartbeatByMachine.delete(machineId);
      app.log.warn(
        `Machine ${machineId} marked offline — no heartbeat for ${HEARTBEAT_TIMEOUT_MS}ms`
      );
    }
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

function exists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function readableDir(targetPath: string): boolean {
  try {
    fs.readdirSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildOpenClawHealth(
  targetPath: string,
  syncStatus: OpenClawSyncStatus
): Promise<OpenClawHealthCheck> {
  const cli = await checkOpenClawCli();
  const cronDir = path.join(targetPath, 'cron');
  const checks: HealthCheckItem[] = [];

  const addCheck = (check: HealthCheckItem): void => {
    checks.push(check);
  };

  if (!exists(targetPath)) {
    addCheck({
      id: 'openclaw-home',
      name: 'OpenClaw home',
      status: 'error',
      message: `OpenClaw directory not found: ${targetPath}`,
      details: 'Set OPENCLAW_HOME to a valid OpenClaw installation path.',
    });
  } else {
    addCheck({
      id: 'openclaw-home',
      name: 'OpenClaw home',
      status: 'ok',
      message: `${targetPath} is accessible`,
      details: undefined,
    });
  }

  if (!exists(cronDir)) {
    addCheck({
      id: 'openclaw-cron-dir',
      name: 'cron directory',
      status: 'error',
      message: `Missing cron folder: ${cronDir}`,
      details: 'OpenClaw jobs may not be available yet.',
    });
  } else if (!readableDir(cronDir)) {
    addCheck({
      id: 'openclaw-cron-dir',
      name: 'cron directory',
      status: 'error',
      message: `Cannot read cron folder: ${cronDir}`,
      details: 'Ensure read permission for the API server user.',
    });
  } else {
    addCheck({
      id: 'openclaw-cron-dir',
      name: 'cron directory',
      status: 'ok',
      message: 'cron folder is readable',
      details: undefined,
    });
  }

  const jobsFile = path.join(cronDir, 'jobs.json');
  if (!exists(cronDir) || !exists(jobsFile)) {
    addCheck({
      id: 'openclaw-jobs',
      name: 'jobs.json',
      status: syncStatus.available ? 'warn' : 'error',
      message: 'jobs.json not found',
      details: 'Sync will stay in standby until OpenClaw creates jobs.json.',
    });
  } else {
    addCheck({
      id: 'openclaw-jobs',
      name: 'jobs.json',
      status: 'ok',
      message: 'jobs.json found',
      details: undefined,
    });
  }

  const runsDir = path.join(cronDir, 'runs');
  if (exists(runsDir) && readableDir(runsDir)) {
    addCheck({
      id: 'openclaw-runs',
      name: 'runs folder',
      status: 'ok',
      message: 'runs folder is readable',
      details: undefined,
    });
  } else {
    addCheck({
      id: 'openclaw-runs',
      name: 'runs folder',
      status: 'warn',
      message: 'runs folder is missing or unreadable',
      details: 'Run history may be empty until jobs execute.',
    });
  }

  if (syncStatus.consecutiveFailures > 0) {
    addCheck({
      id: 'openclaw-sync-failures',
      name: 'sync health',
      status: syncStatus.consecutiveFailures >= 3 ? 'error' : 'warn',
      message: `${syncStatus.consecutiveFailures} consecutive sync failure(s)`,
      details: syncStatus.lastError,
    });
  } else if (syncStatus.stale) {
    addCheck({
      id: 'openclaw-sync-stale',
      name: 'sync health',
      status: 'warn',
      message: 'sync data is stale',
      details: `Last successful sync at ${syncStatus.lastSuccessfulSyncAt ?? 'unknown'}`,
    });
  } else if (syncStatus.running) {
    addCheck({
      id: 'openclaw-sync-health',
      name: 'sync health',
      status: 'ok',
      message: `Sync running every ${Math.round(syncStatus.pollIntervalMs / 1000)}s`,
      details: undefined,
    });
  } else {
    addCheck({
      id: 'openclaw-sync-health',
      name: 'sync health',
      status: 'warn',
      message: 'Sync not running',
      details: 'Check API service lifecycle.',
    });
  }

  if (!cli.available) {
    checks.push({
      id: 'openclaw-cli',
      name: 'OpenClaw CLI',
      status: 'error',
      message: 'openclaw command not found in PATH',
      details: 'Install the OpenClaw CLI to enable config management and command execution.',
    });
  } else {
    checks.push({
      id: 'openclaw-cli',
      name: 'OpenClaw CLI',
      status: 'ok',
      message: `openclaw ${cli.version ?? 'unknown'}`,
      details: undefined,
    });
  }

  const ok = checks.every((check) => check.status === 'ok');
  return {
    ok,
    target: path.resolve(targetPath),
    checks,
    syncStatus,
    cliAvailable: cli.available,
    cliVersion: cli.version,
  };
}

const OPENCLAW_CHANNEL_DEFS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'line', name: 'LINE' },
  { id: 'slack', name: 'Slack' },
  { id: 'discord', name: 'Discord' },
  { id: 'signal', name: 'Signal' },
  { id: 'imessage', name: 'iMessage' },
  { id: 'teams', name: 'Teams' },
];

const CHANNEL_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  line: ['line', 'lineoa', 'line_oa', 'lineofficial', 'line-official'],
  imessage: ['imessage', 'iMessage'],
};

function hasAnyNonEmptyString(
  obj: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  return keys.some((key) => {
    const value = obj[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function inferCredentialReady(
  channelId: string,
  config: Readonly<Record<string, unknown>>
): boolean {
  switch (channelId) {
    case 'line':
      return (
        hasAnyNonEmptyString(config, ['channelAccessToken', 'accessToken']) &&
        hasAnyNonEmptyString(config, ['channelSecret', 'secret'])
      );
    case 'telegram':
      return hasAnyNonEmptyString(config, ['botToken', 'token']);
    case 'discord':
      return hasAnyNonEmptyString(config, ['token']);
    case 'slack':
      return hasAnyNonEmptyString(config, ['botToken', 'token', 'appToken']);
    case 'whatsapp':
      return hasAnyNonEmptyString(config, ['token', 'accessToken', 'apiKey']);
    case 'signal':
      return hasAnyNonEmptyString(config, ['number', 'socketPath', 'serviceUrl']);
    default:
      return hasAnyNonEmptyString(config, ['token', 'accessToken', 'apiKey', 'secret']);
  }
}

const CHANNEL_RUNTIME_PROBE_TTL_MS = 15_000;
const channelRuntimeProbeCache = new Map<
  string,
  {
    readonly expiresAt: number;
    readonly data: ReadonlyMap<string, RuntimeChannelProbeState> | null;
  }
>();
const channelRuntimeProbeInFlight = new Map<
  string,
  Promise<ReadonlyMap<string, RuntimeChannelProbeState> | null>
>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChannelId(raw: string): string {
  const value = raw.trim().toLowerCase();
  for (const [canonicalId, aliases] of Object.entries(CHANNEL_KEY_ALIASES)) {
    if (value === canonicalId || aliases.includes(value)) return canonicalId;
  }
  return value;
}

function toRuntimeState(value: unknown): 'connected' | 'disconnected' | 'unknown' {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'connected' ||
    normalized === 'online' ||
    normalized === 'ready' ||
    normalized === 'ok' ||
    normalized === 'active'
  ) {
    return 'connected';
  }
  if (
    normalized === 'disconnected' ||
    normalized === 'offline' ||
    normalized === 'down' ||
    normalized === 'error' ||
    normalized === 'failed'
  ) {
    return 'disconnected';
  }
  return 'unknown';
}

function extractJsonProbePayload(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallback below
  }
  const candidates: Array<[string, string]> = [
    ['[', ']'],
    ['{', '}'],
  ];
  for (const [startChar, endChar] of candidates) {
    const start = trimmed.indexOf(startChar);
    const end = trimmed.lastIndexOf(endChar);
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

function collectRuntimeProbeStates(
  node: unknown,
  out: Map<string, RuntimeChannelProbeState>
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRuntimeProbeStates(item, out);
    return;
  }
  if (!isRecord(node)) return;
  const nestedKeys = ['channels', 'items', 'data', 'providers', 'results'];
  for (const nestedKey of nestedKeys) {
    if (nestedKey in node) {
      collectRuntimeProbeStates(node[nestedKey], out);
    }
  }

  const idCandidates = [
    typeof node.id === 'string' ? node.id : null,
    typeof node.channel === 'string' ? node.channel : null,
    typeof node.provider === 'string' ? node.provider : null,
    typeof node.key === 'string' ? node.key : null,
    typeof node.name === 'string' ? node.name : null,
  ].filter((value): value is string => Boolean(value));
  if (idCandidates.length === 0) return;

  const runtimeState =
    toRuntimeState(node.runtimeState) !== 'unknown'
      ? toRuntimeState(node.runtimeState)
      : toRuntimeState(node.status) !== 'unknown'
        ? toRuntimeState(node.status)
        : toRuntimeState(node.state);

  const connected =
    node.connected === true ||
    node.isConnected === true ||
    node.online === true ||
    node.ready === true ||
    node.active === true ||
    runtimeState === 'connected';

  const normalizedId = normalizeChannelId(idCandidates[0]!);
  out.set(normalizedId, {
    connected,
    runtimeState: runtimeState !== 'unknown' ? runtimeState : connected ? 'connected' : 'unknown',
  });
}

function parseRuntimeProbe(stdout: string): ReadonlyMap<string, RuntimeChannelProbeState> {
  const parsed = extractJsonProbePayload(stdout);
  if (!parsed) return new Map();
  const result = new Map<string, RuntimeChannelProbeState>();
  collectRuntimeProbeStates(parsed, result);
  return result;
}

async function waitForBridgeCommandCompletion(
  commandId: string,
  timeoutMs: number
): Promise<BridgeCommandRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = bridgeCommandStore.get(commandId);
    if (!current) return null;
    if (
      current.state === 'succeeded' ||
      current.state === 'failed' ||
      current.state === 'rejected' ||
      current.state === 'deadletter'
    ) {
      return current;
    }
    await sleep(250);
  }
  return bridgeCommandStore.get(commandId);
}

async function probeRuntimeChannelsForTarget(
  target: OpenClawTarget
): Promise<ReadonlyMap<string, RuntimeChannelProbeState> | null> {
  const machineId = resolveBridgeMachineIdForTarget(target);
  if (!machineId) return null;
  const recentCommands = bridgeCommandStore.list({
    targetId: target.id,
    machineId,
    limit: 25,
  });
  for (const command of recentCommands) {
    if (
      command.snapshot.createdBy === 'channels-runtime-probe' &&
      (command.state === 'queued' || command.state === 'leased' || command.state === 'running') &&
      Date.now() - Date.parse(command.createdAt) >= 60_000
    ) {
      bridgeCommandStore.reject(command.id, 'runtime_probe_stale');
    }
  }
  const recentProbe = recentCommands.find(
    (command) => command.snapshot.createdBy === 'channels-runtime-probe'
  );
  if (recentProbe) {
    if (
      (recentProbe.state === 'queued' ||
        recentProbe.state === 'leased' ||
        recentProbe.state === 'running') &&
      Date.now() - Date.parse(recentProbe.createdAt) < 60_000
    ) {
      return null;
    }
    if (recentProbe.state === 'succeeded' && recentProbe.result?.stdout) {
      const parsed = parseRuntimeProbe(recentProbe.result.stdout);
      if (parsed.size > 0) return parsed;
    }
  }
  const targetVersion = buildTargetVersion(target.openclawDir);
  const commandCandidates: readonly (readonly string[])[] = [['channels', '--json']];

  for (const args of commandCandidates) {
    const snapshot: BridgeCommandSnapshot = {
      targetId: target.id,
      machineId,
      targetVersion,
      intent: 'run_command',
      args: { command: 'openclaw', args },
      createdBy: 'channels-runtime-probe',
      idempotencyKey: `probe_${target.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      approvalRequired: false,
      policyVersion: 'bridge-control-v1',
    };
    const command = bridgeCommandStore.create({ snapshot });
    const completed = await waitForBridgeCommandCompletion(command.id, 8_000);
    if (
      !completed ||
      (completed.state !== 'succeeded' &&
        completed.state !== 'failed' &&
        completed.state !== 'rejected' &&
        completed.state !== 'deadletter')
    ) {
      bridgeCommandStore.reject(command.id, 'runtime_probe_timeout');
      continue;
    }
    if (completed.state !== 'succeeded' || !completed.result?.stdout) {
      continue;
    }
    const parsed = parseRuntimeProbe(completed.result.stdout);
    if (parsed.size > 0) return parsed;
  }
  return null;
}

async function getCachedRuntimeProbe(
  target: OpenClawTarget
): Promise<ReadonlyMap<string, RuntimeChannelProbeState> | null> {
  const key = target.id;
  const now = Date.now();
  const cached = channelRuntimeProbeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.data;

  const inFlight = channelRuntimeProbeInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = probeRuntimeChannelsForTarget(target)
    .then((data) => {
      channelRuntimeProbeCache.set(key, {
        expiresAt: Date.now() + CHANNEL_RUNTIME_PROBE_TTL_MS,
        data: data && data.size > 0 ? data : null,
      });
      return data;
    })
    .finally(() => {
      channelRuntimeProbeInFlight.delete(key);
    });
  channelRuntimeProbeInFlight.set(key, promise);
  return promise;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isChannelConfigured(config: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(config);
  if (keys.length === 0) return false;
  if (toBoolean(config.enabled) || toBoolean(config.configured)) return true;
  return keys.some(
    (key) => !key.toLowerCase().includes('secret') && !key.toLowerCase().includes('token')
  );
}

function parseDmPolicy(
  config: Readonly<Record<string, unknown>>
): 'pairing' | 'allowlist' | 'open' | 'disabled' | 'unknown' {
  const dmPolicy = config.dmPolicy;
  if (
    dmPolicy === 'pairing' ||
    dmPolicy === 'allowlist' ||
    dmPolicy === 'open' ||
    dmPolicy === 'disabled'
  ) {
    return dmPolicy;
  }
  const dm = toReadonlyRecord(config.dm);
  const dmPolicyAlias = dm?.policy;
  if (
    dmPolicyAlias === 'pairing' ||
    dmPolicyAlias === 'allowlist' ||
    dmPolicyAlias === 'open' ||
    dmPolicyAlias === 'disabled'
  ) {
    return dmPolicyAlias;
  }
  return 'unknown';
}

function parseGroupPolicy(
  config: Readonly<Record<string, unknown>>
): 'open' | 'allowlist' | 'disabled' | 'unknown' {
  const groupPolicy = config.groupPolicy;
  if (groupPolicy === 'open' || groupPolicy === 'allowlist' || groupPolicy === 'disabled') {
    return groupPolicy;
  }
  return 'unknown';
}

function parseAllowFrom(config: Readonly<Record<string, unknown>>): string[] {
  const allowFromRaw = config.allowFrom;
  if (!Array.isArray(allowFromRaw)) {
    const dm = toReadonlyRecord(config.dm);
    const dmAllowFromRaw = dm?.allowFrom;
    if (!Array.isArray(dmAllowFromRaw)) {
      return [];
    }
    return dmAllowFromRaw.map((value) => String(value).trim()).filter((value) => value.length > 0);
  }
  return allowFromRaw.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

function parseRuntimeState(
  config: Readonly<Record<string, unknown>>
): 'connected' | 'disconnected' | 'unknown' {
  if (config.connected === true) return 'connected';
  if (config.connected === false) return 'disconnected';
  if (config.status === 'connected') return 'connected';
  if (config.status === 'disconnected') return 'disconnected';
  if (config.running === false) return 'disconnected';
  return 'unknown';
}

function hasGroupsConfigured(config: Readonly<Record<string, unknown>>): boolean {
  if (toBoolean(config.hasGroups) || toBoolean(config.groupsEnabled)) {
    return true;
  }
  const groups = config.groups;
  if (isRecord(groups) && Object.keys(groups).length > 0) {
    return true;
  }
  return false;
}

function resolveOpenClawConfigCandidates(openclawHome: string): readonly string[] {
  const base = path.resolve(openclawHome);
  return [path.join(base, 'openclaw.json'), path.join(base, 'config', 'openclaw.json')];
}

function readOpenClawChannels(openclawHome: string): {
  configPath?: string;
  configStatus: 'found' | 'missing' | 'empty' | 'invalid';
  configCandidates: readonly string[];
  channels: readonly OpenClawChannelSummary[];
} {
  const configCandidates = resolveOpenClawConfigCandidates(openclawHome);
  const configPath = configCandidates.find((candidate) => exists(candidate));
  if (!configPath) {
    return {
      configStatus: 'missing',
      configCandidates,
      channels: OPENCLAW_CHANNEL_DEFS.map((channel) => ({
        id: channel.id,
        name: channel.name,
        configured: false,
        dmPolicy: 'unknown',
        groupPolicy: 'unknown',
        allowFrom: [],
        allowFromCount: 0,
        allowFromHasWildcard: false,
        hasGroups: false,
        connected: false,
        runtimeState: 'unknown',
        accountSummary: {
          total: 0,
          enabled: 0,
          configured: 0,
          connected: 0,
          runtimeKnown: 0,
        },
        boundAgents: [],
      })),
    };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    if (raw.trim().length === 0) {
      return {
        configPath,
        configStatus: 'empty',
        configCandidates,
        channels: OPENCLAW_CHANNEL_DEFS.map((channel) => ({
          id: channel.id,
          name: channel.name,
          configured: false,
          dmPolicy: 'unknown',
          groupPolicy: 'unknown',
          allowFrom: [],
          allowFromCount: 0,
          allowFromHasWildcard: false,
          hasGroups: false,
          connected: false,
          runtimeState: 'unknown',
          accountSummary: {
            total: 0,
            enabled: 0,
            configured: 0,
            connected: 0,
            runtimeKnown: 0,
          },
          boundAgents: [],
        })),
      };
    }
    const parsed = JSON.parse(raw);
    const parsedRecord = toReadonlyRecord(parsed) ?? {};
    const channelsRecord = toReadonlyRecord(parsedRecord.channels) ?? {};
    const sessionsRecord = toReadonlyRecord(parsedRecord.sessions) ?? {};

    const pluginsRecord = toReadonlyRecord(parsedRecord.plugins) ?? {};
    const pluginEntries = toReadonlyRecord(pluginsRecord.entries) ?? {};

    const channels = OPENCLAW_CHANNEL_DEFS.map((channel): OpenClawChannelSummary => {
      const aliasKeys = CHANNEL_KEY_ALIASES[channel.id] ?? [channel.id];
      const matchedChannelKey = aliasKeys.find(
        (key) => toReadonlyRecord(channelsRecord[key]) !== null
      );
      const matchedSessionKey = aliasKeys.find(
        (key) => toReadonlyRecord(sessionsRecord[key]) !== null
      );
      const matchedPluginKey = aliasKeys.find(
        (key) => toReadonlyRecord(pluginEntries[key]) !== null
      );
      const channelConfig = toReadonlyRecord(channelsRecord[matchedChannelKey ?? channel.id]) ?? {};
      const sessionStats = toReadonlyRecord(sessionsRecord[matchedSessionKey ?? channel.id]) ?? {};
      const pluginConfig = toReadonlyRecord(pluginEntries[matchedPluginKey ?? channel.id]) ?? {};
      const channelAllowFrom = parseAllowFrom(channelConfig);
      const accountConfigs = toReadonlyRecord(channelConfig.accounts) ?? {};
      const accountEntries = Object.values(accountConfigs)
        .map((value) => toReadonlyRecord(value))
        .filter((value): value is Readonly<Record<string, unknown>> => value !== null);

      let accountEnabled = 0;
      let accountConfigured = 0;
      let accountConnected = 0;
      let accountRuntimeKnown = 0;
      const allowFromSet = new Set(channelAllowFrom);
      for (const accountConfig of accountEntries) {
        if (accountConfig.enabled !== false) {
          accountEnabled += 1;
        }
        if (isChannelConfigured(accountConfig)) {
          accountConfigured += 1;
        }
        const runtimeState = parseRuntimeState(accountConfig);
        if (runtimeState !== 'unknown') {
          accountRuntimeKnown += 1;
        }
        if (runtimeState === 'connected') {
          accountConnected += 1;
        }
        for (const entry of parseAllowFrom(accountConfig)) {
          allowFromSet.add(entry);
        }
      }

      const resolvedAllowFrom = [...allowFromSet];
      const channelRuntimeState = parseRuntimeState(channelConfig);
      const credentialReady = inferCredentialReady(channel.id, channelConfig);
      const pluginEnabled = pluginConfig.enabled !== false;
      const inferredConnected =
        channelRuntimeState === 'unknown' &&
        toBoolean(channelConfig.enabled) &&
        credentialReady &&
        pluginEnabled;
      const resolvedRuntimeState =
        channelRuntimeState === 'unknown' && inferredConnected ? 'connected' : channelRuntimeState;
      const connected =
        resolvedRuntimeState === 'connected' ||
        (resolvedRuntimeState === 'unknown' && accountConnected > 0);
      const lastMessageAt = toStringOrUndefined(sessionStats.lastMessageAt);
      const messageCount = toNumberOrUndefined(sessionStats.messageCount);

      const boundAgents: OpenClawChannelBoundAgent[] = [];
      const agentsList = channelConfig.agents ?? channelConfig.bindings;
      if (Array.isArray(agentsList)) {
        for (const entry of agentsList) {
          if (typeof entry === 'string') {
            boundAgents.push({ agentId: entry });
          } else if (isRecord(entry)) {
            const aid =
              typeof entry.agentId === 'string'
                ? entry.agentId
                : typeof entry.id === 'string'
                  ? entry.id
                  : '';
            if (aid) {
              boundAgents.push({
                agentId: aid,
                ...(typeof entry.model === 'string' ? { modelOverride: entry.model } : {}),
              });
            }
          }
        }
      }

      return {
        id: channel.id,
        name: channel.name,
        configured: isChannelConfigured(channelConfig),
        dmPolicy: parseDmPolicy(channelConfig),
        groupPolicy: parseGroupPolicy(channelConfig),
        allowFrom: resolvedAllowFrom,
        allowFromCount: resolvedAllowFrom.length,
        allowFromHasWildcard: resolvedAllowFrom.some((value) => value === '*'),
        hasGroups: hasGroupsConfigured(channelConfig),
        connected,
        runtimeState: resolvedRuntimeState,
        accountSummary: {
          total: accountEntries.length,
          enabled: accountEnabled,
          configured: accountConfigured,
          connected: accountConnected,
          runtimeKnown: accountRuntimeKnown,
        },
        boundAgents,
        ...(lastMessageAt ? { lastMessageAt } : {}),
        ...(messageCount !== undefined ? { messageCount } : {}),
      };
    });

    return { configPath, configStatus: 'found', configCandidates, channels };
  } catch {
    return {
      configPath,
      configStatus: 'invalid',
      configCandidates,
      channels: OPENCLAW_CHANNEL_DEFS.map((channel) => ({
        id: channel.id,
        name: channel.name,
        configured: false,
        dmPolicy: 'unknown',
        groupPolicy: 'unknown',
        allowFrom: [],
        allowFromCount: 0,
        allowFromHasWildcard: false,
        hasGroups: false,
        connected: false,
        runtimeState: 'unknown',
        accountSummary: {
          total: 0,
          enabled: 0,
          configured: 0,
          connected: 0,
          runtimeKnown: 0,
        },
        boundAgents: [],
      })),
    };
  }
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  const errorMessage = error instanceof Error ? error.message : String(error);
  void reply.code(statusCode).send({
    error: statusCode >= 500 ? 'internal_server_error' : 'request_error',
    message: statusCode >= 500 ? 'An unexpected error occurred.' : errorMessage,
  });
});

// ── Auth Settings API ────────────────────────────────────────────────

app.get('/settings/auth', (request, reply) => {
  if (!isAuthorized(request)) {
    void reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  void reply.send({
    mode: authConfig.mode,
    hasToken: authHasToken(),
  });
});

app.post('/settings/auth', async (request, reply) => {
  if (!isAuthorized(request)) {
    void reply.code(401).send({ error: 'unauthorized' });
    return;
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    void reply.code(400).send({ error: 'invalid_body' });
    return;
  }

  const mode = body.mode;
  if (mode !== 'none' && mode !== 'token') {
    void reply.code(400).send({ error: 'invalid_mode', message: 'mode must be "none" or "token"' });
    return;
  }

  if (mode === 'token') {
    const token = body.token;
    if (typeof token !== 'string' || token.trim().length < 16) {
      void reply
        .code(400)
        .send({ error: 'token_too_short', message: 'Token must be at least 16 characters.' });
      return;
    }
    const settings: PersistedAuthSettings = { mode: 'token', token: token.trim() };
    savePersistedAuth(settings);
    authConfig = { mode: 'token', token: token.trim() };
    app.log.info('Auth mode updated to "token" (persisted).');
  } else {
    const confirm = body.confirm;
    if (confirm !== 'DISABLE_AUTH') {
      void reply.code(400).send({
        error: 'confirmation_required',
        message: 'Set confirm: "DISABLE_AUTH" to disable authentication.',
      });
      return;
    }
    const settings: PersistedAuthSettings = { mode: 'none' };
    savePersistedAuth(settings);
    authConfig = { mode: 'none' };
    app.log.warn('Auth mode disabled via API (persisted).');
  }

  void reply.send({
    mode: authConfig.mode,
    hasToken: authHasToken(),
  });
});

app.setNotFoundHandler((_request, reply) => {
  void reply.code(404).send({ error: 'not_found', message: 'Route not found.' });
});

const port = Number(process.env.PORT ?? '9700');
const host = process.env.HOST ?? '127.0.0.1';

const installScriptPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  'scripts',
  'install-bridge.sh'
);
const bridgeSetupManager = new BridgeSetupManager({
  localPort: port,
  installScriptPath,
});
const sftpSessionManager = new SftpSessionManager(bridgeSetupManager);
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

if (authConfig.mode === 'none') {
  app.log.warn('Auth mode is "none" — all endpoints are publicly accessible.');
}

// ── Scheduled Tasks (Cron) ──────────────────────────────────────────

const cronStoreDir =
  process.env.CRON_STORE_DIR ?? path.join(os.homedir(), '.patze-control', 'cron');
const taskExecutor = createTaskExecutor({ orchestrator, telemetryAggregator, app });

const taskEventListeners = new Set<(event: TaskEvent) => void>();
const openclawSyncStatusListeners = new Set<(status: OpenClawSyncStatus) => void>();

type GenericSseEvent = { kind: string; payload: Readonly<unknown> };
const genericSseListeners = new Set<(event: GenericSseEvent) => void>();

function broadcastSse(event: GenericSseEvent): void {
  for (const listener of genericSseListeners) {
    try {
      listener(event);
    } catch {
      /* ok */
    }
  }
}

function buildFleetTargetStatusFromEntry(
  entry: TargetSyncStatusEntry,
  policyOverride?: FleetPolicyProfile
): FleetTargetStatus {
  const policy = policyOverride ?? resolveFleetPolicyForTarget(entry.target.id);
  const desired = buildFleetDesiredState(entry.target, policy);
  const { reported } = buildFleetReportedState(entry.target, entry.syncStatus);
  const drifts = buildFleetDrifts(entry.target.id, desired, reported, entry.syncStatus);
  const violations = buildFleetViolations(entry.target.id, drifts, entry.syncStatus, policy);
  const healthScore = computeFleetHealthScore(
    entry.target,
    entry.syncStatus,
    drifts,
    violations,
    reported,
    desired.maxSyncLagMs
  );
  return {
    targetId: entry.target.id,
    targetLabel: entry.target.label,
    targetType: entry.target.type,
    policyProfileId: policy.id,
    policyProfileName: policy.name,
    transport: entry.target.type === 'remote' ? 'reverse_ssh' : 'direct_https',
    environment: entry.target.type === 'remote' ? 'vps' : 'local',
    healthScore,
    riskLevel: scoreToRiskLevel(healthScore),
    desired,
    reported,
    drifts,
    violations,
    updatedAt: new Date().toISOString(),
  };
}

function isFleetNoiseTarget(entry: TargetSyncStatusEntry): boolean {
  if (entry.target.purpose === 'test') {
    return true;
  }
  if (entry.target.origin === 'smoke') {
    return true;
  }
  const label = entry.target.label.trim();
  if (/^ui smoke target/i.test(label) || /^smoke target/i.test(label)) {
    return true;
  }
  return /patze-smoke/i.test(entry.target.openclawDir);
}

function listFleetTargetStatuses(): FleetTargetStatus[] {
  const entries = openclawSyncManager.getAllStatuses();
  const onlineMachineIds = new Set(bridgeConnections.keys());
  const dedupedEntries = dedupeTargetStatuses(entries, onlineMachineIds);
  return dedupedEntries
    .filter((entry) => entry.target.enabled)
    .filter((entry) => !isFleetNoiseTarget(entry))
    .map((entry) => buildFleetTargetStatusFromEntry(entry));
}

function getFleetTargetStatus(targetId: string): FleetTargetStatus | null {
  const entry = openclawSyncManager.getAllStatuses().find((item) => item.target.id === targetId);
  if (!entry) return null;
  return buildFleetTargetStatusFromEntry(entry);
}

function getFleetTargetStatusWithPolicy(
  targetId: string,
  policy: FleetPolicyProfile
): FleetTargetStatus | null {
  const entry = openclawSyncManager.getAllStatuses().find((item) => item.target.id === targetId);
  if (!entry) return null;
  return buildFleetTargetStatusFromEntry(entry, policy);
}

function fleetAlertSeverityRank(severity: FleetAlertSeverity): number {
  if (severity === 'critical') return 3;
  if (severity === 'high') return 2;
  return 1;
}

function severityFromDriftSeverity(severity: 'minor' | 'major' | 'critical'): FleetAlertSeverity {
  if (severity === 'critical') return 'critical';
  if (severity === 'major') return 'high';
  return 'warning';
}

function maxFleetAlertSeverityFromDrifts(drifts: readonly FleetDriftRecord[]): FleetAlertSeverity {
  let max: FleetAlertSeverity = 'warning';
  for (const drift of drifts) {
    const next = severityFromDriftSeverity(drift.severity);
    if (fleetAlertSeverityRank(next) > fleetAlertSeverityRank(max)) {
      max = next;
    }
  }
  return max;
}

function maxFleetAlertSeverityFromViolations(
  violations: readonly FleetPolicyViolation[]
): FleetAlertSeverity {
  let max: FleetAlertSeverity = 'warning';
  for (const violation of violations) {
    const next: FleetAlertSeverity =
      violation.severity === 'critical'
        ? 'critical'
        : violation.severity === 'high'
          ? 'high'
          : 'warning';
    if (fleetAlertSeverityRank(next) > fleetAlertSeverityRank(max)) {
      max = next;
    }
  }
  return max;
}

function isValidAlertWebhookUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function targetMatchesRule(targetId: string, rule: FleetAlertRouteRule): boolean {
  if (rule.targetScope === 'all') return true;
  return rule.targetIds.includes(targetId);
}

function resolveAlertDestinationIdsForEvent(event: {
  targetId: string;
  severity: FleetAlertSeverity;
}): ReadonlySet<string> {
  const severityRank = fleetAlertSeverityRank(event.severity);
  const enabledRules = [...fleetAlertRouteRules.values()].filter((rule) => rule.enabled);
  if (enabledRules.length === 0) {
    return new Set(fleetAlertDestinations.keys());
  }
  const resolved = new Set<string>();
  for (const rule of enabledRules) {
    if (fleetAlertSeverityRank(rule.minimumSeverity) > severityRank) continue;
    if (!targetMatchesRule(event.targetId, rule)) continue;
    for (const destinationId of rule.destinationIds) {
      resolved.add(destinationId);
    }
  }
  return resolved;
}

function dispatchFleetAlertWebhooks(
  event: {
    kind: 'drift-detected' | 'policy-violation' | 'remediation-failed';
    targetId: string;
    severity: FleetAlertSeverity;
    summary: string;
    details: Readonly<Record<string, unknown>>;
  },
  options?: { destinationIds?: ReadonlySet<string>; ignoreCooldown?: boolean }
): void {
  const now = Date.now();
  const rank = fleetAlertSeverityRank(event.severity);
  const routedDestinationIds = options?.destinationIds ?? resolveAlertDestinationIdsForEvent(event);
  for (const destination of fleetAlertDestinations.values()) {
    if (!routedDestinationIds.has(destination.id)) continue;
    if (!destination.enabled) continue;
    if (fleetAlertSeverityRank(destination.minimumSeverity) > rank) continue;
    const cooldownKey = `${destination.id}:${event.kind}:${event.targetId}:${event.summary}`;
    const lastSentAt = fleetAlertLastSentAtByDestination.get(cooldownKey);
    if (
      !options?.ignoreCooldown &&
      lastSentAt !== undefined &&
      now - lastSentAt < SMART_FLEET_ALERT_COOLDOWN_MS
    ) {
      continue;
    }
    const payload = {
      source: 'patze-control',
      domain: 'smart-fleet',
      sentAt: new Date(now).toISOString(),
      ...event,
    };
    void fetch(destination.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    })
      .then((res) => {
        if (!res.ok) {
          app.log.warn(
            {
              destinationId: destination.id,
              status: res.status,
              kind: event.kind,
              targetId: event.targetId,
            },
            'fleet alert webhook rejected'
          );
          return;
        }
        fleetAlertLastSentAtByDestination.set(cooldownKey, now);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'unknown';
        app.log.warn(
          {
            destinationId: destination.id,
            err: message,
            kind: event.kind,
            targetId: event.targetId,
          },
          'fleet alert webhook failed'
        );
      });
  }
}

function buildBatchApplySignature(
  items: readonly { targetId: string; policyId: string }[],
  reconcileAfterApply: boolean
): string {
  const normalized = [...items]
    .map((item) => ({ targetId: item.targetId, policyId: item.policyId }))
    .sort((a, b) => a.targetId.localeCompare(b.targetId));
  return JSON.stringify({
    reconcileAfterApply,
    items: normalized,
  });
}

function createFleetApprovalToken(
  signature: string,
  criticalTargetIds: readonly string[]
): PendingFleetApproval {
  const now = Date.now();
  const token = `appr_${randomBytes(16).toString('hex')}`;
  const record: PendingFleetApproval = {
    token,
    signature,
    criticalTargetIds,
    createdAt: now,
    expiresAt: now + SMART_FLEET_APPROVAL_TTL_MS,
  };
  fleetPendingApprovals.set(token, record);
  return record;
}

function consumeFleetApprovalToken(
  token: string,
  signature: string
): { ok: true } | { ok: false; reason: 'not_found' | 'expired' | 'signature_mismatch' } {
  const record = fleetPendingApprovals.get(token);
  if (!record) return { ok: false, reason: 'not_found' };
  fleetPendingApprovals.delete(token);
  if (Date.now() > record.expiresAt) return { ok: false, reason: 'expired' };
  if (record.signature !== signature) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

function maybeBroadcastFleetTargetSignals(targetId: string): void {
  if (!SMART_FLEET_V2_ENABLED) return;
  const status = getFleetTargetStatus(targetId);
  if (!status) return;

  const previousScore = fleetHealthScoreByTargetId.get(targetId);
  if (previousScore === undefined || Math.abs(previousScore - status.healthScore) >= 5) {
    fleetHealthScoreByTargetId.set(targetId, status.healthScore);
    broadcastSse({
      kind: 'fleet-health-changed',
      payload: {
        targetId,
        healthScore: status.healthScore,
        riskLevel: status.riskLevel,
        updatedAt: status.updatedAt,
      },
    });
  }

  const driftSignature = JSON.stringify(
    status.drifts.map((drift) => [drift.category, drift.actual])
  );
  const previousDriftSignature = fleetDriftSignatureByTargetId.get(targetId);
  if (driftSignature !== previousDriftSignature) {
    fleetDriftSignatureByTargetId.set(targetId, driftSignature);
    if (status.drifts.length > 0) {
      broadcastSse({
        kind: 'drift-detected',
        payload: {
          targetId,
          drifts: status.drifts,
          updatedAt: status.updatedAt,
        },
      });
      dispatchFleetAlertWebhooks({
        kind: 'drift-detected',
        targetId,
        severity: maxFleetAlertSeverityFromDrifts(status.drifts),
        summary: `${String(status.drifts.length)} drift(s) detected`,
        details: {
          driftCount: status.drifts.length,
          categories: status.drifts.map((drift) => drift.category),
          updatedAt: status.updatedAt,
        },
      });
    }
  }

  const violationSignature = JSON.stringify(status.violations.map((violation) => violation.code));
  const previousViolationSignature = fleetViolationSignatureByTargetId.get(targetId);
  if (violationSignature !== previousViolationSignature) {
    fleetViolationSignatureByTargetId.set(targetId, violationSignature);
    if (status.violations.length > 0) {
      broadcastSse({
        kind: 'policy-violation',
        payload: {
          targetId,
          violations: status.violations,
          updatedAt: status.updatedAt,
        },
      });
      dispatchFleetAlertWebhooks({
        kind: 'policy-violation',
        targetId,
        severity: maxFleetAlertSeverityFromViolations(status.violations),
        summary: `${String(status.violations.length)} policy violation(s) detected`,
        details: {
          violationCount: status.violations.length,
          codes: status.violations.map((violation) => violation.code),
          updatedAt: status.updatedAt,
        },
      });
    }
  }
}

interface DoctorReconcileCandidate {
  readonly targetId: string;
  readonly label: string;
  readonly reasons: readonly string[];
  readonly consecutiveFailures: number;
  readonly stale: boolean;
  readonly available: boolean;
  readonly running: boolean;
}

function reconcileUnhealthyTargets(options?: {
  readonly minConsecutiveFailures?: number;
  readonly includeStale?: boolean;
  readonly includeUnavailable?: boolean;
  readonly dryRun?: boolean;
}): {
  attempted: number;
  restarted: number;
  skipped: number;
  targetIds: readonly string[];
  candidates: readonly DoctorReconcileCandidate[];
} {
  const minConsecutiveFailures = Math.max(1, options?.minConsecutiveFailures ?? 1);
  const includeStale = options?.includeStale ?? true;
  const includeUnavailable = options?.includeUnavailable ?? true;
  const dryRun = options?.dryRun ?? false;
  const entries = openclawSyncManager.getAllStatuses();
  const candidates = entries
    .filter((entry) => entry.target.enabled)
    .map((entry): DoctorReconcileCandidate | null => {
      const reasons: string[] = [];
      if (entry.syncStatus.consecutiveFailures >= minConsecutiveFailures) {
        reasons.push(`consecutive_failures>=${String(minConsecutiveFailures)}`);
      }
      if (includeStale && entry.syncStatus.stale) {
        reasons.push('stale');
      }
      if (includeUnavailable && (!entry.syncStatus.available || !entry.syncStatus.running)) {
        reasons.push('unavailable_or_not_running');
      }
      if (reasons.length === 0) return null;
      return {
        targetId: entry.target.id,
        label: entry.target.label,
        reasons,
        consecutiveFailures: entry.syncStatus.consecutiveFailures,
        stale: entry.syncStatus.stale,
        available: entry.syncStatus.available,
        running: entry.syncStatus.running,
      };
    })
    .filter((item): item is DoctorReconcileCandidate => item !== null);
  let restarted = 0;
  const restartedTargetIds: string[] = [];
  for (const candidate of candidates) {
    if (dryRun) continue;
    const target = openclawTargetStore.get(candidate.targetId);
    if (!target) continue;
    try {
      openclawSyncManager.restartTarget(target);
      maybeBroadcastFleetTargetSignals(target.id);
      restarted += 1;
      restartedTargetIds.push(target.id);
    } catch {
      /* continue */
    }
  }
  return {
    attempted: candidates.length,
    restarted,
    skipped: Math.max(0, candidates.length - restarted),
    targetIds: restartedTargetIds,
    candidates,
  };
}

const cronService = new CronService({
  storeDir: cronStoreDir,
  executor: taskExecutor,
  onTaskEvent: (event) => {
    for (const listener of taskEventListeners) {
      try {
        listener(event);
      } catch {
        /* ok */
      }
    }
  },
});

void cronService.start();

// ── OpenClaw Multi-Target Sync ──────────────────────────────────────

const openclawDir =
  process.env.OPENCLAW_HOME ??
  process.env.CLAWPAL_OPENCLAW_DIR ??
  path.join(os.homedir(), '.openclaw');

const openclawTargetStore = new OpenClawTargetStore(cronStoreDir);

if (openclawTargetStore.list().length === 0) {
  openclawTargetStore.add({
    label: 'Local',
    type: 'local',
    origin: 'auto',
    openclawDir,
    pollIntervalMs: 30_000,
    enabled: true,
  });
  app.log.info({ dir: openclawDir }, 'Auto-created default local OpenClaw target');
}

const openclawSyncManager = new OpenClawSyncManager(openclawTargetStore, {
  onStatus: (targetId, status) => {
    for (const listener of openclawSyncStatusListeners) {
      try {
        listener(status);
      } catch {
        /* ok */
      }
    }
    for (const listener of targetStatusListeners) {
      try {
        listener(targetId, status);
      } catch {
        /* ok */
      }
    }
    maybeBroadcastFleetTargetSignals(targetId);
  },
});
const targetStatusListeners = new Set<(targetId: string, status: OpenClawSyncStatus) => void>();

openclawSyncManager.startAll();
app.log.info({ targets: openclawTargetStore.list().length }, 'OpenClaw sync manager started');

const commandQueue = new OpenClawCommandQueue(cronStoreDir);
const bridgeCommandStore = new BridgeCommandStore(cronStoreDir);

const openclawSync = (() => {
  const defaultTarget = openclawTargetStore.list()[0];
  if (!defaultTarget) return null;
  return {
    getStatus: () =>
      openclawSyncManager.getStatus(defaultTarget.id) ?? {
        running: false,
        available: false,
        pollIntervalMs: 30_000,
        jobsCount: 0,
        lastAttemptAt: undefined,
        lastSuccessfulSyncAt: undefined,
        consecutiveFailures: 0,
        lastError: undefined,
        stale: false,
      },
    getJobs: () => openclawSyncManager.getJobs(defaultTarget.id),
    getRunHistory: (jobId: string, limit?: number) =>
      openclawSyncManager.getRunHistory(defaultTarget.id, jobId, limit),
    createMergedView: (tasks: readonly ScheduledTask[]) =>
      openclawSyncManager.createMergedView(defaultTarget.id, tasks),
    get available() {
      return this.getStatus().available;
    },
    stop: () => openclawSyncManager.stopTarget(defaultTarget.id),
  };
})();

const bridgeCronProxyRootDir = getBridgeCronProxyRootDir();

function parseOpenClawRunRecord(value: unknown): OpenClawRunRecord | null {
  const record = toReadonlyRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.jobId !== 'string' || record.jobId.length === 0) {
    return null;
  }
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    return null;
  }
  if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) {
    return null;
  }
  const status = record.status;
  if (status !== 'ok' && status !== 'error' && status !== 'timeout' && status !== 'running') {
    return null;
  }
  return {
    jobId: record.jobId,
    runId: record.runId,
    startedAt: record.startedAt,
    endedAt: typeof record.endedAt === 'string' ? record.endedAt : undefined,
    status,
    error: typeof record.error === 'string' ? record.error : undefined,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
  };
}

function parseBridgeCronSyncPayload(body: unknown): BridgeCronSyncPayload | null {
  const record = toReadonlyRecord(body);
  if (!record) {
    return null;
  }
  if (typeof record.machineId !== 'string' || record.machineId.length === 0) {
    return null;
  }
  if (typeof record.jobsHash !== 'string' || record.jobsHash.length === 0) {
    return null;
  }
  if (typeof record.configHash !== 'string' || record.configHash.length === 0) {
    return null;
  }
  if (!isRecord(record.newRuns)) {
    return null;
  }

  let jobs: readonly OpenClawCronJob[] | undefined;
  if (record.jobs !== undefined) {
    if (!Array.isArray(record.jobs)) {
      return null;
    }
    jobs = record.jobs as readonly OpenClawCronJob[];
  }
  let configRaw: string | null | undefined;
  if (record.configRaw !== undefined) {
    if (record.configRaw !== null && typeof record.configRaw !== 'string') {
      return null;
    }
    configRaw = record.configRaw as string | null;
  }

  const newRuns: Record<string, readonly OpenClawRunRecord[]> = {};
  for (const [jobId, value] of Object.entries(record.newRuns)) {
    if (!Array.isArray(value)) {
      return null;
    }
    const runs: OpenClawRunRecord[] = [];
    for (const candidate of value) {
      const parsed = parseOpenClawRunRecord(candidate);
      if (parsed) {
        runs.push(parsed);
      }
    }
    newRuns[jobId] = runs;
  }

  return {
    machineId: record.machineId,
    machineLabel: typeof record.machineLabel === 'string' ? record.machineLabel : undefined,
    bridgeVersion: typeof record.bridgeVersion === 'string' ? record.bridgeVersion : undefined,
    jobsHash: record.jobsHash,
    jobs,
    configHash: record.configHash,
    configRaw,
    newRuns,
    sentAt: typeof record.sentAt === 'string' ? record.sentAt : undefined,
  };
}

function hasRunDelta(newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>): boolean {
  return Object.values(newRuns).some((runs) => runs.length > 0);
}

function ensureBridgeProxyTarget(machineId: string, machineLabel?: string): OpenClawTarget {
  const safeMachineId = sanitizePathSegment(machineId);
  const targetOpenClawDir = path.join(bridgeCronProxyRootDir, safeMachineId);
  const existing = openclawTargetStore
    .list()
    .find((target) => target.type === 'remote' && target.openclawDir === targetOpenClawDir);
  if (existing) {
    if (existing.enabled && !openclawSyncManager.isRunning(existing.id)) {
      openclawSyncManager.startTarget(existing);
    }
    return existing;
  }

  const created = openclawTargetStore.add({
    label:
      machineLabel && machineLabel.length > 0 ? `Bridge ${machineLabel}` : `Bridge ${machineId}`,
    type: 'remote',
    origin: 'auto',
    openclawDir: targetOpenClawDir,
    pollIntervalMs: 30_000,
    enabled: true,
  });
  openclawSyncManager.startTarget(created);
  app.log.info({ machineId, targetId: created.id }, 'Auto-created bridge OpenClaw target');
  return created;
}

function appendBridgeRuns(
  openclawDirPath: string,
  newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>
): void {
  const runsDir = path.join(openclawDirPath, 'cron', 'runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  for (const [jobId, runs] of Object.entries(newRuns)) {
    if (runs.length === 0) {
      continue;
    }
    const fileName = `${sanitizeRunFilename(jobId)}.jsonl`;
    const filePath = path.join(runsDir, fileName);
    const content = runs.map((run) => JSON.stringify(run)).join('\n');
    fs.appendFileSync(filePath, `${content}\n`, 'utf-8');
  }
}

function writeBridgeJobsFile(openclawDirPath: string, jobs: readonly OpenClawCronJob[]): void {
  const cronDir = path.join(openclawDirPath, 'cron');
  if (!fs.existsSync(cronDir)) {
    fs.mkdirSync(cronDir, { recursive: true });
  }
  const jobsPath = path.join(cronDir, 'jobs.json');
  const tmpPath = `${jobsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, jobs }, null, 2), 'utf-8');
  fs.renameSync(tmpPath, jobsPath);
}

function writeBridgeConfigFile(openclawDirPath: string, configRaw: string | null): void {
  const rootConfigPath = path.join(openclawDirPath, 'openclaw.json');
  const configDirConfigPath = path.join(openclawDirPath, 'config', 'openclaw.json');
  if (configRaw === null) {
    if (fs.existsSync(rootConfigPath)) {
      fs.unlinkSync(rootConfigPath);
    }
    if (fs.existsSync(configDirConfigPath)) {
      fs.unlinkSync(configDirConfigPath);
    }
    return;
  }
  if (!fs.existsSync(openclawDirPath)) {
    fs.mkdirSync(openclawDirPath, { recursive: true });
  }
  const tmpPath = `${rootConfigPath}.tmp`;
  fs.writeFileSync(tmpPath, configRaw, 'utf-8');
  fs.renameSync(tmpPath, rootConfigPath);
}

app.get('/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send(cronService.list());
});

app.post('/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.name !== 'string' || body.name.length === 0) {
    return reply.code(400).send({ error: 'name is required' });
  }
  if (!isRecord(body.schedule) || typeof body.schedule.kind !== 'string') {
    return reply.code(400).send({ error: 'schedule with kind is required' });
  }
  if (!isRecord(body.action) || typeof body.action.action !== 'string') {
    return reply.code(400).send({ error: 'action with action field is required' });
  }
  const validKinds = ['at', 'every', 'cron'];
  if (!validKinds.includes(body.schedule.kind)) {
    return reply
      .code(400)
      .send({ error: `schedule.kind must be one of: ${validKinds.join(', ')}` });
  }
  try {
    const input = body as unknown as TaskCreateInput;
    const task = await cronService.add(input);
    return reply.code(201).send(task);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid_input' });
  }
});

app.patch(
  '/tasks/:taskId',
  async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const patch = request.body as unknown as TaskPatchInput;
    const result = await cronService.update(request.params.taskId, patch);
    if (!result) {
      return reply.code(404).send({ error: 'task_not_found' });
    }
    return reply.code(200).send(result);
  }
);

app.delete(
  '/tasks/:taskId',
  async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const removed = await cronService.remove(request.params.taskId);
    if (!removed) {
      return reply.code(404).send({ error: 'task_not_found' });
    }
    return reply.code(200).send({ ok: true });
  }
);

app.post(
  '/tasks/:taskId/run',
  async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      const record = await cronService.runNow(request.params.taskId);
      return reply.code(200).send(record);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'run_failed' });
    }
  }
);

app.get(
  '/tasks/history',
  async (request: FastifyRequest<{ Querystring: { taskId?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const taskId = (request.query as Record<string, string | undefined>).taskId;
    return reply.code(200).send(cronService.getRunHistory(taskId));
  }
);

// ── Task Snapshots ──────────────────────────────────────────────────

app.get('/tasks/snapshots', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const query = request.query as Record<string, string | undefined>;
  const limit = parsePositiveInt(query.limit, 20, 200);
  const offset = parsePositiveInt(query.offset, 0, 10_000);
  return reply.code(200).send(cronService.listSnapshots(limit, offset));
});

app.post(
  '/tasks/rollback/:snapshotId',
  async (request: FastifyRequest<{ Params: { snapshotId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const result = await cronService.rollback(request.params.snapshotId);
    if (!result) {
      return reply.code(404).send({ error: 'snapshot_not_found' });
    }
    return reply.code(200).send({ ok: true, tasks: result });
  }
);

// ── Task SSE Stream ─────────────────────────────────────────────────

app.get('/tasks/events', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  reply.hijack();
  const response = reply.raw;
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const sse = createSseWriter(response);
  sse.enqueue(writeSseCommentChunk('task-stream-connected'));

  const listener = (event: TaskEvent): void => {
    const chunk = writeSseNamedEventChunk('task', event);
    sse.enqueue(chunk);
  };
  taskEventListeners.add(listener);

  const syncListener = (status: OpenClawSyncStatus): void => {
    const chunk = writeSseNamedEventChunk('openclaw-sync', status);
    sse.enqueue(chunk);
  };
  openclawSyncStatusListeners.add(syncListener);

  const genericListener = (event: GenericSseEvent): void => {
    const chunk = writeSseNamedEventChunk(event.kind, event.payload);
    sse.enqueue(chunk);
  };
  genericSseListeners.add(genericListener);

  const heartbeat = setInterval(() => {
    sse.enqueue(writeSseCommentChunk('heartbeat'));
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    taskEventListeners.delete(listener);
    openclawSyncStatusListeners.delete(syncListener);
    genericSseListeners.delete(genericListener);
    sse.close();
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
    request.raw.off('close', cleanup);
    response.off('close', cleanup);
    response.off('error', cleanup);
  };

  request.raw.on('close', cleanup);
  response.on('close', cleanup);
  response.on('error', cleanup);
});

// ── OpenClaw Target CRUD Routes ─────────────────────────────────────

function buildOpenClawReadiness(): {
  score: number;
  checks: readonly OpenClawReadinessCheck[];
  rootCause: { severity: 'error' | 'warn' | 'ok'; detail: string };
  summary: {
    bridgeConnections: number;
    targets: number;
    syncRunningTargets: number;
    recentRuns: number;
    authMode: 'none' | 'token';
  };
} {
  const targets = openclawTargetStore.list();
  const statuses = openclawSyncManager.getAllStatuses();
  const runs = toFrontendUnifiedSnapshot(telemetryAggregator.getUnifiedSnapshot()).runs;
  const nowMs = Date.now();
  const recentRuns = runs.filter((run) => {
    const updatedAtMs = Date.parse(run.updatedAt);
    return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= 15 * 60_000;
  }).length;
  const syncRunningTargets = statuses.filter((entry) => entry.syncStatus.running).length;

  const checks: OpenClawReadinessCheck[] = [];
  checks.push({
    id: 'bridge-connected',
    status: bridgeConnections.size > 0 ? 'ok' : 'warn',
    title: 'Bridge connectivity',
    detail:
      bridgeConnections.size > 0
        ? `${String(bridgeConnections.size)} bridge connection(s) active.`
        : 'No active bridge connections.',
    actionHints:
      bridgeConnections.size > 0
        ? ['Open Connections to inspect bridge health.']
        : ['Open Connections and set up bridge on remote OpenClaw host.'],
  });
  checks.push({
    id: 'targets-available',
    status: targets.length > 0 ? 'ok' : 'error',
    title: 'OpenClaw targets',
    detail:
      targets.length > 0
        ? `${String(targets.length)} target(s) registered.`
        : 'No OpenClaw targets registered yet.',
    actionHints:
      targets.length > 0
        ? ['Use OpenClaw Jobs to verify schedules and run history.']
        : ['Run one-click fix to create default local target.'],
  });
  checks.push({
    id: 'sync-running',
    status:
      targets.length === 0
        ? 'warn'
        : syncRunningTargets === targets.length
          ? 'ok'
          : syncRunningTargets > 0
            ? 'warn'
            : 'error',
    title: 'Target sync runtime',
    detail:
      targets.length === 0
        ? 'No targets to sync.'
        : `${String(syncRunningTargets)}/${String(targets.length)} target(s) running sync.`,
    actionHints:
      syncRunningTargets === targets.length
        ? ['Sync runtime is healthy.']
        : ['Run one-click fix to restart sync for all targets.'],
  });
  checks.push({
    id: 'recent-runs',
    status: recentRuns > 0 ? 'ok' : 'warn',
    title: 'Recent telemetry runs',
    detail:
      recentRuns > 0
        ? `${String(recentRuns)} run(s) received in last 15 minutes.`
        : 'No telemetry run events in last 15 minutes.',
    actionHints: [
      'Open Runs for telemetry timeline.',
      'Open OpenClaw Jobs to verify cron run history path.',
    ],
  });
  checks.push({
    id: 'auth-mode',
    status: authConfig.mode === 'token' && !authHasToken() ? 'error' : 'ok',
    title: 'Auth mode',
    detail: authConfig.mode === 'token' ? 'Token auth enabled.' : 'Auth disabled (dev mode).',
    actionHints:
      authConfig.mode === 'token'
        ? ['Ensure clients send Authorization Bearer token.']
        : ['Use token auth in production environments.'],
  });

  const score = computeReadinessScore(checks);
  const rootCause = deriveReadinessRootCause(checks);
  return {
    score,
    checks,
    rootCause,
    summary: {
      bridgeConnections: bridgeConnections.size,
      targets: targets.length,
      syncRunningTargets,
      recentRuns,
      authMode: authConfig.mode,
    },
  };
}

app.get('/openclaw/readiness', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const readiness = buildOpenClawReadiness();
  return reply.code(200).send({ ok: true, ...readiness });
});

app.post('/openclaw/readiness/fix', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const action = typeof request.body.action === 'string' ? request.body.action : '';
  const op = startOperation('readiness-fix', `Readiness fix: ${action || 'unknown'}`);
  if (action === 'create_default_target') {
    if (openclawTargetStore.list().length === 0) {
      const created = openclawTargetStore.add({
        label: 'Local',
        type: 'local',
        origin: 'auto',
        openclawDir,
        pollIntervalMs: 30_000,
        enabled: true,
      });
      openclawSyncManager.startTarget(created);
      finishOperation(op.operationId, 'succeeded', 'Created default local target', undefined);
      return reply
        .code(200)
        .send({ ok: true, action, createdTargetId: created.id, operationId: op.operationId });
    }
    finishOperation(op.operationId, 'succeeded', 'Default target already exists');
    return reply
      .code(200)
      .send({ ok: true, action, message: 'Targets already exist.', operationId: op.operationId });
  }
  if (action === 'restart_sync_all') {
    openclawSyncManager.stopAll();
    openclawSyncManager.startAll();
    finishOperation(op.operationId, 'succeeded', 'Restarted sync for all targets');
    return reply.code(200).send({ ok: true, action, operationId: op.operationId });
  }
  if (action === 'reconcile_unhealthy') {
    const result = reconcileUnhealthyTargets({
      minConsecutiveFailures: 1,
      includeStale: true,
      includeUnavailable: true,
      dryRun: false,
    });
    finishOperation(op.operationId, 'succeeded', 'Executed reconcile unhealthy targets');
    return reply.code(200).send({ ok: true, action, operationId: op.operationId, ...result });
  }
  finishOperation(op.operationId, 'failed', 'Unknown readiness fix action', action);
  return reply.code(400).send({ error: 'unknown_action', operationId: op.operationId });
});

app.get('/openclaw/targets', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const statuses = openclawSyncManager.getAllStatuses();
  const onlineMachineIds = new Set(bridgeConnections.keys());
  const deduped = dedupeTargetStatuses(statuses, onlineMachineIds);
  return reply.code(200).send({
    targets: deduped,
  });
});

app.post(
  '/doctor/actions/reconcile-unhealthy-targets',
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = isRecord(request.body) ? request.body : {};
    const minConsecutiveFailures =
      typeof body.minConsecutiveFailures === 'number' &&
      Number.isFinite(body.minConsecutiveFailures)
        ? Math.max(1, Math.floor(body.minConsecutiveFailures))
        : 1;
    const includeStale = body.includeStale !== false;
    const includeUnavailable = body.includeUnavailable !== false;
    const dryRun = body.dryRun === true;
    const result = reconcileUnhealthyTargets({
      minConsecutiveFailures,
      includeStale,
      includeUnavailable,
      dryRun,
    });
    return reply.code(200).send({
      ok: true,
      strategy: {
        minConsecutiveFailures,
        includeStale,
        includeUnavailable,
        dryRun,
      },
      ...result,
    });
  }
);

app.get('/fleet/targets', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  return reply.code(200).send({
    targets: listFleetTargetStatuses(),
  });
});

app.get('/fleet/policies', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  ensureDefaultFleetPolicyProfile();
  return reply.code(200).send({
    policies: [...fleetPolicyProfiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

app.get('/fleet/alerts/destinations', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  return reply.code(200).send({
    destinations: [...fleetAlertDestinations.values()].sort((a, b) => a.name.localeCompare(b.name)),
    cooldownMs: SMART_FLEET_ALERT_COOLDOWN_MS,
  });
});

app.post('/fleet/alerts/destinations', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!name) {
    return reply.code(400).send({ error: 'invalid_name' });
  }
  if (!isValidAlertWebhookUrl(url)) {
    return reply.code(400).send({ error: 'invalid_url' });
  }
  const minimumSeverity = isFleetAlertSeverity(body.minimumSeverity)
    ? body.minimumSeverity
    : 'high';
  const now = new Date().toISOString();
  const destination: FleetAlertDestination = {
    id: `dest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    kind: 'webhook',
    url,
    minimumSeverity,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  fleetAlertDestinations.set(destination.id, destination);
  savePersistedFleetAlerts();
  return reply.code(201).send(destination);
});

app.patch(
  '/fleet/alerts/destinations/:destinationId',
  async (request: FastifyRequest<{ Params: { destinationId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const existing = fleetAlertDestinations.get(request.params.destinationId);
    if (!existing) {
      return reply.code(404).send({ error: 'destination_not_found' });
    }
    const body = request.body;
    const nextName =
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : existing.name;
    const nextUrl =
      typeof body.url === 'string' && body.url.trim().length > 0 ? body.url.trim() : existing.url;
    if (!isValidAlertWebhookUrl(nextUrl)) {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    const next: FleetAlertDestination = {
      ...existing,
      name: nextName,
      url: nextUrl,
      minimumSeverity: isFleetAlertSeverity(body.minimumSeverity)
        ? body.minimumSeverity
        : existing.minimumSeverity,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
      updatedAt: new Date().toISOString(),
    };
    fleetAlertDestinations.set(next.id, next);
    savePersistedFleetAlerts();
    return reply.code(200).send(next);
  }
);

app.get('/fleet/alerts/rules', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  return reply.code(200).send({
    rules: [...fleetAlertRouteRules.values()].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

app.post('/fleet/alerts/rules', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return reply.code(400).send({ error: 'invalid_name' });
  }
  const minimumSeverity = isFleetAlertSeverity(body.minimumSeverity)
    ? body.minimumSeverity
    : 'high';
  const targetScope = body.targetScope === 'target_ids' ? 'target_ids' : 'all';
  const targetIds =
    targetScope === 'target_ids' && Array.isArray(body.targetIds)
      ? body.targetIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  if (targetScope === 'target_ids' && targetIds.length === 0) {
    return reply.code(400).send({ error: 'target_ids_required' });
  }
  const destinationIds = Array.isArray(body.destinationIds)
    ? body.destinationIds.filter(
        (item): item is string =>
          typeof item === 'string' && item.length > 0 && fleetAlertDestinations.has(item)
      )
    : [];
  if (destinationIds.length === 0) {
    return reply.code(400).send({ error: 'destination_ids_required' });
  }
  const now = new Date().toISOString();
  const rule: FleetAlertRouteRule = {
    id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    minimumSeverity,
    targetScope,
    targetIds,
    destinationIds,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  fleetAlertRouteRules.set(rule.id, rule);
  savePersistedFleetAlerts();
  return reply.code(201).send(rule);
});

app.patch(
  '/fleet/alerts/rules/:ruleId',
  async (request: FastifyRequest<{ Params: { ruleId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const existing = fleetAlertRouteRules.get(request.params.ruleId);
    if (!existing) {
      return reply.code(404).send({ error: 'rule_not_found' });
    }
    const body = request.body;
    const nextScope =
      body.targetScope === 'target_ids' || body.targetScope === 'all'
        ? body.targetScope
        : existing.targetScope;
    const requestedTargetIds = Array.isArray(body.targetIds)
      ? body.targetIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : existing.targetIds;
    const nextTargetIds = nextScope === 'target_ids' ? requestedTargetIds : [];
    if (nextScope === 'target_ids' && nextTargetIds.length === 0) {
      return reply.code(400).send({ error: 'target_ids_required' });
    }
    const nextDestinationIds = Array.isArray(body.destinationIds)
      ? body.destinationIds.filter(
          (item): item is string =>
            typeof item === 'string' && item.length > 0 && fleetAlertDestinations.has(item)
        )
      : existing.destinationIds;
    if (nextDestinationIds.length === 0) {
      return reply.code(400).send({ error: 'destination_ids_required' });
    }
    const next: FleetAlertRouteRule = {
      ...existing,
      name:
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim()
          : existing.name,
      minimumSeverity: isFleetAlertSeverity(body.minimumSeverity)
        ? body.minimumSeverity
        : existing.minimumSeverity,
      targetScope: nextScope,
      targetIds: nextTargetIds,
      destinationIds: nextDestinationIds,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
      updatedAt: new Date().toISOString(),
    };
    fleetAlertRouteRules.set(next.id, next);
    savePersistedFleetAlerts();
    return reply.code(200).send(next);
  }
);

app.post('/fleet/alerts/test', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const destinationId =
    typeof request.body.destinationId === 'string' && request.body.destinationId.length > 0
      ? request.body.destinationId
      : null;
  if (destinationId && !fleetAlertDestinations.has(destinationId)) {
    return reply.code(404).send({ error: 'destination_not_found' });
  }
  const targetId =
    typeof request.body.targetId === 'string' && request.body.targetId.length > 0
      ? request.body.targetId
      : 'fleet-test';
  dispatchFleetAlertWebhooks(
    {
      kind: 'policy-violation',
      targetId,
      severity: 'high',
      summary: 'Fleet alert test event',
      details: {
        triggeredBy: 'manual_test',
        at: new Date().toISOString(),
      },
    },
    {
      ...(destinationId ? { destinationIds: new Set([destinationId]) } : {}),
      ignoreCooldown: true,
    }
  );
  return reply.code(200).send({ ok: true });
});

app.post('/fleet/policies', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return reply.code(400).send({ error: 'invalid_name' });
  }
  const now = new Date().toISOString();
  const allowedAuthMode =
    body.allowedAuthMode === 'none' ||
    body.allowedAuthMode === 'token' ||
    body.allowedAuthMode === 'any'
      ? body.allowedAuthMode
      : 'any';
  const policy: FleetPolicyProfile = {
    id: `policy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: body.name.trim(),
    ...(typeof body.minBridgeVersion === 'string' && body.minBridgeVersion.trim().length > 0
      ? { minBridgeVersion: body.minBridgeVersion.trim() }
      : {}),
    maxSyncLagMs:
      typeof body.maxSyncLagMs === 'number' &&
      Number.isFinite(body.maxSyncLagMs) &&
      body.maxSyncLagMs > 0
        ? Math.floor(body.maxSyncLagMs)
        : SMART_FLEET_MAX_SYNC_LAG_MS,
    allowedAuthMode,
    maxConsecutiveFailures:
      typeof body.maxConsecutiveFailures === 'number' &&
      Number.isFinite(body.maxConsecutiveFailures) &&
      body.maxConsecutiveFailures >= 0
        ? Math.floor(body.maxConsecutiveFailures)
        : 3,
    createdAt: now,
    updatedAt: now,
  };
  fleetPolicyProfiles.set(policy.id, policy);
  return reply.code(201).send(policy);
});

app.patch(
  '/fleet/policies/:policyId',
  async (request: FastifyRequest<{ Params: { policyId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const existing = fleetPolicyProfiles.get(request.params.policyId);
    if (!existing) {
      return reply.code(404).send({ error: 'policy_not_found' });
    }
    const body = request.body;
    const allowedAuthMode =
      body.allowedAuthMode === 'none' ||
      body.allowedAuthMode === 'token' ||
      body.allowedAuthMode === 'any'
        ? body.allowedAuthMode
        : existing.allowedAuthMode;
    let updated: FleetPolicyProfile = {
      ...existing,
      ...(typeof body.name === 'string' && body.name.trim().length > 0
        ? { name: body.name.trim() }
        : {}),
      ...(typeof body.maxSyncLagMs === 'number' &&
      Number.isFinite(body.maxSyncLagMs) &&
      body.maxSyncLagMs > 0
        ? { maxSyncLagMs: Math.floor(body.maxSyncLagMs) }
        : {}),
      ...(typeof body.maxConsecutiveFailures === 'number' &&
      Number.isFinite(body.maxConsecutiveFailures) &&
      body.maxConsecutiveFailures >= 0
        ? { maxConsecutiveFailures: Math.floor(body.maxConsecutiveFailures) }
        : {}),
      allowedAuthMode,
      updatedAt: new Date().toISOString(),
    };
    if (typeof body.minBridgeVersion === 'string') {
      if (body.minBridgeVersion.trim().length > 0) {
        updated = { ...updated, minBridgeVersion: body.minBridgeVersion.trim() };
      } else {
        updated = Object.fromEntries(
          Object.entries(updated).filter(([key]) => key !== 'minBridgeVersion')
        ) as FleetPolicyProfile;
      }
    }
    fleetPolicyProfiles.set(updated.id, updated);
    return reply.code(200).send(updated);
  }
);

app.post(
  '/fleet/targets/:targetId/apply-policy',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const policyId = typeof request.body.policyId === 'string' ? request.body.policyId : '';
    if (!policyId) {
      return reply.code(400).send({ error: 'policy_id_required' });
    }
    if (!fleetPolicyProfiles.has(policyId)) {
      return reply.code(404).send({ error: 'policy_not_found' });
    }
    fleetTargetPolicyId.set(target.id, policyId);
    maybeBroadcastFleetTargetSignals(target.id);
    return reply.code(200).send({ ok: true, targetId: target.id, policyId });
  }
);

app.post('/fleet/policies/batch-apply', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!SMART_FLEET_V2_ENABLED) {
    return reply.code(404).send({ error: 'smart_fleet_disabled' });
  }
  if (!isRecord(request.body) || !Array.isArray(request.body.items)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const reconcileAfterApply = request.body.reconcileAfterApply === true;
  const approvalToken =
    typeof request.body.approvalToken === 'string' && request.body.approvalToken.length > 0
      ? request.body.approvalToken
      : null;
  const itemMap = new Map<string, string>();
  for (const rawItem of request.body.items) {
    if (!isRecord(rawItem)) continue;
    const targetId = typeof rawItem.targetId === 'string' ? rawItem.targetId : '';
    const policyId = typeof rawItem.policyId === 'string' ? rawItem.policyId : '';
    if (!targetId || !policyId) continue;
    itemMap.set(targetId, policyId);
  }
  const items = [...itemMap.entries()].map(([targetId, policyId]) => ({ targetId, policyId }));
  if (items.length === 0) {
    return reply.code(400).send({ error: 'empty_items' });
  }
  for (const item of items) {
    if (!openclawTargetStore.get(item.targetId)) {
      return reply.code(404).send({ error: 'target_not_found', targetId: item.targetId });
    }
    if (!fleetPolicyProfiles.has(item.policyId)) {
      return reply.code(404).send({ error: 'policy_not_found', policyId: item.policyId });
    }
  }

  const changedItems = items.filter((item) => {
    const target = openclawTargetStore.get(item.targetId);
    if (!target) return false;
    const currentPolicyId = resolveFleetPolicyForTarget(target.id).id;
    return currentPolicyId !== item.policyId;
  });
  if (changedItems.length === 0) {
    return reply.code(200).send({
      ok: true,
      summary: {
        requested: items.length,
        changed: 0,
        applied: 0,
        skipped: items.length,
        reconcileFailed: 0,
      },
      results: items.map((item) => ({
        targetId: item.targetId,
        policyId: item.policyId,
        status: 'skipped_no_change',
      })),
    });
  }

  const criticalTargetIds: string[] = [];
  for (const item of changedItems) {
    const policy = fleetPolicyProfiles.get(item.policyId);
    if (!policy) continue;
    const preview = getFleetTargetStatusWithPolicy(item.targetId, policy);
    if (preview?.riskLevel === 'critical') {
      criticalTargetIds.push(item.targetId);
    }
  }

  const signature = buildBatchApplySignature(changedItems, reconcileAfterApply);
  if (criticalTargetIds.length > SMART_FLEET_APPROVAL_CRITICAL_THRESHOLD) {
    if (!approvalToken) {
      const pending = createFleetApprovalToken(signature, criticalTargetIds);
      return reply.code(409).send({
        error: 'approval_required',
        approval: {
          token: pending.token,
          expiresAt: new Date(pending.expiresAt).toISOString(),
          criticalTargetIds,
          requiredAboveCriticalTargets: SMART_FLEET_APPROVAL_CRITICAL_THRESHOLD,
        },
      });
    }
    const approval = consumeFleetApprovalToken(approvalToken, signature);
    if (!approval.ok) {
      return reply.code(403).send({ error: `approval_${approval.reason}` });
    }
  }

  const results: Array<{
    targetId: string;
    policyId: string;
    status: 'applied' | 'skipped_no_change' | 'reconcile_failed';
    message?: string;
  }> = [];
  let applied = 0;
  let reconcileFailed = 0;

  for (const item of items) {
    const target = openclawTargetStore.get(item.targetId);
    if (!target) continue;
    const currentPolicyId = resolveFleetPolicyForTarget(target.id).id;
    if (currentPolicyId === item.policyId) {
      results.push({
        targetId: target.id,
        policyId: item.policyId,
        status: 'skipped_no_change',
      });
      continue;
    }
    fleetTargetPolicyId.set(target.id, item.policyId);
    maybeBroadcastFleetTargetSignals(target.id);
    applied += 1;
    if (reconcileAfterApply) {
      try {
        openclawSyncManager.restartTarget(target);
      } catch (error) {
        reconcileFailed += 1;
        const message = error instanceof Error ? error.message : 'reconcile_failed';
        results.push({
          targetId: target.id,
          policyId: item.policyId,
          status: 'reconcile_failed',
          message,
        });
        continue;
      }
    }
    results.push({
      targetId: target.id,
      policyId: item.policyId,
      status: 'applied',
    });
  }

  return reply.code(200).send({
    ok: true,
    summary: {
      requested: items.length,
      changed: changedItems.length,
      applied,
      skipped: results.filter((item) => item.status === 'skipped_no_change').length,
      reconcileFailed,
    },
    results,
  });
});

app.post(
  '/fleet/targets/:targetId/policy-preview',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const policyId = typeof request.body.policyId === 'string' ? request.body.policyId : '';
    if (!policyId) {
      return reply.code(400).send({ error: 'policy_id_required' });
    }
    const policy = fleetPolicyProfiles.get(policyId);
    if (!policy) {
      return reply.code(404).send({ error: 'policy_not_found' });
    }
    const preview = getFleetTargetStatusWithPolicy(target.id, policy);
    if (!preview) {
      return reply.code(404).send({ error: 'target_not_found' });
    }

    const summary =
      preview.violations.length === 0 && preview.drifts.length === 0
        ? 'No immediate drift/violation detected for selected policy.'
        : `${String(preview.drifts.length)} drift(s), ${String(preview.violations.length)} violation(s) expected.`;

    return reply.code(200).send({
      targetId: preview.targetId,
      policyId,
      policyName: policy.name,
      riskLevel: preview.riskLevel,
      healthScore: preview.healthScore,
      drifts: preview.drifts,
      violations: preview.violations,
      summary,
    });
  }
);

app.get(
  '/fleet/targets/:targetId/health-score',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    const status = getFleetTargetStatus(request.params.targetId);
    if (!status) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    return reply.code(200).send({
      targetId: status.targetId,
      healthScore: status.healthScore,
      riskLevel: status.riskLevel,
      updatedAt: status.updatedAt,
    });
  }
);

app.get(
  '/fleet/targets/:targetId/drift',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    const status = getFleetTargetStatus(request.params.targetId);
    if (!status) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    return reply.code(200).send({
      targetId: status.targetId,
      drifts: status.drifts,
      desired: status.desired,
      reported: status.reported,
      updatedAt: status.updatedAt,
    });
  }
);

app.get(
  '/fleet/violations',
  async (
    request: FastifyRequest<{ Querystring: { targetId?: string; severity?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    const statuses = listFleetTargetStatuses();
    const targetId = request.query.targetId;
    const severity = request.query.severity;
    const violations = statuses
      .filter((status) => !targetId || status.targetId === targetId)
      .flatMap((status) => status.violations)
      .filter((item) => !severity || item.severity === severity);
    return reply.code(200).send({ violations });
  }
);

app.post(
  '/fleet/targets/:targetId/reconcile',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const op = startOperation('fleet-reconcile', 'Manual fleet target reconcile', target.id);

    const runId = `fleet_reconcile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    fleetRemediationRuns.set(runId, {
      id: runId,
      targetId: target.id,
      action: 'reconcile',
      status: 'running',
      startedAt,
      endedAt: undefined,
      message: 'Reconcile started.',
    });
    broadcastSse({
      kind: 'remediation-status',
      payload: {
        runId,
        targetId: target.id,
        action: 'reconcile',
        status: 'running',
        startedAt,
      },
    });

    try {
      openclawSyncManager.restartTarget(target);
      maybeBroadcastFleetTargetSignals(target.id);
      const endedAt = new Date().toISOString();
      const next: FleetRemediationRun = {
        id: runId,
        targetId: target.id,
        action: 'reconcile',
        status: 'succeeded',
        startedAt,
        endedAt,
        message: 'Reconcile completed.',
      };
      fleetRemediationRuns.set(runId, next);
      finishOperation(op.operationId, 'succeeded', 'Fleet reconcile completed');
      broadcastSse({
        kind: 'remediation-status',
        payload: {
          runId,
          targetId: target.id,
          action: 'reconcile',
          status: 'succeeded',
          startedAt,
          endedAt,
        },
      });
      return reply.code(200).send({ ok: true, run: next, operationId: op.operationId });
    } catch (error) {
      const endedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : 'reconcile_failed';
      dispatchFleetAlertWebhooks({
        kind: 'remediation-failed',
        targetId: target.id,
        severity: 'high',
        summary: 'Reconcile failed',
        details: {
          action: 'reconcile',
          message,
          endedAt,
        },
      });
      const next: FleetRemediationRun = {
        id: runId,
        targetId: target.id,
        action: 'reconcile',
        status: 'failed',
        startedAt,
        endedAt,
        message,
      };
      fleetRemediationRuns.set(runId, next);
      finishOperation(op.operationId, 'failed', 'Fleet reconcile failed', message);
      broadcastSse({
        kind: 'remediation-status',
        payload: {
          runId,
          targetId: target.id,
          action: 'reconcile',
          status: 'failed',
          startedAt,
          endedAt,
          message,
        },
      });
      return reply
        .code(500)
        .send({ error: 'reconcile_failed', message, operationId: op.operationId });
    }
  }
);

app.get(
  '/fleet/remediations/runs/:runId',
  async (request: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SMART_FLEET_V2_ENABLED) {
      return reply.code(404).send({ error: 'smart_fleet_disabled' });
    }
    const run = fleetRemediationRuns.get(request.params.runId);
    if (!run) {
      return reply.code(404).send({ error: 'run_not_found' });
    }
    return reply.code(200).send(run);
  }
);

app.get(
  '/openclaw/channels',
  async (request: FastifyRequest<{ Querystring: { targetId?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const targetId = request.query.targetId;
    let resolvedTargetId: string | undefined;
    let targetOpenClawDir = openclawDir;
    let resolvedTarget: OpenClawTarget | null = null;

    if (targetId) {
      const target = openclawTargetStore.get(targetId);
      if (!target) {
        return reply.code(404).send({ error: 'target_not_found' });
      }
      resolvedTargetId = target.id;
      targetOpenClawDir = target.openclawDir;
      resolvedTarget = target;
    }

    const safeOpenClawDir = path.resolve(
      targetOpenClawDir.startsWith('~')
        ? targetOpenClawDir.replace('~', os.homedir())
        : targetOpenClawDir
    );
    const channelData = readOpenClawChannels(safeOpenClawDir);
    const runtimeProbe =
      resolvedTarget && resolvedTarget.type === 'remote'
        ? await getCachedRuntimeProbe(resolvedTarget)
        : null;
    const channels = runtimeProbe
      ? channelData.channels.map((channel) => {
          const probe = runtimeProbe.get(normalizeChannelId(channel.id));
          if (!probe) return channel;
          return {
            ...channel,
            connected: probe.connected,
            runtimeState: probe.runtimeState,
          };
        })
      : channelData.channels;

    return reply.code(200).send({
      targetId: resolvedTargetId,
      ...(channelData.configPath ? { configPath: channelData.configPath } : {}),
      configStatus: channelData.configStatus,
      configCandidates: channelData.configCandidates,
      channels,
    });
  }
);

app.post('/openclaw/targets', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.label !== 'string' || body.label.length === 0) {
    return reply.code(400).send({ error: 'label is required' });
  }
  if (typeof body.openclawDir !== 'string' || body.openclawDir.length === 0) {
    return reply.code(400).send({ error: 'openclawDir is required' });
  }
  if (body.purpose !== undefined && body.purpose !== 'production' && body.purpose !== 'test') {
    return reply.code(400).send({ error: 'invalid_purpose' });
  }
  if (body.origin === 'smoke' && body.purpose === 'production') {
    return reply.code(400).send({ error: 'invalid_purpose_origin_conflict' });
  }
  const resolvedDir = path.resolve(
    body.openclawDir.startsWith('~')
      ? body.openclawDir.replace(/^~/, os.homedir())
      : body.openclawDir
  );
  if (!isOpenClawDirSafe(resolvedDir)) {
    return reply.code(400).send({
      error: 'invalid_openclaw_dir',
      message: 'Directory is not allowed for security reasons.',
    });
  }
  const input: OpenClawTargetInput = {
    label: body.label,
    type: body.type === 'remote' ? 'remote' : 'local',
    origin: body.origin === 'smoke' ? 'smoke' : 'user',
    purpose:
      body.purpose === 'test' || body.origin === 'smoke'
        ? 'test'
        : body.purpose === 'production'
          ? 'production'
          : 'production',
    openclawDir: body.openclawDir,
    pollIntervalMs: typeof body.pollIntervalMs === 'number' ? body.pollIntervalMs : 30_000,
    enabled: body.enabled !== false,
  };
  const target = openclawTargetStore.add(input);
  if (target.enabled) {
    openclawSyncManager.startTarget(target);
  }
  app.log.info({ targetId: target.id, label: target.label }, 'OpenClaw target added');
  return reply.code(201).send(target);
});

app.patch(
  '/openclaw/targets/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const patch = request.body as unknown as OpenClawTargetPatch;
    if (typeof patch.openclawDir === 'string') {
      const resolvedDir = path.resolve(
        patch.openclawDir.startsWith('~')
          ? patch.openclawDir.replace(/^~/, os.homedir())
          : patch.openclawDir
      );
      if (!isOpenClawDirSafe(resolvedDir)) {
        return reply.code(400).send({
          error: 'invalid_openclaw_dir',
          message: 'Directory is not allowed for security reasons.',
        });
      }
    }
    if (
      patch.origin !== undefined &&
      patch.origin !== 'user' &&
      patch.origin !== 'auto' &&
      patch.origin !== 'smoke'
    ) {
      return reply.code(400).send({ error: 'invalid_origin' });
    }
    if (patch.purpose !== undefined && patch.purpose !== 'production' && patch.purpose !== 'test') {
      return reply.code(400).send({ error: 'invalid_purpose' });
    }
    if (patch.origin === 'smoke' && patch.purpose === 'production') {
      return reply.code(400).send({ error: 'invalid_purpose_origin_conflict' });
    }
    const normalizedPatch: OpenClawTargetPatch = {
      ...patch,
      ...(patch.origin === 'smoke' && patch.purpose === undefined ? { purpose: 'test' } : {}),
    };
    const updated = openclawTargetStore.update(request.params.targetId, normalizedPatch);
    if (!updated) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    openclawSyncManager.restartTarget(updated);
    return reply.code(200).send(updated);
  }
);

app.delete(
  '/openclaw/targets',
  async (
    request: FastifyRequest<{ Querystring: { origin?: string; purpose?: string; ids?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { origin, purpose, ids } = request.query;
    if (origin !== undefined && origin !== 'user' && origin !== 'auto' && origin !== 'smoke') {
      return reply.code(400).send({ error: 'invalid_origin' });
    }
    if (purpose !== undefined && purpose !== 'production' && purpose !== 'test') {
      return reply.code(400).send({ error: 'invalid_purpose' });
    }

    const parsedIds =
      typeof ids === 'string' && ids.length > 0
        ? [
            ...new Set(
              ids
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id.length > 0)
            ),
          ]
        : [];
    if (parsedIds.length === 0 && origin === undefined && purpose === undefined) {
      return reply.code(400).send({ error: 'missing_filter' });
    }

    const allTargets = openclawTargetStore.list();
    const byId = new Map(allTargets.map((target) => [target.id, target]));
    let targets =
      parsedIds.length > 0
        ? parsedIds
            .map((id) => byId.get(id))
            .filter((target): target is OpenClawTarget => target !== undefined)
        : allTargets;
    if (origin !== undefined) {
      targets = targets.filter((target) => target.origin === origin);
    }
    if (purpose !== undefined) {
      targets = targets.filter((target) => target.purpose === purpose);
    }

    if (parsedIds.length > 0) {
      const missingTargetIds = parsedIds.filter((id) => !byId.has(id));
      if (missingTargetIds.length > 0) {
        return reply.code(409).send({ error: 'target_ids_not_found', missingTargetIds });
      }
      const unresolvedIds = parsedIds.filter((id) => !targets.some((target) => target.id === id));
      if (unresolvedIds.length > 0) {
        return reply.code(409).send({ error: 'target_ids_filter_mismatch', unresolvedIds });
      }
    }

    const targetIds = targets.map((target) => target.id);
    for (const targetId of targetIds) {
      openclawSyncManager.stopTarget(targetId);
    }
    for (const targetId of targetIds) {
      openclawTargetStore.remove(targetId);
    }
    app.log.info(
      { origin, purpose, removedCount: targetIds.length, byIds: parsedIds.length > 0 },
      'OpenClaw targets bulk removed'
    );
    return reply.code(200).send({
      ok: true,
      origin,
      purpose,
      removedCount: targetIds.length,
      removedTargetIds: targetIds,
    });
  }
);

app.delete(
  '/openclaw/targets/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    openclawSyncManager.stopTarget(request.params.targetId);
    const removed = openclawTargetStore.remove(request.params.targetId);
    if (!removed) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    app.log.info({ targetId: request.params.targetId }, 'OpenClaw target removed');
    return reply.code(200).send({ ok: true });
  }
);

// ── OpenClaw Per-Target Routes ──────────────────────────────────────

app.get(
  '/openclaw/targets/:targetId/jobs',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = openclawSyncManager.getStatus(request.params.targetId);
    if (!status) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const jobs = status.available ? openclawSyncManager.getJobs(request.params.targetId) : [];
    return reply.code(200).send({ available: status.available, jobs, syncStatus: status });
  }
);

app.get(
  '/openclaw/targets/:targetId/runs/:jobId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; jobId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = openclawSyncManager.getStatus(request.params.targetId);
    if (!status) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    if (!status.available) {
      return reply.code(200).send({ available: false, runs: [], syncStatus: status });
    }
    const query = request.query as Record<string, string | undefined>;
    const limit = parsePositiveInt(query.limit, 50, 500);
    const runs = openclawSyncManager.getRunHistory(
      request.params.targetId,
      request.params.jobId,
      limit
    );
    return reply.code(200).send({ available: true, runs, syncStatus: status });
  }
);

app.get(
  '/openclaw/targets/:targetId/health',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const status = openclawSyncManager.getStatus(target.id) ?? {
      running: false,
      available: false,
      pollIntervalMs: target.pollIntervalMs,
      jobsCount: 0,
      lastAttemptAt: undefined,
      lastSuccessfulSyncAt: undefined,
      consecutiveFailures: 0,
      lastError: undefined,
      stale: false,
    };
    return reply.code(200).send(await buildOpenClawHealth(target.openclawDir, status));
  }
);

// ── OpenClaw Legacy Routes (backward compatible, default target) ────

app.get('/openclaw/cron/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const status = openclawSync?.getStatus() ?? {
    running: false,
    available: false,
    pollIntervalMs: 30_000,
    jobsCount: 0,
    lastAttemptAt: undefined,
    lastSuccessfulSyncAt: undefined,
    consecutiveFailures: 0,
    lastError: undefined,
    stale: false,
  };
  const jobs = status.available && openclawSync ? openclawSync.getJobs() : [];
  return reply.code(200).send({ available: status.available, jobs, syncStatus: status });
});

app.get('/openclaw/health', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const status = openclawSync?.getStatus() ?? {
    running: false,
    available: false,
    pollIntervalMs: 30_000,
    jobsCount: 0,
    lastAttemptAt: undefined,
    lastSuccessfulSyncAt: undefined,
    consecutiveFailures: 0,
    lastError: undefined,
    stale: false,
  };
  return reply.code(200).send(await buildOpenClawHealth(openclawDir, status));
});

app.get(
  '/openclaw/cron/runs/:jobId',
  async (request: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = openclawSync?.getStatus() ?? {
      running: false,
      available: false,
      pollIntervalMs: 30_000,
      jobsCount: 0,
      lastAttemptAt: undefined,
      lastSuccessfulSyncAt: undefined,
      consecutiveFailures: 0,
      lastError: undefined,
      stale: false,
    };
    if (!status.available || !openclawSync) {
      return reply.code(200).send({ available: false, runs: [], syncStatus: status });
    }
    const query = request.query as Record<string, string | undefined>;
    const limit = parsePositiveInt(query.limit, 50, 500);
    const runs = openclawSync.getRunHistory(request.params.jobId, limit);
    return reply.code(200).send({ available: true, runs, syncStatus: status });
  }
);

app.get('/openclaw/cron/merged', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const view = openclawSync?.createMergedView(cronService.list());
  const syncStatus = openclawSync?.getStatus() ?? {
    running: false,
    available: false,
    pollIntervalMs: 30_000,
    jobsCount: 0,
    lastAttemptAt: undefined,
    lastSuccessfulSyncAt: undefined,
    consecutiveFailures: 0,
    lastError: undefined,
    stale: false,
  };
  return reply.code(200).send({
    ...(view ?? { patzeTasks: cronService.list(), openclawJobs: [], timestamp: Date.now() }),
    syncStatus,
  });
});

// ── Workspace Browser ───────────────────────────────────────────────

const WORKSPACE_ROOTS: readonly string[] = [openclawDir, path.join(os.homedir(), '.patze-control')];

const WORKSPACE_MAX_FILE_SIZE_BYTES = 512 * 1024;
const WORKSPACE_MAX_DEPTH = 10;
const WORKSPACE_HIDDEN_PATTERNS = ['.git', 'node_modules', '__pycache__', '.DS_Store'];
const WORKSPACE_SEARCH_TIMEOUT_MS = 5_000;
const WORKSPACE_SEARCH_DEFAULT_LIMIT = 20;
const WORKSPACE_SEARCH_MAX_LIMIT = 100;
const WORKSPACE_SEARCH_CONTEXT_MAX_CHARS = 200;
const WORKSPACE_SEARCH_CACHE_MAX_ENTRIES = 200;
const MEMORY_FILE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MEMORY.md',
  'SOUL.md',
  'TASKS.md',
  'CHANGELOG.md',
  'CONTEXT.md',
  'README.md',
]);
const WORKSPACE_SEARCH_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.wasm',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.bin',
  '.exe',
  '.dll',
  '.so',
]);

const workspaceSearchCache = new Map<string, { mtimeMs: number; content: string }>();

function isPathWithinRoots(targetPath: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(targetPath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

function getWorkspaceRoots(): readonly string[] {
  const roots = new Set<string>();
  for (const root of WORKSPACE_ROOTS) {
    if (exists(root)) {
      roots.add(path.resolve(root));
    }
  }
  for (const target of openclawTargetStore.list()) {
    if (exists(target.openclawDir)) {
      roots.add(path.resolve(target.openclawDir));
    }
  }
  return Array.from(roots);
}

function getWorkspaceRootsForTarget(targetId: string | null): readonly string[] {
  if (!targetId) {
    return getWorkspaceRoots();
  }
  const roots = new Set<string>();
  const target = openclawTargetStore.get(targetId);
  if (target && exists(target.openclawDir)) {
    roots.add(path.resolve(target.openclawDir));
  }

  const patzeDir = path.join(os.homedir(), '.patze-control');
  if (exists(patzeDir)) {
    roots.add(path.resolve(patzeDir));
  }
  for (const wp of WORKSPACE_ROOTS) {
    if (exists(wp)) {
      roots.add(path.resolve(wp));
    }
  }
  return Array.from(roots);
}

function truncateContext(text: string): string {
  if (text.length <= WORKSPACE_SEARCH_CONTEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, WORKSPACE_SEARCH_CONTEXT_MAX_CHARS)}…`;
}

function readSearchContent(filePath: string, mtimeMs: number): string | null {
  const cached = workspaceSearchCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    workspaceSearchCache.delete(filePath);
    workspaceSearchCache.set(filePath, cached);
    return cached.content;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    workspaceSearchCache.set(filePath, { mtimeMs, content });
    if (workspaceSearchCache.size > WORKSPACE_SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = workspaceSearchCache.keys().next().value;
      if (oldest) {
        workspaceSearchCache.delete(oldest);
      }
    }
    return content;
  } catch {
    return null;
  }
}

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

function listDirectory(dirPath: string, depth: number): readonly WorkspaceEntry[] {
  if (depth > WORKSPACE_MAX_DEPTH) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !WORKSPACE_HIDDEN_PATTERNS.includes(e.name))
      .map((entry): WorkspaceEntry | null => {
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            return { name: entry.name, path: fullPath, type: 'directory' };
          }
          if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            return {
              name: entry.name,
              path: fullPath,
              type: 'file',
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            };
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter((e): e is WorkspaceEntry => e !== null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

app.get(
  '/workspace/roots',
  async (request: FastifyRequest<{ Querystring: { targetId?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const targetId = request.query?.targetId;

    const roots: Array<{
      path: string;
      label: string;
      type: 'openclaw' | 'config';
      targetId?: string;
      targetType?: string;
    }> = [];

    const targets = targetId
      ? openclawTargetStore.list().filter((target) => target.id === targetId)
      : openclawTargetStore.list();
    for (const target of targets) {
      if (exists(target.openclawDir)) {
        roots.push({
          path: target.openclawDir,
          label: `OpenClaw \u2014 ${target.label}${target.type === 'remote' ? ' (remote)' : ''}`,
          type: 'openclaw',
          targetId: target.id,
          targetType: target.type,
        });
      }
    }

    const patzeDir = path.join(os.homedir(), '.patze-control');
    if (exists(patzeDir)) {
      roots.push({ path: patzeDir, label: 'Patze Control', type: 'config' });
    }

    const seenPaths = new Set(roots.map((r) => path.resolve(r.path)));
    for (const wp of WORKSPACE_ROOTS) {
      if (!seenPaths.has(path.resolve(wp)) && exists(wp)) {
        roots.push({ path: wp, label: path.basename(wp), type: 'config' });
      }
    }

    return reply.code(200).send({ roots });
  }
);

app.get(
  '/workspace/tree',
  async (
    request: FastifyRequest<{ Querystring: { path?: string; targetId?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const dirPath = (request.query as Record<string, string | undefined>).path;
    if (!dirPath) {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }
    const resolved = path.resolve(dirPath);
    const workspaceRoots = getWorkspaceRootsForTarget(request.query?.targetId ?? null);
    if (!isPathWithinRoots(resolved, workspaceRoots)) {
      return reply.code(403).send({ error: 'path_outside_workspace' });
    }
    const entries = listDirectory(resolved, 0);
    return reply.code(200).send({ path: resolved, entries });
  }
);

app.get(
  '/workspace/file',
  async (
    request: FastifyRequest<{ Querystring: { path?: string; targetId?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const filePath = (request.query as Record<string, string | undefined>).path;
    if (!filePath) {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }
    const resolved = path.resolve(filePath);
    const workspaceRoots = getWorkspaceRootsForTarget(request.query?.targetId ?? null);
    if (!isPathWithinRoots(resolved, workspaceRoots)) {
      return reply.code(403).send({ error: 'path_outside_workspace' });
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: 'not_a_file' });
      }
      if (stat.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
        return reply.code(413).send({
          error: 'file_too_large',
          message: `File exceeds ${WORKSPACE_MAX_FILE_SIZE_BYTES} bytes limit.`,
        });
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      const ext = path.extname(resolved).slice(1).toLowerCase();
      return reply.code(200).send({
        path: resolved,
        name: path.basename(resolved),
        extension: ext,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        content,
      });
    } catch {
      return reply.code(404).send({ error: 'file_not_found' });
    }
  }
);

app.put('/workspace/file', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return reply.code(400).send({ error: 'path and content are required' });
  }
  const targetId = typeof body.targetId === 'string' ? body.targetId : null;
  const resolved = path.resolve(body.path);
  const workspaceRoots = getWorkspaceRootsForTarget(targetId);
  if (!isPathWithinRoots(resolved, workspaceRoots)) {
    return reply.code(403).send({ error: 'path_outside_workspace' });
  }
  try {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, body.content, 'utf-8');
    const stat = fs.statSync(resolved);
    return reply.code(200).send({
      ok: true,
      path: resolved,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    return reply.code(500).send({
      error: 'write_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

app.get('/workspace/memory-files', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const agents: Array<{
    agentId: string;
    targetId: string;
    targetType: 'local' | 'remote';
    targetLabel: string;
    workspacePath: string;
    files: Array<{ name: string; path: string; size: number; modifiedAt: string }>;
  }> = [];

  for (const target of openclawTargetStore.list()) {
    if (!exists(target.openclawDir) || !readableDir(target.openclawDir)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target.openclawDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('workspace')) {
        continue;
      }
      const workspacePath = path.join(target.openclawDir, entry.name);
      const files: Array<{ name: string; path: string; size: number; modifiedAt: string }> = [];
      for (const fileName of MEMORY_FILE_ALLOWLIST) {
        const filePath = path.join(workspacePath, fileName);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            continue;
          }
          files.push({
            name: fileName,
            path: filePath,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {
          // Skip missing files.
        }
      }
      if (files.length === 0) {
        continue;
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      agents.push({
        agentId: entry.name,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        workspacePath,
        files,
      });
    }
  }

  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return reply.code(200).send({ agents });
});

app.put('/workspace/memory-file', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return reply.code(400).send({ error: 'path and content are required' });
  }
  const resolved = path.resolve(body.path);
  const workspaceRoots = getWorkspaceRoots();
  if (!isPathWithinRoots(resolved, workspaceRoots)) {
    return reply.code(403).send({ error: 'path_outside_workspace' });
  }
  const fileName = path.basename(resolved);
  if (!MEMORY_FILE_ALLOWLIST.has(fileName)) {
    return reply.code(403).send({ error: 'memory_file_not_allowed' });
  }
  try {
    fs.writeFileSync(resolved, body.content, 'utf-8');
    const stat = fs.statSync(resolved);
    return reply.code(200).send({
      ok: true,
      path: resolved,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    return reply.code(500).send({
      error: 'write_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

app.get(
  '/workspace/search',
  async (
    request: FastifyRequest<{ Querystring: { q?: string; maxResults?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const q = (request.query.q ?? '').trim();
    if (q.length < 3) {
      return reply
        .code(400)
        .send({ error: 'query_too_short', message: 'Minimum query length is 3.' });
    }
    const maxResults = parsePositiveInt(
      request.query.maxResults,
      WORKSPACE_SEARCH_DEFAULT_LIMIT,
      WORKSPACE_SEARCH_MAX_LIMIT
    );
    const queryLower = q.toLowerCase();
    const roots = getWorkspaceRoots().filter(readableDir);
    const deadlineMs = Date.now() + WORKSPACE_SEARCH_TIMEOUT_MS;
    const results: Array<{
      path: string;
      name: string;
      lineNumber: number;
      line: string;
      contextBefore: string;
      contextAfter: string;
    }> = [];
    let timedOut = false;

    const pushFileMatches = (filePath: string): void => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      if (WORKSPACE_SEARCH_BINARY_EXTENSIONS.has(ext)) {
        return;
      }
      const content = readSearchContent(filePath, stat.mtimeMs);
      if (!content) {
        return;
      }
      if (!content.toLowerCase().includes(queryLower)) {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]!.toLowerCase().includes(queryLower)) {
          continue;
        }
        results.push({
          path: filePath,
          name: path.basename(filePath),
          lineNumber: i + 1,
          line: truncateContext(lines[i]!),
          contextBefore: i > 0 ? truncateContext(lines[i - 1]!) : '',
          contextAfter: i + 1 < lines.length ? truncateContext(lines[i + 1]!) : '',
        });
        if (results.length >= maxResults) {
          return;
        }
      }
    };

    for (const root of roots) {
      const queue: string[] = [root];
      while (queue.length > 0 && results.length < maxResults) {
        if (Date.now() > deadlineMs) {
          timedOut = true;
          break;
        }
        const current = queue.shift();
        if (!current) {
          continue;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (WORKSPACE_HIDDEN_PATTERNS.includes(entry.name)) {
            continue;
          }
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            queue.push(fullPath);
            continue;
          }
          if (entry.isFile()) {
            pushFileMatches(fullPath);
          }
          if (results.length >= maxResults) {
            break;
          }
        }
      }
      if (timedOut || results.length >= maxResults) {
        break;
      }
    }

    return reply.code(200).send({
      query: q,
      maxResults,
      timedOut,
      results,
    });
  }
);

// ── Safe Terminal ───────────────────────────────────────────────────

const TERMINAL_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'uptime',
  'whoami',
  'hostname',
  'date',
  'df',
  'free',
  'uname',
  'ps',
  'top',
  'cat',
  'ls',
  'head',
  'tail',
  'wc',
  'du',
  'openclaw',
  'pm2',
  'systemctl',
  'journalctl',
  'ping',
  'dig',
  'nslookup',
  'ss',
  'ip',
  'git',
]);

const TERMINAL_BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'killall',
  'pkill',
  'shutdown',
  'reboot',
  'halt',
  'env',
  'export',
  'set',
  'unset',
  'source',
  'curl',
  'wget',
  'nc',
  'ncat',
  'socat',
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'fish',
  'csh',
  'su',
  'sudo',
  'passwd',
  'useradd',
  'userdel',
  'apt',
  'yum',
  'dnf',
  'pacman',
  'snap',
  'dd',
  'mkfs',
  'mount',
  'umount',
  'fdisk',
]);

const TERMINAL_MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINAL_TIMEOUT_MS = 15_000;

const SENSITIVE_PATH_PREFIXES: readonly string[] = [
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/root/',
  '/proc/self/',
];

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /\.ssh\//,
  /\.env/,
  /id_rsa/,
  /id_ed25519/,
  /authorized_keys/,
  /known_hosts/,
  /credentials/,
  /\.pem$/,
  /\.key$/,
  /private.*key/i,
  /secret/i,
  /token/i,
  /auth\.json/,
  /patze-control\/auth/,
];

const FILE_READING_COMMANDS: ReadonlySet<string> = new Set(['cat', 'head', 'tail']);

const SYSTEMCTL_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'show',
]);

const GIT_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'branch',
  'remote',
  'show',
  'tag',
  'stash',
  'rev-parse',
  'describe',
  'shortlog',
]);

type TerminalScope = 'local' | 'remote_attachment';

interface TerminalScopeInput {
  readonly scope: TerminalScope;
  readonly attachmentId: string | undefined;
}

interface TerminalExecPayload {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface TerminalMachineEntry {
  readonly id: string;
  readonly scope: TerminalScope;
  readonly label: string;
  readonly status: 'connected' | 'degraded';
  readonly host: string;
}

interface InstallCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
}

interface InstallRequestPayload {
  readonly scope: TerminalScope;
  readonly attachmentId: string | undefined;
  readonly installPath: string;
  readonly installCommand: string | undefined;
  readonly force: boolean;
}

const OPENCLAW_INSTALL_TIMEOUT_MS = 5 * 60_000;

function parseCommandBase(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(/\s+/);
  const base = parts[0];
  if (!base) return null;
  if (base.includes('/')) {
    return null;
  }
  return base;
}

function containsSensitivePath(args: string): boolean {
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (args.includes(prefix)) return true;
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(args)) return true;
  }
  return false;
}

function isCommandAllowed(command: string): { ok: true } | { ok: false; reason: string } {
  const base = parseCommandBase(command);
  if (!base) return { ok: false, reason: 'Invalid command (empty or contains path separators)' };
  if (TERMINAL_BLOCKED_COMMANDS.has(base)) {
    return { ok: false, reason: `Command "${base}" is blocked for security` };
  }
  if (!TERMINAL_ALLOWED_COMMANDS.has(base)) {
    return { ok: false, reason: `Command "${base}" is not in the allowlist` };
  }
  if (
    command.includes('|') ||
    command.includes(';') ||
    command.includes('&&') ||
    command.includes('`') ||
    command.includes('$(')
  ) {
    return { ok: false, reason: 'Pipes, chaining, and subshells are not allowed' };
  }

  const argsStr = command.trim().slice(base.length);

  if (FILE_READING_COMMANDS.has(base) && containsSensitivePath(argsStr)) {
    return { ok: false, reason: `Reading sensitive files is not allowed` };
  }

  if (base === 'systemctl') {
    const parts = command.trim().split(/\s+/);
    const sub = parts[1];
    if (!sub || !SYSTEMCTL_SAFE_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `systemctl subcommand "${sub ?? ''}" is not allowed` };
    }
  }

  if (base === 'git') {
    const parts = command.trim().split(/\s+/);
    const sub = parts[1];
    if (!sub || !GIT_SAFE_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `git subcommand "${sub ?? ''}" is not allowed (read-only ops only)`,
      };
    }
  }

  return { ok: true };
}

function parseTerminalScopeInput(body: unknown): TerminalScopeInput {
  if (!isRecord(body)) {
    return { scope: 'local', attachmentId: undefined };
  }
  const scopeRaw = body.scope;
  const scope: TerminalScope =
    scopeRaw === 'remote_attachment' || scopeRaw === 'local' ? scopeRaw : 'local';
  const attachmentId =
    typeof body.attachmentId === 'string' && body.attachmentId.trim().length > 0
      ? body.attachmentId.trim()
      : undefined;
  return { scope, attachmentId };
}

function buildEndpointAuthHeaders(endpoint: MachineEndpoint): Record<string, string> {
  if (endpoint.auth?.mode === 'token' && endpoint.auth.token) {
    return { Authorization: `Bearer ${endpoint.auth.token}` };
  }
  return {};
}

function parseInstallRequestPayload(body: unknown): InstallRequestPayload {
  const scopeInput = parseTerminalScopeInput(body);
  const installPathRaw =
    isRecord(body) && typeof body.installPath === 'string' ? body.installPath : '';
  const installCommandRaw =
    isRecord(body) && typeof body.installCommand === 'string' ? body.installCommand.trim() : '';
  const force = isRecord(body) && body.force === true;
  return {
    scope: scopeInput.scope,
    attachmentId: scopeInput.attachmentId,
    installPath: installPathRaw.trim() || '~/.openclaw',
    installCommand: installCommandRaw.length > 0 ? installCommandRaw : undefined,
    force,
  };
}

function resolveRemoteAttachment(attachmentId: string): {
  readonly localBaseUrl: string;
  readonly endpoint: MachineEndpoint;
} | null {
  const attachment = orchestrator
    .listAttachments()
    .find((entry) => entry.endpointId === attachmentId);
  if (!attachment) return null;
  const endpoint = orchestrator.getEndpointConfig(attachmentId);
  if (!endpoint) return null;
  return { localBaseUrl: attachment.tunnel.localBaseUrl, endpoint };
}

async function runLocalTerminalExec(command: string): Promise<TerminalExecPayload> {
  const { execFile } = await import('node:child_process');
  const parts = command.split(/\s+/);
  const bin = parts[0]!;
  const args = parts.slice(1);
  return new Promise<TerminalExecPayload>((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: TERMINAL_TIMEOUT_MS,
        maxBuffer: TERMINAL_MAX_OUTPUT_BYTES,
        env: { ...process.env, TERM: 'dumb', LANG: 'en_US.UTF-8' },
      },
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({
          command,
          exitCode,
          stdout: typeof stdout === 'string' ? stdout.slice(0, TERMINAL_MAX_OUTPUT_BYTES) : '',
          stderr: typeof stderr === 'string' ? stderr.slice(0, TERMINAL_MAX_OUTPUT_BYTES) : '',
          truncated:
            (typeof stdout === 'string' && stdout.length > TERMINAL_MAX_OUTPUT_BYTES) ||
            (typeof stderr === 'string' && stderr.length > TERMINAL_MAX_OUTPUT_BYTES),
        });
      }
    );
    child.on('error', (err) => {
      resolve({
        command,
        exitCode: 127,
        stdout: '',
        stderr: err.message,
        truncated: false,
      });
    });
  });
}

async function runScopedTerminalExec(
  command: string,
  scopeInput: TerminalScopeInput
): Promise<TerminalExecPayload> {
  if (scopeInput.scope === 'local') {
    return runLocalTerminalExec(command);
  }
  const attachmentId = scopeInput.attachmentId;
  if (!attachmentId) {
    return {
      command,
      exitCode: 1,
      stdout: '',
      stderr: 'attachmentId is required for remote_attachment scope',
      truncated: false,
    };
  }
  const resolved = resolveRemoteAttachment(attachmentId);
  if (!resolved) {
    return {
      command,
      exitCode: 1,
      stdout: '',
      stderr: `remote attachment '${attachmentId}' is not connected`,
      truncated: false,
    };
  }

  try {
    const response = await fetch(`${resolved.localBaseUrl}/terminal/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildEndpointAuthHeaders(resolved.endpoint),
      },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(TERMINAL_TIMEOUT_MS + 3_000),
    });
    if (!response.ok) {
      return {
        command,
        exitCode: 1,
        stdout: '',
        stderr: `remote terminal failed with HTTP ${response.status}`,
        truncated: false,
      };
    }
    const payload = (await response.json()) as Partial<TerminalExecPayload>;
    return {
      command,
      exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 1,
      stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
      stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
      truncated: payload.truncated === true,
    };
  } catch (error) {
    return {
      command,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'remote terminal request failed',
      truncated: false,
    };
  }
}

async function runShellProbe(
  command: string,
  timeoutMs = 12_000
): Promise<{
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileNode('bash', ['-lc', command], {
      timeout: timeoutMs,
      maxBuffer: TERMINAL_MAX_OUTPUT_BYTES,
      env: { ...process.env, TERM: 'dumb', LANG: 'en_US.UTF-8' },
    });
    return { ok: true, exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : (err.message ?? 'command failed'),
    };
  }
}

async function runLocalInstallPrecheck(payload: InstallRequestPayload): Promise<{
  readonly ok: boolean;
  readonly checks: readonly InstallCheck[];
  readonly installPath: string;
  readonly openclawVersion: string | null;
}> {
  const checks: InstallCheck[] = [];
  const whoami = await runShellProbe('whoami');
  checks.push({
    id: 'whoami',
    label: 'Current User',
    status: whoami.ok ? 'ok' : 'warn',
    message: whoami.ok ? whoami.stdout.trim() || 'unknown' : whoami.stderr.trim() || 'unknown',
  });
  const hostnameResult = await runShellProbe('hostname');
  checks.push({
    id: 'hostname',
    label: 'Host',
    status: hostnameResult.ok ? 'ok' : 'warn',
    message: hostnameResult.ok
      ? hostnameResult.stdout.trim() || 'unknown'
      : hostnameResult.stderr.trim() || 'unknown',
  });
  const quotedInstallPath = shellQuote(payload.installPath);
  const disk = await runShellProbe(
    `target_dir=${quotedInstallPath}; mkdir -p -- "$target_dir" && df -h "$target_dir" | tail -n 1`
  );
  checks.push({
    id: 'disk',
    label: 'Disk Check',
    status: disk.ok ? 'ok' : 'warn',
    message: disk.ok ? disk.stdout.trim() : disk.stderr.trim() || 'cannot inspect disk',
  });

  const toolCommands: ReadonlyArray<{ id: string; label: string; command: string }> = [
    { id: 'node', label: 'Node.js', command: 'node --version' },
    { id: 'npm', label: 'npm', command: 'npm --version' },
    { id: 'pnpm', label: 'pnpm', command: 'pnpm --version' },
    { id: 'bun', label: 'bun', command: 'bun --version' },
    { id: 'openclaw', label: 'OpenClaw CLI', command: 'openclaw --version' },
  ];

  let openclawVersion: string | null = null;
  for (const probe of toolCommands) {
    const result = await runShellProbe(probe.command, 8_000);
    const message = result.ok ? result.stdout.trim() : result.stderr.trim();
    checks.push({
      id: probe.id,
      label: probe.label,
      status: result.ok ? 'ok' : probe.id === 'openclaw' ? 'warn' : 'warn',
      message: message || (result.ok ? 'ok' : 'not available'),
    });
    if (probe.id === 'openclaw' && result.ok) {
      openclawVersion = result.stdout.trim() || null;
    }
  }

  const ok = checks.every((check) => check.status !== 'error');
  return { ok, checks, installPath: payload.installPath, openclawVersion };
}

async function runLocalInstall(payload: InstallRequestPayload): Promise<{
  readonly ok: boolean;
  readonly installed: boolean;
  readonly alreadyInstalled: boolean;
  readonly commandUsed: string | null;
  readonly logs: readonly string[];
}> {
  const logs: string[] = [];
  if (!payload.force) {
    const existing = await runShellProbe('openclaw --version', 8_000);
    if (existing.ok) {
      logs.push(`OpenClaw already available: ${existing.stdout.trim()}`);
      return {
        ok: true,
        installed: false,
        alreadyInstalled: true,
        commandUsed: null,
        logs,
      };
    }
  }

  const installCommands =
    payload.installCommand && payload.installCommand.trim().length > 0
      ? [payload.installCommand]
      : ['npm install -g openclaw', 'pnpm add -g openclaw', 'bun add -g openclaw'];

  for (const command of installCommands) {
    logs.push(`$ ${command}`);
    const result = await runShellProbe(command, OPENCLAW_INSTALL_TIMEOUT_MS);
    if (result.stdout.trim()) logs.push(result.stdout.trim());
    if (result.stderr.trim()) logs.push(result.stderr.trim());
    if (result.ok) {
      const verify = await runShellProbe('openclaw --version', 10_000);
      if (verify.ok) {
        logs.push(`Verified OpenClaw: ${verify.stdout.trim()}`);
        return {
          ok: true,
          installed: true,
          alreadyInstalled: false,
          commandUsed: command,
          logs,
        };
      }
      logs.push('Install command succeeded but OpenClaw verification failed.');
    }
  }

  return {
    ok: false,
    installed: false,
    alreadyInstalled: false,
    commandUsed: null,
    logs,
  };
}

async function runLocalInstallVerify(payload: InstallRequestPayload): Promise<{
  readonly ok: boolean;
  readonly openclawAvailable: boolean;
  readonly version: string | null;
  readonly installPath: string;
  readonly writable: boolean;
  readonly message: string;
}> {
  const versionResult = await runShellProbe('openclaw --version', 8_000);
  const quotedInstallPath = shellQuote(payload.installPath);
  const writableCheck = await runShellProbe(
    `target_dir=${quotedInstallPath}; mkdir -p -- "$target_dir" && test -w "$target_dir"`,
    8_000
  );
  const openclawAvailable = versionResult.ok;
  const writable = writableCheck.ok;
  const ok = openclawAvailable && writable;
  return {
    ok,
    openclawAvailable,
    version: openclawAvailable ? versionResult.stdout.trim() || null : null,
    installPath: payload.installPath,
    writable,
    message: ok
      ? 'OpenClaw is ready and install path is writable.'
      : 'OpenClaw verify failed. Check CLI availability and install path permissions.',
  };
}

async function proxyInstallRequestToRemote(
  pathName: '/openclaw/install/precheck' | '/openclaw/install/run' | '/openclaw/install/verify',
  payload: InstallRequestPayload
): Promise<{ status: number; body: unknown }> {
  const attachmentId = payload.attachmentId;
  if (!attachmentId) {
    return { status: 400, body: { error: 'attachmentId is required for remote_attachment scope' } };
  }
  const resolved = resolveRemoteAttachment(attachmentId);
  if (!resolved) {
    return {
      status: 404,
      body: {
        error: 'attachment_not_found',
        message: `Remote attachment '${attachmentId}' not found`,
      },
    };
  }
  const response = await fetch(`${resolved.localBaseUrl}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildEndpointAuthHeaders(resolved.endpoint),
    },
    body: JSON.stringify({
      scope: 'local',
      installPath: payload.installPath,
      installCommand: payload.installCommand,
      force: payload.force,
    }),
    signal: AbortSignal.timeout(OPENCLAW_INSTALL_TIMEOUT_MS + 15_000),
  });
  const body = (await response
    .json()
    .catch(() => ({ error: 'invalid_remote_response' }))) as unknown;
  return { status: response.status, body };
}

app.post('/terminal/exec', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const command = typeof request.body.command === 'string' ? request.body.command.trim() : '';
  if (command.length === 0) {
    return reply.code(400).send({ error: 'command is required' });
  }
  const scopeInput = parseTerminalScopeInput(request.body);

  const check = isCommandAllowed(command);
  if (!check.ok) {
    return reply.code(403).send({ error: 'command_blocked', message: check.reason });
  }

  const result = await runScopedTerminalExec(command, scopeInput);
  return reply.code(200).send({
    ...result,
    scope: scopeInput.scope,
    attachmentId: scopeInput.attachmentId,
  });
});

app.get('/terminal/allowlist', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send({
    allowed: [...TERMINAL_ALLOWED_COMMANDS].sort(),
    blocked: [...TERMINAL_BLOCKED_COMMANDS].sort(),
  });
});

app.get('/terminal/machines', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const machines: TerminalMachineEntry[] = [
    {
      id: 'local',
      scope: 'local',
      label: `Local (${os.hostname()})`,
      status: 'connected',
      host: 'localhost',
    },
  ];
  const attachments = orchestrator.listAttachments();
  for (const attachment of attachments) {
    const endpoint = orchestrator.getEndpointConfig(attachment.endpointId);
    const authHeaders = endpoint ? buildEndpointAuthHeaders(endpoint) : {};
    let status: 'connected' | 'degraded' = 'connected';
    try {
      const healthResponse = await fetch(`${attachment.tunnel.localBaseUrl}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders },
        signal: AbortSignal.timeout(2_500),
      });
      if (!healthResponse.ok) {
        status = 'degraded';
      }
    } catch {
      status = 'degraded';
    }
    machines.push({
      id: attachment.endpointId,
      scope: 'remote_attachment',
      label: endpoint?.label ?? attachment.endpointId,
      status,
      host: attachment.tunnel.remoteHost,
    });
  }
  return reply.code(200).send({ machines });
});

app.post('/openclaw/install/precheck', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const payload = parseInstallRequestPayload(request.body);
  const valid = validateInstallPayload(payload);
  if (!valid.ok) {
    return reply.code(400).send({ error: valid.error });
  }
  if (payload.scope === 'remote_attachment') {
    const proxied = await proxyInstallRequestToRemote('/openclaw/install/precheck', payload);
    return reply.code(proxied.status).send(proxied.body);
  }
  const result = await runLocalInstallPrecheck(payload);
  return reply.code(200).send(result);
});

app.post('/openclaw/install/run', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const payload = parseInstallRequestPayload(request.body);
  const valid = validateInstallPayload(payload);
  if (!valid.ok) {
    return reply.code(400).send({ error: valid.error });
  }
  if (payload.scope === 'remote_attachment') {
    const proxied = await proxyInstallRequestToRemote('/openclaw/install/run', payload);
    return reply.code(proxied.status).send(proxied.body);
  }
  const result = await runLocalInstall(payload);
  return reply.code(result.ok ? 200 : 500).send(result);
});

app.post('/openclaw/install/verify', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const payload = parseInstallRequestPayload(request.body);
  const valid = validateInstallPayload(payload);
  if (!valid.ok) {
    return reply.code(400).send({ error: valid.error });
  }
  if (payload.scope === 'remote_attachment') {
    const proxied = await proxyInstallRequestToRemote('/openclaw/install/verify', payload);
    return reply.code(proxied.status).send(proxied.body);
  }
  const result = await runLocalInstallVerify(payload);
  return reply.code(200).send(result);
});

// ── Config Reader + Command Queue Endpoints ──────────────────────────

app.get(
  '/openclaw/targets/:targetId/config',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const config = readFullConfig(target.openclawDir);
    if (!config) return reply.code(200).send({ available: false, config: null });
    return reply.code(200).send({ available: true, config });
  }
);

app.get(
  '/openclaw/targets/:targetId/agents',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    return reply.code(200).send({ agents: readAgents(target.openclawDir) });
  }
);

app.get(
  '/openclaw/targets/:targetId/models',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    return reply.code(200).send({ models: readModels(target.openclawDir) });
  }
);

app.get(
  '/openclaw/targets/:targetId/bindings',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    return reply.code(200).send({ bindings: readBindings(target.openclawDir) });
  }
);

app.get(
  '/openclaw/targets/:targetId/config-raw',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const raw = readRawConfigString(target.openclawDir);
    return reply.code(200).send({ raw: raw ?? null });
  }
);

// ── Bridge Control Commands ──

app.post(
  '/openclaw/targets/:targetId/control/commands',
  async (
    request: FastifyRequest<{ Params: { targetId: string }; Body: unknown }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const intent = parseBridgeIntent(request.body.intent);
    if (!intent) return reply.code(400).send({ error: 'invalid_intent' });

    const args = parseBridgeArgs(request.body.args);
    const machineId = resolveBridgeMachineIdForTarget(target);
    if (!machineId) {
      return reply.code(422).send({ error: 'target_not_bridge_controlled' });
    }

    const idempotencyKey =
      typeof request.body.idempotencyKey === 'string' && request.body.idempotencyKey.length > 0
        ? request.body.idempotencyKey
        : randomBytes(8).toString('hex');
    const createdBy =
      typeof request.body.createdBy === 'string' && request.body.createdBy.length > 0
        ? request.body.createdBy
        : 'ui';
    const policyVersion =
      typeof request.body.policyVersion === 'string' && request.body.policyVersion.length > 0
        ? request.body.policyVersion
        : 'bridge-control-v1';

    const snapshot: BridgeCommandSnapshot = {
      targetId: target.id,
      machineId,
      targetVersion: buildTargetVersion(target.openclawDir),
      intent,
      args,
      createdBy,
      idempotencyKey,
      approvalRequired: hasMutationArgs(intent, args),
      policyVersion,
    };
    const command = bridgeCommandStore.create({ snapshot });
    broadcastSse({
      kind: 'bridge-command-updated',
      payload: { targetId: target.id, commandId: command.id, state: command.state },
    });
    return reply.code(201).send({ command });
  }
);

app.get(
  '/openclaw/targets/:targetId/control/commands',
  async (
    request: FastifyRequest<{ Params: { targetId: string }; Querystring: { limit?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const machineId = resolveBridgeMachineIdForTarget(target);
    if (!machineId) return reply.code(200).send({ commands: [], counts: {} });
    const commands = bridgeCommandStore.list({
      targetId: target.id,
      machineId,
      limit: parsePositiveInt(request.query.limit, 50, 500),
    });
    const counts = commands.reduce(
      (acc, command) => {
        acc[command.state] = (acc[command.state] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    return reply
      .code(200)
      .send({ commands, counts, machineId, targetVersion: buildTargetVersion(target.openclawDir) });
  }
);

app.post(
  '/openclaw/targets/:targetId/control/commands/:commandId/approve',
  async (
    request: FastifyRequest<{ Params: { targetId: string; commandId: string }; Body: unknown }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const bodyTargetId =
      typeof request.body.targetId === 'string' ? request.body.targetId : request.params.targetId;
    if (bodyTargetId !== request.params.targetId) {
      return reply.code(409).send({ error: 'target_mismatch' });
    }
    const bodyTargetVersion =
      typeof request.body.targetVersion === 'string' ? request.body.targetVersion : '';
    if (!bodyTargetVersion) return reply.code(400).send({ error: 'targetVersion_required' });
    const currentVersion = buildTargetVersion(target.openclawDir);
    if (currentVersion !== bodyTargetVersion) {
      return reply.code(409).send({ error: 'target_version_mismatch', currentVersion });
    }
    const approvedBy =
      typeof request.body.approvedBy === 'string' && request.body.approvedBy.length > 0
        ? request.body.approvedBy
        : 'ui';
    const approved = bridgeCommandStore.approve({
      commandId: request.params.commandId,
      targetId: request.params.targetId,
      targetVersion: bodyTargetVersion,
      approvedBy,
    });
    if (!approved) {
      return reply.code(404).send({ error: 'command_not_found_or_mismatch' });
    }
    broadcastSse({
      kind: 'bridge-command-updated',
      payload: { targetId: request.params.targetId, commandId: approved.id, state: approved.state },
    });
    return reply.code(200).send({ command: approved });
  }
);

app.post('/openclaw/bridge/commands/poll', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
  const machineId = typeof request.body.machineId === 'string' ? request.body.machineId.trim() : '';
  if (!machineId) return reply.code(400).send({ error: 'machineId_required' });
  const leaseTtlMs = parsePositiveInt(
    typeof request.body.leaseTtlMs === 'number' ? String(request.body.leaseTtlMs) : undefined,
    30_000,
    300_000
  );
  const leased = bridgeCommandStore.poll({ machineId, leaseTtlMs });
  if (!leased) return reply.code(200).send({ available: false });
  return reply.code(200).send({ available: true, command: leased });
});

app.post(
  '/openclaw/bridge/commands/:commandId/ack',
  async (request: FastifyRequest<{ Params: { commandId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const machineId =
      typeof request.body.machineId === 'string' ? request.body.machineId.trim() : '';
    if (!machineId) return reply.code(400).send({ error: 'machineId_required' });
    const ack = bridgeCommandStore.ackRunning(request.params.commandId, machineId);
    if (!ack) return reply.code(409).send({ error: 'invalid_transition' });
    return reply.code(200).send({ command: ack });
  }
);

app.post(
  '/openclaw/bridge/commands/:commandId/heartbeat',
  async (request: FastifyRequest<{ Params: { commandId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const machineId =
      typeof request.body.machineId === 'string' ? request.body.machineId.trim() : '';
    if (!machineId) return reply.code(400).send({ error: 'machineId_required' });
    const leaseTtlMs = parsePositiveInt(
      typeof request.body.leaseTtlMs === 'number' ? String(request.body.leaseTtlMs) : undefined,
      30_000,
      300_000
    );
    const renewed = bridgeCommandStore.renewLease(request.params.commandId, machineId, leaseTtlMs);
    if (!renewed) return reply.code(409).send({ error: 'invalid_transition' });
    return reply.code(200).send({ command: renewed });
  }
);

app.post(
  '/openclaw/bridge/commands/:commandId/result',
  async (request: FastifyRequest<{ Params: { commandId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isRecord(request.body) || !isRecord(request.body.result)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const machineId =
      typeof request.body.machineId === 'string' ? request.body.machineId.trim() : '';
    if (!machineId) return reply.code(400).send({ error: 'machineId_required' });

    const resultBody = request.body.result;
    const status =
      resultBody.status === 'succeeded' || resultBody.status === 'failed'
        ? resultBody.status
        : null;
    if (!status) return reply.code(400).send({ error: 'invalid_result_status' });

    const stdoutSanitized = sanitizeOutput(
      typeof resultBody.stdout === 'string' ? resultBody.stdout : '',
      32 * 1024
    );
    const stderrSanitized = sanitizeOutput(
      typeof resultBody.stderr === 'string' ? resultBody.stderr : '',
      32 * 1024
    );
    const result: BridgeCommandResult = {
      status,
      exitCode: typeof resultBody.exitCode === 'number' ? resultBody.exitCode : 1,
      durationMs: typeof resultBody.durationMs === 'number' ? resultBody.durationMs : 0,
      stdout: stdoutSanitized.text,
      stderr: stderrSanitized.text,
      truncated:
        stdoutSanitized.truncated ||
        stderrSanitized.truncated ||
        Boolean(resultBody.truncated === true),
      ...(typeof resultBody.artifact === 'string' ? { artifact: resultBody.artifact } : {}),
      ...(resultBody.duplicate === true ? { duplicate: true } : {}),
    };

    const updated = bridgeCommandStore.pushResult(request.params.commandId, machineId, result);
    if (!updated) return reply.code(409).send({ error: 'invalid_transition' });
    broadcastSse({
      kind: 'bridge-command-updated',
      payload: {
        targetId: updated.snapshot.targetId,
        commandId: updated.id,
        state: updated.state,
        machineId,
      },
    });
    return reply.code(200).send({ command: updated });
  }
);

// ── Command Queue ──

app.post('/openclaw/queue', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

  const targetId = typeof request.body.targetId === 'string' ? request.body.targetId : '';
  if (!targetId) return reply.code(400).send({ error: 'targetId is required' });

  const target = openclawTargetStore.get(targetId);
  if (!target) return reply.code(404).send({ error: 'target_not_found' });

  const ALLOWED_COMMANDS = new Set(['openclaw']);
  const commands = Array.isArray(request.body.commands) ? request.body.commands : [];
  const parsed: { command: string; args: readonly string[]; description: string }[] = [];
  for (const cmd of commands) {
    if (!isRecord(cmd)) continue;
    const command = typeof cmd.command === 'string' ? cmd.command : 'openclaw';
    if (!ALLOWED_COMMANDS.has(command)) {
      return reply.code(400).send({ error: `Disallowed command: ${command}` });
    }
    const args = Array.isArray(cmd.args)
      ? cmd.args.filter((a: unknown): a is string => typeof a === 'string')
      : [];
    parsed.push({
      command,
      args,
      description: typeof cmd.description === 'string' ? cmd.description : '',
    });
  }
  if (parsed.length === 0) return reply.code(400).send({ error: 'No valid commands' });

  const state = commandQueue.queue(targetId, target.openclawDir, parsed);
  return reply.code(200).send(state);
});

app.get(
  '/openclaw/queue/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.code(200).send(commandQueue.getState(request.params.targetId));
  }
);

app.post(
  '/openclaw/queue/:targetId/preview',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const diff = await commandQueue.preview(request.params.targetId);
    if (!diff) return reply.code(200).send({ available: false, diff: null });
    return reply.code(200).send({ available: true, diff });
  }
);

app.post(
  '/openclaw/queue/:targetId/apply',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const source =
      isRecord(request.body) && typeof request.body.source === 'string'
        ? request.body.source
        : 'manual';
    const op = startOperation(
      'queue-apply',
      `Apply queued OpenClaw commands (${source})`,
      request.params.targetId
    );
    const result = await commandQueue.apply(request.params.targetId, source);
    if (!result.ok) {
      finishOperation(op.operationId, 'failed', 'Queued command apply failed', result.error);
      return reply.code(422).send({ ...result, operationId: op.operationId });
    }
    finishOperation(op.operationId, 'succeeded', 'Queued command apply succeeded');
    broadcastSse({ kind: 'config-changed', payload: { targetId: request.params.targetId } });
    return reply.code(200).send({ ...result, operationId: op.operationId });
  }
);

app.delete(
  '/openclaw/queue/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    commandQueue.discard(request.params.targetId);
    return reply.code(200).send({ ok: true });
  }
);

// ── Agent CRUD (queue CLI commands) ──

app.post(
  '/openclaw/targets/:targetId/agents',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = typeof request.body.id === 'string' ? request.body.id.trim() : '';
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent id (alphanumeric, _, -)' });
    }

    const cmds: { command: string; args: string[]; description: string }[] = [];
    cmds.push({
      command: 'openclaw',
      args: ['agents', 'add', agentId, '--non-interactive'],
      description: `Create agent "${agentId}"`,
    });

    const name = typeof request.body.name === 'string' ? request.body.name : '';
    if (name) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.name`, name],
        description: `Set agent "${agentId}" name to "${name}"`,
      });
    }
    const emoji = typeof request.body.emoji === 'string' ? request.body.emoji : '';
    if (emoji) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.emoji`, emoji],
        description: `Set agent "${agentId}" emoji`,
      });
    }
    const systemPrompt =
      typeof request.body.systemPrompt === 'string' ? request.body.systemPrompt : '';
    if (systemPrompt) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.systemPrompt`, systemPrompt],
        description: `Set agent "${agentId}" system prompt`,
      });
    }
    const modelPrimary =
      isRecord(request.body.model) && typeof request.body.model.primary === 'string'
        ? request.body.model.primary
        : '';
    if (modelPrimary) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.model.primary`, modelPrimary],
        description: `Set agent "${agentId}" primary model`,
      });
    }
    if (request.body.enabled === false) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.enabled`, 'false'],
        description: `Disable agent "${agentId}"`,
      });
    }

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.patch(
  '/openclaw/targets/:targetId/agents/:agentId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; agentId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = request.params.agentId;
    if (!isValidEntityId(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });
    const cmds: { command: string; args: string[]; description: string }[] = [];
    const fieldMap: Record<string, string> = {};

    if (typeof request.body.name === 'string') fieldMap.name = request.body.name;
    if (typeof request.body.emoji === 'string') fieldMap.emoji = request.body.emoji;
    if (typeof request.body.systemPrompt === 'string')
      fieldMap.systemPrompt = request.body.systemPrompt;
    if (typeof request.body.enabled === 'boolean') fieldMap.enabled = String(request.body.enabled);

    for (const [field, value] of Object.entries(fieldMap)) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.${field}`, value],
        description: `Update agent "${agentId}" ${field}`,
      });
    }

    if (isRecord(request.body.model)) {
      if (typeof request.body.model.primary === 'string') {
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${agentId}.model.primary`, request.body.model.primary],
          description: `Update agent "${agentId}" primary model`,
        });
      }
      if (typeof request.body.model.fallback === 'string') {
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${agentId}.model.fallback`, request.body.model.fallback],
          description: `Update agent "${agentId}" fallback model`,
        });
      }
    }

    if (cmds.length === 0) return reply.code(400).send({ error: 'No changes' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.delete(
  '/openclaw/targets/:targetId/agents/:agentId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; agentId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isValidEntityId(request.params.agentId))
      return reply.code(400).send({ error: 'Invalid agent id' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, [
      {
        command: 'openclaw',
        args: ['agents', 'remove', request.params.agentId],
        description: `Remove agent "${request.params.agentId}"`,
      },
    ]);
    return reply.code(200).send({ queued: true, state });
  }
);

interface ParsedModelRef {
  readonly provider: string;
  readonly modelId: string;
}

function isValidModelToken(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function parseModelRef(value: string): ParsedModelRef | null {
  const [providerRaw, modelRaw] = value.split('/');
  const provider = providerRaw?.trim() ?? '';
  const modelId = modelRaw?.trim() ?? '';
  if (!provider || !modelId) return null;
  if (!isValidModelToken(provider) || !isValidModelToken(modelId)) return null;
  return { provider, modelId };
}

function loadMutableOpenClawConfig(openclawDirPath: string): {
  configPath: string;
  config: Record<string, unknown>;
} {
  const candidates = resolveOpenClawConfigCandidates(openclawDirPath);
  const configPath = candidates.find((candidate) => exists(candidate)) ?? candidates[0]!;
  let config: Record<string, unknown> = {};
  if (exists(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8').trim();
      if (raw.length > 0) {
        const parsed = JSON.parse(raw) as unknown;
        if (isRecord(parsed)) {
          config = { ...parsed };
        }
      }
    } catch {
      config = {};
    }
  }
  return { configPath, config };
}

function saveMutableOpenClawConfig(
  configPath: string,
  config: Readonly<Record<string, unknown>>
): void {
  const dir = path.dirname(configPath);
  if (!exists(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

function ensureMutableRecord(
  parent: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const current = parent[key];
  if (isRecord(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function ensureMutableArray(parent: Record<string, unknown>, key: string): unknown[] {
  const current = parent[key];
  if (Array.isArray(current)) {
    return [...current];
  }
  const next: unknown[] = [];
  parent[key] = next;
  return next;
}

function setOrUnsetProviderField(
  providerConfig: Record<string, unknown>,
  key: 'baseUrl' | 'apiKey',
  value: unknown
): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete providerConfig[key];
    return;
  }
  providerConfig[key] = trimmed;
}

// ── Model Profiles CRUD ──

app.post(
  '/openclaw/targets/:targetId/models',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const parsedFromId =
      typeof request.body.id === 'string' ? parseModelRef(request.body.id.trim()) : null;
    const provider =
      typeof request.body.provider === 'string'
        ? request.body.provider.trim()
        : (parsedFromId?.provider ?? '');
    const modelId =
      typeof request.body.model === 'string'
        ? request.body.model.trim()
        : (parsedFromId?.modelId ?? '');
    if (!provider || !modelId || !isValidModelToken(provider) || !isValidModelToken(modelId)) {
      return reply.code(400).send({ error: 'invalid_model_reference' });
    }
    const modelName = typeof request.body.name === 'string' ? request.body.name.trim() : '';
    const enabled = request.body.enabled !== false;

    const { configPath, config } = loadMutableOpenClawConfig(target.openclawDir);
    const modelsRoot = ensureMutableRecord(config, 'models');
    if (typeof modelsRoot.mode !== 'string' || modelsRoot.mode.trim().length === 0) {
      modelsRoot.mode = 'merge';
    }
    const providersRoot = ensureMutableRecord(modelsRoot, 'providers');
    const providerConfig = ensureMutableRecord(providersRoot, provider);
    const currentModels = ensureMutableArray(providerConfig, 'models');
    const alreadyExists = currentModels.some(
      (entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id === modelId
    );
    if (alreadyExists) {
      return reply.code(409).send({ error: 'model_already_exists' });
    }

    const nextModel: Record<string, unknown> = {
      id: modelId,
      name: modelName.length > 0 ? modelName : `${provider}/${modelId}`,
      enabled,
    };
    providerConfig.models = [...currentModels, nextModel];
    setOrUnsetProviderField(providerConfig, 'baseUrl', request.body.baseUrl);
    setOrUnsetProviderField(providerConfig, 'apiKey', request.body.apiKey);
    saveMutableOpenClawConfig(configPath, config);

    return reply.code(200).send({ ok: true });
  }
);

app.patch(
  '/openclaw/targets/:targetId/models/:modelId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; modelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const modelRef = parseModelRef(request.params.modelId);
    if (!modelRef) {
      return reply.code(400).send({ error: 'invalid_model_reference' });
    }
    const { configPath, config } = loadMutableOpenClawConfig(target.openclawDir);
    const modelsRoot = ensureMutableRecord(config, 'models');
    const providersRoot = ensureMutableRecord(modelsRoot, 'providers');
    const sourceProviderConfig = ensureMutableRecord(providersRoot, modelRef.provider);
    const sourceModels = ensureMutableArray(sourceProviderConfig, 'models');
    const sourceIndex = sourceModels.findIndex(
      (entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id === modelRef.modelId
    );
    if (sourceIndex === -1) {
      return reply.code(404).send({ error: 'model_not_found' });
    }
    const existingEntryRaw = sourceModels[sourceIndex];
    if (!isRecord(existingEntryRaw)) {
      return reply.code(404).send({ error: 'model_not_found' });
    }
    const existingEntry: Record<string, unknown> = { ...existingEntryRaw };

    const nextProvider =
      typeof request.body.provider === 'string' && request.body.provider.trim().length > 0
        ? request.body.provider.trim()
        : modelRef.provider;
    const nextModelId =
      typeof request.body.model === 'string' && request.body.model.trim().length > 0
        ? request.body.model.trim()
        : modelRef.modelId;
    if (!isValidModelToken(nextProvider) || !isValidModelToken(nextModelId)) {
      return reply.code(400).send({ error: 'invalid_model_reference' });
    }

    if (typeof request.body.name === 'string') {
      const trimmed = request.body.name.trim();
      existingEntry.name = trimmed.length > 0 ? trimmed : `${nextProvider}/${nextModelId}`;
    }
    if (typeof request.body.enabled === 'boolean') {
      existingEntry.enabled = request.body.enabled;
    }
    existingEntry.id = nextModelId;

    const nextProviderConfig = ensureMutableRecord(providersRoot, nextProvider);
    const nextProviderModels = ensureMutableArray(nextProviderConfig, 'models');
    const duplicateInTargetProvider = nextProviderModels.some(
      (entry, index) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        entry.id === nextModelId &&
        !(nextProvider === modelRef.provider && index === sourceIndex)
    );
    if (duplicateInTargetProvider) {
      return reply.code(409).send({ error: 'model_already_exists' });
    }

    sourceProviderConfig.models = sourceModels.filter((_, index) => index !== sourceIndex);
    if (nextProvider === modelRef.provider) {
      const updatedModels = ensureMutableArray(sourceProviderConfig, 'models');
      updatedModels.splice(sourceIndex, 0, existingEntry);
      sourceProviderConfig.models = updatedModels;
      setOrUnsetProviderField(sourceProviderConfig, 'baseUrl', request.body.baseUrl);
      setOrUnsetProviderField(sourceProviderConfig, 'apiKey', request.body.apiKey);
    } else {
      nextProviderConfig.models = [...nextProviderModels, existingEntry];
      setOrUnsetProviderField(nextProviderConfig, 'baseUrl', request.body.baseUrl);
      setOrUnsetProviderField(nextProviderConfig, 'apiKey', request.body.apiKey);
    }

    saveMutableOpenClawConfig(configPath, config);
    return reply.code(200).send({ ok: true });
  }
);

app.delete(
  '/openclaw/targets/:targetId/models/:modelId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; modelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const modelRef = parseModelRef(request.params.modelId);
    if (!modelRef) {
      return reply.code(400).send({ error: 'invalid_model_reference' });
    }
    const { configPath, config } = loadMutableOpenClawConfig(target.openclawDir);
    const modelsRoot = ensureMutableRecord(config, 'models');
    const providersRoot = ensureMutableRecord(modelsRoot, 'providers');
    const providerConfig = ensureMutableRecord(providersRoot, modelRef.provider);
    const providerModels = ensureMutableArray(providerConfig, 'models');
    const nextModels = providerModels.filter(
      (entry) => !(isRecord(entry) && typeof entry.id === 'string' && entry.id === modelRef.modelId)
    );
    if (nextModels.length === providerModels.length) {
      return reply.code(404).send({ error: 'model_not_found' });
    }
    providerConfig.models = nextModels;
    saveMutableOpenClawConfig(configPath, config);
    return reply.code(200).send({ ok: true });
  }
);

app.post(
  '/openclaw/targets/:targetId/models/default',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const primaryModelRef =
      typeof request.body.primary === 'string' ? request.body.primary.trim() : '';
    if (!parseModelRef(primaryModelRef)) {
      return reply.code(400).send({ error: 'invalid_model_reference' });
    }
    const { configPath, config } = loadMutableOpenClawConfig(target.openclawDir);
    const agentsRoot = ensureMutableRecord(config, 'agents');
    const defaultsRoot = ensureMutableRecord(agentsRoot, 'defaults');
    const modelDefaultsRoot = ensureMutableRecord(defaultsRoot, 'model');
    modelDefaultsRoot.primary = primaryModelRef;
    saveMutableOpenClawConfig(configPath, config);
    return reply.code(200).send({ ok: true });
  }
);

// ── Channel Config CRUD ──

app.patch(
  '/openclaw/targets/:targetId/channels/:channelId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; channelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const channelId = request.params.channelId;
    if (!isValidEntityId(channelId)) return reply.code(400).send({ error: 'Invalid channel id' });
    const cmds: { command: string; args: string[]; description: string }[] = [];

    if (typeof request.body.enabled === 'boolean') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.enabled`, String(request.body.enabled)],
        description: `${request.body.enabled ? 'Enable' : 'Disable'} channel "${channelId}"`,
      });
    }
    if (typeof request.body.dmPolicy === 'string') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.dmPolicy`, request.body.dmPolicy],
        description: `Set channel "${channelId}" DM policy`,
      });
    }
    if (typeof request.body.groupPolicy === 'string') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.groupPolicy`, request.body.groupPolicy],
        description: `Set channel "${channelId}" group policy`,
      });
    }
    if (typeof request.body.modelOverride === 'string') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.model`, request.body.modelOverride],
        description: `Set channel "${channelId}" model override`,
      });
    }

    if (cmds.length === 0) return reply.code(400).send({ error: 'No changes' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.post(
  '/openclaw/targets/:targetId/channels/:channelId/bind',
  async (
    request: FastifyRequest<{ Params: { targetId: string; channelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = typeof request.body.agentId === 'string' ? request.body.agentId : '';
    if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
    if (!isValidEntityId(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });

    const channelId = request.params.channelId;
    if (!isValidEntityId(channelId)) return reply.code(400).send({ error: 'Invalid channel id' });
    const cmds: { command: string; args: string[]; description: string }[] = [
      {
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.agents.+`, agentId],
        description: `Bind agent "${agentId}" to channel "${channelId}"`,
      },
    ];

    const modelOverride =
      typeof request.body.modelOverride === 'string' ? request.body.modelOverride : '';
    if (modelOverride) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.model`, modelOverride],
        description: `Set model override for binding on "${channelId}"`,
      });
    }

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.post(
  '/openclaw/targets/:targetId/channels/:channelId/unbind',
  async (
    request: FastifyRequest<{ Params: { targetId: string; channelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = typeof request.body.agentId === 'string' ? request.body.agentId : '';
    if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
    if (!isValidEntityId(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });

    const channelId = request.params.channelId;
    if (!isValidEntityId(channelId)) return reply.code(400).send({ error: 'Invalid channel id' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, [
      {
        command: 'openclaw',
        args: ['config', 'unset', `channels.${channelId}.agents.${agentId}`],
        description: `Unbind agent "${agentId}" from channel "${channelId}"`,
      },
    ]);
    return reply.code(200).send({ queued: true, state });
  }
);

// ── Config Snapshots ──

app.get(
  '/openclaw/targets/:targetId/config-snapshots',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const snapshots = commandQueue.listSnapshots(request.params.targetId);
    return reply.code(200).send({ snapshots });
  }
);

app.get(
  '/openclaw/targets/:targetId/config-snapshots/:snapId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; snapId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const snap = commandQueue.getSnapshot(request.params.targetId, request.params.snapId);
    if (!snap) return reply.code(404).send({ error: 'snapshot_not_found' });
    return reply.code(200).send({ snapshot: snap });
  }
);

app.post(
  '/openclaw/targets/:targetId/config-snapshots/:snapId/rollback',
  async (
    request: FastifyRequest<{ Params: { targetId: string; snapId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const beforeConfig = readRawConfigString(target.openclawDir);
    if (beforeConfig) {
      await commandQueue.createSnapshot(
        request.params.targetId,
        beforeConfig,
        'rollback',
        `Before rollback to ${request.params.snapId}`
      );
    }

    const op = startOperation(
      'recipe-rollback',
      `Rollback config to ${request.params.snapId}`,
      request.params.targetId
    );
    const result = await commandQueue.rollbackToSnapshot(request.params.snapId, target.openclawDir);
    if (result.ok) {
      finishOperation(
        op.operationId,
        'succeeded',
        `Rollback to ${request.params.snapId} succeeded`
      );
      broadcastSse({ kind: 'config-changed', payload: { targetId: request.params.targetId } });
    } else {
      finishOperation(op.operationId, 'failed', 'Rollback failed', result.error);
    }
    return reply.code(result.ok ? 200 : 422).send({ ...result, operationId: op.operationId });
  }
);

function normalizeVersionParts(input: string): [number, number, number] {
  const normalized = input.trim().replace(/^v/i, '');
  const [majorRaw, minorRaw, patchRaw] = normalized.split('.');
  const major = Number(majorRaw ?? '0');
  const minor = Number(minorRaw ?? '0');
  const patch = Number((patchRaw ?? '0').split('-')[0] ?? '0');
  return [
    Number.isFinite(major) ? major : 0,
    Number.isFinite(minor) ? minor : 0,
    Number.isFinite(patch) ? patch : 0,
  ];
}

function compareVersions(left: string, right: string): number {
  const a = normalizeVersionParts(left);
  const b = normalizeVersionParts(right);
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

function resolveRecipeSteps(
  recipe: ExtendedRecipeDefinition,
  params: Readonly<Record<string, unknown>>
): ReadonlyArray<{ action: string; label: string; args: Readonly<Record<string, string>> }> {
  return recipe.steps.map((step) => {
    const resolvedArgs: Record<string, string> = {};
    for (const [key, template] of Object.entries(step.args)) {
      let resolved = template;
      for (const [paramId, paramValue] of Object.entries(params)) {
        resolved = resolved.replaceAll(`{{${paramId}}}`, String(paramValue));
      }
      resolvedArgs[key] = resolved;
    }
    return { ...step, args: resolvedArgs };
  });
}

async function validateRecipeRequest(
  recipe: ExtendedRecipeDefinition,
  params: Readonly<Record<string, unknown>>
): Promise<{ ok: true } | { ok: false; errors: readonly string[] }> {
  const errors: string[] = [];
  for (const param of recipe.params) {
    const value = params[param.id];
    const asString = value === undefined || value === null ? '' : String(value).trim();
    if (param.required && asString.length === 0) {
      errors.push(`Missing required param "${param.id}".`);
    }
  }
  const SAFE_PARAM_RE = /^[a-zA-Z0-9_.@:/ -]*$/;
  for (const [key, value] of Object.entries(params)) {
    const strValue = String(value);
    if (!SAFE_PARAM_RE.test(strValue)) {
      errors.push(`Invalid characters in param "${key}".`);
    }
  }
  if (recipe.compatibility) {
    const cli = await checkOpenClawCli();
    if (!cli.available || !cli.version) {
      errors.push('OpenClaw CLI version is unavailable for compatibility check.');
    } else {
      const minVersion = recipe.compatibility.minOpenClawVersion;
      const maxVersion = recipe.compatibility.maxOpenClawVersion;
      if (minVersion && compareVersions(cli.version, minVersion) < 0) {
        errors.push(`OpenClaw version ${cli.version} is lower than required ${minVersion}.`);
      }
      if (maxVersion && compareVersions(cli.version, maxVersion) > 0) {
        errors.push(`OpenClaw version ${cli.version} is higher than supported ${maxVersion}.`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

// ── Recipes ──

import { BUILT_IN_RECIPES } from './recipes/built-in.js';

app.get('/recipes', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  return reply.code(200).send({ recipes: BUILT_IN_RECIPES });
});

app.get(
  '/recipes/:recipeId',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId) as
      | ExtendedRecipeDefinition
      | undefined;
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    return reply.code(200).send({ recipe });
  }
);

app.post(
  '/recipes/:recipeId/resolve',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId) as
      | ExtendedRecipeDefinition
      | undefined;
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const params = isRecord(request.body.params) ? request.body.params : {};
    const validation = await validateRecipeRequest(recipe, params);
    if (!validation.ok) {
      return reply.code(422).send({ ok: false, errors: validation.errors });
    }
    const resolvedSteps = resolveRecipeSteps(recipe, params);
    const commands: OpenClawCommandInput[] = resolvedSteps.map((step) => ({
      command: 'openclaw',
      args: Object.values(step.args),
      description: step.label,
    }));

    return reply.code(200).send({ steps: resolvedSteps, commands });
  }
);

app.post(
  '/recipes/:recipeId/validate',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId) as
      | ExtendedRecipeDefinition
      | undefined;
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const params = isRecord(request.body.params) ? request.body.params : {};
    const validation = await validateRecipeRequest(recipe, params);
    if (!validation.ok) {
      return reply.code(422).send({
        ok: false,
        errors: validation.errors,
        requiresConfirm: recipe.requiresConfirm === true,
        riskLevel: recipe.riskLevel ?? 'medium',
      });
    }
    return reply.code(200).send({
      ok: true,
      requiresConfirm: recipe.requiresConfirm === true,
      riskLevel: recipe.riskLevel ?? 'medium',
    });
  }
);

app.post(
  '/recipes/:recipeId/preview',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId) as
      | ExtendedRecipeDefinition
      | undefined;
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const params = isRecord(request.body.params) ? request.body.params : {};
    const targetId = typeof request.body.targetId === 'string' ? request.body.targetId : '';
    if (!targetId) return reply.code(400).send({ error: 'targetId is required' });
    const target = openclawTargetStore.get(targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const validation = await validateRecipeRequest(recipe, params);
    if (!validation.ok) {
      return reply.code(422).send({ ok: false, errors: validation.errors });
    }

    const resolvedSteps = resolveRecipeSteps(recipe, params);
    const commands: OpenClawCommandInput[] = resolvedSteps.map((step) => ({
      command: 'openclaw',
      args: Object.values(step.args),
      description: step.label,
    }));
    const diff = await commandQueue.previewCommands(target.openclawDir, commands);
    return reply.code(200).send({ ok: true, steps: resolvedSteps, commands, diff });
  }
);

app.post(
  '/recipes/:recipeId/apply',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId) as
      | ExtendedRecipeDefinition
      | undefined;
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });
    const params = isRecord(request.body.params) ? request.body.params : {};
    const targetId = typeof request.body.targetId === 'string' ? request.body.targetId : '';
    if (!targetId) return reply.code(400).send({ error: 'targetId is required' });
    const target = openclawTargetStore.get(targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const validation = await validateRecipeRequest(recipe, params);
    if (!validation.ok) {
      return reply.code(422).send({ ok: false, errors: validation.errors });
    }

    const resolvedSteps = resolveRecipeSteps(recipe, params);
    const commands: OpenClawCommandInput[] = resolvedSteps.map((step) => ({
      command: 'openclaw',
      args: Object.values(step.args),
      description: step.label,
    }));
    const op = startOperation('recipe-apply', `Apply recipe ${recipe.id}`, targetId);
    const result = await commandQueue.applyCommands(
      targetId,
      target.openclawDir,
      commands,
      `recipe:${recipe.id}`
    );
    if (!result.ok) {
      finishOperation(op.operationId, 'failed', `Recipe ${recipe.id} failed`, result.error);
      return reply.code(422).send({ ...result, operationId: op.operationId });
    }
    finishOperation(op.operationId, 'succeeded', `Recipe ${recipe.id} applied`);
    broadcastSse({ kind: 'config-changed', payload: { targetId } });
    return reply.code(200).send({
      ok: true,
      snapshotId: result.snapshotId,
      operationId: op.operationId,
      steps: resolvedSteps,
    });
  }
);

// ── File Manager (SFTP) ─────────────────────────────────────────────

function validateAbsolutePath(p: string): boolean {
  if (!p || !p.startsWith('/')) return false;
  const normalized = path.posix.normalize(p);
  if (normalized !== p && normalized !== p.replace(/\/+$/, '')) {
    return false;
  }
  if (normalized.includes('/../') || normalized.endsWith('/..') || normalized === '/..') {
    return false;
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') return false;
  }
  return true;
}

app.get('/files/connections', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  const connections = await sftpSessionManager.getConnections();
  return reply.code(200).send(connections);
});

app.post(
  '/files/connections',
  async (
    request: FastifyRequest<{
      Body: Omit<CustomSshConnection, 'id'>;
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const { label, host, port: sshPort, user, keyPath } = request.body;
    if (!host || !user || !keyPath) {
      return reply.code(400).send({ error: 'host, user, and keyPath are required' });
    }
    if (!isPathUnderSshDir(keyPath)) {
      return reply.code(403).send({ error: 'SSH key path must be under ~/.ssh/' });
    }
    const conn = await sftpSessionManager.addCustomConnection({
      label: label || `${user}@${host}`,
      host,
      port: sshPort || 22,
      user,
      keyPath,
    });
    return reply.code(201).send(conn);
  }
);

app.delete(
  '/files/connections/:id',
  async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const removed = await sftpSessionManager.removeCustomConnection(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'connection not found' });
    return reply.code(200).send({ ok: true });
  }
);

app.get(
  '/files/:connId/ls',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path || '/';
    if (!validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    async function readDirEntries() {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      return new Promise<
        Array<{
          filename: string;
          longname: string;
          attrs: { size: number; mtime: number; mode: number; uid: number; gid: number };
        }>
      >((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
          if (err) return reject(err);
          resolve(list as never);
        });
      });
    }

    try {
      let entries: Array<{
        filename: string;
        longname: string;
        attrs: { size: number; mtime: number; mode: number; uid: number; gid: number };
      }>;
      try {
        entries = await readDirEntries();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.trim().toLowerCase() !== 'failure') {
          throw err;
        }
        // ssh2 may return generic "Failure" when the cached SFTP handle is stale.
        sftpSessionManager.closeSession(request.params.connId);
        entries = await readDirEntries();
      }

      const files = entries
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map((e) => {
          const isDir = (e.attrs.mode & 0o40000) !== 0;
          const isLink = (e.attrs.mode & 0o120000) === 0o120000;
          const perms = (e.attrs.mode & 0o7777).toString(8).padStart(4, '0');
          return {
            name: e.filename,
            type: isLink ? 'symlink' : isDir ? 'directory' : 'file',
            size: e.attrs.size,
            mtime: e.attrs.mtime * 1000,
            permissions: perms,
          };
        })
        .sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name);
        });

      return reply.code(200).send({ path: remotePath, entries: files });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.get(
  '/files/:connId/stat',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path || '/';
    if (!validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      const attrs = await new Promise<{
        size: number;
        mtime: number;
        mode: number;
        uid: number;
        gid: number;
      }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });

      const isDir = (attrs.mode & 0o40000) !== 0;
      return reply.code(200).send({
        path: remotePath,
        type: isDir ? 'directory' : 'file',
        size: attrs.size,
        mtime: attrs.mtime * 1000,
        permissions: (attrs.mode & 0o7777).toString(8).padStart(4, '0'),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.get(
  '/files/:connId/download',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path;
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);

      const attrs = await new Promise<{ size: number }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });

      const basename = path.basename(remotePath);
      void reply.header('Content-Type', 'application/octet-stream');
      void reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(basename)}"`
      );
      void reply.header('Content-Length', attrs.size);

      const stream = sftp.createReadStream(remotePath);
      return reply.send(stream);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.get(
  '/files/:connId/download-folder',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path;
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      const rootStats = await new Promise<{ mode: number }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });
      const isDir = (rootStats.mode & 0o40000) !== 0;
      if (!isDir) {
        return reply.code(400).send({ error: 'Path is not a directory' });
      }

      const normalized = remotePath.replace(/\/+$/, '') || '/';
      const baseName = path.posix.basename(normalized);
      const folderName = baseName === '/' ? 'root' : baseName;
      const zipName = `${folderName}.zip`;

      void reply.header('Content-Type', 'application/zip');
      void reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(zipName)}"`
      );

      reply.hijack();
      const archive = archiver('zip', { zlib: { level: 6 } });
      const responseRaw = reply.raw;
      responseRaw.on('close', () => {
        void archive.abort();
      });
      archive.on('error', (err: unknown) => {
        responseRaw.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      archive.pipe(responseRaw);

      async function walkDir(remoteDir: string, zipPrefix: string): Promise<void> {
        const entries = await new Promise<
          Array<{
            filename: string;
            attrs: { mode: number };
          }>
        >((resolve, reject) => {
          sftp.readdir(remoteDir, (err, list) => {
            if (err) return reject(err);
            resolve(list as never);
          });
        });

        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          const childRemotePath = path.posix.join(remoteDir, entry.filename);
          const childZipPath = `${zipPrefix}/${entry.filename}`;
          const mode = entry.attrs.mode;
          const childTypeBits = mode & 0o170000;
          const childIsDir = childTypeBits === 0o040000;
          const childIsSymlink = childTypeBits === 0o120000;
          const childIsRegularFile = childTypeBits === 0o100000;
          if (childIsSymlink) {
            continue;
          }
          if (childIsDir) {
            archive.append('', { name: `${childZipPath}/` });
            await walkDir(childRemotePath, childZipPath);
            continue;
          }
          // Skip special filesystem entries (FIFO/socket/device) to avoid hanging streams.
          if (!childIsRegularFile) {
            continue;
          }
          const fileStream = sftp.createReadStream(childRemotePath);
          fileStream.on('error', (err: unknown) => {
            archive.emit('error', err);
          });
          archive.append(fileStream, { name: childZipPath });
        }
      }

      archive.append('', { name: `${folderName}/` });
      await walkDir(remotePath, folderName);
      await archive.finalize();
      return;
    } catch (err: unknown) {
      if (!reply.sent) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: msg });
      }
      return;
    }
  }
);

app.post(
  '/files/:connId/upload',
  async (request: FastifyRequest<{ Params: { connId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      const parts = request.parts();
      let remotePath = '/tmp';
      const uploaded: string[] = [];

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'remotePath') {
          remotePath = String(part.value);
          if (!validateAbsolutePath(remotePath)) {
            return reply.code(400).send({ error: 'Invalid remotePath' });
          }
          continue;
        }
        if (part.type === 'file') {
          const safeName = path.posix.basename(part.filename);
          if (!safeName || safeName === '.' || safeName === '..') {
            return reply.code(400).send({ error: 'Invalid filename' });
          }
          const destPath = path.posix.join(remotePath, safeName);
          await new Promise<void>((resolve, reject) => {
            const writeStream = sftp.createWriteStream(destPath);
            part.file.pipe(writeStream);
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
            part.file.on('error', reject);
          });
          uploaded.push(destPath);
        }
      }

      return reply.code(200).send({ ok: true, uploaded });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.post(
  '/files/:connId/mkdir',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Body: { path: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = request.body.path;
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      return reply.code(201).send({ ok: true, path: remotePath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.post(
  '/files/:connId/rename',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Body: { oldPath: string; newPath: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const { oldPath, newPath } = request.body;
    if (!validateAbsolutePath(oldPath) || !validateAbsolutePath(newPath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      await new Promise<void>((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      return reply.code(200).send({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.delete(
  '/files/:connId/rm',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string; recursive?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path;
    const recursive = (request.query as { recursive?: string }).recursive === 'true';
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);

      const attrs = await new Promise<{ mode: number }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });

      const isDir = (attrs.mode & 0o40000) !== 0;

      if (isDir) {
        if (recursive) {
          await removeDirRecursive(sftp, remotePath);
        } else {
          await new Promise<void>((resolve, reject) => {
            sftp.rmdir(remotePath, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(remotePath, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      }

      return reply.code(200).send({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

async function removeDirRecursive(
  sftp: Awaited<ReturnType<typeof sftpSessionManager.getSftp>>,
  dirPath: string
): Promise<void> {
  const entries = await new Promise<Array<{ filename: string; attrs: { mode: number } }>>(
    (resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        resolve(list as never);
      });
    }
  );

  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    const fullPath = path.posix.join(dirPath, entry.filename);
    const isDir = (entry.attrs.mode & 0o40000) !== 0;
    if (isDir) {
      await removeDirRecursive(sftp, fullPath);
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(fullPath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(dirPath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ── Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down gracefully…`);
  cronService.stop();
  openclawSyncManager.stopAll();
  sftpSessionManager.closeAll();
  await bridgeSetupManager.closeAll();
  clearInterval(heartbeatChecker);
  await orchestrator.close();
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  app.log.error({ err: error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection');
});

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
