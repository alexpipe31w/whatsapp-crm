import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

const STAFF_SELECT = {
  staffId:              true,
  name:                 true,
  isActive:             true,
  schedule:             true,
  commissionPercentage: true,
  createdAt:            true,
} as const;

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(storeId: string) {
    return this.prisma.staff.findMany({
      where:   { storeId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select:  STAFF_SELECT,
    });
  }

  create(storeId: string, dto: CreateStaffDto) {
    return this.prisma.staff.create({
      data: {
        storeId,
        name:                 dto.name,
        schedule:             dto.schedule ?? Prisma.JsonNull,
        commissionPercentage: dto.commissionPercentage ?? null,
      },
      select: STAFF_SELECT,
    });
  }

  async update(staffId: string, storeId: string, dto: UpdateStaffDto) {
    await this.verifyOwnership(staffId, storeId);
    return this.prisma.staff.update({
      where: { staffId },
      data:  {
        ...(dto.name                 !== undefined && { name:                 dto.name }),
        ...(dto.isActive             !== undefined && { isActive:             dto.isActive }),
        ...(dto.schedule             !== undefined && { schedule:             dto.schedule ?? Prisma.JsonNull }),
        ...(dto.commissionPercentage !== undefined && { commissionPercentage: dto.commissionPercentage }),
      },
      select: STAFF_SELECT,
    });
  }

  async remove(staffId: string, storeId: string) {
    await this.verifyOwnership(staffId, storeId);
    return this.prisma.staff.update({
      where: { staffId },
      data:  { isActive: false },
    });
  }

  private async verifyOwnership(staffId: string, storeId: string) {
    const staff = await this.prisma.staff.findUnique({ where: { staffId } });
    if (!staff)                    throw new NotFoundException('Profesional no encontrado');
    if (staff.storeId !== storeId) throw new ForbiddenException();
  }
}
