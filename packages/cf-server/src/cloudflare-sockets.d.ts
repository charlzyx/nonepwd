declare module 'cloudflare:sockets' {
  export interface CfSocketAddress {
    hostname: string;
    port: number;
  }

  export interface CfSocketOptions {
    secureTransport?: 'on' | 'off' | 'starttls';
    allowHalfOpen?: boolean;
  }

  export interface CfSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }

  export function connect(address: string | CfSocketAddress, options?: CfSocketOptions): CfSocket;
}
