import { Controller, Get, Post, Patch, Param, Body, UseGuards, Request } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IsString, IsOptional } from 'class-validator';

class UpdateCustomerDto {
  @IsString() @IsOptional() name?: string;
  @IsString() @IsOptional() city?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  create(@Body() dto: CreateCustomerDto, @Request() req: any) {
    // storeId siempre del JWT, nunca del body
    return this.customersService.findOrCreate({ ...dto, storeId: req.user.storeId });
  }

  @Get('store/:storeId')
  findAll(@Param('storeId') storeId: string) {
    return this.customersService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.customersService.findOne(id, req.user.storeId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto, @Request() req: any) {
    return this.customersService.update(id, dto, req.user.storeId);
  }
}