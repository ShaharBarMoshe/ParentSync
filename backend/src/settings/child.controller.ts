import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ChildService } from './child.service';
import { CreateChildDto } from './dto/create-child.dto';
import { UpdateChildDto } from './dto/update-child.dto';
import { ReorderChildrenDto } from './dto/reorder-children.dto';

@ApiTags('children')
@Controller('children')
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class ChildController {
  constructor(private readonly childService: ChildService) {}

  @Get()
  @ApiOperation({ summary: 'List all children' })
  findAll() {
    return this.childService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a child' })
  create(@Body() dto: CreateChildDto) {
    return this.childService.create(dto);
  }

  @Put('reorder')
  @ApiOperation({ summary: 'Reorder children' })
  reorder(@Body() dto: ReorderChildrenDto) {
    return this.childService.reorder(dto.ids);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a child' })
  @ApiParam({ name: 'id', description: 'Child ID' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChildDto) {
    return this.childService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a child' })
  @ApiParam({ name: 'id', description: 'Child ID' })
  delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.childService.delete(id);
  }
}
