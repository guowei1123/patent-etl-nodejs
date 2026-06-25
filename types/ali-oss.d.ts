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

  interface PutOptions {
    headers?: Record<string, string>
    mime?: string
    [key: string]: unknown
  }

  interface PutResult {
    name: string
    url?: string
    res?: unknown
    [key: string]: unknown
  }

  interface GetResult {
    content: Buffer
    res?: {
      headers?: Record<string, string | string[] | undefined>
      [key: string]: unknown
    }
    [key: string]: unknown
  }

  interface HeadResult {
    status?: number
    res?: {
      headers?: Record<string, string | string[] | undefined>
      [key: string]: unknown
    }
    [key: string]: unknown
  }

  class OSS {
    constructor(options: OSSOptions)
    list(query: Record<string, unknown>): Promise<ListResult>
    put(name: string, file: Buffer, options?: PutOptions): Promise<PutResult>
    get(name: string, options?: Record<string, unknown>): Promise<GetResult>
    head(name: string, options?: Record<string, unknown>): Promise<HeadResult>
  }

  export = OSS
}
