import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_SECRET')!,
      ignoreExpiration: false,
    });
  }

  // El token ya fue verificado por Passport antes de llegar aquí.
  // Solo extraemos lo que necesitamos — sin hit a la BD.
  async validate(payload: {
    sub: string;
    email: string;
    role: string;
    storeId: string | null;
  }) {
    if (!payload.sub || !payload.email) throw new UnauthorizedException();

    // req.user tendrá exactamente estos campos — nada más, nada menos
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      storeId: payload.storeId,
    };
  }
}