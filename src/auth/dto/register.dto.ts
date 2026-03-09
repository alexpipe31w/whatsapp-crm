import { IsEmail, IsString, MinLength, MaxLength, IsOptional, Matches } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @IsEmail()
  @MaxLength(200)
  email: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(72) // bcrypt trunca a 72 bytes
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])|(?=.*[a-z])(?=.*\d)|(?=.*[A-Z])(?=.*\d)/, {
    message: 'La contraseña debe incluir mayúsculas y minúsculas, o letras y números',
  })
  password: string;

  // role eliminado — siempre se asigna 'admin' en el service, nunca del body

  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  storeName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  storePhone?: string;
}