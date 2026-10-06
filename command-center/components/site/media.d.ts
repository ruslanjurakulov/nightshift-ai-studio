// Video files the public pages import (components/site/clips/): Next serves them from /_next/static/media/, a path the middleware never gates.
declare module "*.mp4" {
  const src: string;
  export default src;
}
declare module "*.webm" {
  const src: string;
  export default src;
}
