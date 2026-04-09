import { Controller, Get, Param, Query, Inject, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MESSAGE_REPOSITORY } from '../../shared/constants/injection-tokens';
import type { IMessageRepository } from '../interfaces/message-repository.interface';
import { QueryMessagesDto } from '../dto/query-messages.dto';

import { MessageEntity } from '../entities/message.entity';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(
    @Inject(MESSAGE_REPOSITORY)
    private readonly messageRepository: IMessageRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get messages (paginated)' })
  @ApiResponse({ status: 200, description: 'Messages retrieved' })
  async getMessages(
    @Query() query: QueryMessagesDto,
  ): Promise<MessageEntity[]> {
    let messages: MessageEntity[];
    if (query.unparsed) {
      messages = await this.messageRepository.findUnparsed();
    } else if (query.source) {
      messages = await this.messageRepository.findBySource(query.source);
    } else {
      messages = await this.messageRepository.findAll();
    }
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return messages.slice(offset, offset + limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get message by ID' })
  @ApiResponse({ status: 200, description: 'Message retrieved' })
  async getMessage(@Param('id', ParseUUIDPipe) id: string): Promise<MessageEntity | null> {
    return this.messageRepository.findById(id);
  }
}
