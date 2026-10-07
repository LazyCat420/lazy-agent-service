function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
const StatFactory = {
    create(name, options = {}) {
        const { min = 0, max = 100, initial = 0, step = 1, onChange = null, } = options;
        let level = initial;
        const clamp = (value) => {
            const sanitized = Number.isNaN(value) ? min : value;
            return Math.max(min, Math.min(max, sanitized));
        };
        const stat = {
            getName() {
                return name;
            },
            getLevel() {
                return level;
            },
            setLevel(newLevel) {
                level = clamp(newLevel);
                if (onChange)
                    onChange(level, name);
                return level;
            },
            increase(multiplier = 1) {
                const amount = step * multiplier;
                level = clamp(level + amount);
                if (onChange)
                    onChange(level, name);
                return level;
            },
            decrease(multiplier = 1) {
                const amount = step * multiplier;
                level = clamp(level - amount);
                if (onChange)
                    onChange(level, name);
                return level;
            },
            reset() {
                level = initial;
                if (onChange)
                    onChange(level, name);
                return level;
            },
        };
        return stat;
    },
};
export default StatFactory;
//# sourceMappingURL=StatFactory.js.map