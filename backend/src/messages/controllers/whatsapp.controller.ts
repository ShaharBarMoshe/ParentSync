import {
  Controller,
  Get,
  Post,
  Sse,
  Inject,
  Logger,
  MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, map, merge } from 'rxjs';
import { WHATSAPP_SERVICE } from '../../shared/constants/injection-tokens';
import type {
  IWhatsAppService,
  WhatsAppConnectionStatus,
} from '../interfaces/whatsapp-service.interface';

@ApiTags('whatsapp')
@Controller('whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    @Inject(WHATSAPP_SERVICE)
    private readonly whatsappService: IWhatsAppService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get WhatsApp connection status' })
  @ApiResponse({ status: 200 })
  getStatus(): { status: WhatsAppConnectionStatus; connected: boolean } {
    return {
      status: this.whatsappService.getConnectionStatus(),
      connected: this.whatsappService.isConnected(),
    };
  }

  @Post('reconnect')
  @ApiOperation({ summary: 'Reconnect WhatsApp (triggers QR if needed)' })
  @ApiResponse({ status: 200 })
  async reconnect(): Promise<{ status: string }> {
    await this.whatsappService.disconnect();
    // Don't await — initialization happens in background, QR comes via SSE
    this.whatsappService.initialize().catch((err) => {
      this.logger.error(`WhatsApp reconnect failed: ${err.message}`);
    });
    return { status: 'reconnecting' };
  }

  @Sse('events')
  @ApiOperation({ summary: 'SSE stream for WhatsApp QR and status events' })
  events(): Observable<MessageEvent> {
    const qr$ = fromEvent(this.eventEmitter, 'whatsapp.qr').pipe(
      map((qrString: unknown) => ({
        data: { type: 'qr', qr: qrString as string },
      })),
    );

    const status$ = fromEvent(this.eventEmitter, 'whatsapp.status').pipe(
      map((status: unknown) => ({
        data: { type: 'status', status: status as string },
      })),
    );

    return merge(qr$, status$);
  }
}
