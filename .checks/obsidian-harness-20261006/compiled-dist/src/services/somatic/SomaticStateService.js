import crypto from "crypto";
import PromptLocaleService from "../PromptLocaleService.js";
import SettingsService from "../SettingsService.js";
import StatFactory from "./StatFactory.js";
import { SOMATIC_KEYWORDS, VALID_EMOTIONS, EMOTION_CLASSIFICATION_PROMPT, getEmotionBehaviorPrompt, } from "./SomaticConstants.js";
import { EmotionalStateEngine, } from "./EmotionalStateEngine.js";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
import RequestLogger from "../RequestLogger.js";
import { MONGO_DB_NAME } from "../../../config.js";
import { COLLECTIONS } from "../../constants.js";
import logger from "../../utils/logger.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
const PHYSICAL_STAT_NAMES = [
    "hunger",
    "thirst",
    "energy",
    "sickness",
    "alcohol",
    "substance",
    "bathroom",
];
const STAT_NAMES = ["emotion", ...PHYSICAL_STAT_NAMES];
const HUNGER_LABELS = [
    [80, "Starving"],
    [40, "Hungry"],
    [0, "Satisfied"],
];
const THIRST_LABELS = [
    [80, "Dehydrated"],
    [40, "Thirsty"],
    [0, "Quenched"],
];
const SICKNESS_LABELS = [
    [70, "Severely Ill"],
    [30, "Nauseous"],
    [0, "Healthy"],
];
const ALCOHOL_LABELS = [
    [7, "Wasted"],
    [4, "Drunk"],
    [1, "Tipsy"],
    [0, "Sober"],
];
const SUBSTANCE_LABELS = [
    [7, "Tripping / Stoned"],
    [4, "High / Baked"],
    [1, "Buzzed / Elevated"],
    [0, "Sober"],
];
const BATHROOM_LABELS = [
    [80, "Needs to use restroom urgently"],
    [40, "Needs to pee"],
    [0, "Fine"],
];
const STAT_MAX_VALUES = {
    hunger: 100,
    thirst: 100,
    energy: 100,
    sickness: 100,
    alcohol: 10,
    substance: 10,
    bathroom: 100,
};
function resolveLabelDescending(level, thresholds) {
    for (const [threshold, label] of thresholds) {
        if (level >= threshold)
            return label;
    }
    return thresholds[thresholds.length - 1][1];
}
function resolveEnergyLabel(level) {
    if (level <= 30)
        return "Exhausted";
    if (level <= 60)
        return "Tired";
    return "Energized";
}
const PASSIVE_DRIFT_INTERVAL_MILLISECONDS = 30_000;
const PERSIST_INTERVAL_MILLISECONDS = 60_000;
const agentStates = new Map();
function createStatInstances(levels) {
    const emotionalState = levels?.emotionalState
        ? EmotionalStateEngine.deserialize(levels.emotionalState)
        : new EmotionalStateEngine();
    return {
        emotionalState,
        hunger: StatFactory.create("hunger", {
            min: 0,
            max: 100,
            initial: levels?.hunger ?? 0,
        }),
        thirst: StatFactory.create("thirst", {
            min: 0,
            max: 100,
            initial: levels?.thirst ?? 0,
        }),
        energy: StatFactory.create("energy", {
            min: 0,
            max: 100,
            initial: levels?.energy ?? 100,
        }),
        sickness: StatFactory.create("sickness", {
            min: 0,
            max: 100,
            initial: levels?.sickness ?? 0,
            step: 10,
        }),
        alcohol: StatFactory.create("alcohol", {
            min: 0,
            max: 10,
            initial: levels?.alcohol ?? 0,
        }),
        substance: StatFactory.create("substance", {
            min: 0,
            max: 10,
            initial: levels?.substance ?? 0,
        }),
        bathroom: StatFactory.create("bathroom", {
            min: 0,
            max: 100,
            initial: levels?.bathroom ?? 0,
        }),
    };
}
function getPhysicalLevelsFromState(state) {
    return {
        hunger: state.hunger.getLevel(),
        thirst: state.thirst.getLevel(),
        energy: state.energy.getLevel(),
        sickness: state.sickness.getLevel(),
        alcohol: state.alcohol.getLevel(),
        substance: state.substance.getLevel(),
        bathroom: state.bathroom.getLevel(),
    };
}
function applyPassiveDrift(state) {
    state.hunger.increase();
    state.thirst.increase();
    state.energy.decrease();
    if (state.alcohol.getLevel() > 0)
        state.alcohol.decrease();
    if (state.substance.getLevel() > 0)
        state.substance.decrease();
    if (state.sickness.getLevel() > 0)
        state.sickness.setLevel(state.sickness.getLevel() - 5);
    // Emotional decay only runs when the engine is in 'decay' mode;
    // in 'reactive' mode this is a no-op inside the engine.
    state.emotionalState.decay();
    state.isDirty = true;
}
function applyHomeostaticDrift(state) {
    const energy = state.energy.getLevel();
    if (energy < 100)
        state.energy.setLevel(energy + 2);
    const sickness = state.sickness.getLevel();
    if (sickness > 0)
        state.sickness.setLevel(sickness - 5);
    const alcohol = state.alcohol.getLevel();
    if (alcohol > 0)
        state.alcohol.setLevel(alcohol - 1);
    const substance = state.substance.getLevel();
    if (substance > 0)
        state.substance.setLevel(substance - 1);
}
function getCollection() {
    return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SOMATIC_STATE);
}
async function loadFromDatabase(agentId) {
    try {
        const collection = getCollection();
        if (!collection)
            return null;
        const document = await collection.findOne({ agentId });
        if (!document?.levels)
            return null;
        return document.levels;
    }
    catch (error) {
        logger.warn(`[SomaticStateService] Failed to load state for "${agentId}": ${getErrorMessage(error)}`);
        return null;
    }
}
async function persistToDatabase(agentId, state) {
    try {
        const collection = getCollection();
        if (!collection)
            return;
        const dominantEmotion = state.emotionalState.getDominantEmotion();
        const levels = {
            emotionalState: state.emotionalState.serialize(),
            ...getPhysicalLevelsFromState(state),
        };
        await collection.updateOne({ agentId }, {
            $set: {
                levels,
                dominantEmotion: dominantEmotion.emotion,
                emotionIntensity: Math.round(dominantEmotion.intensity),
                updatedAt: new Date().toISOString(),
            },
            $setOnInsert: {
                agentId,
                createdAt: new Date().toISOString(),
            },
        }, { upsert: true });
        state.isDirty = false;
    }
    catch (error) {
        logger.warn(`[SomaticStateService] Failed to persist state for "${agentId}": ${getErrorMessage(error)}`);
    }
}
async function initializeAgentState(agentId) {
    const savedLevels = await loadFromDatabase(agentId);
    const stats = createStatInstances(savedLevels ?? undefined);
    const state = {
        ...stats,
        isDirty: false,
    };
    setInterval(() => {
        applyPassiveDrift(state);
    }, PASSIVE_DRIFT_INTERVAL_MILLISECONDS);
    const loadedFrom = savedLevels ? "database" : "defaults";
    logger.info(`[SomaticStateService] Initialized somatic state for agent "${agentId}" (loaded from ${loadedFrom})`);
    return state;
}
async function ensureState(agentId) {
    let state = agentStates.get(agentId);
    if (!state) {
        state = await initializeAgentState(agentId);
        agentStates.set(agentId, state);
    }
    return state;
}
let persistIntervalId = null;
function startPersistenceLoop() {
    if (persistIntervalId)
        return;
    persistIntervalId = setInterval(async () => {
        for (const [agentId, state] of agentStates.entries()) {
            if (state.isDirty) {
                await persistToDatabase(agentId, state);
            }
        }
    }, PERSIST_INTERVAL_MILLISECONDS);
    logger.info(`[SomaticStateService] Persistence loop started (interval: ${PERSIST_INTERVAL_MILLISECONDS / 1000}s)`);
}
async function resolveEmotionModel() {
    try {
        const SettingsService = (await import("../SettingsService.js")).default;
        return await SettingsService.getSomaticModelConfig();
    }
    catch {
        return null;
    }
}
function extractEmotionFromResponse(responseText) {
    const trimmedResponse = responseText.trim().toLowerCase();
    // Fast path: the model returned exactly a valid emotion word (ideal case)
    if (VALID_EMOTIONS.includes(trimmedResponse)) {
        return trimmedResponse;
    }
    // Strip non-alpha and check if the cleaned single-token matches
    // Only valid for short responses (< 30 chars) to avoid collapsing garbage
    if (trimmedResponse.length < 30) {
        const strippedResponse = trimmedResponse.replace(/[^a-z]/g, "");
        if (VALID_EMOTIONS.includes(strippedResponse)) {
            return strippedResponse;
        }
    }
    // Fallback: scan the response for any valid emotion word boundary match
    // Handles cases where the model wraps the emotion in quotes or a sentence
    for (const emotion of VALID_EMOTIONS) {
        const emotionBoundaryPattern = new RegExp(`\\b${emotion}\\b`);
        if (emotionBoundaryPattern.test(trimmedResponse)) {
            return emotion;
        }
    }
    return "neutral";
}
async function analyzeEmotionFromText(agentId, text, requestContext = {}) {
    const emotionModel = await resolveEmotionModel();
    if (!emotionModel)
        return "neutral";
    const { getProvider } = await import("../../providers/index.js");
    const { provider: providerName, model: modelName } = emotionModel;
    const provider = getProvider(providerName);
    const classificationPrompt = EMOTION_CLASSIFICATION_PROMPT(VALID_EMOTIONS.join(", "), text);
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const aiMessages = [{ role: "user", content: classificationPrompt }];
    let result;
    let success = true;
    let errorMessage = null;
    try {
        result = await provider.generateText(aiMessages, modelName, {
            maxTokens: 10,
            temperature: 0,
            thinkingEnabled: false,
        });
    }
    catch (error) {
        success = false;
        errorMessage = getErrorMessage(error);
        logger.error(`[SomaticStateService] ❌ Emotion analysis API failed: ${errorMessage}`);
    }
    const detectedEmotion = success
        ? extractEmotionFromResponse(result?.text || "")
        : "neutral";
    RequestLogger.logBackgroundLlmCall({
        requestId,
        endpoint: requestContext.endpoint || "/agent",
        operation: "somatic:emotion-analysis",
        project: requestContext.project || null,
        username: requestContext.username || "system",
        agent: agentId,
        provider: providerName,
        model: modelName,
        traceId: requestContext.traceId || null,
        agentConversationId: requestContext.agentConversationId || null,
        aiMessages,
        resultText: result?.text || null,
        usage: result?.usage || null,
        success,
        errorMessage,
        requestStartMs: requestStart,
        extraRequestPayload: {
            inputTextLength: text.length,
            textPreview: text.slice(0, 200),
        },
        extraResponsePayload: success ? { detectedEmotion } : undefined,
    });
    if (!success)
        return "neutral";
    if (detectedEmotion === "neutral" && result?.text?.trim()) {
        logger.warn(`[SomaticStateService] Emotion analysis returned unrecognized value: "${result.text.trim()}" — defaulting to neutral`);
    }
    return detectedEmotion;
}
const MESSAGE_CONTENT_TAG_PATTERN = /<message_content>\s*([\s\S]*?)\s*<\/message_content>/gi;
const DISCORD_MENTION_PATTERN = /<@!?\d+>/g;
function extractMessageContent(formattedText) {
    const tagMatches = [...formattedText.matchAll(MESSAGE_CONTENT_TAG_PATTERN)];
    if (tagMatches.length > 0) {
        // Extract content from the last <message_content> tag (the current message,
        // since earlier tags are replied-to messages in the Discord format)
        const lastMatchContent = tagMatches[tagMatches.length - 1][1];
        return lastMatchContent
            .replace(DISCORD_MENTION_PATTERN, "")
            .replace(/\s+/g, " ")
            .trim();
    }
    // Non-Discord source (prism-client, API) — pass through as-is
    return formattedText.trim();
}
const SomaticStateService = {
    initialize() {
        startPersistenceLoop();
    },
    async getSnapshot(agentId) {
        const state = await ensureState(agentId);
        const dominantEmotion = state.emotionalState.getDominantEmotion();
        return {
            emotion: {
                dominant: dominantEmotion.emotion,
                intensity: Math.round(dominantEmotion.intensity),
                all: dominantEmotion.all,
                isDyad: dominantEmotion.isDyad,
                components: dominantEmotion.components,
            },
            hunger: {
                level: state.hunger.getLevel(),
                label: resolveLabelDescending(state.hunger.getLevel(), HUNGER_LABELS),
            },
            thirst: {
                level: state.thirst.getLevel(),
                label: resolveLabelDescending(state.thirst.getLevel(), THIRST_LABELS),
            },
            energy: {
                level: state.energy.getLevel(),
                label: resolveEnergyLabel(state.energy.getLevel()),
            },
            sickness: {
                level: state.sickness.getLevel(),
                label: resolveLabelDescending(state.sickness.getLevel(), SICKNESS_LABELS),
            },
            alcohol: {
                level: state.alcohol.getLevel(),
                label: resolveLabelDescending(state.alcohol.getLevel(), ALCOHOL_LABELS),
            },
            substance: {
                level: state.substance.getLevel(),
                label: resolveLabelDescending(state.substance.getLevel(), SUBSTANCE_LABELS),
            },
            bathroom: {
                level: state.bathroom.getLevel(),
                label: resolveLabelDescending(state.bathroom.getLevel(), BATHROOM_LABELS),
            },
        };
    },
    async getPhysicalStatLevel(agentId, statName) {
        const state = await ensureState(agentId);
        return state[statName].getLevel();
    },
    async setPhysicalStatLevel(agentId, statName, level) {
        const state = await ensureState(agentId);
        const result = state[statName].setLevel(level);
        state.isDirty = true;
        await persistToDatabase(agentId, state);
        return result;
    },
    async increasePhysicalStat(agentId, statName, multiplier = 1) {
        const state = await ensureState(agentId);
        const result = state[statName].increase(multiplier);
        state.isDirty = true;
        return result;
    },
    async decreasePhysicalStat(agentId, statName, multiplier = 1) {
        const state = await ensureState(agentId);
        const result = state[statName].decrease(multiplier);
        state.isDirty = true;
        return result;
    },
    // Legacy compatibility aliases
    async getStatLevel(agentId, statName) {
        if (statName === "mood" || statName === "emotion") {
            const state = await ensureState(agentId);
            return Math.round(state.emotionalState.getDominantEmotion().intensity);
        }
        return this.getPhysicalStatLevel(agentId, statName);
    },
    async setStatLevel(agentId, statName, level) {
        if (statName === "mood" || statName === "emotion") {
            // For backward compat — setting "mood" directly no longer makes sense
            // with Plutchik, but we avoid crashing. No-op with a warning.
            logger.warn(`[SomaticStateService] setStatLevel("${statName}") is deprecated. Use addEmotion() instead.`);
            return level;
        }
        return this.setPhysicalStatLevel(agentId, statName, level);
    },
    async increaseStat(agentId, statName, multiplier = 1) {
        if (statName === "mood" || statName === "emotion") {
            logger.warn(`[SomaticStateService] increaseStat("${statName}") is deprecated. Use addEmotion() instead.`);
            return 0;
        }
        return this.increasePhysicalStat(agentId, statName, multiplier);
    },
    async decreaseStat(agentId, statName, multiplier = 1) {
        if (statName === "mood" || statName === "emotion") {
            logger.warn(`[SomaticStateService] decreaseStat("${statName}") is deprecated. Use addEmotion() instead.`);
            return 0;
        }
        return this.decreasePhysicalStat(agentId, statName, multiplier);
    },
    async addEmotion(agentId, emotion, intensity = 20) {
        const state = await ensureState(agentId);
        state.emotionalState.addEmotion(emotion, intensity);
        state.isDirty = true;
        return state.emotionalState.getDominantEmotion();
    },
    async getDominantEmotion(agentId) {
        const state = await ensureState(agentId);
        return state.emotionalState.getDominantEmotion();
    },
    async getEmotionBehaviorPrompt(agentId) {
        const dominant = await this.getDominantEmotion(agentId);
        const locale = typeof SettingsService.getCached === "function"
            ? SettingsService.getCached().agents?.locale || "en"
            : "en";
        return (PromptLocaleService.get(locale, `somatic.moods.${dominant.emotion}`) ||
            PromptLocaleService.get(locale, "somatic.moods.neutral"));
    },
    async getAlcoholSystemPrompt(agentId) {
        const state = await ensureState(agentId);
        const level = state.alcohol.getLevel();
        const locale = typeof SettingsService.getCached === "function"
            ? SettingsService.getCached().agents?.locale || "en"
            : "en";
        const description = PromptLocaleService.get(locale, `somatic.alcohol.${level}`);
        if (!description || description.startsWith("[MISSING:"))
            return "";
        const alcoholSuffix = PromptLocaleService.get(locale, "somatic.alcohol.suffix");
        const levelInfo = PromptLocaleService.get(locale, "somatic.alcohol.levelInfo", { level: String(level) });
        return description + alcoholSuffix + levelInfo;
    },
    async adaptFromMessage(agentId, text, requestContext = {}) {
        if (!text)
            return;
        const state = await ensureState(agentId);
        // Extract the actual human message content from Discord-formatted text.
        // Discord messages arrive wrapped in metadata headers, XML tags, reactions, etc.
        // The emotion classifier and keyword matching need only the raw user text.
        const extractedContent = extractMessageContent(text);
        const cleanText = extractedContent.toLowerCase();
        applyHomeostaticDrift(state);
        // LLM-based emotion analysis — detect user emotion and feed the Plutchik wheel.
        // In 'reactive' mode, addEmotion is the sole mechanism for emotional shifts.
        // In 'decay' mode, the 30s passive timer also applies continuous time-based decay.
        const detectedEmotion = await analyzeEmotionFromText(agentId, extractedContent, requestContext);
        if (detectedEmotion !== "neutral") {
            state.emotionalState.addEmotion(detectedEmotion);
            const dominant = state.emotionalState.getDominantEmotion();
            logger.info(`[SomaticStateService] 🎭 Emotion "${detectedEmotion}" detected for "${agentId}" → dominant: ${dominant.emotion} (${Math.round(dominant.intensity)}/100)`);
        }
        else {
            logger.debug(`[SomaticStateService] 🎭 Emotion classified as "neutral" for "${agentId}" — no emotional gain applied`);
        }
        if (SOMATIC_KEYWORDS.food.test(cleanText)) {
            state.hunger.decrease();
            state.bathroom.increase();
            logger.debug(`[SomaticStateService] 🍖 Food keyword for "${agentId}". Hunger: ${state.hunger.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.drink.test(cleanText)) {
            state.thirst.decrease();
            state.bathroom.increase();
            logger.debug(`[SomaticStateService] 💧 Drink keyword for "${agentId}". Thirst: ${state.thirst.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.rest.test(cleanText)) {
            state.energy.increase();
            logger.debug(`[SomaticStateService] 💤 Rest keyword for "${agentId}". Energy: ${state.energy.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.work.test(cleanText)) {
            state.energy.decrease();
            logger.debug(`[SomaticStateService] 🔨 Work keyword for "${agentId}". Energy: ${state.energy.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.sick.test(cleanText)) {
            state.sickness.increase();
            logger.debug(`[SomaticStateService] 🤮 Sickness keyword for "${agentId}". Sickness: ${state.sickness.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.alcohol.test(cleanText)) {
            state.alcohol.increase();
            logger.debug(`[SomaticStateService] 🍺 Alcohol keyword for "${agentId}". Alcohol: ${state.alcohol.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.substance.test(cleanText)) {
            state.substance.increase();
            logger.debug(`[SomaticStateService] 🌿 Substance keyword for "${agentId}". Substance: ${state.substance.getLevel()}`);
        }
        if (SOMATIC_KEYWORDS.bathroom.test(cleanText)) {
            state.bathroom.decrease();
            logger.debug(`[SomaticStateService] 🚽 Bathroom keyword for "${agentId}". Bathroom: ${state.bathroom.getLevel()}`);
        }
        state.isDirty = true;
    },
    async renderSystemMessage(agentId, locale = PromptLocaleService.getDefaultLocale()) {
        const snapshot = await this.getSnapshot(agentId);
        const dominantEmotion = snapshot.emotion;
        const intensityBracket = dominantEmotion.intensity >= 75
            ? "OVERWHELMING"
            : dominantEmotion.intensity >= 50
                ? "STRONG"
                : dominantEmotion.intensity >= 25
                    ? "MODERATE"
                    : "MILD";
        const behaviorPrompt = getEmotionBehaviorPrompt(dominantEmotion.dominant, locale) ||
            getEmotionBehaviorPrompt("neutral", locale);
        const emotionDetailsLines = Object.entries(dominantEmotion.all)
            .map(([emotionName, value]) => `  - ${emotionName.charAt(0).toUpperCase() + emotionName.slice(1)}: ${Math.round(value)}/100`)
            .join("\n");
        const moodHeader = PromptLocaleService.get(locale, "somatic.moodTemplate.header");
        const currentMood = PromptLocaleService.get(locale, "somatic.moodTemplate.currentMood", {
            emotion: dominantEmotion.dominant.toUpperCase(),
            intensityBracket,
            intensity: String(Math.round(dominantEmotion.intensity)),
        });
        const moodDirective = PromptLocaleService.get(locale, "somatic.moodTemplate.directive");
        const moodFilter = PromptLocaleService.get(locale, "somatic.moodTemplate.filter");
        const spectrumHeader = PromptLocaleService.get(locale, "somatic.moodTemplate.spectrumHeader");
        const intensityRulesHeader = PromptLocaleService.get(locale, "somatic.moodTemplate.intensityRulesHeader");
        const intensityMild = PromptLocaleService.get(locale, "somatic.moodTemplate.intensityMild");
        const intensityModerate = PromptLocaleService.get(locale, "somatic.moodTemplate.intensityModerate");
        const intensityStrong = PromptLocaleService.get(locale, "somatic.moodTemplate.intensityStrong");
        const intensityOverwhelming = PromptLocaleService.get(locale, "somatic.moodTemplate.intensityOverwhelming");
        const physicalStateHeader = PromptLocaleService.get(locale, "somatic.moodTemplate.physicalStateHeader");
        let block = `${moodHeader}\n${currentMood}\n${moodDirective}\n${moodFilter}\n\n${behaviorPrompt}\n\n${spectrumHeader}\n${emotionDetailsLines}\n\n${intensityRulesHeader}\n${intensityMild}\n${intensityModerate}\n${intensityStrong}\n${intensityOverwhelming}`;
        block += `\n\n${physicalStateHeader}`;
        const physicalStats = [
            ["Hunger", snapshot.hunger, STAT_MAX_VALUES.hunger],
            ["Thirst", snapshot.thirst, STAT_MAX_VALUES.thirst],
            ["Energy", snapshot.energy, STAT_MAX_VALUES.energy],
            ["Sickness", snapshot.sickness, STAT_MAX_VALUES.sickness],
            ["Alcohol", snapshot.alcohol, STAT_MAX_VALUES.alcohol],
            ["Substance", snapshot.substance, STAT_MAX_VALUES.substance],
            ["Bathroom", snapshot.bathroom, STAT_MAX_VALUES.bathroom],
        ];
        for (const [statName, statState, maxValue] of physicalStats) {
            const display = statState.label || statState.name || `Level ${statState.level}`;
            block += `\n- ${statName}: ${display} (${statState.level}/${maxValue})`;
        }
        return block;
    },
    async persistAll() {
        for (const [agentId, state] of agentStates.entries()) {
            if (state.isDirty) {
                await persistToDatabase(agentId, state);
            }
        }
    },
    async destroyAgent(agentId) {
        const state = agentStates.get(agentId);
        if (state) {
            await persistToDatabase(agentId, state);
            agentStates.delete(agentId);
        }
        logger.info(`[SomaticStateService] Destroyed somatic state for agent "${agentId}"`);
    },
    hasAgent(agentId) {
        return agentStates.has(agentId);
    },
    getLoadedAgentIds() {
        return Array.from(agentStates.keys());
    },
};
export default SomaticStateService;
export { STAT_NAMES, PHYSICAL_STAT_NAMES };
//# sourceMappingURL=SomaticStateService.js.map