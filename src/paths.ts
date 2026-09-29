import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Claude Code's config directory: setting > $CLAUDE_CONFIG_DIR > ~/.claude */
export function claudeDir(): string {
  const configured = vscode.workspace.getConfiguration('claudeMonitor').get<string>('claudeConfigDir')?.trim();
  if (configured) {
    return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
  }
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export const sessionsDir = () => path.join(claudeDir(), 'sessions');
export const projectsDir = () => path.join(claudeDir(), 'projects');
export const credentialsFile = () => path.join(claudeDir(), '.credentials.json');
