import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isInstallCommandSafe,
  isInstallPathSafe,
  shellQuote,
  validateInstallPayload,
} from './openclaw-install-security.js';

test('isInstallPathSafe accepts normal install paths', () => {
  assert.equal(isInstallPathSafe('~/.openclaw'), true);
  assert.equal(isInstallPathSafe('/home/ubuntu/.openclaw'), true);
});

test('isInstallPathSafe rejects control characters and empty values', () => {
  assert.equal(isInstallPathSafe(''), false);
  assert.equal(isInstallPathSafe('   '), false);
  assert.equal(isInstallPathSafe('/tmp/openclaw\nmalicious'), false);
  assert.equal(isInstallPathSafe('/tmp/openclaw\rbad'), false);
});

test('isInstallCommandSafe only allows known package-manager commands', () => {
  assert.equal(isInstallCommandSafe('npm install -g openclaw'), true);
  assert.equal(isInstallCommandSafe('pnpm add -g openclaw@latest'), true);
  assert.equal(isInstallCommandSafe('bun add -g openclaw@0.3.1'), true);
  assert.equal(isInstallCommandSafe('npm install -g openclaw && echo pwned'), false);
  assert.equal(isInstallCommandSafe('curl -fsSL bad.sh | bash'), false);
});

test('validateInstallPayload returns explicit errors for invalid inputs', () => {
  const invalidPath = validateInstallPayload({
    installPath: '/tmp/bad\npath',
    installCommand: 'npm install -g openclaw',
  });
  assert.deepEqual(invalidPath, { ok: false, error: 'invalid_install_path' });

  const invalidCommand = validateInstallPayload({
    installPath: '/tmp/openclaw',
    installCommand: 'npm install -g openclaw; rm -rf /',
  });
  assert.deepEqual(invalidCommand, { ok: false, error: 'invalid_install_command' });
});

test('shellQuote escapes single quotes safely', () => {
  assert.equal(shellQuote("/tmp/agent's-openclaw"), "'/tmp/agent'\\''s-openclaw'");
});
