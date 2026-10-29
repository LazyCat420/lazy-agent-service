import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../utils/logger.js";
// ────────────────────────────────────────────────────────────
// PromptLocaleService — Agent Prompt Internationalization
// ────────────────────────────────────────────────────────────
// Resolves localized prompt strings for agent personas, system
// instructions, tool descriptions, and behavioral overrides.
//
// Architecture:
//   - Locale files live in src/locales/{locale}/*.json
//   - Each JSON file is merged into a flat namespace per locale
//   - Access pattern: PromptLocaleService.get("es", "system-prompt.directModeIdentity")
//   - Fallback chain: requested_locale → "en"
//   - Template interpolation: {{variable}} syntax
//
// Thread Safety:
//   Locale data is loaded once at boot and cached in memory.
//   No runtime file I/O after initialization.
// ────────────────────────────────────────────────────────────
const DEFAULT_LOCALE = "en";
const localeCache = new Map();
let availableLocales = [];
let isInitialized = false;
function getLocalesDirectory() {
    const currentFilePath = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFilePath), "..", "locales");
}
function deepFlattenObject(source, prefix = "") {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        const flatKey = prefix ? `${prefix}.${key}` : key;
        if (value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)) {
            Object.assign(result, deepFlattenObject(value, flatKey));
        }
        else {
            result[flatKey] = value;
        }
    }
    return result;
}
function loadLocaleFromDirectory(localeDirectory) {
    const mergedData = {};
    function processDirectory(directory, namespacePrefix) {
        if (!fs.existsSync(directory))
            return;
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                processDirectory(fullPath, `${namespacePrefix}${entry.name}.`);
            }
            else if (entry.name.endsWith(".json")) {
                const fileNameWithoutExtension = entry.name.replace(/\.json$/, "");
                const filePrefix = `${namespacePrefix}${fileNameWithoutExtension}`;
                try {
                    const rawContent = fs.readFileSync(fullPath, "utf-8");
                    const parsedContent = JSON.parse(rawContent);
                    const flattenedContent = deepFlattenObject(parsedContent, filePrefix);
                    Object.assign(mergedData, flattenedContent);
                }
                catch (error) {
                    logger.warn(`[PromptLocaleService] Failed to load locale file: ${fullPath}`, error);
                }
            }
        }
    }
    processDirectory(localeDirectory, "");
    return mergedData;
}
function initialize() {
    if (isInitialized)
        return;
    const localesRootDirectory = getLocalesDirectory();
    if (!fs.existsSync(localesRootDirectory)) {
        logger.warn(`[PromptLocaleService] Locales directory not found: ${localesRootDirectory}`);
        isInitialized = true;
        return;
    }
    const localeDirectories = fs
        .readdirSync(localesRootDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !entry.name.startsWith("__") && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    for (const localeName of localeDirectories) {
        const localeFullPath = path.join(localesRootDirectory, localeName);
        const localeData = loadLocaleFromDirectory(localeFullPath);
        localeCache.set(localeName, localeData);
        logger.info(`[PromptLocaleService] Loaded locale "${localeName}" (${Object.keys(localeData).length} keys)`);
    }
    availableLocales = localeDirectories.sort();
    isInitialized = true;
    logger.info(`[PromptLocaleService] Initialized with ${availableLocales.length} locale(s): ${availableLocales.join(", ")}`);
}
function interpolateTemplate(template, variables) {
    if (!variables)
        return template;
    let interpolatedResult = template;
    for (const [variableKey, variableValue] of Object.entries(variables)) {
        interpolatedResult = interpolatedResult.replaceAll(`{{${variableKey}}}`, variableValue);
    }
    return interpolatedResult;
}
function getValueCaseInsensitive(data, searchKey) {
    if (!data)
        return undefined;
    if (searchKey in data)
        return data[searchKey];
    const lowerSearchKey = searchKey.toLowerCase();
    for (const [k, v] of Object.entries(data)) {
        if (k.toLowerCase() === lowerSearchKey) {
            return v;
        }
    }
    return undefined;
}
const PromptLocaleService = {
    get(locale, key, variables) {
        initialize();
        const localeData = localeCache.get(locale);
        const fallbackData = locale !== DEFAULT_LOCALE
            ? localeCache.get(DEFAULT_LOCALE)
            : undefined;
        const rawValue = getValueCaseInsensitive(localeData, key) ??
            getValueCaseInsensitive(fallbackData, key);
        if (rawValue === undefined) {
            logger.warn(`[PromptLocaleService] Missing key "${key}" for locale "${locale}"`);
            return `[MISSING: ${key}]`;
        }
        return interpolateTemplate(String(rawValue), variables);
    },
    getRecord(locale, keyPrefix) {
        initialize();
        const result = {};
        const searchPrefix = `${keyPrefix}.`;
        const localeData = localeCache.get(locale);
        const fallbackData = locale !== DEFAULT_LOCALE
            ? localeCache.get(DEFAULT_LOCALE)
            : undefined;
        const mergedEntries = new Map();
        if (fallbackData) {
            for (const [fullKey, value] of Object.entries(fallbackData)) {
                if (fullKey.startsWith(searchPrefix)) {
                    const subKey = fullKey.slice(searchPrefix.length);
                    if (!subKey.includes(".")) {
                        mergedEntries.set(subKey, String(value));
                    }
                }
            }
        }
        if (localeData) {
            for (const [fullKey, value] of Object.entries(localeData)) {
                if (fullKey.startsWith(searchPrefix)) {
                    const subKey = fullKey.slice(searchPrefix.length);
                    if (!subKey.includes(".")) {
                        mergedEntries.set(subKey, String(value));
                    }
                }
            }
        }
        for (const [subKey, value] of mergedEntries) {
            result[subKey] = value;
        }
        return result;
    },
    getAvailableLocales() {
        initialize();
        return [...availableLocales];
    },
    isLocaleAvailable(locale) {
        initialize();
        return localeCache.has(locale);
    },
    reload() {
        localeCache.clear();
        availableLocales = [];
        isInitialized = false;
        initialize();
    },
    getDefaultLocale() {
        return DEFAULT_LOCALE;
    },
};
export default PromptLocaleService;
//# sourceMappingURL=PromptLocaleService.js.map