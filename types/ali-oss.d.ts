declare module 'ali-oss' {
  interface OSSOptions {
    accessKeyId: string
    accessKeySecret: string
    bucket: string
    region?: string
    endpoint?: string
  }

  interface ListResult {
    objects?: Array<{ name: string; [key: string]: unknown }>
    [key: string]: unknown
  }

  class OSS {
    constructor(options: OSSOptions)
    list(query: Record<string, unknown>): Promise<ListResult>
  }

  export = OSS
}
