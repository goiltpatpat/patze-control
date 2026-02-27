/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeSetupManager, type BridgeSetupInput } from './bridge-setup-manager.js';

function createManager(): any {
  return new BridgeSetupManager({ localPort: 9700 }) as any;
}

function createInput(): BridgeSetupInput {
  return {
    label: 'vps-a',
    sshHost: 'example.com',
    sshPort: 22,
    sshUser: 'root',
    sshKeyPath: '~/.ssh/id_rsa',
    authToken: 'token',
    remotePort: 19700,
  };
}

function createActiveBridge(installMode: 'system' | 'user'): any {
  return {
    id: 'bridge_example_22',
    label: 'vps-a',
    sshHost: 'example.com',
    sshUser: 'root',
    sshPort: 22,
    remotePort: 19700,
    client: {},
    status: 'installing',
    error: undefined,
    logs: [],
    machineId: undefined,
    connectedAt: undefined,
    closing: false,
    installMode,
    pendingInput: undefined,
    lastInput: undefined,
    retryAttempt: 0,
    retryTimer: null,
  };
}

function createBridgeWithClientState(id: string, status: string): any {
  return {
    id,
    label: 'bridge-test',
    sshHost: 'example.com',
    sshUser: 'root',
    sshPort: 22,
    remotePort: 19700,
    client: {
      ended: false,
      end() {
        this.ended = true;
      },
    },
    status,
    error: undefined,
    logs: [],
    machineId: undefined,
    connectedAt: undefined,
    closing: false,
    installMode: 'system',
    pendingInput: undefined,
    lastInput: undefined,
    retryAttempt: 0,
    retryTimer: null,
  };
}

test('tryInstallBridge skips restart when system service unchanged', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  const input = createInput();
  const executedCommands: string[] = [];

  manager.uploadAndReplaceBridgeBundleIfChanged = async () => false;
  manager.remoteWriteConfigIfChanged = async () => false;
  manager.addLog = () => undefined;
  manager.remoteExec = async (_client: unknown, command: string) => {
    executedCommands.push(command);
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const result = await manager.tryInstallBridge(bridge, input);
  assert.equal(result, 'already_running');
  assert.equal(
    executedCommands.some((command) => command.includes('systemctl restart patze-bridge')),
    false
  );
});

