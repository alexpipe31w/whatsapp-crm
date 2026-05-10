import { IsString, Matches, IsOptional } from 'class-validator';

const HEX_COLOR = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const MSG = (field: string) => `${field} debe ser un color hex válido (#fff o #ffffff)`;

export class UpdateThemeDto {
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: MSG('primaryColor') })
  primaryColor?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: MSG('secondaryColor') })
  secondaryColor?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: MSG('accentColor') })
  accentColor?: string;
}
