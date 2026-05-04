import { generateLinuxScript } from './linux';
import { generateMacScript } from './mac';
import { generateWindowsScript } from './windows';

const baseInput = {
  homeDir: '/home/tester',
  logPath: '/tmp/parentsync-uninstall.log',
};

describe('uninstall script generators', () => {
  describe('Linux', () => {
    it('emits all expected cleanup steps when keeping user data', () => {
      const { content, filename, interpreter } = generateLinuxScript({
        ...baseInput,
        removeUserData: false,
      });
      expect(filename).toBe('parentsync-uninstall.sh');
      expect(interpreter).toBe('bash');
      expect(content).toMatch(/systemctl --user stop parentsync\.service/);
      expect(content).toMatch(/systemctl --user disable parentsync\.service/);
      expect(content).toMatch(/rm -f .*ParentSync\.AppImage/);
      expect(content).toMatch(/rm -rf .*\.local\/share\/parentsync/);
      expect(content).toMatch(/parentsync\.desktop/);
      expect(content).toMatch(/Skipping user data removal/);
      expect(content).not.toMatch(/Removing user data/);
    });

    it('removes user-data dir when removeUserData=true', () => {
      const { content } = generateLinuxScript({
        ...baseInput,
        removeUserData: true,
      });
      expect(content).toMatch(/Removing user data/);
      expect(content).toMatch(/rm -rf "\/home\/tester\/\.config\/parentsync"/);
    });

    it('attempts pkexec dpkg -r when .deb is installed', () => {
      const { content } = generateLinuxScript({
        ...baseInput,
        removeUserData: false,
      });
      expect(content).toMatch(/dpkg -l parentsync/);
      expect(content).toMatch(/pkexec dpkg -r parentsync/);
    });
  });

  describe('macOS', () => {
    it('quits then removes the .app bundle', () => {
      const { content, interpreter } = generateMacScript({
        ...baseInput,
        removeUserData: false,
      });
      expect(interpreter).toBe('bash');
      expect(content).toMatch(/osascript -e 'quit app "ParentSync"'/);
      expect(content).toMatch(/rm -rf "\/Applications\/ParentSync\.app"/);
      expect(content).toMatch(/launchctl unload/);
    });

    it('purges Library data when removeUserData=true', () => {
      const { content } = generateMacScript({
        ...baseInput,
        removeUserData: true,
      });
      expect(content).toMatch(/Library\/Application Support\/ParentSync/);
      expect(content).toMatch(/Library\/Logs\/ParentSync/);
      expect(content).toMatch(/com\.parentsync\.app/);
    });
  });

  describe('Windows', () => {
    it('runs NSIS uninstaller silently and clears Run-on-login key', () => {
      const { content, filename, interpreter } = generateWindowsScript({
        ...baseInput,
        removeUserData: false,
      });
      expect(filename).toBe('parentsync-uninstall.ps1');
      expect(interpreter).toBe('powershell');
      expect(content).toMatch(/Uninstall ParentSync\.exe/);
      expect(content).toMatch(/-ArgumentList "\/S"/);
      expect(content).toMatch(/CurrentVersion\\Run/);
    });

    it('purges %APPDATA%\\ParentSync when removeUserData=true', () => {
      const { content } = generateWindowsScript({
        ...baseInput,
        removeUserData: true,
      });
      expect(content).toMatch(/\$env:APPDATA\\ParentSync/);
      expect(content).toMatch(/\$env:LOCALAPPDATA\\ParentSync/);
    });
  });

  it('every generator is idempotent — re-running is safe (uses ErrorAction / 2>/dev/null)', () => {
    const linux = generateLinuxScript({ ...baseInput, removeUserData: true }).content;
    const mac = generateMacScript({ ...baseInput, removeUserData: true }).content;
    const win = generateWindowsScript({ ...baseInput, removeUserData: true }).content;

    expect(linux).toMatch(/2>\/dev\/null/);
    expect(mac).toMatch(/2>\/dev\/null/);
    expect(win).toMatch(/-ErrorAction SilentlyContinue/);
  });
});
