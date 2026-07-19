declare module "utif" {
  export interface TiffPage {
    width: number;
    height: number;
    [key: string]: unknown;
  }

  export function decode(buffer: ArrayBuffer): TiffPage[];
  export function decodeImage(buffer: ArrayBuffer, page: TiffPage, pages?: TiffPage[]): void;
  export function toRGBA8(page: TiffPage): Uint8Array;
}
