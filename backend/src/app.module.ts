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

const defaultDbPath = path.join(os.homedir(), '.parentsync', 'parentsync.sqlite');
import { SettingsModule } from './settings/settings.module';
import { MessagesModule } from './messages/messages.module';
import { CalendarModule } from './calendar/calendar.module';
import { LlmModule } from './llm/llm.module';
import { SyncModule } from './sync/sync.module';
import { AuthModule } from './auth/auth.module';
import { SharedModule } from './shared/shared.module';
import { MonitorModule } from './monitor/monitor.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test')
          .default('development'),
        PORT: Joi.number().default(3000),
        DATABASE_URL: Joi.string().default(defaultDbPath),
        FRONTEND_URL: Joi.string().default('http://localhost:5173'),
      }),
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3',
        database: config.get<string>('DATABASE_URL', defaultDbPath),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: true,
        logging: config.get<string>('NODE_ENV') !== 'test',
      }),
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
