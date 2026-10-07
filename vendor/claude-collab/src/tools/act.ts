import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

// The browser-side action executor — shared between single and batch modes.
// Injected as a string into evalFrame. Receives the full action logic.
const ACT_RUNTIME = `
// ── Validate ref map ──
if (!window.__dcRefs) {
  return { success: false, error: 'No scan data found. Run collab_scan first.' };
}
if (window.__dcRefsUrl !== location.href) {
  return { success: false, error: 'Page URL changed since last scan (' + window.__dcRefsUrl + ' → ' + location.href + '). Run collab_scan again.' };
}
var __refsAge = window.__dcRefsTimestamp ? (Date.now() - window.__dcRefsTimestamp) : 0;
var __refsStaleWarning = __refsAge > 60000 ? ' (warning: scan data is ' + Math.round(__refsAge / 1000) + 's old — consider re-scanning if DOM has changed)' : '';

function describe(el) {
  var role = el.getAttribute('role') || el.tagName.toLowerCase();
  var label = el.getAttribute('aria-label') || el.getAttribute('alt') || (el.textContent || '').trim().slice(0, 50);
  return role + (label ? ' "' + label + '"' : '');
}

function execAction(action, ref, value) {
  var el = window.__dcRefs[ref];
  if (!el) {
    return { success: false, error: 'Ref "' + ref + '" not found. Available refs: e1–e' + Object.keys(window.__dcRefs).length + '.' };
  }
  if (!document.contains(el)) {
    return { success: false, error: 'Ref "' + ref + '" is stale (element removed from DOM). Run collab_scan again.' };
  }

  var desc = describe(el);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  try {
    switch (action) {
      case 'click': {
        var rect = el.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var evtOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent('mousedown', evtOpts));
        el.dispatchEvent(new MouseEvent('mouseup', evtOpts));
        el.dispatchEvent(new MouseEvent('click', evtOpts));
        var isLink = el.tagName === 'A' && el.href;
        return {
          success: true, action: 'click', ref: ref, element: desc,
          urlBefore: location.href, isLink: !!isLink,
          linkTarget: isLink ? el.href : null,
        };
      }

      case 'type': {
        if (value === undefined || value === null) {
          return { success: false, error: '"type" action requires a value parameter.' };
        }
        el.focus();
        if ('value' in el) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = '';
        }
        if ('value' in el) {
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          var nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          var setter = el.tagName === 'TEXTAREA' ? nativeTextareaValueSetter : nativeInputValueSetter;
          if (setter && setter.set) {
            setter.set.call(el, value);
          } else {
            el.value = value;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { success: true, action: 'type', ref: ref, element: desc, value: value };
      }

      case 'select': {
        if (value === undefined || value === null) {
          return { success: false, error: '"select" action requires a value parameter.' };
        }
        if (el.tagName === 'SELECT') {
          var found = false;
          for (var i = 0; i < el.options.length; i++) {
            if (el.options[i].value === value || el.options[i].textContent.trim() === value) {
              el.selectedIndex = i; found = true; break;
            }
          }
          if (!found) {
            var lv = value.toLowerCase();
            for (var j = 0; j < el.options.length; j++) {
              if (el.options[j].textContent.trim().toLowerCase().indexOf(lv) >= 0) {
                el.selectedIndex = j; found = true; break;
              }
            }
          }
          if (!found) {
            var opts = [];
            for (var k = 0; k < Math.min(el.options.length, 10); k++) {
              opts.push('"' + el.options[k].textContent.trim() + '"');
            }
            return { success: false, error: 'Option "' + value + '" not found. Available: ' + opts.join(', ') + (el.options.length > 10 ? '...' : '') };
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, action: 'select', ref: ref, element: desc, value: el.options[el.selectedIndex].textContent.trim() };
        }
        el.click();
        return { success: true, action: 'select', ref: ref, element: desc, note: 'Clicked custom dropdown. Use collab_scan to see options, then collab_act click on the desired option.' };
      }

      case 'hover': {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
        return { success: true, action: 'hover', ref: ref, element: desc };
      }

      case 'focus': {
        el.focus();
        return { success: true, action: 'focus', ref: ref, element: desc };
      }

      case 'clear': {
        el.focus();
        if ('value' in el) {
          var setter2 = Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value'
          );
          if (setter2 && setter2.set) { setter2.set.call(el, ''); } else { el.value = ''; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { success: true, action: 'clear', ref: ref, element: desc };
      }

      default:
        return { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { success: false, error: 'Action failed: ' + (err.message || String(err)), ref: ref, element: desc };
  }
}
`;

