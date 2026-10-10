import { assertLocalDatabase } from './guard';
import { TEST_DATABASE_URL } from './env';
import { installNetworkGuard } from './network';

// Primer setupFile del proyecto int y sin imports de src/: PrismaService y
// ConfigModule leen el entorno al instanciarse, así que va fijado antes.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = assertLocalDatabase('TEST_DATABASE_URL', TEST_DATABASE_URL);
process.env.JWT_SECRET = 'test-jwt-secret-con-mas-de-32-caracteres-xx';
process.env.JWT_EXPIRES_IN = '1h';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.BREVO_API_KEY = '';
process.env.CLOUDINARY_CLOUD_NAME = 'test';
process.env.CLOUDINARY_API_KEY = 'test';
process.env.CLOUDINARY_API_SECRET = 'test';

// La cola de WhatsApp no se mueve sola en tests: se mueve con dispatcher.tick().
process.env.WA_OUTBOUND_DISPATCHER = 'off';

installNetworkGuard();
