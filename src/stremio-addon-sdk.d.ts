/*  src/stremio-addon-sdk.d.ts
    Dichiarazioni minime per soddisfare il compilatore TS                 */

declare module 'stremio-addon-sdk' {
  /* ────────── CLASSI/FUNZIONI ESPORTATE ────────── */

  /** Costruttore usato con `new addonBuilder(...)` */
  export class addonBuilder {
    constructor(manifest: Manifest);
    defineStreamHandler(handler: any): void;
    /* Altri metodi del vero SDK non indispensabili al compile-time     */
    defineCatalogHandler?: any;
    defineMetaHandler?: any;
    defineSubtitlesHandler?: any;
    defineSubtitleHandler?: any;
    getInterface(): any;
  }

  /** Funzioni helper usate nel codice */
  export function getRouter(addonInterface: any): any;
  export function serveHTTP(addonInterface: any, options?: any): void;

  /* ────────── TIPI USATI NEL PROGETTO ────────── */

  /** Manifest dell’addon (versione ridotta: aggiungi campi se servono) */
  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description?: string;
    icon?: string;
    background?: string;

    resources: string[];
    types: string[];
    idPrefixes?: string[];
    catalogs?: any[];
    config?: any[];
    behaviorHints?: any;

    [k: string]: any;           // per campi aggiuntivi
  }

  /** Oggetto stream restituito dagli handler */
  export interface Stream {
    title?: string;
    name?: string;
    url: string;
    behaviorHints?: any;
    headers?: Record<string, string>;
    [k: string]: any;
  }

  /** Alias usato nel codice per evitare errori di namespace */
  export type ContentType = any;
}
