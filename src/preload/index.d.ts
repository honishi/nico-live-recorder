import type { RendererApi } from './index';

declare global {
  interface Window {
    api: RendererApi;
  }
}

export {};
