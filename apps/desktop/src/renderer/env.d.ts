import type { KynimoApi } from "../shared/api.js";

declare global {
  interface Window {
    kynimo: KynimoApi;
  }
}
