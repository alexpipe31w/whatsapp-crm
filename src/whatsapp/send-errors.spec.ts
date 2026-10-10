import {
  classifySendError,
  isNotAcceptable,
  SendTimeoutError,
  WaNotConnectedError,
} from './send-errors';

const boom = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { output: { statusCode } });

describe('classifySendError', () => {
  it('sin socket = desconectado', () => {
    expect(classifySendError(new WaNotConnectedError('s1'))).toBe(
      'disconnected',
    );
  });

  it('Connection Closed (428) o conexión perdida = desconectado', () => {
    expect(classifySendError(boom('Connection Closed', 428))).toBe(
      'disconnected',
    );
    expect(classifySendError(new Error('Connection Lost'))).toBe(
      'disconnected',
    );
  });

  it('timeout, 5xx y nuestro propio timeout = temporal', () => {
    expect(classifySendError(boom('Timed Out', 408))).toBe('temporary');
    expect(classifySendError(boom('Internal Server Error', 500))).toBe(
      'temporary',
    );
    expect(classifySendError(new SendTimeoutError(30_000))).toBe('temporary');
  });

  it('not-acceptable = temporal y se reconoce para esperar más', () => {
    const err = new Error('not-acceptable');
    expect(classifySendError(err)).toBe('temporary');
    expect(isNotAcceptable(err)).toBe(true);
    expect(isNotAcceptable(new Error('Timed Out'))).toBe(false);
  });

  it('400, 403 y 404 = permanente', () => {
    expect(classifySendError(boom('bad-request', 400))).toBe('permanent');
    expect(classifySendError(boom('forbidden', 403))).toBe('permanent');
    expect(classifySendError(boom('item-not-found', 404))).toBe('permanent');
  });

  it('lo desconocido = temporal (lo frena el tope de intentos)', () => {
    expect(classifySendError(new Error('???'))).toBe('temporary');
    expect(classifySendError('texto suelto')).toBe('temporary');
    expect(classifySendError(undefined)).toBe('temporary');
  });
});
