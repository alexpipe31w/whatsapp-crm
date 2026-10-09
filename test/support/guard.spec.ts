import { assertLocalDatabase, assertTestDatabaseName } from './guard';

describe('assertLocalDatabase', () => {
  it('acepta localhost', () => {
    const url = 'postgresql://u:p@localhost:5434/crm_test';
    expect(assertLocalDatabase('X', url)).toBe(url);
  });

  it('acepta 127.0.0.1', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@127.0.0.1:5434/crm_test')).not.toThrow();
  });

  it('rechaza un host remoto', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@167.114.209.204:5432/instapod')).toThrow(/no a localhost/);
  });

  it('rechaza ?host= que sobrescribe el host real', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@localhost:5434/crm_test?host=10.0.0.1')).toThrow(/host=/);
  });

  it('rechaza ?hostaddr=', () => {
    expect(() => assertLocalDatabase('X', 'postgresql://u:p@localhost:5434/crm_test?hostaddr=10.0.0.1')).toThrow(/hostaddr=/);
  });

  it('rechaza una URL vacía', () => {
    expect(() => assertLocalDatabase('X', undefined)).toThrow(/no está definida/);
  });

  it('rechaza algo que no es postgres', () => {
    expect(() => assertLocalDatabase('X', 'mysql://u:p@localhost/crm_test')).toThrow(/postgres/);
  });
});

describe('assertTestDatabaseName', () => {
  it('acepta *_test', () => {
    expect(assertTestDatabaseName('crm_test')).toBe('crm_test');
  });

  it('rechaza la BD de producción aunque llegue por un túnel local', () => {
    expect(() => assertTestDatabaseName('instapod')).toThrow(/_test/);
  });
});
