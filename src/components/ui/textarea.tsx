import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-20 w-full rounded-md border border-input bg-surface px-3 py-2 text-base leading-6 shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-input-hover focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20 aria-invalid:border-danger aria-invalid:ring-danger/20 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60 md:text-sm md:leading-5",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
