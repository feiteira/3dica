declare module '@jscad/stl-serializer' {
  export const mimeType: string
  export function serialize(
    options: { binary?: boolean; statusCallback?: (s: { progress: number }) => void },
    ...objects: unknown[]
  ): ArrayBuffer[] | string[]
  const _default: { mimeType: string; serialize: typeof serialize }
  export default _default
}
