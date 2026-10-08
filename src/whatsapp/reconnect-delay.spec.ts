import { computeReconnectDelay } from './reconnect-delay';

describe('computeReconnectDelay', () => {
  const noJitter = () => 0.5; // factor 1.0

  it('primer cierre usa el retraso base por código', () => {
    expect(computeReconnectDelay(undefined, 1, noJitter)).toBe(3_000);
    expect(computeReconnectDelay(408, 1, noJitter)).toBe(5_000);
    expect(computeReconnectDelay(440, 1, noJitter)).toBe(8_000);
  });

  it('duplica con cada cierre seguido', () => {
    expect(computeReconnectDelay(428, 2, noJitter)).toBe(6_000);
    expect(computeReconnectDelay(428, 3, noJitter)).toBe(12_000);
    expect(computeReconnectDelay(428, 5, noJitter)).toBe(48_000);
  });

  it('no pasa del techo de 5 minutos', () => {
    expect(computeReconnectDelay(503, 50, noJitter)).toBe(300_000);
    expect(computeReconnectDelay(503, 50, () => 1)).toBe(360_000); // techo + 20 % jitter
  });

  it('el jitter queda en ±20 %', () => {
    expect(computeReconnectDelay(undefined, 1, () => 0)).toBe(2_400);
    expect(
      computeReconnectDelay(undefined, 1, () => 0.999999),
    ).toBeLessThanOrEqual(3_600);
  });
});
