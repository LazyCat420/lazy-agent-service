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
import logger from "../utils/logger.js";
const MinioWrapper = {
    async init(endpoint, accessKey, secretKey, bucket) {
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
    getPublicUrl: (key) => MinioManager.getPublicUrl(key),
    upload: (key, buffer, contentType) => MinioManager.upload(key, buffer, contentType),
    get: (key) => MinioManager.get(key),
    remove: (key) => MinioManager.remove(key),
    stat: (key) => MinioManager.stat(key),
    listObjects: (prefix) => MinioManager.listObjects(prefix),
};
export default MinioWrapper;
//# sourceMappingURL=MinioWrapper.js.map