import { ConsoleLogger, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FileLoggerService extends ConsoleLogger {
  private readonly logFilePath: string;
  private logStream: fs.WriteStream;

  constructor() {
    super();
    const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFilePath = path.join(logDir, 'app.log');
    this.logStream = this.createStream();
  }

  private createStream(): fs.WriteStream {
    return fs.createWriteStream(this.logFilePath, { flags: 'a' });
  }

  private writeToFile(level: string, message: unknown, context?: string) {
    const timestamp = new Date().toISOString();
    const ctx = context ? `[${context}] ` : '';
    const line = `${timestamp} ${level.toUpperCase()} ${ctx}${message}\n`;
    this.logStream.write(line);
  }

  log(message: unknown, context?: string) {
    super.log(message, context);
    this.writeToFile('LOG', message, context);
  }

  error(message: unknown, stack?: string, context?: string) {
    super.error(message, stack, context);
    const fullMessage = stack ? `${message}\n${stack}` : message;
    this.writeToFile('ERROR', fullMessage, context);
  }

  warn(message: unknown, context?: string) {
    super.warn(message, context);
    this.writeToFile('WARN', message, context);
  }

  debug(message: unknown, context?: string) {
    super.debug(message, context);
    this.writeToFile('DEBUG', message, context);
  }

  verbose(message: unknown, context?: string) {
    super.verbose(message, context);
    this.writeToFile('VERBOSE', message, context);
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  handleDailyLogCleanup() {
    this.logStream.end();
    try {
      fs.truncateSync(this.logFilePath, 0);
    } catch {
      // File may not exist yet
    }
    this.logStream = this.createStream();
    this.log('Daily log file cleanup completed', 'FileLogger');
  }
}
