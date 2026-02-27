export interface InstallPayloadValidationInput {
  readonly installPath: string;
  readonly installCommand?: string | undefined;
}

const MAX_INSTALL_PATH_LENGTH = 512;

const SAFE_INSTALL_COMMAND_PATTERNS: readonly RegExp[] = [
  /^npm\s+install\s+-g\s+openclaw(?:@[a-zA-Z0-9._-]+)?$/,
  /^pnpm\s+add\s+-g\s+openclaw(?:@[a-zA-Z0-9._-]+)?$/,
  /^bun\s+add\s+-g\s+openclaw(?:@[a-zA-Z0-9._-]+)?$/,
];

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function isInstallPathSafe(installPath: string): boolean {
  const trimmed = installPath.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INSTALL_PATH_LENGTH) return false;
  if (trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0')) return false;
  return true;
}

export function isInstallCommandSafe(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return SAFE_INSTALL_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateInstallPayload(input: InstallPayloadValidationInput):
  | {
      ok: true;
    }
  | {
      ok: false;
      error: 'invalid_install_path' | 'invalid_install_command';
    } {
  if (!isInstallPathSafe(input.installPath)) {
    return {
      ok: false,
      error: 'invalid_install_path',
    };
  }
  if (input.installCommand && !isInstallCommandSafe(input.installCommand)) {
    return {
      ok: false,
      error: 'invalid_install_command',
    };
  }
  return { ok: true };
}
