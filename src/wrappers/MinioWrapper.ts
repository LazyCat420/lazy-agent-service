// ─── MinioWrapper — Thin adapter over service-library MinioManager ───
//
// Re-exports MinioManager from the service-library while preserving
// the Prism-specific init(endpoint, accessKey, secretKey, bucket) signature.
//
// The service-library version uses a config object:
//   init({ endpoint, accessKey, secretKey, bucket, publicRead, logger })
//
// This adapter bridges the positional-args API to the config-object API.
// ─────────────────────────────────────────────────────────────────────

import { MinioManager } from "@rodrigo-barraza/utilities-library/service/minio";
import logger from "../utils/logger.ts";

const MinioWrapper = {
  async init(
    endpoint: string,
    accessKey: string,
    secretKey: string,
    bucket: string,
  ) {
    return MinioManager.init({
      endpoint,
      accessKey,
      secretKey,
      bucket,
      publicRead: true,
      logger,
    });
  },

  isAvailable: () => MinioManager.isAvailable(),
  getBucketUrl: () => MinioManager.getBucketUrl(),
  getPublicUrl: (key: string) => MinioManager.getPublicUrl(key),
  upload: (key: string, buffer: Buffer, contentType: string) =>
    MinioManager.upload(key, buffer, contentType),
  get: (key: string) => MinioManager.get(key),
  remove: (key: string) => MinioManager.remove(key),
  stat: (key: string) => MinioManager.stat(key),
  listObjects: (prefix: string) => MinioManager.listObjects(prefix),
};

export default MinioWrapper;
