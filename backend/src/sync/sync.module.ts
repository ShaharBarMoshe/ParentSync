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
import { MessageDeduplicationService } from './services/message-deduplication.service';
import { CalendarConflictDedupService } from './services/calendar-conflict-dedup.service';
import { OutOfBandAlertService } from './services/out-of-band-alert.service';
import { DbHygieneService } from './services/db-hygiene.service';
import { SmokeTestService } from './services/smoke-test.service';
import { SyncLockService } from './services/sync-lock.service';
import { EventSyncGraph } from './graph/event-sync.graph';
import { SyncSettings } from './graph/sync-settings.service';
import { LoadMessagesNode } from './graph/nodes/load-messages.node';
import { DedupFilterNode } from './graph/nodes/dedup-filter.node';
import { ExtractNode } from './graph/nodes/extract.node';
import { PersistEventsNode } from './graph/nodes/persist-events.node';
import { ScreenEventsNode } from './graph/nodes/screen-events.node';
import { RequestApprovalNode } from './graph/nodes/request-approval.node';
import { ProcessDismissalsNode } from './graph/nodes/process-dismissals.node';
import { SyncToGoogleNode } from './graph/nodes/sync-to-google.node';
import { SyncController } from './controllers/sync.controller';
import { ApprovalController } from './controllers/approval.controller';
import { SmokeTestController } from './controllers/smoke-test.controller';
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
  controllers: [SyncController, ApprovalController, SmokeTestController],
  providers: [
    {
      provide: SYNC_LOG_REPOSITORY,
      useClass: TypeOrmSyncLogRepository,
    },
    {
      provide: DISMISSAL_REPOSITORY,
      useClass: TypeOrmDismissalRepository,
    },
    SyncLockService,
    SyncService,
    EventSyncService,
    // The event-sync graph and its nodes. Each node is injectable so it can be
    // unit-tested against a stubbed state without standing up the graph.
    EventSyncGraph,
    SyncSettings,
    LoadMessagesNode,
    DedupFilterNode,
    ExtractNode,
    PersistEventsNode,
    ScreenEventsNode,
    RequestApprovalNode,
    ProcessDismissalsNode,
    SyncToGoogleNode,
    ApprovalService,
    EventDismissalService,
    EventReminderService,
    MessageDeduplicationService,
    CalendarConflictDedupService,
    DbHygieneService,
    OutOfBandAlertService,
    SmokeTestService,
  ],
  exports: [
    SyncService,
    EventSyncService,
    ApprovalService,
    EventDismissalService,
    EventReminderService,
    MessageDeduplicationService,
    CalendarConflictDedupService,
    DbHygieneService,
  ],
})
export class SyncModule {}
