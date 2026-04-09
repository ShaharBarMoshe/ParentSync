import * as fs from 'fs';
import * as path from 'path';

// Mock fs before importing the service
jest.mock('fs', () => {
  const writeFn = jest.fn();
  const endFn = jest.fn();
  return {
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn(),
    truncateSync: jest.fn(),
    createWriteStream: jest.fn().mockReturnValue({
      write: writeFn,
      end: endFn,
    }),
  };
});

import { FileLoggerService } from './file-logger.service';

describe('FileLoggerService', () => {
  let service: FileLoggerService;
  let mockFs: jest.Mocked<typeof fs>;
  let mockStream: { write: jest.Mock; end: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs = fs as any;
    // Reset the stream mock for each test
    mockStream = { write: jest.fn(), end: jest.fn() };
    mockFs.createWriteStream.mockReturnValue(mockStream as any);

    // Suppress console output from ConsoleLogger
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'debug').mockImplementation();

    service = new FileLoggerService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create logs directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.createWriteStream.mockReturnValue(mockStream as any);

      new FileLoggerService();

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('should not create logs directory if it already exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.createWriteStream.mockReturnValue(mockStream as any);
      mockFs.mkdirSync.mockClear();

      new FileLoggerService();

      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should create a write stream to app.log', () => {
      mockFs.createWriteStream.mockReturnValue(mockStream as any);

      new FileLoggerService();

      expect(mockFs.createWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('app.log'),
        { flags: 'a' },
      );
    });

    it('should use LOG_DIR env variable when set', () => {
      const originalLogDir = process.env.LOG_DIR;
      process.env.LOG_DIR = '/custom/log/dir';
      mockFs.createWriteStream.mockReturnValue(mockStream as any);

      new FileLoggerService();

      expect(mockFs.createWriteStream).toHaveBeenCalledWith(
        path.join('/custom/log/dir', 'app.log'),
        { flags: 'a' },
      );

      process.env.LOG_DIR = originalLogDir;
    });
  });

  describe('log', () => {
    it('should write LOG level message to file', () => {
      service.log('test message');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringMatching(/^\d{4}-.*LOG test message\n$/),
      );
    });

    it('should include context when provided', () => {
      service.log('test message', 'TestContext');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('[TestContext] test message'),
      );
    });
  });

  describe('error', () => {
    it('should write ERROR level message to file', () => {
      service.error('something broke');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('ERROR'),
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('something broke'),
      );
    });

    it('should include stack trace when provided', () => {
      service.error('something broke', 'Error\n  at foo.ts:10');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('something broke\nError\n  at foo.ts:10'),
      );
    });

    it('should include context when provided', () => {
      service.error('fail', undefined, 'ErrCtx');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('[ErrCtx]'),
      );
    });
  });

  describe('warn', () => {
    it('should write WARN level message to file', () => {
      service.warn('warning msg', 'WarnCtx');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('WARN'),
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('[WarnCtx] warning msg'),
      );
    });
  });

  describe('debug', () => {
    it('should write DEBUG level message to file', () => {
      service.debug('debug info');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('DEBUG'),
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('debug info'),
      );
    });
  });

  describe('verbose', () => {
    it('should write VERBOSE level message to file', () => {
      service.verbose('verbose info', 'VerbCtx');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('VERBOSE'),
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('[VerbCtx] verbose info'),
      );
    });
  });

  describe('handleDailyLogCleanup', () => {
    it('should end old stream, delete log file, and create new stream', () => {
      mockFs.existsSync.mockReturnValue(true);
      const newStream = { write: jest.fn(), end: jest.fn() };
      mockFs.createWriteStream.mockReturnValue(newStream as any);

      service.handleDailyLogCleanup();

      expect(mockStream.end).toHaveBeenCalled();
      expect(mockFs.truncateSync).toHaveBeenCalledWith(
        expect.stringContaining('app.log'),
        0,
      );
      expect(mockFs.createWriteStream).toHaveBeenCalled();
    });

    it('should not throw if truncateSync fails during cleanup', () => {
      mockFs.truncateSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const newStream = { write: jest.fn(), end: jest.fn() };
      mockFs.createWriteStream.mockReturnValue(newStream as any);

      expect(() => service.handleDailyLogCleanup()).not.toThrow();
    });

    it('should not throw if unlinkSync throws', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.unlinkSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const newStream = { write: jest.fn(), end: jest.fn() };
      mockFs.createWriteStream.mockReturnValue(newStream as any);

      expect(() => service.handleDailyLogCleanup()).not.toThrow();
    });

    it('should log a cleanup message after recreating stream', () => {
      const newStream = { write: jest.fn(), end: jest.fn() };
      mockFs.createWriteStream.mockReturnValue(newStream as any);

      service.handleDailyLogCleanup();

      // The cleanup log is written to the new stream
      expect(newStream.write).toHaveBeenCalledWith(
        expect.stringContaining('Daily log file cleanup completed'),
      );
    });
  });
});
