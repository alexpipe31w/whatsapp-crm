import { JwtService } from '@nestjs/jwt';

export interface TokenUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

export function tokenFor(user: TokenUser): string {
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  return jwt.sign({ sub: user.userId, email: user.email, role: user.role, storeId: user.storeId }, { expiresIn: '1h' });
}

export function bearer(user: TokenUser): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}
