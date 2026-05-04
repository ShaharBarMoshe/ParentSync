export interface UninstallScriptInput {
  /** Remove the user-data directory (database, OAuth tokens, WhatsApp session, logs). */
  removeUserData: boolean;
  /** User's home directory — usually `os.homedir()`. */
  homeDir: string;
  /** Path to the cleanup log file the script writes. */
  logPath: string;
}

export interface GeneratedScript {
  /** Suggested filename (sans path). */
  filename: string;
  /** Full text of the script. */
  content: string;
  /**
   * Shell or interpreter the orchestrator should use. On *nix the script is
   * invoked with bash and chmod +x; on Windows we spawn powershell.exe with
   * `-ExecutionPolicy Bypass -File <path>`.
   */
  interpreter: 'bash' | 'powershell';
}
