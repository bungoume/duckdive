import { describe, expect, it } from 'vitest';
import { describeError } from '../src/errors';
import { CancelledError, TimeoutError } from '../src/net';

describe('describeError', () => {
  it('uses the message of an Error without the class name', () => {
    expect(describeError(new Error('IO Error: no such file'))).toBe('IO Error: no such file');
    expect(describeError(new CancelledError())).toBe('Cancelled');
  });
  it('describes a timeout in the UI language', () => {
    expect(describeError(new TimeoutError('STS', 10_000))).toBe('STS did not answer within 10 s');
  });
  it('turns anything else into text', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
  });
});
