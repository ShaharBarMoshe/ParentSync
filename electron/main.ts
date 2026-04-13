import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  shell,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { ChildProcess, fork } from 'child_process';

// Simple JSON-based store (avoids ESM issues with electron-store v10)
interface AppStore {
  windowBounds: { x: number; y: number; width: number; height: number };
  firstRun: boolean;
}

const defaultStore: AppStore = {
  windowBounds: { x: -1, y: -1, width: 1280, height: 800 },
  firstRun: true,
};

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'app-config.json');
}

function loadStore(): AppStore {
  try {
    const data = fs.readFileSync(getStorePath(), 'utf-8');
    return { ...defaultStore, ...JSON.parse(data) };
  } catch {
    return { ...defaultStore };
  }
}

function saveStore(data: Partial<AppStore>): void {
  const current = loadStore();
  const merged = { ...current, ...data };
  fs.writeFileSync(getStorePath(), JSON.stringify(merged, null, 2));
}

function storeGet<K extends keyof AppStore>(key: K): AppStore[K] {
  return loadStore()[key];
}

function storeSet<K extends keyof AppStore>(key: K, value: AppStore[K]): void {
  saveStore({ [key]: value });
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 3000;
let isQuitting = false;

// ── Paths ──────────────────────────────────────────────────────────

const isProd = !process.env.ELECTRON_DEV;
const userData = app.getPath('userData');
const dbPath = path.join(userData, 'parentsync.db');

function getBackendDistPath(): string {
  if (isProd) {
    // In packaged app, backend/dist is inside the app resources
    return path.join(process.resourcesPath, 'backend', 'dist');
  }
  // __dirname is electron/dist/, so ../.. gets to project root
  return path.join(__dirname, '..', '..', 'backend', 'dist');
}

function getFrontendDistPath(): string {
  if (isProd) {
    return path.join(process.resourcesPath, 'frontend', 'dist');
  }
  return path.join(__dirname, '..', '..', 'frontend', 'dist');
}

function getAssetsPath(): string {
  if (isProd) {
    return path.join(process.resourcesPath, 'assets');
  }
  return path.join(__dirname, '..', '..', 'assets');
}

// ── Helpers ────────────────────────────────────────────────────────

function ensureDirectories(): void {
  const dirs = [
    userData,
    path.join(userData, 'chrome-profile'),
    path.join(userData, 'tokens'),
    path.join(userData, 'logs'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      if (startPort < 65535) {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(new Error('No available ports'));
      }
    });
  });
}

// ── Backend ────────────────────────────────────────────────────────

async function startBackend(): Promise<number> {
  const port = await findAvailablePort(3000);
  backendPort = port;

  const backendMain = path.join(getBackendDistPath(), 'main.js');

  if (!fs.existsSync(backendMain)) {
    throw new Error(`Backend not found at ${backendMain}. Run "npm run build:backend" first.`);
  }

  return new Promise((resolve, reject) => {
    const backendDir = isProd
      ? path.join(process.resourcesPath, 'backend')
      : path.join(__dirname, '..', '..', 'backend');

    backendProcess = fork(backendMain, [], {
      cwd: backendDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        DATABASE_URL: dbPath,
        FRONTEND_URL: `http://localhost:${port}`,
        FRONTEND_DIST_PATH: getFrontendDistPath(),
        LOG_DIR: path.join(userData, 'logs'),
        WHATSAPP_DATA_DIR: path.join(userData, 'whatsapp-session'),
        CHROME_PROFILE_DIR: path.join(userData, 'chrome-profile'),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    backendProcess.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString();
      console.log('[backend]', msg);
      if (msg.includes('listening on') || msg.includes('Nest application successfully started')) {
        resolve(port);
      }
    });

    backendProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[backend:err]', data.toString());
    });

    backendProcess.on('error', (err) => {
      console.error('[backend] process error:', err);
      reject(err);
    });

    backendProcess.on('exit', (code) => {
      console.log('[backend] exited with code:', code);
      backendProcess = null;
    });

    // If NestJS doesn't log the magic string, resolve after a timeout
    setTimeout(() => resolve(port), 8000);
  });
}

function stopBackend(): void {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
}

