/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Hosted URL of the catalog-tuned artifact for a deployed build; the dev server serves it locally when unset. */
  readonly VITE_TUNED_MODEL_URL?: string;
}
