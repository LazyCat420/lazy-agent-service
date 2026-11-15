function matchCronField(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  if (pattern.includes(",")) {
    return pattern.split(",").some((sub) => matchCronField(sub, value));
  }
  if (pattern.includes("/")) {
    const [range, stepString] = pattern.split("/");
    const step = parseInt(stepString, 10);
    if (isNaN(step)) return false;
    if (range === "*") {
      return value % step === 0;
    }
    const [startString] = range.split("-");
    const start = parseInt(startString, 10);
    return !isNaN(start) && value >= start && (value - start) % step === 0;
  }
  if (pattern.includes("-")) {
    const [startString, endString] = pattern.split("-");
    const start = parseInt(startString, 10);
    const end = parseInt(endString, 10);
    return !isNaN(start) && !isNaN(end) && value >= start && value <= end;
  }
  return parseInt(pattern, 10) === value;
}

export function matchCron(
  expression: string,
  date: Date = new Date(),
): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;

  return (
    matchCronField(min, date.getMinutes()) &&
    matchCronField(hour, date.getHours()) &&
    matchCronField(dom, date.getDate()) &&
    matchCronField(month, date.getMonth() + 1) &&
    matchCronField(dow, date.getDay())
  );
}
