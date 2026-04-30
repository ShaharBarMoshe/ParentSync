import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  EVENT_REPOSITORY,
  GOOGLE_CALENDAR_SERVICE,
} from '../../shared/constants/injection-tokens';
import type { IEventRepository } from '../interfaces/event-repository.interface';
import type { IGoogleCalendarService } from '../interfaces/google-calendar-service.interface';
import { CreateCalendarEventDto } from '../dto/create-calendar-event.dto';
import { UpdateCalendarEventDto } from '../dto/update-calendar-event.dto';
import { GetEventsQueryDto } from '../dto/get-events-query.dto';

@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(
    @Inject(EVENT_REPOSITORY)
    private readonly eventRepository: IEventRepository,
    @Inject(GOOGLE_CALENDAR_SERVICE)
    private readonly googleCalendarService: IGoogleCalendarService,
  ) {}

  @Get('events')
  @ApiOperation({
    summary:
      'Get calendar events. Optional `from`/`to` (YYYY-MM-DD) filters by event date and bypasses pagination.',
  })
  @ApiResponse({ status: 200, description: 'Events retrieved' })
  async getEvents(@Query() query: GetEventsQueryDto) {
    if (query.from && query.to) {
      return this.eventRepository.findInDateRange(query.from, query.to);
    }
    const events = await this.eventRepository.findAll();
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return events.slice(offset, offset + limit);
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Get a calendar event by ID' })
  async getEvent(@Param('id', ParseUUIDPipe) id: string) {
    const event = await this.eventRepository.findById(id);
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  @Post('events')
  @ApiOperation({ summary: 'Create a calendar event' })
  @ApiResponse({ status: 201, description: 'Event created' })
  async createEvent(@Body() dto: CreateCalendarEventDto) {
    return this.eventRepository.create(dto);
  }

  @Put('events/:id')
  @ApiOperation({ summary: 'Update a calendar event' })
  async updateEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCalendarEventDto,
  ) {
    const event = await this.eventRepository.findById(id);
    if (!event) throw new NotFoundException('Event not found');
    return this.eventRepository.update(id, dto);
  }

  @Delete('events/:id')
  @ApiOperation({ summary: 'Delete a calendar event' })
  async deleteEvent(@Param('id', ParseUUIDPipe) id: string) {
    const event = await this.eventRepository.findById(id);
    if (!event) throw new NotFoundException('Event not found');

    // Delete from Google Calendar if synced
    if (event.googleEventId) {
      try {
        await this.googleCalendarService.deleteEvent(
          event.googleEventId,
          'primary',
        );
      } catch (error) {
        // Log but don't fail - still delete locally
      }
    }

    await this.eventRepository.delete(id);
    return { deleted: true };
  }

  @Get('google/calendars')
  @ApiOperation({ summary: 'Get list of Google Calendars' })
  async getGoogleCalendars() {
    return this.googleCalendarService.getCalendarList();
  }

  @Post('events/:id/sync')
  @ApiOperation({ summary: 'Sync a single event to Google Calendar' })
  async syncEventToGoogle(@Param('id', ParseUUIDPipe) id: string) {
    const event = await this.eventRepository.findById(id);
    if (!event) throw new NotFoundException('Event not found');

    if (event.syncedToGoogle && event.googleEventId) {
      return { message: 'Event already synced', googleEventId: event.googleEventId };
    }

    const googleEventId = await this.googleCalendarService.createEvent(
      event,
      'primary',
    );

    await this.eventRepository.update(id, {
      googleEventId,
      syncedToGoogle: true,
    });

    return { synced: true, googleEventId };
  }
}
