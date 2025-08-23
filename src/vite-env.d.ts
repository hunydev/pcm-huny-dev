/// <reference types="vite/client" />

declare module "*.svg" {
  const src: string;
  export default src;
}

// Ambient declarations to avoid TS errors until packages are installed
declare module '@ffmpeg/ffmpeg';
declare module '@ffmpeg/util';

// Vite raw asset URLs (e.g., '?url')
declare module '*?url' {
  const url: string;
  export default url;
}
