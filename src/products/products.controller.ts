import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { ProductsService } from './products.service';
import { CreateProductDto, CreateVariantInlineDto } from './dto/create-product.dto';
import { UpdateProductDto, UpdateVariantInlineDto } from './dto/update-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// ─── DTO inline para categoría ────────────────────────────────────────────────

class CreateCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────

@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ─── Categorías ───────────────────────────────────────────────────────────
  // Antes de :id para que no colisionen las rutas

  @Get('categories')
  getCategories(@Request() req: any) {
    return this.productsService.getCategories(req.user.storeId);
  }

  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto, @Request() req: any) {
    return this.productsService.createCategory(req.user.storeId, dto.name);
  }

  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeCategory(@Param('categoryId') categoryId: string, @Request() req: any) {
    return this.productsService.removeCategory(categoryId, req.user.storeId);
  }

  // ─── Productos ────────────────────────────────────────────────────────────

  @Post()
  create(@Body() dto: CreateProductDto, @Request() req: any) {
    // storeId del JWT — nunca del body
    return this.productsService.create({ ...dto, storeId: req.user.storeId });
  }

  @Get()
  findAll(@Request() req: any) {
    return this.productsService.findAllByStore(req.user.storeId);
  }

  // Mantener compatibilidad con la ruta anterior
  @Get('store/:storeId')
  findAllByStore(@Param('storeId') storeId: string) {
    return this.productsService.findAllByStore(storeId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.productsService.findOne(id, req.user.storeId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Request() req: any,
  ) {
    return this.productsService.update(id, dto, req.user.storeId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.productsService.remove(id, req.user.storeId);
  }

  // ─── Variantes individuales ───────────────────────────────────────────────

  @Post(':id/variants')
  addVariant(
    @Param('id') productId: string,
    @Body() dto: CreateVariantInlineDto,
    @Request() req: any,
  ) {
    return this.productsService.addVariant(productId, dto, req.user.storeId);
  }

  @Patch('variants/:variantId')
  updateVariant(
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantInlineDto,
    @Request() req: any,
  ) {
    return this.productsService.updateVariant(variantId, dto, req.user.storeId);
  }

  @Delete('variants/:variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeVariant(
    @Param('variantId') variantId: string,
    @Request() req: any,
  ) {
    return this.productsService.removeVariant(variantId, req.user.storeId);
  }
}