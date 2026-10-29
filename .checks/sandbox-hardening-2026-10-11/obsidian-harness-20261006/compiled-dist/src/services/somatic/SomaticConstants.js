import PromptLocaleService from "../PromptLocaleService.js";
export const PRIMARY_EMOTIONS = [
    "joy",
    "trust",
    "fear",
    "surprise",
    "sadness",
    "disgust",
    "anger",
    "anticipation",
];
export const VALID_EMOTIONS = [...PRIMARY_EMOTIONS, "neutral"];
export const PLUTCHIK_OPPOSITES = {
    joy: "sadness",
    sadness: "joy",
    trust: "disgust",
    disgust: "trust",
    fear: "anger",
    anger: "fear",
    surprise: "anticipation",
    anticipation: "surprise",
};
export const PLUTCHIK_DYADS = {
    // Primary dyads (adjacent, 1 petal apart)
    "joy+trust": "love",
    "fear+trust": "submission",
    "fear+surprise": "awe",
    "sadness+surprise": "disapproval",
    "disgust+sadness": "remorse",
    "anger+disgust": "contempt",
    "anger+anticipation": "aggressiveness",
    "anticipation+joy": "optimism",
    // Secondary dyads (2 petals apart)
    "fear+joy": "guilt",
    "surprise+trust": "curiosity",
    "fear+sadness": "despair",
    "disgust+surprise": "unbelief",
    "anger+sadness": "envy",
    "anticipation+disgust": "cynicism",
    "anger+joy": "pride",
    "anticipation+trust": "hope",
    // Tertiary dyads (3 petals apart)
    "joy+surprise": "delight",
    "sadness+trust": "sentimentality",
    "disgust+fear": "shame",
    "anger+surprise": "outrage",
    "anticipation+sadness": "pessimism",
    "disgust+joy": "morbidness",
    "anger+trust": "dominance",
    "anticipation+fear": "anxiety",
};
export const DEFAULT_EMOTION_PERSONALITY = {
    emotionalModel: "reactive",
    decayRate: 0.04,
    linearDecay: 0.3,
    zeroClamp: 0.1,
    sensitivity: 2.0,
    volatility: 0.6,
    emotionalInertia: 0.45,
    baselineEmotion: null,
    baselinePull: 0.01,
    threshold: 0.1,
    dyadThreshold: 0.6,
};
export const EMOTION_COLORS = {
    neutral: "#53c2ac",
    joy: "#44dd88",
    trust: "#55ddbb",
    fear: "#7788aa",
    surprise: "#55aaff",
    sadness: "#5577bb",
    disgust: "#77aa55",
    anger: "#ff4444",
    anticipation: "#ffaa44",
    love: "#ff6699",
    submission: "#77bbaa",
    awe: "#88bbff",
    disapproval: "#7788aa",
    remorse: "#6677aa",
    contempt: "#aa7766",
    aggressiveness: "#ff6633",
    optimism: "#ffcc44",
    guilt: "#88aacc",
    curiosity: "#55ddaa",
    despair: "#556688",
    unbelief: "#99aa88",
    envy: "#77aa55",
    cynicism: "#aaaa66",
    pride: "#ffaa55",
    hope: "#55ddbb",
    delight: "#44eeaa",
    sentimentality: "#77bbaa",
    shame: "#8899aa",
    outrage: "#ff5544",
    pessimism: "#7788aa",
    morbidness: "#99aa66",
    dominance: "#dd8844",
    anxiety: "#aaaa77",
};
const allSomaticPrompts = PromptLocaleService.getRecord("en", "somatic.moods");
const validSomaticKeys = new Set([...VALID_EMOTIONS, ...Object.values(PLUTCHIK_DYADS)]);
export const EMOTION_BEHAVIOR_PROMPTS = Object.fromEntries(Object.entries(allSomaticPrompts).filter(([key]) => validSomaticKeys.has(key)));
export function getEmotionBehaviorPrompt(emotion, locale) {
    return PromptLocaleService.get(locale, `somatic.moods.${emotion}`);
}
export const ALCOHOL_DESCRIPTIONS = Object.fromEntries(Object.entries(PromptLocaleService.getRecord("en", "somatic.alcohol")).map(([key, value]) => [Number(key), value]));
export const SOMATIC_KEYWORDS = {
    food: /\b(pizza|burger|taco|food|eat|eating|ramen|snack|cookie|lunch|dinner|breakfast|feast|delicious|yum|yummy|hungry|starving)\b|🍔|🍕|🌮|🍜|🍪/i,
    drink: /\b(water|soda|juice|tea|drink|drinking|sips|hydrate|coffee|fluid|quenched|thirsty|dehydrated)\b|🥛|🥤|🧃|☕/i,
    rest: /\b(sleep|nap|tired|rest|goodnight|bed|exhausted|sleepy|lazy)\b|😴|💤/i,
    work: /\b(work|coding|code|gaming|game|study|studying|running|run|push|exertion|labor|exercise|typing|testing)\b/i,
    sick: /\b(poison|bleach|trash|vomit|sick|flu|covid|ill|illness|disease|nausea|pain|hurt|stomachache)\b|🤢|🤮|😷/i,
    alcohol: /\b(beer|wine|whiskey|vodka|alcohol|drunk|party|shots|tipsy|inebriated|cocktail|booze)\b|🍺|🍻|🍷|🥃|🍸/i,
    substance: /\b(weed|marijuana|joint|smoke|high|stoned|baked|blunt|vape|trip|tripping|acid|shrooms|mushroom|cbd|thc|substance|intoxicated)\b|🌿|🚬|🍄|🌀/i,
    bathroom: /\b(toilet|bathroom|restroom|pee|poop|piss|shit|flush|lavatory|washroom)\b|🚽|🧻/i,
};
export const EMOTION_CLASSIFICATION_PROMPT = (validEmotionsList, textToClassify) => PromptLocaleService.get("en", "somatic.classificationPrompt", {
    validEmotionsList,
    textToClassify,
});
//# sourceMappingURL=SomaticConstants.js.map