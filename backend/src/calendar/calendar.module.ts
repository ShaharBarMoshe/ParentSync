import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CalendarEventEntity } from './entities/calendar-event.entity';
import { TypeOrmEventRepository } from './repositories/typeorm-event.repository';
import { GoogleCalendarService } from './services/google-calendar.service';
import { CalendarController } from './controllers/calendar.controller';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../shared/constants/injection-tokens';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([CalendarEventEntity]), AuthModule],
  controllers: [CalendarController],
  providers: [
    {
      provide: EVENT_REPOSITORY,
      useClass: TypeOrmEventRepository,
    },
    {
      provide: GOOGLE_CALENDAR_SERVICE,
      useClass: GoogleCalendarService,
    },
  ],
  exports: [EVENT_REPOSITORY, GOOGLE_CALENDAR_SERVICE],
})
export class CalendarModule {}
