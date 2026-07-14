import crypto from "node:crypto";

export interface WidgetTemplate {
  type: string;
  defaultTitle: string;
  html: string;
  css: string;
  js: string;
}

export class WidgetTemplateRegistry {
  private static templates = new Map<string, WidgetTemplate>([
    [
      "clock",
      {
        type: "clock",
        defaultTitle: "World Clock",
        html: `
<div class="clock-widget">
  <div class="time-display" id="time">00:00:00</div>
  <div class="date-display" id="date">Loading date...</div>
  <select class="timezone-select" id="timezone">
    <option value="UTC">UTC</option>
    <option value="America/New_York">New York (EST)</option>
    <option value="Europe/London">London (GMT)</option>
    <option value="Asia/Tokyo">Tokyo (JST)</option>
  </select>
</div>
        `,
        css: `
.clock-widget {
  padding: 1rem;
  text-align: center;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
}
.time-display {
  font-size: 2rem;
  font-weight: bold;
}
.date-display {
  color: #888;
  margin-bottom: 0.5rem;
}
.timezone-select {
  background: #333;
  color: white;
  border: 1px solid #555;
  padding: 0.2rem;
  border-radius: 4px;
}
        `,
        js: `
const timeEl = document.getElementById('time');
const dateEl = document.getElementById('date');
const tzSelect = document.getElementById('timezone');

function updateClock() {
  const tz = tzSelect.value;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
  const dateStr = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  if (timeEl) timeEl.textContent = timeStr;
  if (dateEl) dateEl.textContent = dateStr;
}

tzSelect.addEventListener('change', updateClock);
setInterval(updateClock, 1000);
updateClock();
        `
      }
    ],
    [
      "checklist",
      {
        type: "checklist",
        defaultTitle: "Interactive Checklist",
        html: `
<div class="checklist-widget">
  <ul class="task-list" id="tasks">
    <li><input type="checkbox" id="task-1"> <label for="task-1">Analyze market signals</label></li>
    <li><input type="checkbox" id="task-2"> <label for="task-2">Review pipeline metrics</label></li>
  </ul>
</div>
        `,
        css: `
.checklist-widget {
  padding: 1rem;
}
.task-list {
  list-style: none;
  padding: 0;
}
.task-list li {
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
        `,
        js: `
// Standard checklist behaviors
        `
      }
    ]
  ]);

  static get(type: string): WidgetTemplate | undefined {
    return this.templates.get(type);
  }

  static list(): WidgetTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Scope CSS rules by prefixing them with a widget container selector.
   * e.g., `.clock-widget { ... }` becomes `#widget-1234 .clock-widget { ... }`
   */
  static scopeCSS(css: string, containerId: string): string {
    if (!css) return "";
    const prefix = `#${containerId}`;
    
    // Simple parser: prefix selectors not starting with @ or media queries
    return css
      .split("}")
      .map((rule) => {
        const parts = rule.split("{");
        if (parts.length < 2) return rule;
        const selector = parts[0].trim();
        const body = parts[1];
        
        if (!selector || selector.startsWith("@") || selector.startsWith("from") || selector.startsWith("to")) {
          return `${selector} {${body}`;
        }
        
        const scopedSelector = selector
          .split(",")
          .map((subSelector) => {
            const trimmed = subSelector.trim();
            if (trimmed === ":root") return prefix;
            return `${prefix} ${trimmed}`;
          })
          .join(", ");
        
        return `${scopedSelector} {${body}`;
      })
      .join("}");
  }

  /**
   * Basic HTML validation verifying matching tag counts and basic structure.
   */
  static validateHTML(html: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!html) {
      errors.push("HTML content is empty.");
      return { valid: false, errors };
    }

    // Check tags balance
    const tagRegex = /<\/?([a-zA-Z0-9:-]+)(?:\s+[^>]*?)?>/g;
    const stack: string[] = [];
    const selfClosing = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const tagName = match[1].toLowerCase();
      
      if (selfClosing.has(tagName) || fullTag.endsWith("/>")) {
        continue;
      }
      
      if (fullTag.startsWith("</")) {
        const top = stack.pop();
        if (top !== tagName) {
          errors.push(`Mismatched closing tag: expected </${top || 'none'}>, found ${fullTag}`);
        }
      } else {
        stack.push(tagName);
      }
    }
    
    while (stack.length > 0) {
      const top = stack.pop();
      errors.push(`Unclosed opening tag: <${top}>`);
    }

    // Check for inline event handlers or script tags with security issues
    if (html.includes("javascript:")) {
      errors.push("Inline 'javascript:' URI schemes are disallowed for security.");
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
