import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageEntity } from './entities/message.entity';
import { TypeOrmMessageRepository } from './repositories/typeorm-message.repository';
import { WhatsAppService } from './services/whatsapp.service';
import { GmailService } from './services/gmail.service';
import { MessagesController } from './controllers/messages.controller';
import { WhatsAppController } from './controllers/whatsapp.controller';
import {
  MESSAGE_REPOSITORY,
  WHATSAPP_SERVICE,
  GMAIL_SERVICE,
} from '../shared/constants/injection-tokens';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([MessageEntity]), AuthModule],
  controllers: [MessagesController, WhatsAppController],
  providers: [
    {
      provide: MESSAGE_REPOSITORY,
      useClass: TypeOrmMessageRepository,
    },
    {
      provide: WHATSAPP_SERVICE,
      useClass: WhatsAppService,
    },
    {
      provide: GMAIL_SERVICE,
      useClass: GmailService,
    },
  ],
  exports: [MESSAGE_REPOSITORY, WHATSAPP_SERVICE, GMAIL_SERVICE],
})
export class MessagesModule {}
