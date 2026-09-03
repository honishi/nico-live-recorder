export class ProtobufStreamReader {
  private static readonly maxVarIntBytes = 5;
  private buffer = new Uint8Array(0);

  addChunk(chunk: Uint8Array): void {
    if (!chunk.length) {
      return;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  unshift(): Uint8Array | undefined {
    const varInt = this.readVarInt();
    if (!varInt) {
      return undefined;
    }

    const { offset, value } = varInt;
    if (this.buffer.length < offset + value) {
      return undefined;
    }

    const message = this.buffer.slice(offset, offset + value);
    this.buffer = this.buffer.slice(offset + value);
    return message;
  }

  private readVarInt(): { offset: number; value: number } | undefined {
    let offset = 0;
    let result = 0;
    let multiplier = 1;

    while (true) {
      if (offset >= this.buffer.length) {
        return undefined;
      }
      const current = this.buffer[offset];
      const payload = current & 0x7f;

      // protobuf の長さプレフィックスは uint32 のため、5 バイト目は下位 4 bit のみ有効
      if (offset === ProtobufStreamReader.maxVarIntBytes - 1 && payload > 0x0f) {
        throw new Error('VarInt が uint32 の範囲を超えています');
      }

      result += payload * multiplier;
      offset += 1;
      if ((current & 0x80) === 0) {
        break;
      }
      if (offset >= ProtobufStreamReader.maxVarIntBytes) {
        throw new Error('VarInt が長すぎます');
      }
      multiplier *= 128;
    }

    return { offset, value: result };
  }
}
