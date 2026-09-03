import path from 'path';
import protobuf from 'protobufjs';

interface ProtoRegistry {
  ChunkedEntry: protobuf.Type;
  ChunkedMessage: protobuf.Type;
  PackedSegment: protobuf.Type;
}

let registryPromise: Promise<ProtoRegistry> | undefined;
// 既定は cwd 直下の resources/proto (開発時・スクリプト実行時)。Electron アプリでは起動時に
// configureProtoRootDir() で実際の配置先 (パッケージ後は process.resourcesPath/proto) を指定する
let configuredProtoRootDir = path.resolve(process.cwd(), 'resources', 'proto');

export function configureProtoRootDir(dir: string): void {
  if (registryPromise && configuredProtoRootDir !== dir) {
    registryPromise = undefined;
  }
  configuredProtoRootDir = dir;
}

function resolveGoogleProto(target: string): string {
  const protobufPkgPath = require.resolve('protobufjs/package.json');
  const protobufDir = path.dirname(protobufPkgPath);
  return path.join(protobufDir, 'src', target);
}

function buildRegistry(): Promise<ProtoRegistry> {
  const protoRootDir = configuredProtoRootDir;
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    if (target.startsWith('google/')) {
      return resolveGoogleProto(target);
    }
    if (path.isAbsolute(target)) {
      return target;
    }
    if (target.startsWith('dwango/')) {
      return path.join(protoRootDir, target);
    }
    const baseDir = origin ? path.dirname(origin) : protoRootDir;
    return path.join(baseDir, target);
  };

  return root
    .load(path.join(protoRootDir, 'dwango/nicolive/chat/service/edge/payload.proto'), {
      keepCase: true,
    })
    .then((loadedRoot) => {
      const chunkedEntry = loadedRoot.lookupType('dwango.nicolive.chat.service.edge.ChunkedEntry');
      const chunkedMessage = loadedRoot.lookupType(
        'dwango.nicolive.chat.service.edge.ChunkedMessage',
      );
      const packedSegment = loadedRoot.lookupType(
        'dwango.nicolive.chat.service.edge.PackedSegment',
      );
      return {
        ChunkedEntry: chunkedEntry as protobuf.Type,
        ChunkedMessage: chunkedMessage as protobuf.Type,
        PackedSegment: packedSegment as protobuf.Type,
      };
    });
}

export function getProtoRegistry(): Promise<ProtoRegistry> {
  if (!registryPromise) {
    registryPromise = buildRegistry();
  }
  return registryPromise;
}
