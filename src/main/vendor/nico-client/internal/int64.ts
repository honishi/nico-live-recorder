// protobufjs は int64 フィールドを Long オブジェクト ({ low, high, unsigned }) としてデコードする
interface LongLike {
  low: number;
  high: number;
  unsigned?: boolean;
}

const isLongLike = (value: unknown): value is LongLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LongLike).low === 'number' &&
  typeof (value as LongLike).high === 'number';

const longLikeToBigInt = (value: LongLike): bigint => {
  const unsignedValue = (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
  return value.unsigned ? unsignedValue : BigInt.asIntN(64, unsignedValue);
};

const toSafeInteger = (value: number): number | undefined =>
  Number.isSafeInteger(value) ? value : undefined;

// number / string / bigint / Long の int64 値を安全整数の number に変換する。
// 不正値や Number.MAX_SAFE_INTEGER を超える値は undefined を返す。
export const int64ToSafeInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return toSafeInteger(value);
  }
  if (typeof value === 'bigint') {
    return toSafeInteger(Number(value));
  }
  if (typeof value === 'string') {
    if (value.trim() === '') {
      return undefined;
    }
    return toSafeInteger(Number(value));
  }
  if (isLongLike(value)) {
    return toSafeInteger(Number(longLikeToBigInt(value)));
  }
  return undefined;
};
