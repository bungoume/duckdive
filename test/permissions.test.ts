import { describe, expect, it } from 'vitest';
import { isAwsOrigin, originPattern } from '../src/permissions';

describe('originPattern', () => {
  it('keeps the origin of an http(s) URL and refuses anything else', () => {
    expect(originPattern('https://bucket.s3.ap-northeast-1.amazonaws.com/p/x.gz')).toBe('https://bucket.s3.ap-northeast-1.amazonaws.com/*');
    expect(originPattern('http://localhost:9000/bucket')).toBe('http://localhost:9000/*');
    expect(originPattern('s3://bucket/p/*.gz')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
  });
});

describe('isAwsOrigin', () => {
  it('looks at the host of the pattern, not at the text', () => {
    expect(isAwsOrigin('https://*.amazonaws.com/*')).toBe(true);
    expect(isAwsOrigin('https://bucket.s3.ap-northeast-1.amazonaws.com/*')).toBe(true);
    expect(isAwsOrigin('https://amazonaws.com/*')).toBe(true);
    expect(isAwsOrigin('https://amazonaws.com.example/*')).toBe(false);
    expect(isAwsOrigin('https://example.com/amazonaws.com/*')).toBe(false);
    expect(isAwsOrigin('http://localhost:9000/*')).toBe(false);
  });
});
