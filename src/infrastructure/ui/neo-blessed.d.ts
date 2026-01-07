/**
 * Type definitions for neo-blessed
 *
 * @remarks
 * Minimal type definitions for neo-blessed terminal UI library.
 * These definitions cover only the features used by BlessedTradingUI.
 */

declare module 'neo-blessed' {
  namespace blessed {
    namespace Widgets {
      interface Screen {
        append(element: Element): void;
        render(): void;
        destroy(): void;
        key(keys: string[], callback: () => void): void;
      }

      interface Element {
        setContent(content: string): void;
        setScrollPerc(percent: number): void;
      }

      interface BoxElement extends Element {}
    }

    interface ScreenOptions {
      smartCSR?: boolean;
      title?: string;
      fullUnicode?: boolean;
      dockBorders?: boolean;
      ignoreLocked?: string[];
      warnings?: boolean;
      terminal?: string;
      forceUnicode?: boolean;
    }

    interface BoxOptions {
      top?: number | string;
      left?: number | string;
      width?: number | string;
      height?: number | string;
      label?: string;
      border?: { type: string };
      style?: any;
      tags?: boolean;
      scrollable?: boolean;
      alwaysScroll?: boolean;
      scrollbar?: any;
    }

    function screen(options: ScreenOptions): Widgets.Screen;
    function box(options: BoxOptions): Widgets.BoxElement;
    function stripTags(text: string): string;
  }

  export = blessed;
}
