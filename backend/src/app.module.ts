import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TerminusModule } from '@nestjs/terminus';
import * as Joi from 'joi';
import * as os from 'os';
import * as path from 'path';

import * as fs from 'fs';

const defaultDbPath = path.join(os.homedir(), '.parentsync', 'parentsync.sqlite');
import { SettingsModule } from './settings/settings.module';
import { MessagesModule } from './messages/messages.module';
import { CalendarModule } from './calendar/calendar.module';
import { LlmModule } from './llm/llm.module';
import { SyncModule } from './sync/sync.module';
import { AuthModule } from './auth/auth.module';
import { SharedModule } from './shared/shared.module';
import { MonitorModule } from './monitor/monitor.module';
import { SystemModule } from './system/system.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test')
          .default('development'),
        PORT: Joi.number().default(41932),
        DATABASE_URL: Joi.string().default(defaultDbPath),
        FRONTEND_URL: Joi.string().default('*'),
      }),
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbPath = config.get<string>('DATABASE_URL', defaultDbPath);
        const dir = path.dirname(path.resolve(dbPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        return {
        type: 'better-sqlite3' as const,
        database: dbPath,
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: true,
        logging: config.get<string>('NODE_ENV') !== 'test',
        };
      },
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 100 }],
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    TerminusModule,
    SettingsModule,
    MessagesModule,
    CalendarModule,
    LlmModule,
    SyncModule,
    AuthModule,
    SharedModule,
    MonitorModule,
    SystemModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
