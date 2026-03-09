import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IsString, IsOptional, IsNumber, IsInt, IsBoolean, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';

class CreateVariantDto {
  @IsString() name: string;
  @IsString() @IsOptional() sku?: string;
  @Type(() => Number) @IsNumber() @Min(0) costPrice: number;
  @Type(() => Number) @IsNumber() @Min(0) salePrice: number;
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() stock?: number;
}

class UpdateVariantDto {
  @IsString() @IsOptional() name?: string;
  @IsString() @IsOptional() sku?: string;
  @Type(() => Number) @IsNumber() @Min(0) @IsOptional() costPrice?: number;
  @Type(() => Number) @IsNumber() @Min(0) @IsOptional() salePrice?: number;
  @Type(() => Number) @IsInt() @Min(0) @IsOptional() stock?: number;
  @IsBoolean() @IsOptional() @Transform(({ value }) => value === true || value === 'true') isActive?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  // ── Productos ─────────────────────────────────────────────────────────────
  @Post()
  create(@Body() dto: CreateProductDto, @Request() req: any) {
    // storeId del JWT — no del body
    return this.productsService.create({ ...dto, storeId: req.user.storeId });
  }

  @Get('store/:storeId')
  findAllByStore(@Param('storeId') storeId: string) {
    return this.productsService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.productsService.findOne(id, req.user.storeId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto, @Request() req: any) {
    return this.productsService.update(id, dto, req.user.storeId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.productsService.remove(id, req.user.storeId);
  }

  // ── Variantes ─────────────────────────────────────────────────────────────
  @Post(':id/variants')
  addVariant(@Param('id') productId: string, @Body() dto: CreateVariantDto, @Request() req: any) {
    return this.productsService.addVariant(productId, dto, req.user.storeId);
  }

  @Patch('variants/:variantId')
  updateVariant(@Param('variantId') variantId: string, @Body() dto: UpdateVariantDto, @Request() req: any) {
    return this.productsService.updateVariant(variantId, dto, req.user.storeId);
  }

  @Delete('variants/:variantId')
  removeVariant(@Param('variantId') variantId: string, @Request() req: any) {
    return this.productsService.removeVariant(variantId, req.user.storeId);
  }
}