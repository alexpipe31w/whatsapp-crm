import { assertLocalDatabase } from './guard';
import { TEST_DATABASE_URL } from './env';
import { installNetworkGuard } from './network';

// El .env local apunta al túnel de producción. Nest/ConfigModule no pisa variables ya
// presentes en process.env, así que fijarla aquí impide que un spec que instancie
// PrismaService de verdad toque producción.
process.env.DATABASE_URL = assertLocalDatabase('TEST_DATABASE_URL', TEST_DATABASE_URL);

installNetworkGuard();