const stepSchema = z.object({
  action: z.enum(['click', 'type', 'select', 'hover', 'focus', 'clear']),
  ref: z.string(),
  value: z.string().max(100000).optional(),
  delay: z.number().max(10000).optional().describe('ms to wait AFTER this step (e.g. 500 for animations)'),
});

export function registerActTool(server: McpServer): void {
  server.tool(
    'collab_act',
    'Interact with page elements using [ref=eN] indices from collab_scan. Supports click, type, select, hover, focus, clear. Send a single action OR multiple steps in sequence (e.g. click a menu then click an option). Use "delay" between steps when the page needs time to react (dropdowns, animations).',
    {
      // Single action (backwards compatible)
      action: z.enum(['click', 'type', 'select', 'hover', 'focus', 'clear']).optional().describe('Action for single-step mode'),
      ref: z.string().optional().describe('Element ref for single-step mode, e.g. "e5"'),
      value: z.string().max(100000).optional().describe('Text to type or option to select'),
      // Batch mode
      steps: z.array(stepSchema).optional().describe('Multiple actions to execute in sequence. Each step: { action, ref, value?, delay? }'),
    },
    async (params) => {
      const t = getTransport();

      // Normalize: single action → steps array
      let steps: Array<{ action: string; ref: string; value?: string; delay?: number }>;

      if (params.steps && params.steps.length > 0) {
        steps = params.steps;
      } else if (params.action && params.ref) {
        steps = [{ action: params.action, ref: params.ref, value: params.value }];
      } else {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Provide either (action + ref) for a single action, or steps[] for a batch.' }) }],
        };
      }

      // Execute all steps in a single browser eval for speed
      const stepsJson = JSON.stringify(steps);

      const batchCode = `((steps) => {
${ACT_RUNTIME}

  var results = [];
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    var result = execAction(s.action, s.ref, s.value);
    results.push(result);

    // Stop on first failure
    if (!result.success) {
      result.stoppedAt = i;
      result.completedSteps = i;
      result.totalSteps = steps.length;
      break;
    }
  }

  if (results.length === 1) {
    if (__refsStaleWarning && results[0].success) results[0].warning = __refsStaleWarning;
    return results[0];
  }
  var out = {
    success: results.every(function(r) { return r.success; }),
    completedSteps: results.filter(function(r) { return r.success; }).length,
    totalSteps: steps.length,
    results: results,
  };
  if (__refsStaleWarning && out.success) out.warning = __refsStaleWarning;
  return out;
})(${stepsJson})`;

      // If any step has a delay, we need to execute step-by-step with waits
      const hasDelays = steps.some(s => s.delay && s.delay > 0);

      if (hasDelays) {
        // Execute steps one-by-one with delays between them
        const results: any[] = [];
        for (const step of steps) {
          const singleCode = `((steps) => {
${ACT_RUNTIME}
  var result = execAction(steps[0].action, steps[0].ref, steps[0].value);
  if (__refsStaleWarning && result.success) result.warning = __refsStaleWarning;
  return result;
})(${JSON.stringify([step])})`;

          const result = await t.evalFrame(singleCode);
          results.push(result);

          if (!result.success) break;

          if (step.delay && step.delay > 0) {
            await new Promise(resolve => setTimeout(resolve, step.delay));
          }
        }

        const output = results.length === 1 ? results[0] : {
          success: results.every((r: any) => r.success),
          completedSteps: results.filter((r: any) => r.success).length,
          totalSteps: steps.length,
          results,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        };
      }

      // No delays — execute all in one eval (fastest)
      const result = await t.evalFrame(batchCode);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
