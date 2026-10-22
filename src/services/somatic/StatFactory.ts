export interface StatOptions {
  min?: number;
  max?: number;
  initial?: number;
  step?: number;
  onChange?: ((level: number, name: string) => void) | null;
}

export interface StatInstance {
  getName(): string;
  getLevel(): number;
  setLevel(newLevel: number): number;
  increase(multiplier?: number): number;
  decrease(multiplier?: number): number;
  reset(): number;
}

const StatFactory = {
  create(name: string, options: StatOptions = {}): StatInstance {
    const {
      min = 0,
      max = 100,
      initial = 0,
      step = 1,
      onChange = null,
    } = options;

    let level = initial;

    const clamp = (value: number) => {
      const sanitized = Number.isNaN(value) ? min : value;
      return Math.max(min, Math.min(max, sanitized));
    };

    const stat: StatInstance = {
      getName() {
        return name;
      },

      getLevel() {
        return level;
      },

      setLevel(newLevel: number) {
        level = clamp(newLevel);
        if (onChange) onChange(level, name);
        return level;
      },

      increase(multiplier: number = 1) {
        const amount = step * multiplier;
        level = clamp(level + amount);
        if (onChange) onChange(level, name);
        return level;
      },

      decrease(multiplier: number = 1) {
        const amount = step * multiplier;
        level = clamp(level - amount);
        if (onChange) onChange(level, name);
        return level;
      },

      reset() {
        level = initial;
        if (onChange) onChange(level, name);
        return level;
      },
    };

    return stat;
  },
};

export default StatFactory;