test('tryInstallBridge restarts system service when config changes', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  const input = createInput();
  const executedCommands: string[] = [];

  manager.uploadAndReplaceBridgeBundleIfChanged = async () => false;
  manager.remoteWriteConfigIfChanged = async () => true;
  manager.addLog = () => undefined;
  manager.remoteExec = async (_client: unknown, command: string) => {
    executedCommands.push(command);
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.includes('sudo -n systemctl restart patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const result = await manager.tryInstallBridge(bridge, input);
  assert.equal(result, 'already_running');
  assert.equal(
    executedCommands.some((command) => command.includes('sudo -n systemctl restart patze-bridge')),
    true
  );
});

test('tryInstallBridge skips restart when user service unchanged', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('user');
  const input = createInput();
  const executedCommands: string[] = [];

  manager.uploadAndReplaceBridgeBundleIfChanged = async () => false;
  manager.remoteWriteConfigIfChanged = async () => false;
  manager.addLog = () => undefined;
  manager.remoteExec = async (_client: unknown, command: string) => {
    executedCommands.push(command);
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    if (command.includes('systemctl --user is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.trim() === 'echo $HOME') {
      return { stdout: '/home/test\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const result = await manager.tryInstallBridge(bridge, input);
  assert.equal(result, 'already_running');
  assert.equal(
    executedCommands.some((command) => command.includes('systemctl --user restart patze-bridge')),
    false
  );
});

test('tryInstallBridge asks for sudo password when system restart needs password', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  const input = createInput();

  manager.uploadAndReplaceBridgeBundleIfChanged = async () => true;
  manager.remoteWriteConfigIfChanged = async () => true;
  manager.addLog = () => undefined;
  manager.remoteExec = async (_client: unknown, command: string) => {
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (command.includes('sudo -n systemctl restart patze-bridge')) {
      return { stdout: '', stderr: 'sudo password required', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const result = await manager.tryInstallBridge(bridge, input);
  assert.equal(result, 'needs_sudo_password');
  assert.equal(bridge.status, 'needs_sudo_password');
  assert.equal(bridge.pendingInput, input);
});

test('retryInstallWithSudoPassword restarts running service and marks active', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  const input = createInput();
  bridge.status = 'needs_sudo_password';
  bridge.pendingInput = input;
  const executedCommands: string[] = [];

  manager.bridges.set(bridge.id, bridge);
  manager.addLog = () => undefined;
  manager.verifyTelemetry = async () => true;
  manager.tryGetMachineId = async () => 'machine_123';
  manager.remoteExec = async (_client: unknown, command: string) => {
    executedCommands.push(command);
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  manager.remoteExecWithStdin = async () => ({ stdout: '', stderr: '', exitCode: 0 });

  const result = await manager.retryInstallWithSudoPassword(bridge.id, 'secret');

  assert.ok(result);
  assert.equal(result?.status, 'telemetry_active');
  assert.equal(result?.machineId, 'machine_123');
  assert.equal(bridge.pendingInput, undefined);
  assert.equal(
    executedCommands.some((command) =>
      command.includes('systemctl is-active --quiet patze-bridge')
    ),
    true
  );
});

test('retryInstallWithSudoPassword falls back to user install when system install skipped', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  const input = createInput();
  bridge.status = 'needs_sudo_password';
  bridge.pendingInput = input;

  const runInstallCalls: string[] = [];
  const uploadCalls: string[] = [];
  const finishCalls: string[] = [];

  manager.bridges.set(bridge.id, bridge);
  manager.addLog = () => undefined;
  manager.remoteExec = async (_client: unknown, command: string) => {
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  manager.uploadBridgeBundle = async (_bridge: unknown, mode: 'system' | 'user') => {
    uploadCalls.push(mode);
    return mode === 'system' ? '/tmp/system.mjs' : '/tmp/user.mjs';
  };
  manager.runInstallScript = async (
    _bridge: unknown,
    _pendingInput: unknown,
    extraFlags: string,
    password?: string
  ) => {
    void password;
    runInstallCalls.push(extraFlags);
    return extraFlags.includes('--user-mode') ? 'installed' : 'skipped';
  };
  manager.finishPostInstall = async (_bridge: unknown, result: 'installed' | 'skipped') => {
    finishCalls.push(result);
  };

  const result = await manager.retryInstallWithSudoPassword(bridge.id, 'secret');

  assert.ok(result);
  assert.equal(uploadCalls.join(','), 'system,user');
  assert.equal(runInstallCalls.length, 2);
  assert.equal(runInstallCalls[0]?.includes('--sudo-pass'), true);
  assert.equal(runInstallCalls[1]?.includes('--user-mode'), true);
  assert.equal(finishCalls.join(','), 'installed');
  assert.equal(bridge.installMode, 'user');
  assert.equal(bridge.pendingInput, undefined);
});

test('retryInstallWithSudoPassword marks error when sudo restart fails', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  const input = createInput();
  bridge.status = 'needs_sudo_password';
  bridge.pendingInput = input;

  manager.bridges.set(bridge.id, bridge);
  manager.addLog = () => undefined;
  manager.remoteExec = async (_client: unknown, command: string) => {
    if (command.includes('systemctl is-active --quiet patze-bridge')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  manager.remoteExecWithStdin = async () => ({
    stdout: '',
    stderr: 'permission denied',
    exitCode: 1,
  });

  const result = await manager.retryInstallWithSudoPassword(bridge.id, 'secret');

  assert.ok(result);
  assert.equal(result?.status, 'error');
  assert.equal(result?.error, 'sudo restart failed: permission denied');
  assert.equal(bridge.pendingInput, undefined);
});

test('retryInstallUserMode runs user install and finishes post-install', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('user');
  const input = createInput();
  bridge.status = 'needs_sudo_password';
  bridge.pendingInput = input;

  const calls: string[] = [];
  manager.bridges.set(bridge.id, bridge);
  manager.addLog = () => undefined;
  manager.uploadBridgeBundle = async (_bridge: unknown, mode: 'system' | 'user') => {
    calls.push(`upload:${mode}`);
    return '/tmp/user.mjs';
  };
  manager.runInstallScript = async () => {
    calls.push('run:user');
    return 'installed';
  };
  manager.finishPostInstall = async (_bridge: unknown, result: 'installed' | 'skipped') => {
    calls.push(`finish:${result}`);
  };

  const result = await manager.retryInstallUserMode(bridge.id);

  assert.ok(result);
  assert.equal(bridge.installMode, 'user');
  assert.equal(bridge.pendingInput, undefined);
  assert.equal(calls.join(','), 'upload:user,run:user,finish:installed');
});

test('finishPostInstall marks tunnel_open with error when install is skipped', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  bridge.status = 'installing';
  bridge.error = undefined;
  manager.addLog = () => undefined;

  await manager.finishPostInstall(bridge, 'skipped');

  assert.equal(bridge.status, 'tunnel_open');
  assert.equal(
    bridge.error,
    'Bridge install/start failed. Tunnel is open but bridge service is not running yet.'
  );
});

test('finishPostInstall keeps running status when telemetry verification times out', async () => {
  const manager = createManager();
  const bridge = createActiveBridge('system');
  bridge.status = 'installing';
  manager.addLog = () => undefined;
  manager.tryGetMachineId = async () => 'machine_987';
  manager.verifyTelemetry = async () => false;

  await manager.finishPostInstall(bridge, 'installed');

  assert.equal(bridge.status, 'running');
  assert.equal(bridge.machineId, 'machine_987');
  assert.equal(typeof bridge.connectedAt, 'string');
});

test('disconnect marks bridge disconnected and closes client', () => {
  const manager = createManager();
  const bridge = createBridgeWithClientState('bridge-disconnect', 'running');
  manager.bridges.set(bridge.id, bridge);
  manager.addLog = () => undefined;

  const ok = manager.disconnect(bridge.id);

  assert.equal(ok, true);
  assert.equal(bridge.status, 'disconnected');
  assert.equal(bridge.closing, true);
  assert.equal(bridge.client.ended, true);
});

test('remove deletes bridge and closes client', () => {
  const manager = createManager();
  const bridge = createBridgeWithClientState('bridge-remove', 'running');
  manager.bridges.set(bridge.id, bridge);

  const ok = manager.remove(bridge.id);

  assert.equal(ok, true);
  assert.equal(manager.get(bridge.id), null);
  assert.equal(bridge.closing, true);
  assert.equal(bridge.client.ended, true);
});

test('getSshClient returns null for disconnected, error, or closing bridge', () => {
  const manager = createManager();
  const running = createBridgeWithClientState('bridge-running', 'running');
  const disconnected = createBridgeWithClientState('bridge-disconnected', 'disconnected');
  const failed = createBridgeWithClientState('bridge-error', 'error');
  const closing = createBridgeWithClientState('bridge-closing', 'running');
  closing.closing = true;
  manager.bridges.set(running.id, running);
  manager.bridges.set(disconnected.id, disconnected);
  manager.bridges.set(failed.id, failed);
  manager.bridges.set(closing.id, closing);

  assert.equal(manager.getSshClient('bridge-running'), running.client);
  assert.equal(manager.getSshClient('bridge-disconnected'), null);
  assert.equal(manager.getSshClient('bridge-error'), null);
  assert.equal(manager.getSshClient('bridge-closing'), null);
  assert.equal(manager.getSshClient('bridge-missing'), null);
});

test('closeAll closes clients and clears manager state', async () => {
  const manager = createManager();
  const a = createBridgeWithClientState('bridge-a', 'running');
  const b = createBridgeWithClientState('bridge-b', 'telemetry_active');
  manager.bridges.set(a.id, a);
  manager.bridges.set(b.id, b);

  await manager.closeAll();

  assert.equal(a.client.ended, true);
  assert.equal(b.client.ended, true);
  assert.equal(manager.list().length, 0);
});
