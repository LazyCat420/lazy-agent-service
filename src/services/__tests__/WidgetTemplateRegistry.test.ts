import { describe, it, expect } from "vitest";
import { WidgetTemplateRegistry } from "../WidgetTemplateRegistry.ts";

describe("WidgetTemplateRegistry", () => {
  describe("validateHTML", () => {
    it("accepts well-formed HTML", () => {
      const validation = WidgetTemplateRegistry.validateHTML(
        `<div><p>Hello World</p><img src="test.jpg" /></div>`,
      );
      expect(validation.valid).toBe(true);
    });

    it("rejects mismatched closing tags", () => {
      const validation = WidgetTemplateRegistry.validateHTML(
        `<div><p>Hello World</div></p>`,
      );
      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((err) => err.includes("Mismatched closing tag")),
      ).toBe(true);
    });

    it("rejects unclosed tags", () => {
      const validation = WidgetTemplateRegistry.validateHTML(`<div><p>Hello World`);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((err) => err.includes("Unclosed"))).toBe(true);
    });

    it("blocks javascript: URL schemes", () => {
      const validation = WidgetTemplateRegistry.validateHTML(
        `<a href="javascript:alert(1)">Link</a>`,
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((err) => err.includes("javascript:"))).toBe(true);
    });
  });
});
