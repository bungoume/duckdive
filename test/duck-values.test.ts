import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/cache', () => ({}));
vi.mock('../src/worker/duckdb-cache-worker?worker', () => ({ default: class {} }));
import { tableToRows, toPlain } from '../src/duck';

const bn = (value: string) => ({
  [Symbol.for('isArrowBigNum')]: true,
  toString: () => value,
  toJSON: () => JSON.stringify(value),
});
describe('Arrow numeric values', () => {
  it('preserves decimal scale and large integer precision, including nested fields', () => {
    const fields = [
      { name: 'amount', type: { scale: 2 } },
      { name: 'large', type: { scale: 0 } },
      { name: 'total', type: { scale: 0 } },
      {
        name: 'nested',
        type: {
          children: [
            {
              name: 'values',
              type: { typeId: 12, valueType: { scale: 3 }, children: [{ name: 'item', type: { scale: 3 } }] },
            },
          ],
        },
      },
    ];
    const rows = [
      {
        amount: bn('-125'),
        large: bn('9007199254740993'),
        total: bn('4950'),
        nested: {
          toArray: () => {
            throw new Error('raw buffers lose schema');
          },
          toJSON: () => ({
            values: {
              toArray: () => {
                throw new Error('raw decimal words');
              },
              toJSON: () => [bn('1'), bn('-2'), null],
            },
          }),
        },
      },
    ];
    expect(tableToRows({ schema: { fields }, [Symbol.iterator]: () => rows[Symbol.iterator]() })).toEqual([
      { amount: '-1.25', large: '9007199254740993', total: 4950, nested: { values: ['0.001', '-0.002', null] } },
    ]);
    expect(toPlain(bn('12345678901234567890123456789012345678'), { scale: 10 })).toBe(
      '1234567890123456789012345678.9012345678',
    );
  });
});
