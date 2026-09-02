import { contextBridge } from 'electron';

const api = {
  appVersion: (): string => process.env['npm_package_version'] ?? '',
};

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
