/**
 * Safe Lucide Icons Registry & Vue-compatible Renderer
 *
 * CRITICAL VUE ARCHITECTURE NOTE:
 * Standard lucide.createIcons() uses element.parentNode.replaceChild(svg, element),
 * which removes the <i> element from the live DOM tree.
 * When Vue's Virtual DOM later attempts to unmount, patch, or replace that node
 * (e.g. during v-if spinner toggles, toast notifications, or modal switches),
 * Vue accesses vnode.el.parentNode which becomes null, crashing with:
 * "TypeError: Cannot read properties of null (reading 'insertBefore')" and
 * "TypeError: Cannot set properties of null (setting '__vnode')".
 *
 * To completely prevent this:
 * This safe renderer renders the SVG INSIDE the <i> element via element.replaceChildren(svg),
 * keeping the <i> node attached to its parent and preserving Vue's VNode reference intact.
 */

import { icons as allIcons } from 'lucide';

const toPascalCase = (str: string): string =>
  str.replace(/(^\w|-\w)/g, (c) => c.replace('-', '').toUpperCase());

function renderSvgNode(iconNode: Array<[string, Record<string, string | number>]>): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'w-full h-full block pointer-events-none');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.display = 'block';

  for (const [tag, attrs] of iconNode) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        child.setAttribute(key, String(value));
      }
    }
    svg.appendChild(child);
  }
  return svg;
}

/**
 * Vue-safe icon creation function that mounts SVGs inside elements without detaching them.
 */
export function createIcons(options?: {
  root?: Document | HTMLElement;
  nameAttr?: string;
  attrs?: Record<string, string>;
}): void {
  if (typeof document === 'undefined') return;

  const root = options?.root || document;
  const nameAttr = options?.nameAttr || 'data-lucide';
  const elements = root.querySelectorAll(`[${nameAttr}]`);

  elements.forEach((el) => {
    const iconName = el.getAttribute(nameAttr)?.trim();
    if (!iconName) return;

    // Fast-path: already rendered and up to date
    if (el.getAttribute('data-rendered-icon') === iconName && el.children.length > 0) {
      return;
    }

    const pascalName = toPascalCase(iconName);
    const iconNode = (allIcons as Record<string, Array<[string, Record<string, string | number>]>>)[pascalName];
    if (!iconNode) {
      return;
    }

    const htmlEl = el as HTMLElement;
    // Ensure the container is inline-flex so the inner SVG fills its dimensions cleanly
    if (!htmlEl.style.display || htmlEl.style.display === 'inline') {
      htmlEl.style.display = 'inline-flex';
    }
    htmlEl.style.alignItems = 'center';
    htmlEl.style.justifyContent = 'center';
    htmlEl.style.verticalAlign = 'middle';

    const svg = renderSvgNode(iconNode);

    // CRITICAL: Replace CHILDREN only. Never replace el in parentNode!
    htmlEl.replaceChildren(svg);
    htmlEl.setAttribute('data-rendered-icon', iconName);
  });
}

export const lucideProxy = {
  createIcons,
  icons: allIcons,
  ...allIcons,
};

export default lucideProxy;
