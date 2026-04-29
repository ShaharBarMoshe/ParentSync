import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLogEntity } from './entities/sync-log.entity';
import { PendingDismissalEntity } from './entities/pending-dismissal.entity';
import { TypeOrmSyncLogRepository } from './repositories/typeorm-sync-log.repository';
import { TypeOrmDismissalRepository } from './repositories/typeorm-dismissal.repository';
import { SyncService } from './services/sync.service';
import { EventSyncService } from './services/event-sync.service';
import { ApprovalService } from './services/approval.service';
import { EventDismissalService } from './services/event-dismissal.service';
import { EventReminderService } from './services/event-reminder.service';
import { SyncController } from './controllers/sync.controller';
import {
  SYNC_LOG_REPOSITORY,
  DISMISSAL_REPOSITORY,
} from '../shared/constants/injection-tokens';
import { MessagesModule } from '../messages/messages.module';
import { CalendarModule } from '../calendar/calendar.module';
import { LlmModule } from '../llm/llm.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncLogEntity, PendingDismissalEntity]),
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
    {
      provide: DISMISSAL_REPOSITORY,
      useClass: TypeOrmDismissalRepository,
    },
    SyncService,
    EventSyncService,
    ApprovalService,
    EventDismissalService,
    EventReminderService,
  ],
  exports: [
    SyncService,
    EventSyncService,
    ApprovalService,
    EventDismissalService,
    EventReminderService,
  ],
})
export class SyncModule {}
