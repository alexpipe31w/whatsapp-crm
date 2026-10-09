const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const POSTGRES_PROTOCOLS = new Set(['postgresql:', 'postgres:']);
const HOST_OVERRIDE_PARAM = /^host(addr)?$/i;

/**
 * Primera llave: la BD tiene que estar en esta máquina. Rechaza también
 * `?host=`/`?hostaddr=`, porque pg les da prioridad sobre el host de la URL.
 */
export function assertLocalDatabase(name: string, url: string | undefined): string {
  if (!url) throw new Error(`[test-guard] ${name} no está definida`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[test-guard] ${name} no es una URL válida`);
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`[test-guard] ${name} no es una URL de postgres`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (HOST_OVERRIDE_PARAM.test(key)) {
      throw new Error(`[test-guard] ${name} trae "${key}=" en la query, que sobrescribe el host. Prohibido en tests.`);
    }
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`[test-guard] ${name} apunta a "${parsed.hostname}", no a localhost. Abortando para no tocar producción.`);
  }
  return url;
}

/**
 * Segunda llave, sobre la conexión real: un túnel SSH en un puerto local pasa la
 * primera. Las BDs de tests se llaman *_test.
 */
export function assertTestDatabaseName(name: string): string {
  if (!/_test$/.test(name)) {
    throw new Error(`[test-guard] conectado a la BD "${name}", que no termina en _test. Abortando para no tocar producción.`);
  }
  return name;
}
