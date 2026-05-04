import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateLinuxScript } from './uninstall-scripts/linux';
import { generateMacScript } from './uninstall-scripts/mac';
import { generateWindowsScript } from './uninstall-scripts/windows';
import { GeneratedScript } from './uninstall-scripts/types';

export interface UninstallResult {
  scriptPath: string;
  logPath: string;
  platform: NodeJS.Platform;
}

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  /**
   * Writes the platform-appropriate cleanup script to a temp location, kicks
   * it off detached, and signals the host (Electron) to quit. The script
   * itself sleeps a couple seconds before doing destructive work, so the
   * HTTP response and the Electron quit have time to land first.
   */
  async uninstall(removeUserData: boolean): Promise<UninstallResult> {
    const homeDir = os.homedir();
    const platform = process.platform;
    const logDir =
      platform === 'win32'
        ? process.env.TEMP || os.tmpdir()
        : os.tmpdir();
    const logPath = path.join(logDir, 'parentsync-uninstall.log');

    const generated = this.buildScript({
      removeUserData,
      homeDir,
      logPath,
      platform,
    });

    const scriptPath = path.join(os.tmpdir(), generated.filename);
    fs.writeFileSync(scriptPath, generated.content, { mode: 0o700 });
    this.logger.log(
      `Wrote uninstall script to ${scriptPath} (removeUserData=${removeUserData})`,
    );

    this.spawnDetached(generated, scriptPath, logPath);

    // Trigger our own exit so Electron sees the backend die. The cleanup
    // script will kill the Electron process anyway, but exiting here speeds
    // up the visible "app closed" feedback. Delay a moment so the response
    // can flush back to the client.
    setTimeout(() => {
      this.logger.warn('Backend exiting to make way for uninstall cleanup');
      process.exit(0);
    }, 1000).unref();

    return { scriptPath, logPath, platform };
  }

  private buildScript(input: {
    removeUserData: boolean;
    homeDir: string;
    logPath: string;
    platform: NodeJS.Platform;
  }): GeneratedScript {
    const { platform, ...rest } = input;
    if (platform === 'darwin') return generateMacScript(rest);
    if (platform === 'win32') return generateWindowsScript(rest);
    // Default: Linux (also covers freebsd/openbsd which would be similar).
    return generateLinuxScript(rest);
  }

  private spawnDetached(
    generated: GeneratedScript,
    scriptPath: string,
    logPath: string,
  ): void {
    const stdout = fs.openSync(logPath + '.spawn', 'a');
    const stderr = fs.openSync(logPath + '.spawn', 'a');

    let child;
    if (generated.interpreter === 'powershell') {
      child = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { detached: true, stdio: ['ignore', stdout, stderr] },
      );
    } else {
      child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: ['ignore', stdout, stderr],
      });
    }
    child.unref();
    this.logger.log(
      `Spawned detached uninstall script (pid=${child.pid}, log=${logPath})`,
    );
  }
}
