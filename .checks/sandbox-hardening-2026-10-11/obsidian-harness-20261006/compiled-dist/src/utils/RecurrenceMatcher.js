/**
 * Returns whether targetDate matches the given recurrence rule starting from startDate.
 * Calculations are performed based on the local time of the system.
 */
export function matchRecurrenceRule(rule, startDateInput, targetDateInput) {
    // Normalize dates to midnight local time for precise date comparisons
    const startDate = new Date(startDateInput.getFullYear(), startDateInput.getMonth(), startDateInput.getDate());
    const targetDate = new Date(targetDateInput.getFullYear(), targetDateInput.getMonth(), targetDateInput.getDate());
    // If target date is before the start date, it cannot match
    if (targetDate.getTime() < startDate.getTime()) {
        return false;
    }
    const interval = Math.max(1, rule.interval);
    switch (rule.frequency) {
        case "daily": {
            const differenceInMs = targetDate.getTime() - startDate.getTime();
            const differenceInDays = Math.floor(differenceInMs / (24 * 60 * 60 * 1000));
            return differenceInDays % interval === 0;
        }
        case "weekly": {
            // Find the Sunday at the start of the week for both dates to align intervals
            const startSunday = new Date(startDate);
            startSunday.setDate(startDate.getDate() - startDate.getDay());
            const targetSunday = new Date(targetDate);
            targetSunday.setDate(targetDate.getDate() - targetDate.getDay());
            const differenceInMs = targetSunday.getTime() - startSunday.getTime();
            const differenceInWeeks = Math.floor(differenceInMs / (7 * 24 * 60 * 60 * 1000));
            if (differenceInWeeks % interval !== 0) {
                return false;
            }
            // Check if target day of week is scheduled
            if (!rule.weekdays || rule.weekdays.length === 0) {
                return targetDate.getDay() === startDate.getDay();
            }
            return rule.weekdays.includes(targetDate.getDay());
        }
        case "monthly": {
            const differenceInMonths = (targetDate.getFullYear() - startDate.getFullYear()) * 12 +
                (targetDate.getMonth() - startDate.getMonth());
            if (differenceInMonths % interval !== 0) {
                return false;
            }
            return matchMonthlyOrYearlyDayRule(rule, targetDate, false, startDate);
        }
        case "yearly": {
            const differenceInYears = targetDate.getFullYear() - startDate.getFullYear();
            if (differenceInYears % interval !== 0) {
                return false;
            }
            const activeMonths = rule.months || [startDate.getMonth() + 1];
            const targetMonthOneIndexed = targetDate.getMonth() + 1;
            if (!activeMonths.includes(targetMonthOneIndexed)) {
                return false;
            }
            return matchMonthlyOrYearlyDayRule(rule, targetDate, true, startDate);
        }
        default:
            return false;
    }
}
/**
 * Internal helper to match day of month or Nth day of week logic within monthly/yearly scopes
 */
function matchMonthlyOrYearlyDayRule(rule, targetDate, isYearly = false, startDate) {
    const type = isYearly ? rule.yearlyType : rule.monthlyType;
    if (type === "nthDayOfWeek") {
        const nthRule = rule.nthDayOfWeek;
        if (!nthRule)
            return false;
        if (targetDate.getDay() !== nthRule.dayOfWeek) {
            return false;
        }
        const occurrence = nthRule.occurrence;
        const dayOfMonth = targetDate.getDate();
        if (occurrence > 0) {
            const startRange = (occurrence - 1) * 7 + 1;
            const endRange = occurrence * 7;
            return dayOfMonth >= startRange && dayOfMonth <= endRange;
        }
        else if (occurrence === -1) {
            // Find the last day of this target month
            const lastDayOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
            return dayOfMonth >= lastDayOfMonth - 6 && dayOfMonth <= lastDayOfMonth;
        }
        return false;
    }
    // Default is dayOfMonth specific date.
    // When no dayOfMonth is set, infer from the recurrence start date
    // so that "every year on Feb 29" works without requiring explicit config.
    const dayOfMonthRule = rule.dayOfMonth ?? (startDate ? startDate.getDate() : 1);
    if (dayOfMonthRule === -1) {
        const nextDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1);
        return nextDay.getMonth() !== targetDate.getMonth();
    }
    // Clamping logic: if the target month has fewer days than the scheduled day,
    // clamp the target matching day to the last day of the target month.
    const lastDayOfTargetMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
    const effectiveDayRule = Math.min(dayOfMonthRule, lastDayOfTargetMonth);
    return targetDate.getDate() === effectiveDayRule;
}
//# sourceMappingURL=RecurrenceMatcher.js.map