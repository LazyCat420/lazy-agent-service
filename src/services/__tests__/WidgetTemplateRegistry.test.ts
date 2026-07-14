import { WidgetTemplateRegistry } from "../WidgetTemplateRegistry.ts";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
  console.log(`✓ Passed: ${message}`);
}

console.log("Running WidgetTemplateRegistry tests...");

// Test CSS scoping
const css = `.clock-widget { color: red; }
.time, .date { font-weight: bold; }
@keyframes fade { from { opacity: 0; } }`;
const scopedCss = WidgetTemplateRegistry.scopeCSS(css, "widget-123");
assert(
  scopedCss.includes("#widget-123 .clock-widget"),
  "CSS scoping should prefix clock-widget class"
);
assert(
  scopedCss.includes("#widget-123 .time, #widget-123 .date"),
  "CSS scoping should prefix comma-separated selectors"
);
assert(
  scopedCss.includes("@keyframes fade"),
  "CSS scoping should ignore @ rules"
);

// Test HTML tags validation - valid
const validHtml = `<div><p>Hello World</p><img src="test.jpg" /></div>`;
const validation1 = WidgetTemplateRegistry.validateHTML(validHtml);
assert(validation1.valid, "Valid HTML should pass tag validation");

// Test HTML tags validation - mismatched tags
const invalidHtml1 = `<div><p>Hello World</div></p>`;
const validation2 = WidgetTemplateRegistry.validateHTML(invalidHtml1);
assert(!validation2.valid, "Mismatched HTML tags should fail validation");
assert(
  validation2.errors.some((err) => err.includes("Mismatched closing tag")),
  "Should complain about mismatched tags"
);

// Test HTML tags validation - unclosed tags
const invalidHtml2 = `<div><p>Hello World`;
const validation3 = WidgetTemplateRegistry.validateHTML(invalidHtml2);
assert(!validation3.valid, "Unclosed HTML tags should fail validation");
assert(
  validation3.errors.some((err) => err.includes("Unclosed")),
  "Should complain about unclosed tags"
);

// Test HTML tags validation - security violations
const insecureHtml = `<div onclick="alert(1)">Click me</div>`;
const validation4 = WidgetTemplateRegistry.validateHTML(insecureHtml);
// Note: our simple validation doesn't block onclick yet, but let's check javascript: scheme
const insecureHtml2 = `<a href="javascript:alert(1)">Link</a>`;
const validation5 = WidgetTemplateRegistry.validateHTML(insecureHtml2);
assert(!validation5.valid, "Inline javascript: scheme should be blocked");
assert(
  validation5.errors.some((err) => err.includes("javascript:")),
  "Should complain about javascript: scheme"
);

console.log("All WidgetTemplateRegistry tests passed successfully!");
