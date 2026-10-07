import { DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import MinioWrapper from "../wrappers/MinioWrapper.js";
import logger from "../utils/logger.js";
import { FILE_CATEGORIES } from "../constants.js";
const MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogg",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
    "text/plain": "txt",
    "application/json": "json",
};
/**
 * FileService — abstracts file storage with MinIO primary / MongoDB inline fallback.
 *
 * When MinIO is available, files are uploaded to the bucket and a lightweight
 * reference string `minio://files/<uuid>.<fileExtension>` is returned.
 *
 * When MinIO is unavailable, the original base64 data URL is returned unchanged,
 * so it continues to be stored inline in MongoDB.
 */
const FileService = {
    isExternalStorage() {
        return MinioWrapper.isAvailable();
    },
    async uploadFile(dataUrl, category = FILE_CATEGORIES.UPLOADS, project = null, username = null) {
        // If MinIO is not available, return the data URL as-is (MongoDB inline)
        if (!MinioWrapper.isAvailable()) {
            const size = Math.round((dataUrl.length * 3) / 4); // rough base64 → bytes
            return { ref: dataUrl, size, contentType: "application/octet-stream" };
        }
        // Parse the data URL
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
            // Not a data URL — return as-is (could be a plain URL or already a ref)
            return { ref: dataUrl, size: 0, contentType: "application/octet-stream" };
        }
        const contentType = match[1];
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, "base64");
        const fileExtension = MIME_TO_EXT[contentType] || "bin";
        // Build path: projects/{project}/{username}/{category}/{uuid}.{fileExtension}
        // Falls back to flat {category}/{uuid}.{fileExtension} when project/username not provided
        let key;
        if (project && username) {
            // Sanitize: never use raw IP addresses as path segments — they cause
            // duplicate directories when the same user is later identified by name.
            const safeUsername = /^\d{1,3}(\.\d{1,3}){3}$/.test(username) || username.includes(":")
                ? DEFAULT_USERNAME
                : username;
            key = `projects/${project}/${safeUsername}/${category}/${crypto.randomUUID()}.${fileExtension}`;
        }
        else {
            key = `${category}/${crypto.randomUUID()}.${fileExtension}`;
        }
        await MinioWrapper.upload(key, buffer, contentType);
        logger.info(`FileService: uploaded ${key} (${buffer.length} bytes, ${contentType})`);
        return {
            ref: `minio://${key}`,
            size: buffer.length,
            contentType,
        };
    },
    async getFile(key) {
        if (!MinioWrapper.isAvailable())
            return null;
        // Helper to fetch stat + stream for a given key
        const tryKey = async (k) => {
            const stat = (await MinioWrapper.stat(k));
            const stream = await MinioWrapper.get(k);
            return {
                stream: stream,
                contentType: stat?.metaData?.["content-type"] || "application/octet-stream",
            };
        };
        try {
            return await tryKey(key);
        }
        catch {
            logger.error(`FileService: failed to get ${key}`);
            return null;
        }
    },
    isMinioRef(ref) {
        return typeof ref === "string" && ref.startsWith("minio://");
    },
    extractKey(ref) {
        return ref.replace("minio://", "");
    },
};
export default FileService;
//# sourceMappingURL=FileService.js.map