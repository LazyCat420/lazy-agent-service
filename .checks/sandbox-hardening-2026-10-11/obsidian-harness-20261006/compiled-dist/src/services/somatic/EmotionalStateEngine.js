import { PLUTCHIK_OPPOSITES, PLUTCHIK_DYADS, PRIMARY_EMOTIONS, DEFAULT_EMOTION_PERSONALITY, } from "./SomaticConstants.js";
function getDyadKey(firstEmotion, secondEmotion) {
    return [firstEmotion, secondEmotion].sort().join("+");
}
export class EmotionalStateEngine {
    emotions;
    personality;
    constructor(personalityOverrides = {}) {
        this.emotions = {
            joy: 0,
            trust: 0,
            fear: 0,
            surprise: 0,
            sadness: 0,
            disgust: 0,
            anger: 0,
            anticipation: 0,
        };
        this.personality = {
            ...DEFAULT_EMOTION_PERSONALITY,
            ...personalityOverrides,
        };
    }
    decay() {
        if (this.personality.emotionalModel !== "decay")
            return;
        const { decayRate, linearDecay, zeroClamp, baselineEmotion, baselinePull } = this.personality;
        for (const emotion of PRIMARY_EMOTIONS) {
            const proportional = this.emotions[emotion] * decayRate;
            this.emotions[emotion] -= Math.max(proportional, linearDecay);
            if (baselineEmotion && emotion === baselineEmotion) {
                this.emotions[emotion] += baselinePull * (100 - this.emotions[emotion]);
            }
            if (this.emotions[emotion] < zeroClamp) {
                this.emotions[emotion] = 0;
            }
        }
    }
    addEmotion(emotion, intensity = 20) {
        if (!PRIMARY_EMOTIONS.includes(emotion)) {
            return;
        }
        const { sensitivity, volatility, emotionalInertia } = this.personality;
        const currentDominant = this.getDominantEmotion().emotion;
        let inertiaFactor = 1;
        if (currentDominant !== emotion && currentDominant !== "neutral") {
            const inertiaValue = this.emotions[currentDominant] || 0;
            inertiaFactor = 1 - emotionalInertia * (inertiaValue / 100);
        }
        const adjustedIntensity = intensity * sensitivity * volatility * inertiaFactor;
        const currentValue = this.emotions[emotion];
        const headroom = 100 - currentValue;
        const actualGain = adjustedIntensity * (headroom / 100);
        this.emotions[emotion] = Math.min(100, currentValue + actualGain);
        const opposite = PLUTCHIK_OPPOSITES[emotion];
        if (opposite) {
            this.emotions[opposite] = Math.max(0, this.emotions[opposite] - adjustedIntensity * 0.5);
        }
    }
    getDominantEmotion() {
        const { threshold, dyadThreshold } = this.personality;
        const sorted = Object.entries(this.emotions).sort(([, firstValue], [, secondValue]) => secondValue - firstValue);
        const [topName, topValue] = sorted[0];
        const [secondName, secondValue] = sorted[1];
        if (topValue < threshold) {
            return {
                emotion: "neutral",
                intensity: 0,
                all: { ...this.emotions },
            };
        }
        if (secondValue >= threshold && topValue > 0) {
            const ratio = secondValue / topValue;
            if (ratio >= dyadThreshold) {
                const key = getDyadKey(topName, secondName);
                const dyadName = PLUTCHIK_DYADS[key];
                if (dyadName) {
                    return {
                        emotion: dyadName,
                        intensity: (topValue + secondValue) / 2,
                        all: { ...this.emotions },
                        isDyad: true,
                        components: [topName, secondName],
                    };
                }
            }
        }
        return {
            emotion: topName,
            intensity: topValue,
            all: { ...this.emotions },
        };
    }
    reset() {
        for (const emotion of PRIMARY_EMOTIONS) {
            this.emotions[emotion] = 0;
        }
    }
    setEmotion(emotion, value) {
        if (PRIMARY_EMOTIONS.includes(emotion)) {
            this.emotions[emotion] = Math.max(0, Math.min(100, value));
        }
    }
    getEmotionValues() {
        return { ...this.emotions };
    }
    serialize() {
        return {
            emotions: { ...this.emotions },
        };
    }
    static deserialize(data) {
        const engine = new EmotionalStateEngine(data.personality);
        for (const emotion of PRIMARY_EMOTIONS) {
            if (typeof data.emotions[emotion] === "number") {
                engine.emotions[emotion] = Math.max(0, Math.min(100, data.emotions[emotion]));
            }
        }
        return engine;
    }
}
//# sourceMappingURL=EmotionalStateEngine.js.map