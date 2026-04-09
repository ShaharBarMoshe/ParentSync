import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLogEntity } from './entities/sync-log.entity';
import { TypeOrmSyncLogRepository } from './repositories/typeorm-sync-log.repository';
import { SyncService } from './services/sync.service';
import { EventSyncService } from './services/event-sync.service';
import { ApprovalService } from './services/approval.service';
import { EventReminderService } from './services/event-reminder.service';
import { SyncController } from './controllers/sync.controller';
import { SYNC_LOG_REPOSITORY } from '../shared/constants/injection-tokens';
import { MessagesModule } from '../messages/messages.module';
import { CalendarModule } from '../calendar/calendar.module';
import { LlmModule } from '../llm/llm.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLogEntity]),
    MessagesModule,
    CalendarModule,
    LlmModule,
    SettingsModule,
  ],
  controllers: [SyncController],
  providers: [
    {
      provide: SYNC_LOG_REPOSITORY,
      useClass: TypeOrmSyncLogRepository,
    },
    SyncService,
    EventSyncService,
    ApprovalService,
    EventReminderService,
  ],
  exports: [SyncService, EventSyncService, ApprovalService, EventReminderService],
})
export class SyncModule {}
