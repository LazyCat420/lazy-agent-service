/**
 * The plan gate for model-built widgets.
 *
 * plan_widget used to set a boolean and answer "approved" to ANY call — an
 * empty {} approved create_widget. Now a plan is a small contract: a known
 * widgetType, a title, and a description long enough to be a design. The
 * plan is remembered per conversation and create_widget must honour its
 * type, so the model cannot plan a "custom" widget and then create a
 * "clock", or skip planning altogether.
 *
 * Pure functions, so the rules are unit-testable without the router.
 */

export const WIDGET_TYPES = [
  "checklist",
  "clock",
  "notes",
  "iframe_app",
  "mini_music_player",
  "youtube_player",
  "custom",
] as const;

export const MIN_DESCRIPTION_CHARS = 20;

export interface WidgetPlan {
  widgetType: string;
  title: string;
  description: string;
}

/** What the model is told a custom widget may and may not do. HTML-Notes
 *  renders it inside a sandboxed iframe (sandbox="allow-scripts", never
 *  allow-same-origin), so these are the honest limits of that frame. */
export const CREATE_CONSTRAINTS =
  "Your HTML, CSS and JS run inside a sandboxed frame of their own: `container` is the root " +
  "element; keep state in JS variables; style dark-on-transparent; no external scripts or " +
  "stylesheets; no fetch; one root element; no globals. Put behaviour in jsContent, not in " +
  "inline on* attributes.";

type PlanVerdict =
  | { ok: true; plan: WidgetPlan }
  | { ok: false; missing: string[]; message: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function evaluateWidgetPlan(args: Record<string, unknown>): PlanVerdict {
  const widgetType = str(args?.widgetType);
  const title = str(args?.title);
  const description = str(args?.description);
  const missing: string[] = [];
  if (!(WIDGET_TYPES as readonly string[]).includes(widgetType)) missing.push("widgetType");
  if (!title) missing.push("title");
  if (description.length < MIN_DESCRIPTION_CHARS) missing.push("description");
  if (missing.length) {
    return {
      ok: false,
      missing,
      message:
        `plan_widget needs ${missing.join(", ")}: widgetType one of ` +
        `${WIDGET_TYPES.join("|")}, a title, and a description of at least ` +
        `${MIN_DESCRIPTION_CHARS} characters saying what the widget shows and how it behaves.`,
    };
  }
  return { ok: true, plan: { widgetType, title, description } };
}

type CreateVerdict =
  | { ok: true }
  | { ok: false; error: "PLANNING_REQUIRED" | "PLAN_MISMATCH"; message: string };

export function checkCreateAgainstPlan(
  plan: WidgetPlan | undefined,
  args: Record<string, unknown>,
): CreateVerdict {
  if (!plan) {
    return {
      ok: false,
      error: "PLANNING_REQUIRED",
      message:
        "You must first call plan_widget with widgetType, title and a description before calling create_widget.",
    };
  }
  const widgetType = str(args?.widgetType);
  if (widgetType && widgetType !== plan.widgetType) {
    return {
      ok: false,
      error: "PLAN_MISMATCH",
      message:
        `The plan was for a '${plan.widgetType}' widget ("${plan.title}") but create_widget ` +
        `asked for '${widgetType}'. Create the planned type, or call plan_widget again.`,
    };
  }
  return { ok: true };
}