// ── Splash Screen ──────────────────────────────────────────────────

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0; display: flex; align-items: center; justify-content: center;
          height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: white; border-radius: 16px; overflow: hidden;
          -webkit-app-region: drag;
        }
        .container { text-align: center; }
        h1 { font-size: 32px; margin: 0 0 8px; font-weight: 700; }
        p { font-size: 14px; opacity: 0.8; margin: 0; }
        .spinner {
          margin: 24px auto 0; width: 32px; height: 32px;
          border: 3px solid rgba(255,255,255,0.3); border-top-color: white;
          border-radius: 50%; animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>ParentSync</h1>
        <p>Starting up...</p>
        <div class="spinner"></div>
      </div>
    </body>
    </html>
  `)}`);

  return splash;
}

// ── Main Window ────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  const bounds = storeGet('windowBounds');

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x >= 0 ? bounds.x : undefined,
    y: bounds.y >= 0 ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 600,
    title: 'ParentSync',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      storeSet('windowBounds', win.getBounds());
    }
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Closing the window quits the app
  win.on('close', () => {
    isQuitting = true;
    app.quit();
  });

  return win;
}

// ── System Tray ────────────────────────────────────────────────────

function createTray(): Tray {
  const iconPath = path.join(getAssetsPath(), 'icon.png');
  let icon: Electron.NativeImage;

  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Fallback: create a simple colored icon
    icon = nativeImage.createEmpty();
  }

  const newTray = new Tray(icon);
  newTray.setToolTip('ParentSync');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open ParentSync',
      click: () => mainWindow?.show(),
    },
    {
      label: 'Sync Now',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('trigger-sync');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  newTray.setContextMenu(contextMenu);
  newTray.on('double-click', () => mainWindow?.show());

  return newTray;
}

// ── Native Menus ───────────────────────────────────────────────────

function createAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Sync Now',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('trigger-sync'),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About ParentSync',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About ParentSync',
              message: 'ParentSync v1.0.0',
              detail: 'Family task manager with WhatsApp & Gmail integration.',
            });
          },
        },
      ],
    },
  ];

  // macOS has a special app menu
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'Cmd+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC Handlers ───────────────────────────────────────────────────

function setupIPC(): void {
  ipcMain.handle('get-backend-url', () => {
    return `http://127.0.0.1:${backendPort}/api`;
  });

  ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    userData,
    dbPath,
    isFirstRun: storeGet('firstRun'),
  }));

  ipcMain.handle('set-first-run-done', () => {
    storeSet('firstRun', false);
  });

  ipcMain.handle('show-notification', (_event, { title, body }: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  ipcMain.handle('open-external', (_event, url: string) => {
    shell.openExternal(url);
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  // macOS: re-show window when dock icon clicked
  mainWindow?.show();
});

app.whenReady().then(async () => {
  ensureDirectories();

  // Show splash screen
  splashWindow = createSplashWindow();

  // Set up native menus
  createAppMenu();

  // Set up IPC handlers
  setupIPC();

  try {
    if (process.env.ELECTRON_DEV) {
      // In dev mode, backend is already running separately (via concurrently)
      backendPort = 3000;
      console.log(`Dev mode: using existing backend on port ${backendPort}`);
    } else {
      // In production, start the NestJS backend as a child process
      console.log('Starting backend...');
      await startBackend();
      console.log(`Backend running on port ${backendPort}`);
    }

    // Create main window
    mainWindow = createMainWindow();

    // In dev, load from Vite dev server; in prod, load from built files
    if (process.env.ELECTRON_DEV) {
      await mainWindow.loadURL('http://localhost:5173');
    } else {
      const frontendDir = getFrontendDistPath();
      const indexPath = path.join(frontendDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        await mainWindow.loadFile(indexPath);
      } else {
        // Fallback: point to backend which may serve static files
        await mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
      }
    }

    // Create system tray
    tray = createTray();

    // Show main window, hide splash
    mainWindow.show();
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
  } catch (err) {
    console.error('Failed to start application:', err);
    if (splashWindow) {
      splashWindow.close();
    }
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'ParentSync - Startup Error',
      `Failed to start the application.\n\n${(err as Error).message}\n\nPlease ensure the backend is built (npm run build:backend).`,
    );
    app.quit();
  }
});

app.on('quit', () => {
  stopBackend();
});
