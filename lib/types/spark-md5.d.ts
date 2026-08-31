declare module 'spark-md5' {
  interface SparkMD5 {
    hash(str: string, raw?: boolean): string;
    hashBinary(content: ArrayBuffer | Uint8Array): string;
  }
  const SparkMD5: SparkMD5;
  export default SparkMD5;
}
