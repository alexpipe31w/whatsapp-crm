import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post()
  create(@Body() dto: CreateMessageDto, @Request() req: any) {
    // Forzar storeId del JWT — el body no puede sobreescribirlo
    return this.messagesService.create({ ...dto, storeId: req.user.storeId });
  }

  @Get('conversation/:id')
  findByConversation(@Param('id') id: string, @Request() req: any) {
    return this.messagesService.findByConversation(id, req.user.storeId);
  }
}