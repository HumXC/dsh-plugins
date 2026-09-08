// Public browser primitive supplied by DSH's module loader. The development
// SDK does not ship this package's declarations; keep this narrow bridge in
// sync with DisclosureRow in the deployed dsh-web-frontend bundle.
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ComponentType, ReactNode } from "react";
  export const DisclosureRow: ComponentType<{
    icon: ReactNode;
    title: ReactNode;
    open: boolean;
    expandable: boolean;
    onToggle: () => void;
    expandOnRowClick?: boolean;
    previewChevron?: boolean;
    keepContentWhenOpen?: boolean;
    collapsedContent?: ReactNode;
    children?: ReactNode;
    className?: string;
    rowClassName?: string;
    leadingClassName?: string;
    chevronClassName?: string;
    titleClassName?: string;
  }>;
}
