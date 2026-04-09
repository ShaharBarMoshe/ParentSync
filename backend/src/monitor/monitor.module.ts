import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageEntity } from '../messages/entities/message.entity';
import { CalendarEventEntity } from '../calendar/entities/calendar-event.entity';
import { SyncLogEntity } from '../sync/entities/sync-log.entity';
import { MonitorController } from './controllers/monitor.controller';
import { MonitorService } from './services/monitor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MessageEntity,
      CalendarEventEntity,
      SyncLogEntity,
    ]),
  ],
  controllers: [MonitorController],
  providers: [MonitorService],
})
export class MonitorModule {}
