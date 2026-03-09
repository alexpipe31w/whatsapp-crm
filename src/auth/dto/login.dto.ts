import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(200)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt trunca a 72 bytes — no tiene sentido aceptar más
  password: string;
}